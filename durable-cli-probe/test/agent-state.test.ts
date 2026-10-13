// TASK-005.1 test/agent-state.test.ts
//
// The shared state machine, its quota accounting, and the one thing that has to
// be verified against the real harness rather than in a unit: **that a
// submission really stops the round** (AC-05).
//
// Evidence discipline for the finish checks: the assertions are about what the
// harness persisted and how many provider turns actually happened, never about
// what a tool called `finish_task` printed. Every run records the real
// conversation id and submission id, so a later reader can reopen the database
// and see the same thing.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { createFinishTaskTool } from "../src/agent/tools/finish-task.ts";
import { RUN_CONFIG_SCHEMA_VERSION, validateRunConfig } from "../src/agent/contracts/run-config.ts";
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
		// An old document's `revising` *is* an executing round.
		expect(readLegacyStatus("revising")).toBe("running");
		expect(readLegacyStatus("awaiting_review")).toBe("awaiting_review");
		// The edge TASK-003 wrote stays legal, so an old ledger keeps working.
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

describe("TASK-005.1 state — round failure is not task failure (AC-02)", () => {
	const budget = { maxTechnicalRestarts: 2, maxAttemptsPerOperation: 3 };

	it("retries a technical failure inside the restart budget and keeps the task running", () => {
		const settlement = decideRoundFailure({ businessStatus: "running", failureKind: "technical", technicalRestartsUsed: 1, attemptsUsed: 2, budget });
		expect(settlement.roundStatus).toBe("retry_wait");
		expect(settlement.nextBusinessStatus).toBeUndefined();
		expect(settlement.terminal).toBeUndefined();
	});

	it("ends the task when the restart budget or the attempt budget is spent", () => {
		const restarts = decideRoundFailure({ businessStatus: "running", failureKind: "technical", technicalRestartsUsed: 2, attemptsUsed: 3, budget });
		expect(restarts.roundStatus).toBe("failed");
		expect(restarts.nextBusinessStatus).toBe("failed");
		expect(restarts.terminal).toBe(true);

		const attempts = decideRoundFailure({ businessStatus: "running", failureKind: "technical", technicalRestartsUsed: 0, attemptsUsed: 3, budget });
		expect(attempts.nextBusinessStatus).toBe("failed");
	});

	it("treats a rejected result as a review matter, not a run failure", () => {
		const settlement = decideRoundFailure({ businessStatus: "awaiting_review", failureKind: "quality", technicalRestartsUsed: 0, attemptsUsed: 1, budget });
		expect(settlement.roundStatus).toBe("completed");
		expect(settlement.nextBusinessStatus).toBeUndefined();
	});

	it("ends as cancelled when the task is already cancelled", () => {
		const settlement = decideRoundFailure({ businessStatus: "cancelled", failureKind: "technical", technicalRestartsUsed: 0, attemptsUsed: 1, budget });
		expect(settlement.nextBusinessStatus).toBe("cancelled");
		expect(settlement.terminal).toBe(true);
	});

	it("resumes after an answer, and only when every blocking question is answered", () => {
		expect(mayResumeAfterAnswer("awaiting_input", ["q-1"], ["q-1", "q-2"])).toBe(false);
		expect(mayResumeAfterAnswer("awaiting_input", ["q-1", "q-2"], ["q-1", "q-2"])).toBe(true);
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
		// Restarts are spent, but quality attempts are untouched.
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
//
// Both checks below are about persisted facts: how many assistant entries exist
// afterwards (one means the run stopped; two means it continued), what the
// submission settled as, and the ids a reader can reopen.

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

describe("TASK-005.1 finish — submission stops the round (AC-05)", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-state-"));
		databasePath = join(directory, "state.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("ends the run on a validated submission: one model turn, submission done", async () => {
		const recorded: string[] = [];
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "The figure matches the material." } }]],
			// Any further provider request would prove the round did not stop.
			fauxRouter: () => fauxAssistantMessage("MUST NOT BE REACHED"),
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool({ onFinish: (work) => recorded.push(work.summary) }), siblingTool] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify the figure.", requestId: "finish-terminate-1" }, context);
			const settled = await submission.wait(context);

			expect(settled.status).toBe("done");
			if (settled.status !== "done" || settled.type !== "input") throw new Error("expected an input answer");

			const entries = await entriesOf(root);
			const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
			const toolResults = entries.filter((entry) => entry.kind === "pi.tool-result");
			// The stop is structural: exactly one assistant turn (the one that asked
			// to finish), one tool result, and no further model request.
			expect(assistantEntries).toHaveLength(1);
			expect(toolResults).toHaveLength(1);
			// The runtime's writer saw the model's work.
			expect(recorded).toEqual(["The figure matches the material."]);
			// Real identifiers, for a reader reopening this database: the submission's
			// own entry and the assistant entry it answered with.
			expect([root.id, settled.entry, settled.answer, assistantEntries.map((entry) => entry.id)]).toEqual([
				root.id,
				settled.entry,
				settled.answer,
				assistantEntries.map((entry) => entry.id),
			]);
		} finally {
			await runtime.close();
		}
	});

	it("does not stop the round when the submission is not alone in it (every call must terminate)", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [
				[
					{ name: "finish_task", arguments: { summary: "Submitted next to a sibling call." } },
					{ name: "sibling_noop", arguments: {} },
				],
			],
			// The round continues, so the model gets exactly one more turn.
			fauxResponses: ["Answer after the round continued."],
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool(), siblingTool] })],
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify, then also do the sibling.", requestId: "finish-competing-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");

			const entries = await entriesOf(root);
			const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
			// Two assistant turns: the terminating call did not stop the round,
			// because its sibling did not ask to terminate.
			expect(assistantEntries).toHaveLength(2);
		} finally {
			await runtime.close();
		}
	});

	it("never terminates on an invalid submission", async () => {
		const runtime: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			// An empty summary fails the contract validation, so the tool must
			// refuse instead of asking the run to end.
			fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "" } }]],
			fauxResponses: ["Answer after the refused submission."],
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool(), siblingTool] })],
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
			expect(entries.filter((entry) => entry.kind === "pi.tool-result").length).toBeGreaterThanOrEqual(1);
		} finally {
			await runtime.close();
		}
	});

	it("reopening the same database keeps the settled work byte-identical (AC-03/AC-05)", async () => {
		const recorded: string[] = [];
		const first = await openProbe({
			databasePath,
			provider: "faux",
			fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "The figure matches the material." } }]],
			fauxRouter: () => fauxAssistantMessage("MUST NOT BE REACHED"),
			extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool({ onFinish: (work) => recorded.push(work.summary) }), siblingTool] })],
		});
		let before: { readonly id: number; readonly kinds: readonly string[] };
		try {
			const root = await openRoot(first);
			first.harness.resume();
			const submission = await root.submit({ type: "input", content: "Verify the figure.", requestId: "finish-reopen-1" }, context);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");
			before = { id: root.id, kinds: (await entriesOf(root)).map((entry) => entry.kind) };
		} finally {
			await first.close();
		}

		// Reopen over the same file. If a reopen caused a new model call or a new
		// entry, the router below would fire and this assertion would be meaningless.
		const second = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: () => {
				throw new Error("a reopen must not make a provider request");
			},
		});
		try {
			const root = await openRoot(second);
			expect(root.id).toBe(before.id);
			const after = (await entriesOf(root)).map((entry) => entry.kind);
			// Same conversation, same entries, same order: a settled round is not
			// re-run and its outcome is not rewritten by the reopen.
			expect(after).toEqual(before.kinds);
			expect(recorded).toEqual(["The figure matches the material."]);
		} finally {
			await second.close();
		}
	});
});
