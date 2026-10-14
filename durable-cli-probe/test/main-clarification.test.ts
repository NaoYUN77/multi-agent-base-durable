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
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../src/agent/contracts/documents.ts";
import { composeModelResolution, openQuestionIds, validateClarificationState } from "../src/agent/contracts/clarification.ts";
import { MainServiceDoc } from "../src/agent/main/service-doc.ts";
import { deriveQuestionId, stableSlug } from "../src/agent/main/request-id.ts";
import { openMainService } from "../src/service/main-service.ts";

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
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
				.join("\n");
		})
		.join("\n");
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

	/** Open a service over a fresh database, with the asking router installed. */
	async function openAsking(): Promise<{ runtime: ProbeRuntime; service: Awaited<ReturnType<typeof openMainService>> }> {
		const runtime = await openProbe({
			databasePath,
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
			now: () => 1_700_000_000_000,
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
});
