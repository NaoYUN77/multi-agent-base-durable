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
import { AgentClarificationDoc, AgentRequestDoc } from "../src/agent/contracts/documents.ts";
import { composeModelResolution } from "../src/agent/contracts/clarification.ts";
import { MainServiceDoc } from "../src/agent/main/service-doc.ts";
import { deriveQuestionId, stableSlug } from "../src/agent/main/request-id.ts";
import { openQuestionIds } from "../src/agent/contracts/clarification.ts";
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
	 * A router that asks a question on the first turn and answers plainly on any
	 * later turn. It records every request, so a second turn is *observed* rather
	 * than inferred.
	 */
	const askingRouter: FauxResponseFactory = (request) => {
		requests.push(flatten(request.messages));
		// A tool result in the transcript means the ask round already happened.
		const sawToolResult = request.messages.some((message) => message.role === "toolResult");
		if (sawToolResult) return fauxAssistantMessage([fauxText("answered after the question")]);
		return fauxAssistantMessage(
			[fauxToolCall("request_clarification", { question: "Which file should I use?", reason: "two files match", blockedTaskIds: [] }, { id: "ask-1" })],
			{ stopReason: "toolUse" },
		);
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

	it("derives the question id from the program's own round count, not the clock", async () => {
		// Pure: the same round and question always produce the same id, so a replay
		// after an interruption resumes the same question instead of asking twice.
		expect(deriveQuestionId(1, "Which file?")).toBe(deriveQuestionId(1, "Which file?"));
		expect(deriveQuestionId(1, "Which file?")).not.toBe(deriveQuestionId(2, "Which file?"));
		// Two long questions that share an opening still get distinct ids.
		const a = deriveQuestionId(1, "Which of the two candidate files should I read first, given the size?");
		const b = deriveQuestionId(1, "Which of the two candidate files should I read first, given the age?");
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

			const answer = await service.submitUserInput({ text: "Use report.txt", answerTo: questionId });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") return;
			const settled = await answer.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The answer reached the model as a real request in the SAME conversation.
			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("Use report.txt");

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
			// And it can still be answered.
			const answer = await second.service.submitUserInput({ text: "Use report.txt", answerTo: questionId });
			expect(answer.kind).toBe("answer");
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
			const answered = await service.submitUserInput({ text: "report.txt", answerTo: questionId });
			expect(answered.kind).toBe("answer");
			if (answered.kind !== "answer") return;
			await answered.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			const again = await service.submitUserInput({ text: `${MARKER} count again`, requestId: "req-1", expectedRequestVersion: 1 });
			expect(again.kind).toBe("request");
			if (again.kind !== "request") return;
			expect(again.requestVersion).toBe(2);
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
			const answered = await service.submitUserInput({ text: "report.txt", answerTo: questionId });
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
});
