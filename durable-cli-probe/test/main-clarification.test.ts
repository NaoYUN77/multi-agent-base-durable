// TASK-005.2 test/main-clarification.test.ts
//
// The Main service's clarification path, against a real harness and a real
// SQLite file (AC-01, AC-02, AC-04).
//
// Evidence discipline, as in the TASK-005.1 suites: every assertion is about
// what the Harness persisted, what the *provider actually received*, or how many
// provider turns happened — never about what a tool printed or what a prompt
// contained. The `fauxRouter` sees the real request, so "the model was told about
// the question" is measured rather than assumed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type Conversation,
	type ConversationId,
	type Harness,
	type InputSubmissionDraft,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../src/agent/contracts/documents.ts";
import { composeModelResolution, openQuestionIds, validateClarificationState } from "../src/agent/contracts/clarification.ts";
import { MainServiceDoc } from "../src/agent/main/service-doc.ts";
import { derivedRequestId, deriveQuestionId, stableSlug } from "../src/agent/main/request-id.ts";
import { openMainService, type SubmitOutcome } from "../src/service/main-service.ts";

/** A stand-in for whatever the model would do when it is not asking a question. */
const answerTool = defineTool({
	name: "answer_directly",
	description: "Answer the user without delegating.",
	parameters: Type.Object({ text: Type.String() }),
	replay: "safe",
	execute: async (args) => ({ output: [{ type: "text", text: args.text }] }),
});

const MARKER = "CLARIFY-MARKER-3B7E";

/** Flatten the messages of a provider request into one searchable string. */
function flatten(messages: readonly unknown[]): string {
	return messages
		.map((message) => {
			const record = message as { content?: unknown; sections?: Record<string, string | null> };
			// A system message carries prompt sections in a `sections` field beside
			// `content`, and the provider renders those sections into the text it sends,
			// so a helper that reads only `content` reports a rendered section as
			// absent. Both halves belong in "what the provider actually received".
			const sections = Object.values(record.sections ?? {})
				.filter((value): value is string => typeof value === "string")
				.join("\n");
			const content = record.content;
			if (typeof content === "string") return `${content}\n${sections}`;
			if (!Array.isArray(content)) return sections;
			return [
				content
					.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
					.join("\n"),
				sections,
			].join("\n");
		})
		.join("\n");
}

/**
 * The restoration section of a request, folded the way the prompt replays it: a
 * later system message's value replaces an earlier one, `null` removes it.
 *
 * Needed in addition to `flatten` because a request carries the whole transcript,
 * so the previous request's *words* are in it as ordinary user content. Only the
 * section says which requirement the prompt claims to be serving.
 */
function restorationOf(messages: readonly unknown[]): string {
	let shown: string | null = null;
	for (const message of messages) {
		const sections = (message as { sections?: Record<string, string | null> }).sections;
		if (sections === undefined || !("main-restoration" in sections)) continue;
		shown = sections["main-restoration"] ?? null;
	}
	return shown ?? "";
}

/**
 * A Harness whose conversations park *after* a real `submit` resolves.
 *
 * The identity/content window is not reachable by racing threads, and clearing the
 * link by hand afterwards is a *different* state: by then the service has already
 * written the input's queue record and, with it, the input's text. This seam opens
 * the window where it actually exists — `handle.submit` has returned, so the
 * Harness holds a runnable input, while the service's own commit recording what
 * that input *says* has not run yet. `onSubmitted` is awaited between the two.
 *
 * Every other member is forwarded bound to the real object: the Harness and its
 * conversations carry private state, and a method invoked on the proxy receiver
 * throws on its first private-field read.
 */
function harnessParkingSubmits(harness: Harness, onSubmitted: () => Promise<void>): Harness {
	const park = (conversation: Conversation): Conversation =>
		new Proxy(conversation, {
			get(target, property) {
				if (property === "submit") {
					return async (draft: InputSubmissionDraft, ctx: Context) => {
						const submission = await target.submit(draft, ctx);
						await onSubmitted();
						return submission;
					};
				}
				const value = Reflect.get(target, property, target) as unknown;
				return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
			},
		}) as Conversation;
	return new Proxy(harness, {
		get(target, property) {
			if (property === "conversation") {
				return async (id: ConversationId, ctx: Context) => {
					const conversation = await target.conversation(id, ctx);
					return conversation === undefined ? undefined : park(conversation);
				};
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		},
	}) as Harness;
}

/**
 * Drive one queued input through that window.
 *
 * Order: the first round is parked at the provider, the second input is submitted
 * and parked inside `handle.submit` — after the Harness admitted it and before the
 * service recorded anything about what it says — the first round is released so
 * the round boundary places the second input and starts its run, and only once
 * that run has finished is the parked call allowed to return.
 */
async function driveSubmitWindow(options: {
	readonly databasePath: string;
	readonly router: FauxResponseFactory;
	readonly first: { readonly text: string; readonly requestId: string };
	readonly queued: { readonly text: string; readonly requestId: string; readonly expectedRequestVersion?: number };
	readonly assert: (input: {
		readonly runtime: ProbeRuntime;
		readonly requests: readonly (readonly unknown[])[];
		readonly outcome: SubmitOutcome;
	}) => Promise<void>;
}): Promise<void> {
	const requests: (readonly unknown[])[] = [];
	let releaseFirst: (() => void) | undefined;
	const firstParked = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let releaseQueued: (() => void) | undefined;
	const queuedParked = new Promise<void>((resolve) => {
		releaseQueued = resolve;
	});
	let reachedBarrier: (() => void) | undefined;
	const atBarrier = new Promise<void>((resolve) => {
		reachedBarrier = resolve;
	});
	let parkedFirstOnce = false;
	let parkNextSubmit = false;

	const router: FauxResponseFactory = async (request, providerOptions, state, model) => {
		requests.push(request.messages);
		if (!parkedFirstOnce) {
			parkedFirstOnce = true;
			await firstParked;
		}
		return await options.router(request, providerOptions, state, model);
	};

	const runtime = await openProbe({ databasePath: options.databasePath, provider: "faux", fauxRouter: router });
	try {
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const service = await openMainService({
			harness: harnessParkingSubmits(runtime.harness, async () => {
				if (!parkNextSubmit) return;
				reachedBarrier?.();
				await queuedParked;
			}),
			registry: runtime.registry,
			context,
			conversationId: root.id,
			dispatch: async () => [],
			now: () => 1_700_000_000_000,
		});

		const first = await service.submitUserInput({ text: options.first.text, requestId: options.first.requestId });
		if (first.kind !== "request") throw new Error(`expected the first input to start a request, got ${first.kind}`);

		// Deliberately not awaited: the call parks inside `handle.submit` until the
		// window is over, and the point of the window is that nothing it would have
		// recorded afterwards exists yet.
		parkNextSubmit = true;
		const queued = service.submitUserInput({
			text: options.queued.text,
			requestId: options.queued.requestId,
			...(options.queued.expectedRequestVersion === undefined ? {} : { expectedRequestVersion: options.queued.expectedRequestVersion }),
		});
		// The Harness now holds the input as runnable and the service has recorded
		// nothing about what it says. Releasing the first round is what lets the
		// boundary place it and start the run that has to be served from the input.
		await atBarrier;
		releaseFirst?.();
		await first.submission.wait(context);
		await runtime.harness.waitForIdle(context);
		releaseQueued?.();
		const outcome = await queued;

		await options.assert({ runtime, requests, outcome });
	} finally {
		releaseFirst?.();
		releaseQueued?.();
		await runtime.close();
	}
}

describe("TASK-005.2 clarification — a question ends the round (AC-02)", { timeout: 30_000 }, () => {

	let directory: string;
	let databasePath: string;
	/** Every request the provider actually received, in order. */
	let requests: string[];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "main-clarification-"));
		databasePath = join(directory, "main.sqlite");
		requests = [];
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	/**
	 * A router that asks a question on a request and answers plainly on anything
	 * else. It records every request, so a second turn is *observed* rather than
	 * inferred.
	 *
	 * The turn is decided by the newest user input, not by whether the transcript
	 * already holds a tool result: in one conversation a *second request* also
	 * follows a tool result, and keying on that would make it look like a follow-up
	 * to the first and never get asked about. A request carries the marker, an
	 * answer does not — and the marker is what tells the two apart.
	 */
	const askingRouter: FauxResponseFactory = (request) => {
		requests.push(flatten(request.messages));
		let newest = -1;
		for (let index = request.messages.length - 1; index >= 0; index--) {
			if (request.messages[index]!.role === "user") {
				newest = index;
				break;
			}
		}
		const isRequest = newest >= 0 && flatten([request.messages[newest]!]).includes(MARKER);
		// Once this round has produced a tool result the question has been asked;
		// asking again would loop.
		const askedThisRound = request.messages.slice(newest + 1).some((message) => message.role === "toolResult");
		if (isRequest && !askedThisRound) {
			return fauxAssistantMessage(
				[fauxToolCall("request_clarification", { question: "Which file should I use?", reason: "two files match", blockedTaskIds: [] }, { id: "ask-1" })],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage([fauxText("answered after the question")]);
	};

	/**
	 * Open a service over a fresh database, with the asking router installed.
	 *
	 * `now` and the database path are overridable so a test can open a *second*,
	 * independent conversation — the only way to exercise a derivation that must
	 * not depend on the clock, since within one conversation the active requirement
	 * short-circuits it.
	 */
	async function openAsking(
		options: { readonly databasePath?: string; readonly now?: () => number } = {},
	): Promise<{ runtime: ProbeRuntime; service: Awaited<ReturnType<typeof openMainService>> }> {
		const runtime = await openProbe({
			databasePath: options.databasePath ?? databasePath,
			provider: "faux",
			fauxRouter: askingRouter,
			extensions: [defineExtension({ name: "test-extra", tools: [answerTool] })],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const service = await openMainService({
			harness: runtime.harness,
			registry: runtime.registry,
			context,
			conversationId: root.id,
			dispatch: async () => [],
			now: options.now ?? (() => 1_700_000_000_000),
		});
		return { runtime, service };
	}

	it("records the question, ends the round, and does not continue the run", async () => {
		const { runtime, service } = await openAsking();
		try {
			const outcome = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			expect(outcome.kind).toBe("request");
			if (outcome.kind !== "request") return;
			const settled = await outcome.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The run settled `done`: the question ended it rather than leaving it open.
			expect(settled.status).toBe("done");
			// Exactly one provider request: the round ended, and no second turn ran.
			expect(requests).toHaveLength(1);

			// The question is persisted, and it is open: the model asked, nobody answered.
			const view = await service.readRequest();
			expect(view.openQuestionIds).toHaveLength(1);
			expect(view.questions[0]?.question).toBe("Which file should I use?");
			expect(view.questions[0]?.blockingScope).toEqual([]);
			expect(view.questions[0]?.askedAt).toBe(1_700_000_000_000);
		} finally {
			await runtime.close();
		}
	});

	it("derives the question id from the request and the program's round count, not the clock", async () => {
		// Pure: the same request, round and question always produce the same id, so a
		// replay after an interruption resumes the same question instead of asking
		// twice.
		expect(deriveQuestionId("req-1", 1, "Which file?")).toBe(deriveQuestionId("req-1", 1, "Which file?"));
		expect(deriveQuestionId("req-1", 1, "Which file?")).not.toBe(deriveQuestionId("req-1", 2, "Which file?"));
		// Two requests that ask the same words get different questions. A question id
		// scoped only by its text would collide across requests on one conversation,
		// and the second request's answer would dedup against the first.
		expect(deriveQuestionId("req-a", 1, "Which file?")).not.toBe(deriveQuestionId("req-b", 1, "Which file?"));
		// Two long questions that share an opening still get distinct ids.
		const a = deriveQuestionId("req-1", 1, "Which of the two candidate files should I read first, given the size?");
		const b = deriveQuestionId("req-1", 1, "Which of the two candidate files should I read first, given the age?");
		expect(a).not.toBe(b);
		expect(stableSlug("Which file?")).toMatch(/^which-file-[0-9a-f]{8}$/);
	});

	it("derives an unnamed requirement's id from its words, not the clock, so a retry cannot fork it (AC-04)", async () => {
		// `requestId` is optional, so the service derives one when the caller does not
		// name the requirement. A clock-derived id — the shape this replaced — made the
		// same logical input a *different* submission on a retry after an interruption:
		// a second requirement with its own document and its own plan index, instead of
		// the replay the Harness's dedup key exists to catch.
		expect(derivedRequestId("count the markers in report.txt")).toBe(derivedRequestId("count the markers in report.txt"));
		expect(derivedRequestId("count the markers in report.txt")).not.toBe(derivedRequestId("count the markers in the annex.txt"));
		// A derived id still has to be a legal id: it is embedded in question ids and
		// persisted in the clarification document.
		expect(derivedRequestId("count the markers in report.txt")).toMatch(/^req-[a-z0-9][a-z0-9._-]{0,127}$/);

		// Two independent conversations, whose clocks differ by a wide margin. The
		// identity is the same, which is what makes the retry a replay.
		const first = await openAsking();
		let one: string;
		try {
			const outcome = await first.service.submitUserInput({ text: "count the markers in report.txt" });
			if (outcome.kind !== "request") throw new Error(`expected a request, got ${outcome.kind}`);
			await outcome.submission.wait(context);
			await first.runtime.harness.waitForIdle(context);
			one = outcome.requestId;
			expect(one).toBe(derivedRequestId("count the markers in report.txt"));
		} finally {
			await first.runtime.close();
		}

		const second = await openAsking({ databasePath: join(directory, "other.sqlite"), now: () => 1_999_999_999_999 });
		try {
			const outcome = await second.service.submitUserInput({ text: "count the markers in report.txt" });
			if (outcome.kind !== "request") throw new Error(`expected a request, got ${outcome.kind}`);
			await outcome.submission.wait(context);
			await second.runtime.harness.waitForIdle(context);
			expect(outcome.requestId).toBe(one);
		} finally {
			await second.runtime.close();
		}
	});

	it("refuses a plain input while a question is open instead of reinterpreting it (AC-04)", async () => {
		const { runtime, service } = await openAsking();
		try {
			const first = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			expect(first.kind).toBe("request");
			if (first.kind !== "request") return;
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// A new plain input, with no `answerTo`, while a question is open.
			const second = await service.submitUserInput({ text: "just do it" });
			expect(second.kind).toBe("refused");
			if (second.kind !== "refused") return;
			expect(second.reason).toContain("is open");
		} finally {
			await runtime.close();
		}
	});

	it("keeps a question open when the application does not judge the answer sufficient (AC-04)", async () => {
		// The contract's rule, and the one most likely to drift: a question stops
		// blocking on a *resolution*, not on an answer. A vague reply that the
		// application does not accept must leave the question open, so the model
		// asks again instead of proceeding on it.
		const { runtime, service } = await openAsking();
		try {
			const first = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			const vague = await service.submitUserInput({ text: "not sure, you decide", answerTo: questionId, sufficient: false });
			expect(vague.kind).toBe("answer");
			if (vague.kind !== "answer") return;
			await vague.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The answer was recorded — the user did reply — but the question still
			// blocks, because nobody judged the reply sufficient.
			const stored = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-1", context);
			expect(stored?.answers).toHaveLength(1);
			expect(stored?.answers[0]?.sufficient).toBe(false);
			expect(openQuestionIds(stored!)).toEqual([questionId]);
			expect((await service.readRequest()).openQuestionIds).toEqual([questionId]);
		} finally {
			await runtime.close();
		}
	});

	it("records the answer through the application boundary and submits it into the same conversation (AC-01, AC-04)", async () => {
		const { runtime, service } = await openAsking();
		try {
			const first = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;
			requests.length = 0;

			const answer = await service.submitUserInput({ text: "Use report.txt", answerTo: questionId, sufficient: true });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") return;
			const settled = await answer.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The answer reached the model as a real request in the SAME conversation.
			// Not asserted as "exactly one request": the answer's own round is free to
			// take more than one provider turn, and what matters is that the model saw
			// the words the user typed.
			expect(requests.length).toBeGreaterThan(0);
			expect(requests.some((request) => request.includes("Use report.txt"))).toBe(true);

			// The recorded answer is application-sourced and judged sufficient, so the
			// question no longer blocks.
			const stored = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-1", context);
			expect(stored?.answers).toHaveLength(1);
			expect(stored?.answers[0]?.source).toBe("application");
			expect(stored?.answers[0]?.sufficient).toBe(true);
			expect(openQuestionIds(stored!)).toEqual([]);
			expect(settled.status).toBe("done");

			// Every entry the answer produced is in the main conversation, not a child:
			// AC-01's "同主 Conversation".
			const entries = await (await runtime.harness.conversation(1 as never, context))!.entries({ order: "ascending" }, 200, undefined, context);
			expect(entries.items.every((entry) => entry.conversationId === 1)).toBe(true);
			expect(entries.items.some((entry) => entry.kind === "pi.user")).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("keeps a question open across a close and reopen, so a restart can still answer it (AC-01)", async () => {
		const first = await openAsking();
		let questionId: string;
		try {
			const outcome = await first.service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (outcome.kind !== "request") throw new Error("expected a request");
			await outcome.submission.wait(context);
			await first.runtime.harness.waitForIdle(context);
			questionId = (await first.service.readRequest()).openQuestionIds[0]!;
		} finally {
			await first.runtime.close();
		}

		// Reopen the same database in a new process-shaped runtime.
		const second = await openAsking();
		try {
			const view = await second.service.readRequest();
			// The pointer survived, and the question is still open.
			expect(view.requestId).toBe("req-1");
			expect(view.openQuestionIds).toEqual([questionId]);
			// And it can still be answered — and the answer actually reaches the model.
			// Asserting only that `submit` returned an answer would not show that the
			// reopened conversation delivered it: the submission has to settle and the
			// provider has to receive the words.
			requests.length = 0;
			const answer = await second.service.submitUserInput({ text: "Use report.txt", answerTo: questionId, sufficient: true });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") return;
			await answer.submission.wait(context);
			await second.runtime.harness.waitForIdle(context);
			expect(requests.some((text) => text.includes("Use report.txt"))).toBe(true);
			expect((await second.service.readRequest()).openQuestionIds).toEqual([]);
		} finally {
			await second.runtime.close();
		}
	});

	it("refuses a model resolution that names an input entry the program never persisted (AC-04)", async () => {
		const { runtime, service } = await openAsking();
		try {
			const outcome = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (outcome.kind !== "request") throw new Error("expected a request");
			await outcome.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			// A model claiming the original input already covers the question, with an
			// entry id the program never persisted, is refused — the claim is not a
			// reference. The grounding here is what the program actually holds.
			const forged = composeModelResolution(
				{ questionId, basis: { kind: "original_input", inputEntryId: "999999", detail: "the input covers it" } },
				{ at: 1 },
				{ requestId: "req-1", originalInputEntryIds: [], recordedAnswers: [] },
			);
			expect(forged.ok).toBe(false);
			if (forged.ok) return;
			expect(forged.violations.some((violation) => violation.code === "resolution_original_input_unbound")).toBe(true);

			// The question is still open: a refused resolution changes nothing.
			expect((await service.readRequest()).openQuestionIds).toEqual([questionId]);
		} finally {
			await runtime.close();
		}
	});

	it("keeps status and cancel responsive while a round is running (AC-05)", async () => {
		// A router that parks the first request until the test releases it, so the
		// conversation is genuinely busy while `status()` is called.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const parkingRouter: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: parkingRouter });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const outcome = await service.submitUserInput({ text: `${MARKER} go`, requestId: "req-busy" });
			if (outcome.kind !== "request") throw new Error("expected a request");

			// The round is parked inside the provider. A control call must still answer.
			const status = await service.status();
			expect(status.busy).toBe(true);

			// Cancel is also responsive: it persists the intent and aborts without
			// waiting for the parked round to finish.
			const cancelled = await service.requestCancel("test cancel");
			expect(cancelled.requested).toBe(true);
			const intent = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(intent?.cancelRequested?.reason).toBe("test cancel");

			release?.();
			await outcome.submission.wait(context);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("queues an ordinary input submitted while a round is running, and says so (AC-05)", async () => {
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const parkingRouter: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: parkingRouter });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER} go`, requestId: "req-busy" });
			if (first.kind !== "request") throw new Error("expected a request");

			// A second ordinary input while the round runs is queued, not refused and
			// not silently treated as a fresh task.
			const second = await service.submitUserInput({ text: "a follow-up" });
			expect(second.kind).toBe("queued");
			if (second.kind !== "queued") return;
			expect(second.reason).toContain("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("records the request document with its business version (AC-01)", async () => {
		const { runtime, service } = await openAsking();
		try {
			const outcome = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (outcome.kind !== "request") throw new Error("expected a request");
			expect(outcome.requestVersion).toBe(1);
			await outcome.submission.wait(context);

			const stored = await runtime.harness.snapshot(AgentRequestDoc, 1 as never, "req-1", context);
			expect(stored?.text).toBe(`${MARKER} please count`);
			expect(stored?.requestVersion).toBe(1);

			// A restatement of the same request id bumps the business version. The
			// question the first turn asked is still open, so it is answered first:
			// otherwise the restatement is refused, which the next test covers.
			const questionId = (await service.readRequest()).openQuestionIds[0]!;
			const answered = await service.submitUserInput({ text: "report.txt", answerTo: questionId, sufficient: true });
			expect(answered.kind).toBe("answer");
			if (answered.kind !== "answer") return;
			await answered.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The restatement must reach the model as a real request. The Harness
			// deduplicates submissions by requestId, so an id keyed on the request
			// alone would make this settle as a replay of version 1 and the model
			// would never see the new words — a restatement that silently does
			// nothing. Asserting the provider *received* the text is what catches it.
			requests.length = 0;
			const again = await service.submitUserInput({ text: `${MARKER} count again`, requestId: "req-1", expectedRequestVersion: 1 });
			expect(again.kind).toBe("request");
			if (again.kind !== "request") return;
			expect(again.requestVersion).toBe(2);
			await again.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect(requests.length).toBeGreaterThan(0);
			expect(requests.some((request) => request.includes(`${MARKER} count again`))).toBe(true);

			// And the stored request is the restated one, at version 2.
			const restated = await runtime.harness.snapshot(AgentRequestDoc, 1 as never, "req-1", context);
			expect(restated?.requestVersion).toBe(2);
			expect(restated?.text).toBe(`${MARKER} count again`);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a restatement whose expected version is stale (AC-04)", async () => {
		const { runtime, service } = await openAsking();
		try {
			const first = await service.submitUserInput({ text: `${MARKER} v1`, requestId: "req-1" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			// Settle the question first, so the refusal below is about the version and
			// not about the open clarification.
			const questionId = (await service.readRequest()).openQuestionIds[0]!;
			const answered = await service.submitUserInput({ text: "report.txt", answerTo: questionId, sufficient: true });
			if (answered.kind !== "answer") throw new Error("expected an answer");
			await answered.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			const stale = await service.submitUserInput({ text: `${MARKER} v-stale`, requestId: "req-1", expectedRequestVersion: 99 });
			expect(stale.kind).toBe("refused");
			if (stale.kind !== "refused") return;
			expect(stale.reason).toContain("stale request version");
		} finally {
			await runtime.close();
		}
	});

	it("treats a requirement that was never written as version 1 for the version precondition (AC-04)", async () => {
		// `expectedRequestVersion` is a precondition on the version the requirement is
		// at, and "nothing recorded yet" is one of the versions it can be at — not a
		// missing comparison. Treating it as missing lets a caller whose premise could
		// never have been observed have it silently ignored, and a request created on
		// top of that. All three shapes are checked here: absent, matching, mismatching.
		const router: FauxResponseFactory = () => fauxAssistantMessage([fauxText("done")]);

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			// Absent: no precondition at all, so the request is created.
			const absent = await service.submitUserInput({ text: `${MARKER} first`, requestId: "req-x" });
			expect(absent.kind).toBe("request");
			if (absent.kind !== "request") return;
			await absent.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// Mismatching on a requirement that was never written: the basis is 1, so a
			// caller expecting 99 is refused — and the refusal writes nothing, leaving the
			// requirement exactly as absent as it was.
			const wrong = await service.submitUserInput({ text: `${MARKER} other`, requestId: "req-never", expectedRequestVersion: 99 });
			expect(wrong.kind).toBe("refused");
			if (wrong.kind !== "refused") return;
			expect(wrong.reason).toContain("stale request version");
			expect(wrong.reason).toContain("stored none");
			const never = await runtime.harness.snapshot(AgentRequestDoc, 1 as never, "req-never", context);
			expect(never?.requestedAt ?? 0).toBe(0);
			expect(never?.text ?? "").toBe("");
			expect((await service.readRequest()).requestId).toBe("req-x");

			// Matching on a requirement that was never written: 1 is the version it is at.
			const matching = await service.submitUserInput({ text: `${MARKER} second`, requestId: "req-y", expectedRequestVersion: 1 });
			expect(matching.kind).toBe("request");
			if (matching.kind !== "request") return;
			expect(matching.requestVersion).toBe(1);
			await matching.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// And matching on a requirement that *has* been written: it is at v1, so the
			// restatement is accepted and moves it to v2.
			const restated = await service.submitUserInput({ text: `${MARKER} second, restated`, requestId: "req-y", expectedRequestVersion: 1 });
			expect(restated.kind).toBe("request");
			if (restated.kind !== "request") return;
			expect(restated.requestVersion).toBe(2);
			await restated.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The same basis a second time is now stale: the requirement moved under it.
			const late = await service.submitUserInput({ text: `${MARKER} second, again`, requestId: "req-y", expectedRequestVersion: 1 });
			expect(late.kind).toBe("refused");
			if (late.kind !== "refused") return;
			expect(late.reason).toContain("stored 2");
		} finally {
			await runtime.close();
		}
	});

	it("refuses an answer with no sufficiency judgement, and leaves the question open (AC-02, AC-04)", async () => {
		// There is no default. "The user replied" is not "the reply is sufficient"
		// (contract §"Main Agent 合同"), so an input that answers without a judgement
		// is refused rather than treated as settled. Omitting the judgement used to
		// default to `true`, which unblocked work on a vague reply.
		const { runtime, service } = await openAsking();
		try {
			const first = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			const vague = await service.submitUserInput({ text: "I do not know which file", answerTo: questionId });
			expect(vague.kind).toBe("refused");
			if (vague.kind !== "refused") return;
			expect(vague.reason).toContain("sufficiency judgement");

			// Nothing was recorded and the question still blocks.
			const stored = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-1", context);
			expect(stored?.answers).toHaveLength(0);
			expect(openQuestionIds(stored!)).toEqual([questionId]);
		} finally {
			await runtime.close();
		}
	});

	it("accepts a follow-up answer after an insufficient one and unblocks once sufficient (AC-01, AC-02)", async () => {
		// The insufficient→sufficient chain, end to end: the first reply is recorded
		// but does not resolve the question, and the follow-up REPLACES it (the
		// contract holds exactly one answer per question — a duplicate is a
		// validation failure) and finally resolves it.
		const { runtime, service } = await openAsking();
		try {
			const first = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-1" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			const vague = await service.submitUserInput({ text: "not sure, you decide", answerTo: questionId, sufficient: false });
			expect(vague.kind).toBe("answer");
			if (vague.kind !== "answer") throw new Error("expected an answer");
			await vague.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect((await service.readRequest()).openQuestionIds).toEqual([questionId]);

			// Re-submitting the *same logical answer* while the question is still open
			// is a replay, not a new input: the attempt count does not grow, and the
			// submission key is unchanged so the Harness dedups it rather than the model
			// being asked to consider the same vague reply twice.
			requests.length = 0;
			const repeated = await service.submitUserInput({ text: "not sure, you decide", answerTo: questionId, sufficient: false });
			expect(repeated.kind).toBe("answer");
			if (repeated.kind !== "answer") throw new Error("expected an answer");
			await repeated.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect(requests).toHaveLength(0);
			expect((await runtime.harness.snapshot(MainServiceDoc, 1 as never, context))?.answerAttempts).toHaveLength(1);

			// The follow-up must reach the model as its own input, not a replay of the
			// first answer.
			requests.length = 0;
			const precise = await service.submitUserInput({ text: "Use report.txt", answerTo: questionId, sufficient: true });
			expect(precise.kind).toBe("answer");
			if (precise.kind !== "answer") throw new Error("expected an answer");
			await precise.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			expect(requests.some((request) => request.includes("Use report.txt"))).toBe(true);
			expect((await service.readRequest()).openQuestionIds).toEqual([]);

			// Exactly one stored answer (the sufficient one), and both attempts are
			// kept in the service's own log rather than silently discarded.
			const stored = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-1", context);
			expect(stored?.answers).toHaveLength(1);
			expect(stored?.answers[0]?.text).toBe("Use report.txt");
			expect(stored?.answers[0]?.sufficient).toBe(true);
			expect(validateClarificationState(stored!).ok).toBe(true);
			const service2 = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(service2?.answerAttempts.map((attempt) => attempt.text)).toEqual(["not sure, you decide", "Use report.txt"]);
		} finally {
			await runtime.close();
		}
	});

	it("keeps two requests with the same question from colliding on one answer (AC-01, AC-04)", async () => {
		// Two requests whose first question is word-for-word identical. The question
		// id and the answer key are both derived per request, so answering the second
		// one cannot dedup against the first — and it must actually reach the model.
		const { runtime, service } = await openAsking();
		try {
			// Request A asks, and A's question is answered so A is closed out. The
			// service refuses a plain input while a question is open (AC-04's "a new
			// input is not silently reinterpreted"), so A is settled first.
			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionA = (await service.readRequest()).openQuestionIds[0]!;
			expect(questionA).toContain("req-a");
			const answeredA = await service.submitUserInput({ text: "report.txt", answerTo: questionA, sufficient: true });
			if (answeredA.kind !== "answer") throw new Error("expected an answer");
			await answeredA.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// Request B, whose model asks the exact same words as A's did. Two
			// requests, two questions, one conversation.
			const second = await service.submitUserInput({ text: `${MARKER} second request`, requestId: "req-b" });
			if (second.kind !== "request") throw new Error("expected a request");
			await second.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionB = (await service.readRequest()).openQuestionIds[0]!;
			expect(questionB).not.toBe(questionA);
			expect(questionB).toContain("req-b");

			// Answering B's question must reach the model. An answer key scoped only by
			// the question text would collide with A's answered question and be
			// deduplicated away — the model would never hear the reply.
			requests.length = 0;
			const answer = await service.submitUserInput({ text: "Use report.txt", answerTo: questionB, sufficient: true });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") throw new Error("expected an answer");
			await answer.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect(requests.some((request) => request.includes("Use report.txt"))).toBe(true);

			// The answer landed on request B's document, and A's is untouched.
			const b = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-b", context);
			expect(b?.answers.map((entry) => entry.questionId)).toEqual([questionB]);
			expect(openQuestionIds(b!)).toEqual([]);
			const a = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-a", context);
			expect(a?.answers).toHaveLength(1);
			expect(openQuestionIds(a!)).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it("asks a resolved question's words again as a new, answerable question (AC-02, AC-04)", async () => {
		// The contract holds one answer per question, and a question is closed once it
		// has one. So the *same words* are two different questions depending on when
		// they are asked: while the first is still open a repeat is that same question,
		// and once it has been resolved the repeat is a new one. Reusing the resolved
		// id would make the ask and the answer disagree about what is being answered —
		// the model would name a question the service has closed, and the user's reply
		// to it would be refused as "question ... is not open".
		//
		// Both halves are asserted: the id is new, and the new question can actually be
		// answered and reach the model.
		let asked = 0;
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			let newest = -1;
			for (let index = request.messages.length - 1; index >= 0; index--) {
				if (request.messages[index]!.role === "user") {
					newest = index;
					break;
				}
			}
			const askedThisRound = request.messages.slice(newest + 1).some((message) => message.role === "toolResult");
			// The first turn of each of the first two runs asks the identical words.
			if (asked < 2 && !askedThisRound) {
				asked += 1;
				return fauxAssistantMessage(
					[fauxToolCall("request_clarification", { question: "Which file should I use?", reason: "two files match", blockedTaskIds: [] }, { id: `ask-${asked}` })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([fauxText("nothing more to ask")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} please count`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const firstQuestion = (await service.readRequest()).openQuestionIds[0]!;

			// Answering it sufficiently resolves it, which is what makes the next ask a
			// different question rather than a repeat.
			const answered = await service.submitUserInput({ text: "Use report.txt", answerTo: firstQuestion, sufficient: true });
			if (answered.kind !== "answer") throw new Error("expected an answer");
			await answered.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			const doc = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-a", context);
			const questions = doc?.questions ?? [];
			expect(questions).toHaveLength(2);
			// The same words, asked twice, as two questions.
			expect(questions[0]!.question).toBe(questions[1]!.question);
			expect(questions[1]!.questionId).not.toBe(questions[0]!.questionId);
			// The resolution stayed with the first question, and only the second is open.
			expect((await service.readRequest()).openQuestionIds).toEqual([questions[1]!.questionId]);

			// And the new question is answerable: the reply is accepted, and it reaches
			// the model rather than being deduplicated against the answered first one.
			requests.length = 0;
			const second = await service.submitUserInput({ text: "Use the second file", answerTo: questions[1]!.questionId, sufficient: true });
			expect(second.kind).toBe("answer");
			if (second.kind !== "answer") return;
			await second.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect(requests.some((said) => said.includes("Use the second file"))).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("queues, lists and withdraws one input without disturbing another (AC-05)", async () => {
		// The queue is a persisted record, so it can be listed; and withdrawing one
		// input must not withdraw the rest. Two different requests that say the same
		// words are two inputs, so the queue is keyed on identity, not text.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const parkingRouter: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: parkingRouter });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER} go`, requestId: "req-busy" });
			if (first.kind !== "request") throw new Error("expected a request");

			// Two more inputs, different requests, identical text.
			const queuedA = await service.submitUserInput({ text: "same words", requestId: "req-q1" });
			const queuedB = await service.submitUserInput({ text: "same words", requestId: "req-q2" });
			expect(queuedA.kind).toBe("queued");
			expect(queuedB.kind).toBe("queued");
			if (queuedA.kind !== "queued" || queuedB.kind !== "queued") return;

			// Both are listed, and they are two distinct records.
			const queue = await service.readQueue();
			expect(queue).toHaveLength(2);
			expect(new Set(queue.map((entry) => entry.requestId))).toEqual(new Set(["req-q1", "req-q2"]));

			// Withdraw one. The other survives.
			const withdrawn = await service.withdrawQueued(queue[0]!.submissionId);
			expect(withdrawn.withdrawn).toBe(true);
			expect(await service.readQueue()).toHaveLength(1);
			expect((await service.readQueue())[0]!.requestId).toBe("req-q2");

			// The consume boundary: once the round that was running settles, the
			// Harness places the surviving input and the queue must stop reporting it.
			// Without reconciliation the list only ever grew, and a caller could try to
			// withdraw an input that had already been consumed.
			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect(await service.readQueue()).toHaveLength(0);

			// Consuming is not just "left the queue": the surviving input's own
			// requirement identity is applied to the request document and the active
			// pointer, so the service serves the queued restatement rather than the
			// request that happened to be running when it was admitted.
			const view = await service.readRequest();
			expect(view.requestId).toBe("req-q2");
			expect(view.text).toBe("same words");
			// And withdrawing a consumed input is refused, not reported as a withdrawal.
			const late = await service.withdrawQueued(queue[1]!.submissionId);
			expect(late.withdrawn).toBe(false);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("does not apply a queued restatement whose version basis went stale while it waited (AC-04)", async () => {
		// A queued input carries the version its caller's decision was made against.
		// If the requirement moves on while the input waits, applying it would
		// complete a new goal on a stale basis — so the consume boundary re-checks
		// and drops it, leaving the active requirement where it was.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const parkingRouter: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: parkingRouter });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER} go`, requestId: "req-busy" });
			if (first.kind !== "request") throw new Error("expected a request");

			// Queued against a basis that is already stale: the requirement is at v1.
			const stale = await service.submitUserInput({ text: "restated", requestId: "req-busy", expectedRequestVersion: 99 });
			expect(stale.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			await service.readQueue();

			// The stale restatement was admitted to the queue but is not applied: the
			// active requirement is unchanged, and the text did not become the request.
			const view = await service.readRequest();
			expect(view.requestId).toBe("req-busy");
			expect(view.text).toBe(`${MARKER} go`);
			expect(view.requestVersion).toBe(1);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("binds a queued input's identity to the run it starts, before any tool in that run (AC-01, AC-03)", async () => {
		// The reviewer's ordering point: the Harness places a queued input and starts
		// a run for it, and the service's pointer is only written on a later read. If a
		// tool resolved the requirement from the pointer, the run's plan and dispatch
		// would carry the *previous* request's identity. The run resolves the
		// requirement from its own input instead, so the plan it saves names the queued
		// request even though nothing has read the queue yet.
		const requests: string[] = [];
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			// The run for the queued input saves a plan; the earlier run just answers.
			const said = requests[requests.length - 1] ?? "";
			if (said.includes("second request")) {
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-b", goals: ["B"], taskIds: ["t1"] }, { id: "b1" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			// A second request arrives while the first run is parked: it is queued.
			const queued = await service.submitUserInput({ text: `${MARKER} second request`, requestId: "req-b" });
			expect(queued.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The plan the queued run saved is bound to req-b, not to req-a — without
			// anyone having read the queue first.
			const doc = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-b", context);
			expect(doc?.requestId).toBe("req-b");
			expect(doc?.goals).toEqual(["B"]);
		} finally {
			release?.();
			await runtime.close();
		}
	});
	it("sends a queued run's own requirement in its first provider request, not the previous one's (AC-01, AC-03)", async () => {
		// The reviewer's prompt point, and the reason a section alone is not enough.
		// The restoration section is rendered in the `prepare` phase, and the service
		// only consumes a queued input at the request boundary — so the run that starts
		// for a restatement prepares while the pointer still names the requirement of
		// the round before it, and its *first* provider request would carry that
		// requirement's text, materials, questions and plans. Correcting the pointer
		// afterwards cannot fix a prompt that is already built, so the service rewrites
		// the section in the messages the attempt is about to send.
		//
		// The assertion is on the request the provider actually received, and on the
		// section rather than the whole transcript: the previous request's *words* are
		// in the transcript as ordinary user content and are supposed to be there. What
		// must not be there is a restoration that names the wrong requirement.
		const requests: (readonly unknown[])[] = [];
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async (request) => {
			requests.push(request.messages);
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const queued = await service.submitUserInput({ text: `${MARKER} second request`, requestId: "req-b" });
			expect(queued.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The run the queue produced: the first request whose restoration names req-b.
			const index = requests.findIndex((messages) => restorationOf(messages).includes("Request req-b"));
			expect(index).toBeGreaterThanOrEqual(0);
			const section = restorationOf(requests[index]!);

			// Its own requirement, at its own version, with its own words — and no trace
			// of the requirement the pointer still named while this prompt was prepared.
			expect(section).toContain("Request req-b v1");
			expect(section).toContain(`${MARKER} second request`);
			expect(section).not.toContain("req-a");
			expect(section).not.toContain(`${MARKER} first request`);

			// And the section is in the *leading* system message, which is the only
			// placement every provider renders: a trailing system message is an update
			// for APIs that accept mid-conversation system messages and is folded away
			// by the rest.
			const leading = requests[index]![0] as { role?: string; sections?: Record<string, string | null> };
			expect(leading.role).toBe("system");
			expect(leading.sections?.["main-restoration"]).toContain("Request req-b v1");

			// The first run's own request is unchanged in kind: it names req-a, because
			// that is the requirement it was admitted for.
			expect(restorationOf(requests[0]!)).toContain("Request req-a v1");
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("resolves a queued run's requirement from its own input while its admission is still unlinked (AC-01, AC-03)", async () => {
		// The placement window, made deterministic. `handle.submit` returns before the
		// service's own link commit lands, and the Harness may place the input and start
		// its run in between — so a live run can have an input whose admission names no
		// submission. Resolving from the admission list alone finds nothing there, and
		// falling back to the pointer would hand that run the *previous* requirement.
		// The submission carries the key the placement was written under, so the
		// identity is recovered from the run's own input rather than guessed.
		//
		// The window is opened here by clearing the link the service wrote, because
		// racing a thread through the real gap cannot be made deterministic. The link is
		// asserted gone before the run starts, so a test that passes did so through the
		// recovery path and not through the field it just cleared.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		let askedOnce = false;
		const requests: string[] = [];
		const router: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			// Asked once: a refused `save_plan` does not end the round the way a saved one
			// does, so an unguarded script would call it again on every subsequent request
			// and never reach a stop reason.
			if (!askedOnce && (requests[requests.length - 1] ?? "").includes("second request")) {
				askedOnce = true;
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-b", goals: ["B"], taskIds: ["t1"] }, { id: "b1" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const queued = await service.submitUserInput({ text: `${MARKER} second request`, requestId: "req-b" });
			expect(queued.kind).toBe("queued");

			// Open the window: the identity is placed and the submission is admitted, but
			// the run that starts for it will find no admission naming its submission.
			await runtime.harness.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, 1 as never);
				doc.admissions = doc.admissions.map((admission) => {
					if (admission.requestId !== "req-b") return admission;
					// Dropped rather than set to `undefined`: the document is JSON, and an
					// explicit `undefined` is not a value it can hold.
					const { submissionId: _unlinked, ...rest } = admission;
					return rest;
				});
			}, context);
			const unlinked = (await runtime.harness.snapshot(MainServiceDoc, 1 as never, context))?.admissions ?? [];
			expect(unlinked.find((admission) => admission.requestId === "req-b")?.submissionId).toBeUndefined();

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The plan the queued run saved names req-b, so the run resolved its own
			// requirement through the recovery rather than falling back to req-a.
			const saved = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-b", context);
			expect(saved?.requestId).toBe("req-b");
			expect(saved?.goals).toEqual(["B"]);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("refuses a queued run that resolves no requirement of its own instead of serving the previous one (AC-01, AC-04)", async () => {
		// The other half of the same rule. A queued restatement whose version basis went
		// stale while it waited is placed in the transcript — nothing can un-place it —
		// but it is denied an identity. Its run must then refuse, not fall through to the
		// pointer: the pointer still names the requirement the round before it was
		// serving, and a tool acting under that identity would write the *old* goal's
		// plan for a run the user had already restated.
		//
		// The refusal is asserted where it matters — on the text the provider was
		// actually handed after the tool ran — and again on the durable fact that no plan
		// was written under req-a's name.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		let askedOnce = false;
		const requests: string[] = [];
		const router: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			if (!askedOnce && (requests[requests.length - 1] ?? "").includes("stale restatement")) {
				askedOnce = true;
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-stale", goals: ["g"], taskIds: ["t1"] }, { id: "s1" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			// Queued against a basis that is already stale: the requirement is at v1.
			const stale = await service.submitUserInput({ text: "stale restatement", requestId: "req-a", expectedRequestVersion: 99 });
			expect(stale.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The tool ran and refused; the provider was told so, in the run that was
			// denied the identity.
			expect(requests.some((said) => said.includes("save_plan refused: no active request is recorded"))).toBe(true);

			// And durably: nothing was written under the previous requirement's name.
			const saved = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-stale", context);
			expect(saved?.requestId ?? "").not.toBe("req-a");
			expect(saved?.goals ?? []).toEqual([]);

			// The requirement itself did not move: the stale input never became it.
			const view = await service.readRequest();
			expect(view.text).toBe(`${MARKER} first request`);
			expect(view.requestVersion).toBe(1);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("refuses a run whose input carries no requirement of this service's, rather than serving the previous one (AC-01, AC-04)", async () => {
		// The fail-closed half of the identity rule, and the one a pointer fallback
		// gets wrong. A run can be live whose inputs name no requirement *this service*
		// admitted — an input placed by another writer, or one replayed after a
		// restart. The pointer still names whatever the round before it was serving, so
		// falling back to it lets that run save a plan and dispatch work under a
		// requirement it was never admitted for. Refusing is the only safe answer, and
		// the refusal is asserted where it lands: on the text the provider was handed,
		// and on the requirement document that was not written.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		let askedOnce = false;
		const requests: string[] = [];
		const router: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			if (!askedOnce && (requests[requests.length - 1] ?? "").includes("foreign input")) {
				askedOnce = true;
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-f", goals: ["g"], taskIds: ["t1"] }, { id: "f1" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			// Submitted straight to the Harness, the way another writer would: the
			// service never placed an identity for it, so its run has none to resolve.
			await root.submit({ type: "input", content: `${MARKER} foreign input`, requestId: "req-foreign" }, context);

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			expect(requests.some((said) => said.includes("save_plan refused: no active request is recorded"))).toBe(true);
			const saved = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-f", context);
			expect(saved?.version ?? 0).toBe(0);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("activates a consumed queued input at its run's boundary, without a queue read (AC-01, AC-03)", async () => {
		// The consumption boundary is the run, not a query. A queued input is placed
		// and its run started by the Harness before any service call observes the
		// queue, so activating it only when a caller happens to read the queue leaves
		// the requirement pointing at the previous request for that whole run — the
		// restoration section would present the old request, and readRequest would
		// report it too. The service reconciles on every generation attempt, so the
		// input is active as its run begins, with nothing having read the queue.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async () => {
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER} first request`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const queued = await service.submitUserInput({ text: `${MARKER} second request`, requestId: "req-b" });
			expect(queued.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// No readQueue() call anywhere in this test: the activation came from the
			// boundary, not from a query.
			const view = await service.readRequest();
			expect(view.requestId).toBe("req-b");
			expect(view.text).toBe(`${MARKER} second request`);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("does not activate a queued input that was cancelled rather than placed (AC-01, AC-04)", async () => {
		// `requestCancel` aborts the conversation, which withdraws every queued input:
		// the Harness settles it `unanswered` and drops it from the inbox, so it leaves
		// the queue without ever being placed. Treating that as consumption would write
		// a cancelled requirement's text and identity into the active request. Only a
		// placed input — one the transcript actually received — may be activated.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async () => {
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER} keep me`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const queued = await service.submitUserInput({ text: `${MARKER} cancelled`, requestId: "req-b" });
			expect(queued.kind).toBe("queued");

			// Cancel while the round is parked: the queued input is withdrawn, not placed.
			const cancelPromise = service.requestCancel("changed my mind");
			release?.();
			await cancelPromise;
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			const view = await service.readRequest();
			expect(view.requestId).toBe("req-a");
			expect(view.text).toBe(`${MARKER} keep me`);
			// And the queue no longer reports it: it was withdrawn, not consumed.
			expect(await service.readQueue()).toHaveLength(0);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("records one queue entry when the same input is submitted twice (AC-05)", async () => {
		// A retry of the same logical input derives the same submission key, and the
		// Harness answers it with the same submission id. Appending a second record
		// would make one input look like two, and consuming it would apply it twice.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async () => {
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER} busy`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const once = await service.submitUserInput({ text: "same words", requestId: "req-b" });
			const twice = await service.submitUserInput({ text: "same words", requestId: "req-b" });
			expect(once.kind).toBe("queued");
			expect(twice.kind).toBe("queued");
			if (once.kind !== "queued" || twice.kind !== "queued") return;
			// The Harness deduplicated the submission; the queue record follows it.
			expect(String(once.submission.id)).toBe(String(twice.submission.id));
			const queue = await service.readQueue();
			expect(queue).toHaveLength(1);
			expect(queue[0]?.submissionId).toBe(String(once.submission.id));
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("allocates a queued retry's version once, so consuming it moves the requirement once (AC-05, AC-01)", async () => {
		// The consequence of the record above, and the reason the allocation lives in
		// the admission rather than being derived at consume time. A retry is the same
		// logical input — the same requirement and the same words — so it derives the
		// same key and the Harness answers it with the same submission. Reserving a
		// version per *call* would count the retry as a second queued input and allocate
		// the version after it, while the admission the run resolves from keeps the
		// first: the input's identity would be split across two versions, and the
		// requirement would end at a version no run and no plan ever saw.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		let askedOnce = false;
		const requests: string[] = [];
		const router: FauxResponseFactory = async (request) => {
			requests.push(flatten(request.messages));
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			if (!askedOnce && (requests[requests.length - 1] ?? "").includes("restated words")) {
				askedOnce = true;
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-r", goals: ["g"], taskIds: ["t1"] }, { id: "r1" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} busy`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const once = await service.submitUserInput({ text: "restated words", requestId: "req-a" });
			const twice = await service.submitUserInput({ text: "restated words", requestId: "req-a" });
			expect(once.kind).toBe("queued");
			expect(twice.kind).toBe("queued");
			if (once.kind !== "queued" || twice.kind !== "queued") return;
			expect(String(twice.submission.id)).toBe(String(once.submission.id));

			// The queue record and the admission agree on the version this input
			// *becomes*. The defect the review found was exactly a split here — the
			// record at one version, the admission the run resolves from at another — and
			// a length-1 queue does not show it, so the two are read separately.
			const record = (await service.readQueue()).find((entry) => entry.submissionId === String(once.submission.id));
			expect(record?.allocatedVersion).toBe(2);

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// One input was consumed, so the requirement moved one version — to v2, the
			// version the run resolved and the version its plan was written against.
			const view = await service.readRequest();
			expect(view.text).toBe("restated words");
			expect(view.requestVersion).toBe(2);

			const saved = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-r", context);
			expect(saved?.requestId).toBe("req-a");
			expect(saved?.requestVersion).toBe(2);

			// And the admission the run resolved from agrees with the document and the
			// plan: all three at v2, so no read point is a version out of step.
			const admissionDoc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const admission = admissionDoc?.admissions.find((entry) => entry.key.startsWith("queued:") && entry.requestId === "req-a");
			expect(admission?.requestVersion).toBe(2);
		} finally {
			release?.();
			await runtime.close();
		}
	});
	it("keeps the accepted run's requirement after its own version increment (AC-01, AC-04)", async () => {
		// A restatement queued against `expectedRequestVersion` 1 is legitimately
		// consumed, and consuming it moves the requirement to v2. Re-comparing the
		// stored v2 against the caller's original basis would then deny the very run
		// the basis was accepted for, so every remaining tool in it would refuse. The
		// outcome of the check is recorded rather than re-derived.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async (request) => {
			const text = flatten(request.messages);
			if (!parkedOnce) {
				// Run 1: save a plan so the requirement document exists, then park so the
				// restatement queues.
				if (!text.includes("saved plan")) {
					return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-one", goals: ["one"], taskIds: ["t1"] }, { id: "save-one" })], { stopReason: "toolUse" });
				}
				parkedOnce = true;
				await parked;
				return fauxAssistantMessage([fauxText("run 1 done")]);
			}
			// Run 2 (the accepted restatement): its tools must still resolve a
			// requirement after the increment.
			if (!text.includes("saved plan plan-two")) {
				await new Promise((resolve) => setTimeout(resolve, 120));
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-two", goals: ["two"], taskIds: ["t1"] }, { id: "save-two" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			const first = await service.submitUserInput({ text: `${MARKER} original`, requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
				if ((doc?.plans.length ?? 0) > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const queued = await service.submitUserInput({ text: `${MARKER} restated`, requestId: "req-a", expectedRequestVersion: 1 });
			expect(queued.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The run's own plan was saved, which is only possible if its tools could
			// still resolve a requirement after the requirement moved to v2.
			const saved = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-two", context);
			expect(saved?.requestId).toBe("req-a");
			expect(saved?.requestVersion).toBe(2);
			const admissions = (await runtime.harness.snapshot(MainServiceDoc, 1 as never, context))?.admissions ?? [];
			expect(admissions.some((admission) => admission.basisAccepted === true)).toBe(true);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("serves a run started inside the submit window from its own requirement, not from none and not from the previous one's (AC-01, AC-04)", async () => {
		// Identity and content are two halves of one fact, and only the first was
		// persisted before the Harness could start the run: the input's text lived in a
		// record written *after* `handle.submit` returned, and the request document
		// learns it at the consume boundary, which is later still. So the run the
		// boundary started was served the pointer's requirement — or, for a
		// requirement its own input creates, no requirement at all.
		//
		// The window is opened by the real call rather than by clearing state by hand:
		// nothing here is missing that the service had already written.
		await driveSubmitWindow({
			databasePath,
			router: async () => fauxAssistantMessage([fauxText("done")]),
			first: { text: `${MARKER} first request`, requestId: "req-a" },
			queued: { text: `${MARKER} second request`, requestId: "req-b" },
			assert: async ({ requests, outcome }) => {
				expect(outcome.kind).toBe("queued");
				// The run the boundary started: the first provider request that carries the
				// second input at all.
				const index = requests.findIndex((messages) => flatten(messages).includes(`${MARKER} second request`));
				expect(index).toBeGreaterThanOrEqual(0);
				const section = restorationOf(requests[index]!);
				// Its own requirement, at its own version, with its own words — the section
				// is present rather than dropped for having no document to read.
				expect(section).toContain("Request req-b v1");
				expect(section).toContain(`${MARKER} second request`);
				// And not the requirement the pointer still named when this prompt was
				// prepared.
				expect(section).not.toContain("req-a");
				expect(section).not.toContain(`${MARKER} first request`);
			},
		});
	});

	it("serves a same-request restatement started inside the submit window at the version it establishes (AC-01, AC-04)", async () => {
		// The same window with the same requirement on both sides, which is the harder
		// case: there *is* a document to read, and it holds the right identity with the
		// previous version's words. Identity and content must come from one record, or
		// the run saves a plan at v2 while the prompt it reads says v1.
		await driveSubmitWindow({
			databasePath,
			router: async (request) =>
				flatten(request.messages).includes("NEW-REQUIREMENT")
					? fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-restated", goals: ["new goal"], taskIds: ["t1"] }, { id: "p1" })], { stopReason: "toolUse" })
					: fauxAssistantMessage([fauxText("done")]),
			first: { text: `${MARKER} OLD-REQUIREMENT`, requestId: "req-a" },
			queued: { text: `${MARKER} NEW-REQUIREMENT`, requestId: "req-a", expectedRequestVersion: 1 },
			assert: async ({ runtime, requests, outcome }) => {
				expect(outcome.kind).toBe("queued");
				const index = requests.findIndex((messages) => flatten(messages).includes("NEW-REQUIREMENT"));
				expect(index).toBeGreaterThanOrEqual(0);
				const section = restorationOf(requests[index]!);
				expect(section).toContain("Request req-a v2");
				expect(section).toContain(`${MARKER} NEW-REQUIREMENT`);
				// Not the version, and not the words, of the requirement it restates.
				expect(section).not.toContain("OLD-REQUIREMENT");
				expect(section).not.toContain("v1");
				// And the plan the same run saved agrees with the prompt it read: one
				// record, one version.
				const plan = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-restated", context);
				expect(plan?.requestId).toBe("req-a");
				expect(plan?.requestVersion).toBe(2);
			},
		});
	});

	it("builds the handoff of a run started inside the submit window from that run's own requirement (AC-01, AC-04)", async () => {
		// The other program-authored context payload, and it reads the same document:
		// a handoff *replaces* the next round's context, so one built from a document
		// the input has not reached yet hands that round the previous version's wording
		// as if it were the request being served.
		let asked = false;
		await driveSubmitWindow({
			databasePath,
			router: async (request) => {
				if (!asked && flatten(request.messages).includes(`${MARKER} second request`)) {
					asked = true;
					return fauxAssistantMessage(
						[fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match" }, { id: "ask-b" })],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage([fauxText("done")]);
			},
			first: { text: `${MARKER} first request`, requestId: "req-a" },
			queued: { text: `${MARKER} second request`, requestId: "req-b" },
			assert: async ({ runtime }) => {
				const entries = await (await runtime.harness.conversation(1 as never, context))!.entries({ order: "ascending" }, 200, undefined, context);
				const payload = entries.items.find((entry) => entry.kind === "pi.reset")?.model?.[0]?.content;
				expect(typeof payload).toBe("string");
				const text = typeof payload === "string" ? payload : "";
				expect(text).toContain("req-b v1");
				expect(text).toContain(`${MARKER} second request`);
				expect(text).not.toContain("req-a");
			},
		});
	});

	it("names one requirement for an unnamed input resubmitted in the same conversation, at the next version (AC-04)", async () => {
		// The boundary of what a derived id promises, asserted in *one* conversation
		// rather than across two clocks: the identity is stable — the same words are the
		// same requirement instead of forking a second one — while the version moves,
		// because the same words said again are a restatement. "A retry never moves the
		// version" is not claimed, and this is the test that says so.
		let clock = 1_700_000_000_000;
		const router: FauxResponseFactory = async () => fauxAssistantMessage([fauxText("done")]);
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
				now: () => (clock += 1000),
			});

			const first = await service.submitUserInput({ text: `${MARKER} unnamed` });
			if (first.kind !== "request") throw new Error(`expected a request, got ${first.kind}`);
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			const second = await service.submitUserInput({ text: `${MARKER} unnamed` });
			if (second.kind !== "request") throw new Error(`expected a restatement, got ${second.kind}`);

			// Named by its words rather than by the clock, which moved between the two
			// calls and would have given a second requirement its own identity.
			expect(first.requestId).toBe(derivedRequestId(`${MARKER} unnamed`));
			expect(second.requestId).toBe(first.requestId);
			expect(first.requestVersion).toBe(1);
			expect(second.requestVersion).toBe(2);
		} finally {
			await runtime.close();
		}
	});
});
