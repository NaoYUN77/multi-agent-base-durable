// TASK-005.1 test/agent-state.test.ts
//
// The shared state machine, its quota accounting, and the things that can only be
// checked against a real harness and a real file: that a settled structured answer
// is the submission (and a tool call never is), that the five documents survive a
// reopen, and that evidence from another conversation is refused (AC-05, AC-03,
// AC-04).
//
// Evidence discipline: assertions are about what the harness persisted and how
// many provider turns actually happened, never about what a tool printed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { Conversation, ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc, AgentTaskConfigDoc, AgentTaskResultDoc } from "../src/agent/contracts/documents.ts";
import { RUN_CONFIG_SCHEMA_VERSION, validateRunConfig, validateTaskConfigSnapshot } from "../src/agent/contracts/run-config.ts";
import { validateClarificationState } from "../src/agent/contracts/clarification.ts";
import { validatePlan } from "../src/agent/contracts/plan.ts";
import { assembleTaskResult, validateTaskResult, type PersistedEntryIndex } from "../src/agent/contracts/task-result.ts";
import { completeSubmission } from "../src/agent/state/finish.ts";
import { QuotaError, businessStopReason, consume, initialQuotaState, isBusinessBudgetExhausted, quotaRemaining, resetRoundCounters } from "../src/agent/state/quota.ts";
import {
	IllegalTransitionError,
	admissionBlockReasons,
	assertBusinessTransition,
	assertRoundTransition,
	businessTransitionTable,
	decideRoundFailure,
	isLegalBusinessTransition,
	isLegacyBusinessStatus,
	isTerminalBusinessStatus,
	isTerminalRoundStatus,
	mayResumeAfterAnswer,
	mayTerminateAfterCancel,
	readLegacyStatus,
	stopsBusinessCalls,
} from "../src/agent/state/lifecycle.ts";

describe("TASK-005.1 state — business transition table (AC-02)", () => {
	it("publishes the legal edges, including the new planned/awaiting_input states", () => {
		const table = businessTransitionTable().map(([from, to]) => `${from}->${to}`);
		expect(table).toContain("planned->running");
		expect(table).toContain("running->awaiting_input");
		expect(table).toContain("awaiting_input->running");
		expect(table).toContain("running->awaiting_review");
		expect(table).toContain("awaiting_review->accepted");
	});

	it("accepts the legal edges and refuses the illegal ones", () => {
		expect(isLegalBusinessTransition("running", "awaiting_review")).toBe(true);
		expect(isLegalBusinessTransition("awaiting_input", "running")).toBe(true);
		expect(isLegalBusinessTransition("awaiting_review", "running")).toBe(true);
		expect(isLegalBusinessTransition("running", "planned")).toBe(false);
		expect(isLegalBusinessTransition("awaiting_input", "accepted")).toBe(false);
		expect(() => assertBusinessTransition("running", "planned")).toThrow(IllegalTransitionError);
	});

	it("refuses a terminal resurrection and a self transition", () => {
		for (const terminal of ["accepted", "failed", "cancelled"] as const) {
			expect(isTerminalBusinessStatus(terminal)).toBe(true);
			expect(() => assertBusinessTransition(terminal, "running")).toThrow(IllegalTransitionError);
		}
		expect(() => assertBusinessTransition("running", "running")).toThrow(IllegalTransitionError);
	});

	it("keeps the legacy `revising` label readable and old-writer legal (AC-02)", () => {
		expect(isLegacyBusinessStatus("revising")).toBe(true);
		expect(readLegacyStatus("revising")).toBe("running");
		expect(readLegacyStatus("awaiting_review")).toBe("awaiting_review");
		expect(isLegalBusinessTransition("awaiting_review", "revising")).toBe(true);
		expect(isLegalBusinessTransition("revising", "awaiting_review")).toBe(true);
	});

	it("treats a round's own statuses as settled once terminal", () => {
		expect(isTerminalRoundStatus("completed")).toBe(true);
		expect(isTerminalRoundStatus("failed")).toBe(true);
		expect(() => assertRoundTransition("completed", "running")).toThrow(IllegalTransitionError);
		expect(() => assertRoundTransition("queued", "running")).not.toThrow();
	});
});

describe("TASK-005.1 state — an exhausted budget is not a verdict (AC-02)", () => {
	const budget = { maxTechnicalRestarts: 2, maxAttemptsPerOperation: 3 };

	it("retries a technical failure inside the restart budget and keeps the task running", () => {
		const settlement = decideRoundFailure({ businessStatus: "running", failureKind: "technical", technicalRestartsUsed: 1, attemptsUsed: 2, budget });
		expect(settlement.roundStatus).toBe("retry_wait");
		expect(settlement.nextBusinessStatus).toBeUndefined();
		expect(settlement.requiresMainDecision).toBeUndefined();
	});

	it("settles a failed round and hands the task to Main instead of failing it", () => {
		const exhaustedCases: readonly (readonly [string, number, number])[] = [
			["restarts spent", 2, 3],
			["attempts spent", 0, 3],
		];
		for (const [label, technicalRestartsUsed, attemptsUsed] of exhaustedCases) {
			const settlement = decideRoundFailure({ businessStatus: "running", failureKind: "technical", technicalRestartsUsed, attemptsUsed, budget });
			expect(label).toBeTruthy();
			expect(settlement.roundStatus).toBe("failed");
			// The business status is untouched: an infrastructure fact is not a
			// judgement about the task, and `failed` cannot be undone.
			expect(settlement.nextBusinessStatus).toBeUndefined();
			expect(settlement.terminal).toBeUndefined();
			expect(settlement.requiresMainDecision).toBe(true);
			expect(stopsBusinessCalls(settlement)).toBe(true);
		}
	});

	it("keeps the business terminal states for explicit decisions only", () => {
		const cancelled = decideRoundFailure({ businessStatus: "running", failureKind: "cancelled", technicalRestartsUsed: 0, attemptsUsed: 1, budget });
		expect(cancelled.nextBusinessStatus).toBe("cancelled");
		expect(cancelled.terminal).toBe(true);

		const quality = decideRoundFailure({ businessStatus: "awaiting_review", failureKind: "quality", technicalRestartsUsed: 0, attemptsUsed: 1, budget });
		expect(quality.roundStatus).toBe("completed");
		expect(quality.nextBusinessStatus).toBeUndefined();
	});
});

describe("TASK-005.1 state — resuming after an answer (AC-02, AC-03)", () => {
	it("requires a settled question, not merely an answered one", () => {
		// The clarification contract's complement of `openQuestionIds`: only the
		// questions with a satisfying resolution count as settled.
		expect(mayResumeAfterAnswer("awaiting_input", ["q-1"], [])).toBe(false);
		expect(mayResumeAfterAnswer("awaiting_input", ["q-1"], ["q-2"])).toBe(false);
		expect(mayResumeAfterAnswer("awaiting_input", ["q-1", "q-2"], ["q-1"])).toBe(false);
		expect(mayResumeAfterAnswer("awaiting_input", ["q-1"], ["q-1"])).toBe(true);
		expect(mayResumeAfterAnswer("running", ["q-1"], ["q-1"])).toBe(false);
	});
});

describe("TASK-005.1 state — cancel intent gates the terminal status (AC-02)", () => {
	it("refuses to terminate while something is still executing", () => {
		expect(mayTerminateAfterCancel({ businessStatus: "running", hasActiveExecution: true, hasCancelIntent: true })).toBe(false);
		expect(mayTerminateAfterCancel({ businessStatus: "running", hasActiveExecution: false, hasCancelIntent: true })).toBe(true);
		expect(mayTerminateAfterCancel({ businessStatus: "running", hasActiveExecution: false, hasCancelIntent: false })).toBe(false);
		expect(mayTerminateAfterCancel({ businessStatus: "cancelled", hasActiveExecution: false, hasCancelIntent: true })).toBe(false);
	});
});

describe("TASK-005.1 state — admission reasons (AC-01)", () => {
	it("names every blocking rule, and none when nothing blocks", () => {
		expect(
			admissionBlockReasons({
				expectedPlanVersion: 2,
				storedPlanVersion: 1,
				openQuestionIds: ["q-1"],
				unacceptedDependencies: ["task-a"],
				quotaRemaining: { attempts: 0 },
			}),
		).toEqual(["plan_version_stale", "clarification_open", "dependencies_not_accepted", "quota_exhausted"]);
		expect(
			admissionBlockReasons({
				expectedPlanVersion: 2,
				storedPlanVersion: 2,
				openQuestionIds: [],
				unacceptedDependencies: [],
				quotaRemaining: { attempts: 3 },
			}),
		).toEqual([]);
	});
});

describe("TASK-005.1 state — quota accounting (AC-01, AC-02)", () => {
	const config = () => {
		const result = validateRunConfig({
			schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
			maxConcurrentSubAgents: 1,
			maxSubAgentsPerRequest: 1,
			maxToolInvocationsPerRound: 3,
			maxFailedToolCallsPerRound: 2,
			maxAttemptsPerOperation: 3,
			maxTechnicalRestarts: 2,
			roundTimeoutMs: 1000,
			providerRetry: { maxRetries: 0, backoffMs: 0 },
			harnessRetry: { maxRetries: 0, backoffMs: 0 },
		});
		if (!result.ok) throw new Error("fixture config invalid");
		return result.value;
	};

	it("reserves and refuses in the same call, with a stable code", () => {
		const state = initialQuotaState(1);
		const budget = config();
		consume(state, { kind: "tool_call" }, budget);
		consume(state, { kind: "tool_call" }, budget);
		expect(quotaRemaining(state, budget).toolInvocations).toBe(1);
		try {
			consume(state, { kind: "tool_call" }, budget);
			consume(state, { kind: "tool_call" }, budget);
			throw new Error("expected the third call to be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(QuotaError);
			expect((error as QuotaError).code).toBe("quota_tool_invocations_exhausted");
		}
		// A refused call must have changed nothing.
		expect(quotaRemaining(state, budget).toolInvocations).toBe(0);
	});

	it("counts quality attempts and technical restarts separately", () => {
		const state = initialQuotaState(1);
		const budget = config();
		consume(state, { kind: "technical_restart" }, budget);
		consume(state, { kind: "technical_restart" }, budget);
		expect(() => consume(state, { kind: "technical_restart" }, budget)).toThrow(QuotaError);
		expect(quotaRemaining(state, budget).attempts).toBe(3);
		consume(state, { kind: "attempt" }, budget);
		expect(state.operation.attemptsUsed).toBe(1);
	});

	it("resets per-round counters and keeps per-operation counters", () => {
		const state = initialQuotaState(1);
		const budget = config();
		consume(state, { kind: "tool_call" }, budget);
		resetRoundCounters(state, 2);
		expect(quotaRemaining(state, budget).toolInvocations).toBe(3);
		expect(state.round.round).toBe(2);
	});

	it("refuses a new business call once the round has spent its failure allowance", () => {
		const budget = config();
		const state = initialQuotaState(1);
		// One call, one failure. The allowance is 2, so work may continue.
		consume(state, { kind: "tool_call" }, budget);
		consume(state, { kind: "failed_tool_call" }, budget);
		expect(businessStopReason(state, budget)).toBeUndefined();

		consume(state, { kind: "tool_call" }, budget);
		consume(state, { kind: "failed_tool_call" }, budget);
		// The allowance is spent. The next call is refused *before* it happens —
		// recording the failure afterwards would let the side effect run first.
		expect(businessStopReason(state, budget)).toBe("failed_tool_calls_exhausted");
		const spent = quotaRemaining(state, budget).toolInvocations;
		expect(() => consume(state, { kind: "tool_call" }, budget)).toThrow(QuotaError);
		expect(quotaRemaining(state, budget).toolInvocations).toBe(spent);

		// The control channel is not a business call: reporting and finishing stay
		// available so the round can hand the stop reason to Main.
		expect(() => consume(state, { kind: "control" }, budget)).not.toThrow();
	});

	it("treats a zero failure allowance as admitting no business call at all", () => {
		const zeroFailures = validateRunConfig({
			schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
			maxConcurrentSubAgents: 1,
			maxSubAgentsPerRequest: 1,
			maxToolInvocationsPerRound: 3,
			maxFailedToolCallsPerRound: 0,
			maxAttemptsPerOperation: 2,
			maxTechnicalRestarts: 1,
			roundTimeoutMs: 1000,
			providerRetry: { maxRetries: 0, backoffMs: 0 },
			harnessRetry: { maxRetries: 0, backoffMs: 0 },
		});
		if (!zeroFailures.ok) throw new Error("fixture config invalid");
		const state = initialQuotaState(1);
		expect(businessStopReason(state, zeroFailures.value)).toBe("failed_tool_calls_exhausted");
		expect(() => consume(state, { kind: "tool_call" }, zeroFailures.value)).toThrow(QuotaError);
		// A refused admission spends nothing.
		expect(state.round.toolInvocationsUsed).toBe(0);
		expect(() => consume(state, { kind: "control" }, zeroFailures.value)).not.toThrow();
	});

	it("reports the business budget as exhausted, not the control channel", () => {
		const state = initialQuotaState(1);
		const tight = validateRunConfig({
			schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
			maxConcurrentSubAgents: 1,
			maxSubAgentsPerRequest: 1,
			maxToolInvocationsPerRound: 0,
			maxFailedToolCallsPerRound: 0,
			maxAttemptsPerOperation: 1,
			maxTechnicalRestarts: 0,
			roundTimeoutMs: 1000,
			providerRetry: { maxRetries: 0, backoffMs: 0 },
			harnessRetry: { maxRetries: 0, backoffMs: 0 },
		});
		if (!tight.ok) throw new Error("fixture config invalid");
		expect(isBusinessBudgetExhausted(state, tight.value)).toBe(true);
		expect(isBusinessBudgetExhausted(state, config())).toBe(false);
	});
});
// ── The finish mechanism, verified against the real harness (AC-05) ──────────

/** A sibling call that never asks to terminate: what keeps a round alive. */
const siblingTool = defineTool({
	name: "sibling_noop",
	description: "A sibling call that does not ask to terminate.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "sibling done" }] }),
});

async function entriesOf(conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

/** The answering assistant message's text, as persisted. */
function assistantTextOf(entry: EntryRecord | undefined): string | undefined {
	if (entry === undefined) return undefined;
	const parts: string[] = [];
	for (const message of entry.model ?? []) {
		const typed = message as { role?: string; content?: unknown };
		if (typed.role !== "assistant") continue;
		if (typeof typed.content === "string") parts.push(typed.content);
		else if (Array.isArray(typed.content)) {
			for (const part of typed.content) {
				if (typeof part === "object" && part !== null && "text" in part) parts.push(String((part as { text?: unknown }).text ?? ""));
			}
		}
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

/** The work contract a submission's final answer must carry. */
const submissionWork = {
	summary: "Revenue is 1,204 units, quoted from the material.",
	findings: ["quoted verbatim"],
	unresolved: [],
	artifacts: [],
};

/** The completion the program actually accepts: the settled answer, read and validated. */
function submissionOf(entries: readonly EntryRecord[], settled: { readonly status: "queued" | "placed" | "done" | "unanswered"; readonly answer?: unknown }) {
	const answerEntryId = settled.status === "done" ? String(settled.answer) : undefined;
	return completeSubmission({
		settlement: settled,
		...(answerEntryId === undefined ? {} : { answerEntryId }),
		...(answerEntryId === undefined ? {} : { answerText: assistantTextOf(entries.find((entry) => String(entry.id) === answerEntryId)) }),
	});
}

// Each suite below opens a real harness over a real SQLite file, which is an
// order of magnitude slower than the pure checks above and can be stretched
// several-fold when the whole suite runs in parallel. The default five-second
// per-test budget is too tight for that, so the budget is stated explicitly
// rather than left to the machine's load.
describe("TASK-005.1 finish — the completion boundary is the settled answer (AC-05)", { timeout: 30_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-state-"));
		databasePath = join(directory, "state.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	/** One submission whose final answer is `answerText`, read back through the boundary. */
	const settleWithAnswer = async (answerText: string, requestId: string) => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxResponses: [answerText],
			extensions: [defineExtension({ name: "agent-finish", tools: [siblingTool] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Do the work and submit.", requestId }, context);
			const settled = await submission.wait(context);
			const entries = await entriesOf(root);
			return { settled, entries, completed: submissionOf(entries, settled) };
		} finally {
			await runtime.close();
		}
	};

	it("accepts a settled structured answer as the submission, bare or fenced", async () => {
		const { settled, entries, completed } = await settleWithAnswer(JSON.stringify(submissionWork), "finish-answer-1");
		expect(settled.status).toBe("done");
		if (settled.status !== "done") return;

		// The answering turn is the one that ended the run: a turn with no tool
		// calls, which needs no cooperation from any sibling.
		const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
		expect(assistantEntries).toHaveLength(1);
		expect(String(settled.answer)).toBe(String(assistantEntries[0]?.id));

		expect(completed.ok).toBe(true);
		if (completed.ok) {
			expect(completed.value.answerEntryId).toBe(String(settled.answer));
			expect(completed.value.work).toEqual(submissionWork);
		}

		// The same payload inside a fenced block is accepted too: the answer may
		// carry a sentence, but the contract has to be in the block.
		const fenced = ["Here is the result:", "```json", JSON.stringify(submissionWork), "```"].join("\n");
		const wrapped = await settleWithAnswer(fenced, "finish-answer-fenced-1");
		expect(wrapped.completed.ok).toBe(true);
		if (wrapped.completed.ok) expect(wrapped.completed.value.work).toEqual(submissionWork);
	});

	it("settles but does not accept an answer that is not the work contract", async () => {
		// Prose instead of a payload: settled, but nothing to accept.
		const unparseable = await settleWithAnswer("I have finished the review.", "finish-answer-prose-1");
		expect(unparseable.settled.status).toBe("done");
		expect(unparseable.completed.ok).toBe(false);
		if (!unparseable.completed.ok) expect(unparseable.completed.violations.map((item) => item.code)).toContain("submission_result_unparseable");

		// Valid JSON, invalid contract (no summary): the run settled, the
		// submission did not.
		const invalid = await settleWithAnswer(JSON.stringify({ findings: ["quoted verbatim"] }), "finish-answer-invalid-1");
		expect(invalid.settled.status).toBe("done");
		expect(invalid.completed.ok).toBe(false);
		if (!invalid.completed.ok) {
			expect(invalid.completed.violations.map((item) => item.code)).toContain("submission_result_invalid");
			expect(invalid.completed.violations.some((item) => item.path === "$.answer.summary")).toBe(true);
		}

		// And a model payload cannot smuggle runtime-owned fields into the answer.
		const reserved = await settleWithAnswer(JSON.stringify({ ...submissionWork, status: "completed" }), "finish-answer-reserved-1");
		expect(reserved.completed.ok).toBe(false);
		if (!reserved.completed.ok) expect(reserved.completed.violations.map((item) => item.code)).toContain("reserved_field");
	});

	it("never treats a tool call as a submission, and no business call follows the answer", async () => {
		// The shape that failed before: business work in early rounds, and a
		// submission that must end the run by itself.
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [
				[{ name: "sibling_noop", arguments: {} }],
				[{ name: "sibling_noop", arguments: {} }],
			],
			fauxResponses: [JSON.stringify(submissionWork)],
			// A further provider request — the only way to start a business call —
			// would reach the router, which refuses.
			fauxRouter: () => {
				throw new Error("the run must not make a further provider request");
			},
			extensions: [defineExtension({ name: "agent-finish", tools: [siblingTool] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Work twice, then submit.", requestId: "finish-answer-business-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");
			if (settled.status !== "done") return;

			const entries = await entriesOf(root);
			// Three turns: two business rounds, then the answer that ended the run.
			// The business calls happened *before* the submission — that is what
			// makes "no business call after the submission" a structural property
			// rather than a request to the model.
			expect(entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(3);
			const answerIndex = entries.findIndex((entry) => String(entry.id) === String(settled.answer));
			expect(answerIndex).toBe(entries.length - 1);
			const businessResults = entries.filter((entry) => entry.kind === "pi.tool-result");
			expect(businessResults).toHaveLength(2);
			expect(entries.slice(answerIndex + 1).filter((entry) => entry.kind === "pi.tool-result")).toHaveLength(0);

			const completed = submissionOf(entries, settled);
			expect(completed.ok).toBe(true);
			if (completed.ok) expect(completed.value.work).toEqual(submissionWork);

			// Settled means settled: the transcript does not move afterwards.
			const after = await entriesOf(root);
			expect(after.map((entry) => `${entry.kind}#${entry.id}`)).toEqual(entries.map((entry) => `${entry.kind}#${entry.id}`));
		} finally {
			await runtime.close();
		}
	});
});
describe("TASK-005.1 finish — reopening settles nothing twice (AC-03, AC-05)", { timeout: 30_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-state-reopen-"));
		databasePath = join(directory, "state.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("keeps the settled submission unchanged across a reopen", async () => {
		const first: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxResponses: [JSON.stringify(submissionWork)],
			fauxRouter: () => {
				throw new Error("a reopen must not make a provider request");
			},
			extensions: [defineExtension({ name: "agent-finish", tools: [siblingTool] })],
		});
		let before: readonly string[];
		let beforeWork: unknown;
		try {
			const root = await openRoot(first);
			first.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify the figure.", requestId: "finish-reopen-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");
			const entries = await entriesOf(root);
			before = entries.map((entry) => `${entry.kind}#${entry.id}`);
			const completed = submissionOf(entries, settled);
			expect(completed.ok).toBe(true);
			if (completed.ok) beforeWork = completed.value.work;
		} finally {
			await first.close();
		}

		// Reopen over the same file: the router above throws if a provider request
		// happens, so a reopen that resumed work would fail this test.
		const second = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: () => {
				throw new Error("a reopen must not make a provider request");
			},
		});
		try {
			const root = await openRoot(second);
			const entries = await entriesOf(root);
			// Same conversation, same entries in the same order: a settled run is not
			// re-run and its outcome is not rewritten by the reopen.
			expect(entries.map((entry) => `${entry.kind}#${entry.id}`)).toEqual(before);
			expect(entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
			// And the submission read back from the reopened database is the same one.
			const answerEntry = entries.find((entry) => entry.kind === "pi.assistant");
			const reread = completeSubmission({ settlement: { status: "done" }, answerEntryId: String(answerEntry?.id), answerText: assistantTextOf(answerEntry) });
			expect(reread.ok).toBe(true);
			if (reread.ok) expect(reread.value.work).toEqual(beforeWork);
		} finally {
			await second.close();
		}
	});
});
describe("TASK-005.1 documents — write, close, reopen (AC-03)", { timeout: 30_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-docs-"));
		databasePath = join(directory, "docs.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("persists all five documents and reads them back field for field", async () => {
		const requestId = "req-1";
		const planId = "plan-1";
		const taskId = "task-a";

		const clarification = validateClarificationState({
			schemaVersion: 1,
			questions: [{ questionId: "q-1", question: "Which version?", reason: "Two are supplied.", blockingScope: ["scope"], askedAt: 10 }],
			answers: [{ questionId: "q-1", text: "The 2026 one.", source: "application", sufficient: true, answeredAt: 20 }],
			resolutions: [{ questionId: "q-1", resolvedAt: 21, resolvedBy: "model", basis: { kind: "answer", answerAt: 20 } }],
		});
		const plan = validatePlan({
			schemaVersion: 1,
			planId,
			version: 1,
			goals: ["Check the figures."],
			taskIds: [taskId],
			relatedQuestionIds: ["q-1"],
			savedAt: 1_700_000_000_000,
		});
		const snapshot = validateTaskConfigSnapshot({
			schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
			contractRevision: 1,
			requestVersion: 2,
			taskSpecVersion: 1,
			planVersion: 1,
			assembledPrompt: "Check the supplied material only.",
			skillVersion: "1.0.0",
			skillHash: "a".repeat(64),
			tools: [{ name: "text_check", version: "1.0.0" }],
			model: "faux-faux-1",
			budget: (validateRunConfig({
				schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
				maxConcurrentSubAgents: 2,
				maxSubAgentsPerRequest: 2,
				maxToolInvocationsPerRound: 8,
				maxFailedToolCallsPerRound: 2,
				maxAttemptsPerOperation: 3,
				maxTechnicalRestarts: 2,
				roundTimeoutMs: 120_000,
				providerRetry: { maxRetries: 1, backoffMs: 25 },
				harnessRetry: { maxRetries: 1, backoffMs: 25 },
			}) as { ok: true; value: unknown }).value,
			configHash: "b".repeat(64),
		});
		const result = validateTaskResult({
			schemaVersion: 1,
			resultId: "result-1",
			runtime: { taskId, round: 1, status: "completed", attempts: 1, technicalRestarts: 0, toolInvocations: 2, sideEffect: "recorded", settledAt: 1_700_000_000_000 },
			// Non-empty evidence and work, so the comparison after the reopen has
			// something to lose: an empty list round-trips through anything.
			evidence: [{ entryId: "42", kind: "pi.tool-result", byTaskId: taskId, toolCallId: "call-1", toolName: "text_check" }],
			work: { summary: "The figure matches.", findings: ["Revenue is 1,204 units."], unresolved: ["Nothing open."], artifacts: [{ kind: "text", ref: "answer-1" }] },
		});
		if (!clarification.ok || !plan.ok || !snapshot.ok || !result.ok) throw new Error("fixture documents must validate");

		/**
		 * Read all five documents through the public read-only API. Used both
		 * before the close and after the reopen, so the comparison is
		 * document-to-document: a document that quietly became a *different valid*
		 * document fails it, which field-by-field spot checks would not catch.
		 */
		const readFive = async (harness: ProbeRuntime["harness"], conversationId: ConversationId) => {
			const request = await harness.snapshot(AgentRequestDoc, conversationId as never, requestId, context);
			const clarificationRead = await harness.snapshot(AgentClarificationDoc, conversationId as never, requestId, context);
			const planRead = await harness.snapshot(AgentPlanDoc, conversationId as never, planId, context);
			const configRead = await harness.snapshot(AgentTaskConfigDoc, conversationId as never, taskId, context);
			const resultRead = await harness.snapshot(AgentTaskResultDoc, conversationId as never, taskId, context);
			if (request === undefined || clarificationRead === undefined || planRead === undefined || configRead === undefined || resultRead === undefined) {
				throw new Error("every document must exist");
			}
			return { request, clarification: clarificationRead, plan: planRead, config: configRead, result: resultRead };
		};

		let before: Awaited<ReturnType<typeof readFive>> | undefined;
		const runtime: ProbeRuntime = await openProbe({ databasePath, provider: "faux" });
		try {
			const root = await openRoot(runtime);
			// One commit for all five documents, the way the runtime writes them.
			await runtime.harness.commit(
				async (tx) => {
					const request = await tx.doc(AgentRequestDoc, root.id, requestId, { requestId });
					request.requestVersion = 2;
					request.text = "Verify the revenue figure.";
					request.materials = [{ id: "mat-1", content: "Revenue is 1,204 units.", source: "provided-by-user" }];
					request.requestedAt = 1_700_000_000_000;
					request.inputEntryId = "31";

					const clarificationDoc = await tx.doc(AgentClarificationDoc, root.id, requestId, { requestId });
					clarificationDoc.questions = [...clarification.value.questions];
					clarificationDoc.answers = [...clarification.value.answers];
					clarificationDoc.resolutions = [...clarification.value.resolutions];

					const planDoc = await tx.doc(AgentPlanDoc, root.id, planId, { planId });
					planDoc.version = plan.value.version;
					planDoc.goals = [...plan.value.goals];
					planDoc.taskIds = [...plan.value.taskIds];
					planDoc.relatedQuestionIds = [...plan.value.relatedQuestionIds];
					planDoc.savedAt = plan.value.savedAt;

					const configDoc = await tx.doc(AgentTaskConfigDoc, root.id, taskId, { taskId });
					configDoc.snapshot = snapshot.value;

					const resultDoc = await tx.doc(AgentTaskResultDoc, root.id, taskId, { taskId });
					resultDoc.result = result.value;
				},
				context,
			);
			before = await readFive(runtime.harness, root.id);
		} finally {
			await runtime.close();
		}
		if (before === undefined) throw new Error("the documents must be readable before the reopen");

		const reopened = await openProbe({ databasePath, provider: "faux" });
		try {
			const root = await openRoot(reopened);
			const after = await readFive(reopened.harness, root.id);

			// Identity, schemaVersion and every field, document for document.
			expect(after).toEqual(before);

			// And the fields the reopen is most likely to lose, named explicitly so
			// a regression says which one moved.
			expect(after.request.requestVersion).toBe(2);
			expect(after.request.text).toBe("Verify the revenue figure.");
			expect(after.request.materials).toEqual([{ id: "mat-1", content: "Revenue is 1,204 units.", source: "provided-by-user" }]);
			expect(after.request.inputEntryId).toBe("31");
			expect(after.clarification.questions).toEqual([{ questionId: "q-1", question: "Which version?", reason: "Two are supplied.", blockingScope: ["scope"], askedAt: 10 }]);
			expect(after.clarification.answers).toEqual([{ questionId: "q-1", text: "The 2026 one.", source: "application", sufficient: true, answeredAt: 20 }]);
			expect(after.clarification.resolutions).toEqual([{ questionId: "q-1", resolvedAt: 21, resolvedBy: "model", basis: { kind: "answer", answerAt: 20 } }]);
			expect(after.plan.version).toBe(1);
			expect(after.plan.goals).toEqual(["Check the figures."]);
			expect(after.plan.taskIds).toEqual([taskId]);
			expect(after.plan.savedAt).toBe(1_700_000_000_000);
			expect(after.config.snapshot?.contractRevision).toBe(1);
			expect(after.config.snapshot?.requestVersion).toBe(2);
			expect(after.config.snapshot?.assembledPrompt).toBe("Check the supplied material only.");
			expect(after.config.snapshot?.model).toBe("faux-faux-1");
			expect(after.config.snapshot?.configHash).toBe("b".repeat(64));
			expect(after.config.snapshot?.budget.maxToolInvocationsPerRound).toBe(8);
			expect(after.config.snapshot?.tools).toEqual([{ name: "text_check", version: "1.0.0" }]);
			expect(after.result.result?.evidence).toEqual([{ entryId: "42", kind: "pi.tool-result", byTaskId: taskId, toolCallId: "call-1", toolName: "text_check" }]);
			expect(after.result.result?.work).toEqual({
				summary: "The figure matches.",
				findings: ["Revenue is 1,204 units."],
				unresolved: ["Nothing open."],
				artifacts: [{ kind: "text", ref: "answer-1" }],
			});
			expect(after.result.result?.runtime.status).toBe("completed");

			// And the documents still validate after the reopen: surviving is not
			// the same as still being a contract.
			expect(validateClarificationState(after.clarification).ok).toBe(true);
			expect(validatePlan(after.plan).ok).toBe(true);
			expect(after.config.snapshot !== undefined && validateTaskConfigSnapshot(after.config.snapshot).ok).toBe(true);
			expect(after.result.result !== undefined && validateTaskResult(after.result.result).ok).toBe(true);
		} finally {
			await reopened.close();
		}
	});
});
describe("TASK-005.1 documents — evidence attribution against real entries (AC-04)", { timeout: 30_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-evidence-"));
		databasePath = join(directory, "evidence.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("refuses an entry of another conversation, and one of an earlier round", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxResponses: ["Child answer one.", "Child answer two.", "Other conversation answer."],
		});
		try {
			// The child conversation (two rounds) and a foreign one with its own entry.
			const child = await openRoot(runtime);
			const foreign = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			await foreign.configure({ model: runtime.modelRef }, context);
			runtime.harness.resume();

			const firstRound = await child.submit({ type: "input", content: "Do the work.", requestId: "evidence-child-1" }, context);
			expect((await firstRound.wait(context)).status).toBe("done");
			const secondRound = await child.submit({ type: "input", content: "Do it again.", requestId: "evidence-child-2" }, context);
			expect((await secondRound.wait(context)).status).toBe("done");
			const foreignSubmission = await foreign.submit({ type: "input", content: "Somebody else's work.", requestId: "evidence-foreign-1" }, context);
			expect((await foreignSubmission.wait(context)).status).toBe("done");

			const indexEntries = (entries: readonly EntryRecord[]): Map<string, PersistedEntryIndex> =>
				new Map(entries.map((entry) => [String(entry.id), { entryId: String(entry.id), conversationId: String(entry.conversationId), taskId: entry.byTaskId === undefined ? undefined : String(entry.byTaskId), kind: entry.kind }]));
			// The index is everything the program can see: the child conversation *and*
			// the other one. Attribution, not lookup, is what must refuse the forgery.
			const childIndex = indexEntries([...(await entriesOf(child)), ...(await entriesOf(foreign))]);
			const childAssistants = (await entriesOf(child)).filter((entry) => entry.kind === "pi.assistant");
			const foreignEntry = (await entriesOf(foreign)).find((entry) => entry.kind === "pi.assistant");
			// Two rounds of the same child conversation, each with its own durable task.
			expect(childAssistants).toHaveLength(2);
			expect(foreignEntry).toBeDefined();
			const earlier = childAssistants[0];
			const current = childAssistants[1];
			if (earlier === undefined || current === undefined || foreignEntry === undefined) return;
			expect(earlier.byTaskId).toBeDefined();
			expect(current.byTaskId).toBeDefined();
			expect(String(earlier.byTaskId)).not.toBe(String(current.byTaskId));
			if (earlier.byTaskId === undefined || current.byTaskId === undefined) return;

			const runtimeOutcome = (overrides: Readonly<Record<string, unknown>> = {}) => ({
				taskId: "task-a",
				round: 2,
				status: "completed" as const,
				attempts: 1,
				technicalRestarts: 0,
				toolInvocations: 1,
				sideEffect: "recorded" as const,
				settledAt: 1,
				...overrides,
			});
			// Round 2 owns the durable task round 2 created — not every task the
			// business task ever ran, which is what the earlier round's entry would
			// need to slip through.
			const contextForRound2 = { childConversationId: String(child.id), businessTaskId: "task-a", round: 2, roundDurableTaskIds: [String(current.byTaskId)] };
			const assemble = (evidence: readonly { readonly entryId: string; readonly kind: string; readonly byTaskId?: string }[], overrides: Readonly<Record<string, unknown>> = {}) =>
				assembleTaskResult({
					resultId: "result-1",
					runtime: runtimeOutcome(overrides),
					work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
					evidence,
					knownEntries: childIndex,
					attribution: contextForRound2,
				});

			// A reference to the foreign conversation's own entry, claiming this task.
			const forged = assemble([{ entryId: String(foreignEntry.id), kind: "pi.assistant", byTaskId: "task-a" }]);
			expect(forged.ok).toBe(false);
			if (!forged.ok) expect(forged.violations.map((item) => item.code)).toContain("evidence_conversation_foreign");

			// Round 1's real entry, offered as round 2's evidence.
			const stale = assemble([{ entryId: String(earlier.id), kind: "pi.assistant" }]);
			expect(stale.ok).toBe(false);
			if (!stale.ok) expect(stale.violations.map((item) => item.code)).toContain("evidence_task_mismatch");

			// And a result that claims round 1 while the context is round 2.
			const wrongRound = assemble([{ entryId: String(current.id), kind: "pi.assistant" }], { round: 1 });
			expect(wrongRound.ok).toBe(false);
			if (!wrongRound.ok) expect(wrongRound.violations.map((item) => item.code)).toContain("result_round_mismatch");

			// This round's own entry, with the durable task the round actually owns.
			const honest = assemble([{ entryId: String(current.id), kind: "pi.assistant" }]);
			expect(honest.ok).toBe(true);
		} finally {
			await runtime.close();
		}
	});
});
