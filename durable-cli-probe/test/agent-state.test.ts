// TASK-005.1 test/agent-state.test.ts
//
// The shared state machine, its quota accounting, and the things that can only be
// checked against a real harness and a real file: that a submission stops the
// round, that the five documents survive a reopen, and that evidence from another
// conversation is refused (AC-05, AC-03, AC-04).
//
// Evidence discipline: assertions are about what the harness persisted and how
// many provider turns actually happened, never about what a tool printed.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc, AgentTaskConfigDoc, AgentTaskResultDoc } from "../src/agent/contracts/documents.ts";
import { RUN_CONFIG_SCHEMA_VERSION, validateRunConfig, validateTaskConfigSnapshot } from "../src/agent/contracts/run-config.ts";
import { validateClarificationState } from "../src/agent/contracts/clarification.ts";
import { validatePlan } from "../src/agent/contracts/plan.ts";
import { assembleTaskResult, validateTaskResult, type PersistedEntryIndex } from "../src/agent/contracts/task-result.ts";
import { createFinishTaskTool } from "../src/agent/tools/finish-task.ts";
import { QuotaError, consume, initialQuotaState, isBusinessBudgetExhausted, quotaRemaining, resetRoundCounters } from "../src/agent/state/quota.ts";
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

/** The tool result of one named call: what the model saw, and whether it failed. */
function toolResultOf(entries: readonly EntryRecord[], toolName: string): { readonly text: string; readonly isError: boolean } | undefined {
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const typed = message as { role?: string; toolName?: string; content?: unknown; isError?: boolean };
			if (typed.role !== "toolResult" || typed.toolName !== toolName) continue;
			const parts = Array.isArray(typed.content) ? typed.content : [];
			const text = parts
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
				.join("\n");
			return { text, isError: typed.isError === true };
		}
	}
	return undefined;
}

describe("TASK-005.1 finish — a submission the round can actually honour (AC-05)", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-state-"));
		databasePath = join(directory, "state.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("ends the run when the submission is the only call its round can contain", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "Revenue is 1,204 units, quoted from the material.", findings: ["quoted verbatim"] } }]],
			// Any further provider request would prove the round did not stop.
			fauxRouter: () => {
				throw new Error("the run must not make a second provider request");
			},
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool()] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify the figure.", requestId: "finish-alone-1" }, context);
			const settled = await submission.wait(context);

			expect(settled.status).toBe("done");
			if (settled.status !== "done" || settled.type !== "input") throw new Error("expected an input answer");

			const entries = await entriesOf(root);
			const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
			// The stop is structural: exactly one assistant turn (the one that asked
			// to finish), and no further model request.
			expect(assistantEntries).toHaveLength(1);
			const result = toolResultOf(entries, "finish_task");
			expect(result?.isError).toBe(false);
			// The tool says the round is asking to end; it does not claim completion.
			expect(result?.text).toContain("asking to end");
			expect(result?.text).not.toContain("Finished");
			// The model's work is persisted in the call it made.
			expect(JSON.stringify(assistantEntries[0]?.model ?? [])).toContain("Revenue is 1,204 units, quoted from the material.");
			// Real identifiers, for a reader reopening this database.
			expect({ conversationId: root.id, submissionEntry: settled.entry, answer: settled.answer, assistant: assistantEntries.map((e) => e.id) }).toEqual({
				conversationId: root.id,
				submissionEntry: settled.entry,
				answer: settled.answer,
				assistant: assistantEntries.map((e) => e.id),
			});
		} finally {
			await runtime.close();
		}
	});

	it("refuses the submission when the round could contain another call", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [
				[
					{ name: "finish_task", arguments: { summary: "Submitted next to a sibling call." } },
					{ name: "sibling_noop", arguments: {} },
				],
			],
			fauxResponses: ["Answer after the refused submission."],
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool(), siblingTool] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify, then also do the sibling.", requestId: "finish-refused-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");

			const entries = await entriesOf(root);
			const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
			// The round did not stop: the submission was refused, so the model got
			// another turn. Returning a control here would have told it "Finished"
			// while the run continued.
			expect(assistantEntries).toHaveLength(2);
			const result = toolResultOf(entries, "finish_task");
			expect(result?.isError).toBe(true);
			expect(result?.text).toContain("sibling_noop");
		} finally {
			await runtime.close();
		}
	});
});
describe("TASK-005.1 finish — an invalid submission is never a stop (AC-05)", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-state-invalid-"));
		databasePath = join(directory, "state.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("refuses an empty summary and lets the round continue", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "" } }]],
			fauxResponses: ["Answer after the refused submission."],
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool()] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Submit an empty summary.", requestId: "finish-invalid-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");

			const entries = await entriesOf(root);
			const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
			// The round continued past the refused submission.
			expect(assistantEntries).toHaveLength(2);
			const result = toolResultOf(entries, "finish_task");
			expect(result?.isError).toBe(true);
			expect(entries.filter((entry) => entry.kind === "pi.tool-result").length).toBeGreaterThanOrEqual(1);
		} finally {
			await runtime.close();
		}
	});
});

describe("TASK-005.1 finish — reopening settles nothing twice (AC-03, AC-05)", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-state-reopen-"));
		databasePath = join(directory, "state.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("keeps the settled round unchanged across a reopen", async () => {
		const first: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "Revenue is 1,204 units, quoted from the material." } }]],
			fauxRouter: () => {
				throw new Error("a reopen must not make a provider request");
			},
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool()] })],
		});
		let before: readonly string[];
		try {
			const root = await openRoot(first);
			first.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify the figure.", requestId: "finish-reopen-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");
			before = (await entriesOf(root)).map((entry) => `${entry.kind}#${entry.id}`);
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
			const after = (await entriesOf(root)).map((entry) => `${entry.kind}#${entry.id}`);
			// Same conversation, same entries in the same order: a settled round is
			// not re-run and its outcome is not rewritten by the reopen.
			expect(after).toEqual(before);
			expect(after.filter((kind) => kind.startsWith("pi.assistant"))).toHaveLength(1);
		} finally {
			await second.close();
		}
	});
});
describe("TASK-005.1 documents — write, close, reopen (AC-03)", () => {
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
			taskSpecVersion: 1,
			planVersion: 1,
			assembledPrompt: "Check the supplied material only.",
			skillVersion: "1.0.0",
			skillHash: "a".repeat(64),
			tools: [{ name: "finish_task", version: "1.0.0" }],
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
			evidence: [],
			work: { summary: "The figure matches.", findings: [], unresolved: [], artifacts: [] },
		});
		if (!clarification.ok || !plan.ok || !snapshot.ok || !result.ok) throw new Error("fixture documents must validate");

		const runtime: ProbeRuntime = await openProbe({ databasePath, provider: "faux" });
		try {
			const root = await openRoot(runtime);
			// One commit for all five documents, the way the runtime writes them.
			await runtime.harness.commit(
				async (tx) => {
					const request = await tx.doc(AgentRequestDoc, root.id, requestId, { requestId });
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
		} finally {
			await runtime.close();
		}

		const reopened = await openProbe({ databasePath, provider: "faux" });
		try {
			const root = await openRoot(reopened);
			// Read-only snapshots: no commit, so nothing is written by reading.
			const request = await reopened.harness.snapshot(AgentRequestDoc, root.id as never, requestId, context);
			const clarificationRead = await reopened.harness.snapshot(AgentClarificationDoc, root.id as never, requestId, context);
			const planRead = await reopened.harness.snapshot(AgentPlanDoc, root.id as never, planId, context);
			const configRead = await reopened.harness.snapshot(AgentTaskConfigDoc, root.id as never, taskId, context);
			const resultRead = await reopened.harness.snapshot(AgentTaskResultDoc, root.id as never, taskId, context);
			if (clarificationRead === undefined || planRead === undefined || configRead === undefined || resultRead === undefined || request === undefined) {
				throw new Error("every document must survive the reopen");
			}

			// Field for field, after a real close and reopen of the SQLite file.
			expect(request.text).toBe("Verify the revenue figure.");
			expect(request.materials).toEqual([{ id: "mat-1", content: "Revenue is 1,204 units.", source: "provided-by-user" }]);
			expect(request.inputEntryId).toBe("31");
			expect(clarificationRead.answers[0]?.source).toBe("application");
			expect(clarificationRead.answers[0]?.sufficient).toBe(true);
			expect(clarificationRead.questions[0]?.blockingScope).toEqual(["scope"]);
			expect(planRead.version).toBe(1);
			expect(planRead.taskIds).toEqual([taskId]);
			expect(configRead.snapshot?.contractRevision).toBe(1);
			expect(configRead.snapshot?.tools).toEqual([{ name: "finish_task", version: "1.0.0" }]);
			expect(resultRead.result?.runtime.status).toBe("completed");
			expect(resultRead.result?.work.summary).toBe("The figure matches.");

			// And the documents still validate after the reopen: surviving is not
			// the same as still being a contract.
			expect(validateClarificationState(clarificationRead).ok).toBe(true);
			expect(validatePlan(planRead).ok).toBe(true);
			expect(validateTaskConfigSnapshot(configRead.snapshot).ok).toBe(true);
			expect(validateTaskResult(resultRead.result).ok).toBe(true);
		} finally {
			await reopened.close();
		}
	});
});
describe("TASK-005.1 documents — evidence attribution against real entries (AC-04)", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-evidence-"));
		databasePath = join(directory, "evidence.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("refuses an entry that belongs to another conversation", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxResponses: ["Child answer.", "Other conversation answer."],
		});
		try {
			// The child conversation, and a foreign one with its own entries.
			const child = await openRoot(runtime);
			const foreign = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
			await foreign.configure({ model: runtime.modelRef }, context);
			runtime.harness.resume();

			const childSubmission = await child.submit({ type: "input", content: "Do the work.", requestId: "evidence-child-1" }, context);
			expect((await childSubmission.wait(context)).status).toBe("done");
			const foreignSubmission = await foreign.submit({ type: "input", content: "Somebody else's work.", requestId: "evidence-foreign-1" }, context);
			expect((await foreignSubmission.wait(context)).status).toBe("done");

			const indexEntries = (entries: readonly EntryRecord[]): Map<string, PersistedEntryIndex> =>
				new Map(entries.map((entry) => [String(entry.id), { entryId: String(entry.id), conversationId: String(entry.conversationId), taskId: entry.byTaskId === undefined ? undefined : String(entry.byTaskId), kind: entry.kind }]));
			// The index is everything the program can see: the child conversation *and*
			// the other one. Attribution, not lookup, is what must refuse the forgery.
			const childIndex = indexEntries([...(await entriesOf(child)), ...(await entriesOf(foreign))]);
			const foreignEntry = (await entriesOf(foreign)).find((entry) => entry.kind === "pi.assistant");
			expect(foreignEntry).toBeDefined();
			if (foreignEntry === undefined) return;

			// The program binds the durable tasks it owns to the business task; the child's
			// own assistant entry was produced by one of them.
			const ownEntry = (await entriesOf(child)).find((entry) => entry.kind === "pi.assistant");
			expect(ownEntry).toBeDefined();
			if (ownEntry === undefined) return;
			const ownedDurableTaskIds = ownEntry.byTaskId === undefined ? [] : [String(ownEntry.byTaskId)];
			const contextForTask = { childConversationId: String(child.id), businessTaskId: "task-a", ownedDurableTaskIds, round: 1 };
			// A reference to the foreign conversation's own entry, claiming this task.
			const forged = assembleTaskResult({
				resultId: "result-1",
				runtime: { taskId: "task-a", round: 1, status: "completed", attempts: 1, technicalRestarts: 0, toolInvocations: 1, sideEffect: "recorded", settledAt: 1 },
				work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
				evidence: [{ entryId: String(foreignEntry.id), kind: "pi.assistant", byTaskId: "task-a" }],
				knownEntries: childIndex,
				attribution: contextForTask,
			});
			expect(forged.ok).toBe(false);
			if (!forged.ok) expect(forged.violations.map((item) => item.code)).toContain("evidence_conversation_foreign");

			// The same entry number would be accepted only if it were the child's.
			const honest = assembleTaskResult({
				resultId: "result-1",
				runtime: { taskId: "task-a", round: 1, status: "completed", attempts: 1, technicalRestarts: 0, toolInvocations: 1, sideEffect: "recorded", settledAt: 1 },
				work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
				evidence: [{ entryId: String(ownEntry.id), kind: "pi.assistant" }],
				knownEntries: childIndex,
				attribution: contextForTask,
			});
			expect(honest.ok).toBe(true);
		} finally {
			await runtime.close();
		}
	});
});
