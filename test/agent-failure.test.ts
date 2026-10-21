// TASK-005.4 test/agent-failure.test.ts
//
// AC-04 — one member's failure does not withhold another member's result; every
// settled round persists a result, including a round that ended without a
// `finish`; and what Main receives is the program's own entry and call evidence,
// never the model's account of what it claims to have done.
//
// AC-05 — Main reworks one task by round and restarts a technically failed round;
// the original conversation, budget and history carry into the next round, and a
// task that already reached a terminal state refuses new work.
//
// The `run_batch` tool below is test-only. The production Main agent's tool set is
// `request_clarification`, `save_plan`, `dispatch_tasks` (`MAIN_TOOL_NAMES`), so
// no production entry point calls `runTaskBatch` directly; the service exposes
// `extensionsExtra` as a composition hook, and this file uses it to make a real
// durable Main tool call. The tool records what the runtime returned in a test
// array, so every assertion about a returned result is about a returned value,
// never about model text.
//
// Every number is stated in this file. Nothing here is a product default.

import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { TaskResult } from "../src/agent/contracts/task-result.ts";
import { AgentPlanDoc } from "../src/agent/contracts/documents.ts";
import { BatchIndexDoc } from "../src/agent/runtime/documents.ts";
import type { BatchRuntime } from "../src/agent/runtime/runtime.ts";
import { context } from "../src/runtime.ts";
import {
	type BatchSystem,
	type ChildRouter,
	childAnswer,
	driveMain,
	flattenRequest,
	mainRouter,
	type MainStep,
	openBatchSystem,
	onlyBatchId,
	readBatch,
	readBatchIndex,
	readEntries,
	readLedger,
	readQuota,
	readResult,
	readScheduler,
	runConfigOf,
	submittedTaskId,
} from "./helpers/batch-system.ts";

const PLAN_ID = "plan-failure";
const MAIN_MARKER = "MAIN-MARKER-5E12";
const MATERIAL = "MATERIAL-3: alpha beta alpha";
const FEEDBACK_ONE = "the answer must also name the second count";
const FEEDBACK_TWO = "still not enough; name both counts in one sentence";
const ANSWER_ONE = "counted the marker once";
const ANSWER_TWO = "counted the marker twice, once per round";

/** Every limit this suite spends is stated here. */
function configOf(overrides: Record<string, unknown>) {
	return runConfigOf({
		schemaVersion: 1,
		maxConcurrentSubAgents: 2,
		maxSubAgentsPerRequest: 4,
		maxToolInvocationsPerRound: 4,
		maxFailedToolCallsPerRound: 2,
		maxAttemptsPerOperation: 2,
		maxTechnicalRestarts: 1,
		roundTimeoutMs: 10_000,
		providerRetry: { maxRetries: 0, backoffMs: 0 },
		harnessRetry: { maxRetries: 0, backoffMs: 0 },
		...overrides,
	});
}

const BUDGET = { maxToolInvocations: 3, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 8_000 };

/** The raw body sent through `dispatch_tasks`; the saved contract is its validated twin. */
function specBody(id: string): JsonObject {
	return {
		schemaVersion: 1,
		id,
		purpose: `do ${id}`,
		materials: [{ id: "material-1", content: MATERIAL, source: "user note" }],
		scope: ["use only the supplied material"],
		exclusions: [],
		constraints: ["use only the granted tools"],
		outputContract: { format: "text", requiredFields: ["summary"] },
		acceptance: ["the answer names the count"],
		skillId: "material-summary",
		requestedTools: ["text_stats"],
		dependencies: [],
		budget: { ...BUDGET },
	};
}

/** What one `run_batch` call returned, recorded program-side. */
type RunBatchCall = {
	readonly taskIds: readonly string[];
	readonly results: readonly TaskResult[];
	readonly error?: string;
};

/**
 * The test-only Main tool that calls `runTaskBatch`, and the extension that
 * carries it.
 *
 * It derives the batch id from the session's admitted-batch index and the plan
 * version from the stored plan, both program-side, so neither is a model argument
 * that could be wrong. `runtime` is a thunk because the tool has to exist before
 * the system that owns the runtime has been opened.
 */
function runBatchExtension(calls: RunBatchCall[], runtime: () => BatchRuntime): Extension {
	const tool = defineTool({
		name: "run_batch",
		description: "Test-only: run the admitted batch's members, or rework one, through runTaskBatch.",
		parameters: Type.Object({
			taskIds: Type.Array(Type.String()),
			reworkTaskId: Type.Optional(Type.String()),
			feedback: Type.Optional(Type.String()),
		}),
		replay: "unsafe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const ref = await api.commit(async (tx) => {
				const index = await tx.doc(BatchIndexDoc);
				const batchId = index.batches[0];
				if (batchId === undefined) throw new Error("run_batch: no batch was admitted");
				const plan = await tx.doc(AgentPlanDoc, api.conversationId, PLAN_ID, { planId: PLAN_ID });
				return { batchId, version: plan.version };
			}, callContext);
			try {
				const results = await runtime().runTaskBatch({ planId: PLAN_ID, version: ref.version }, [...args.taskIds], {
					api,
					batchId: ref.batchId,
					trigger:
						args.reworkTaskId === undefined
							? { kind: "dispatch" }
							: { kind: "rework", taskId: args.reworkTaskId, feedback: args.feedback ?? "" },
				});
				calls.push({ taskIds: [...args.taskIds], results });
				const text =
					results.length === 0
						? "runTaskBatch returned no persisted result"
						: results.map((result) => `${result.resultId}: ${result.runtime.status}`).join("\n");
				return { output: [{ type: "text" as const, text }] };
			} catch (error) {
				calls.push({
					taskIds: [...args.taskIds],
					results: [],
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	});
	return defineExtension({ name: "test-run-batch", tools: [tool] });
}

function countRows(databasePath: string, sql: string, params: readonly string[] = []): number {
	const require = createRequire(import.meta.url);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		return (db.prepare(sql).all(...params) as unknown[]).length;
	} finally {
		db.close();
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a predicate, failing with a useful message instead of hanging. */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await sleep(10);
	}
}

/** Poll an asynchronous predicate, failing with a useful message instead of hanging. */
async function waitUntil(predicate: () => Promise<boolean>, message: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(message);
		await sleep(10);
	}
}

/** A script that saves a plan and dispatches the given task bodies once. */
function saveAndDispatch(tasks: readonly JsonObject[], taskIds: readonly string[]): (flat: string) => readonly MainStep[] {
	return () => [
		[{ name: "save_plan", arguments: { planId: PLAN_ID, goals: ["run the batch"], taskIds: [...taskIds] } }],
		[{ name: "dispatch_tasks", arguments: { planId: PLAN_ID, version: 1, tasks: tasks.map((task) => task) } }],
	];
}

describe("TASK-005.4 failure — partial results, rework, restart and terminal refusal (AC-04, AC-05)", { timeout: 60_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-failure-"));
		databasePath = join(directory, "failure.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("returns the surviving member's result, persists one for the failed member, and proves the evidence is real (AC-04)", async () => {
		const calls: RunBatchCall[] = [];
		let runtime: BatchRuntime | undefined;
		const extension = runBatchExtension(calls, () => {
			if (runtime === undefined) throw new Error("run_batch ran before the runtime was bound");
			return runtime;
		});
		const child: ChildRouter = (request) => {
			const flat = flattenRequest(request.messages);
			const taskId = submittedTaskId(flat);
			if (taskId === undefined) throw new Error("child router saw a Main request");
			if (taskId === "task-broken") {
				// A non-retryable provider failure: no tool ever ran for this task, so its
				// round must still produce a result — program work, no evidence.
				return fauxAssistantMessage([fauxText("denied")], {
					stopReason: "error",
					errorMessage: "401 unauthorized: invalid api key",
				});
			}
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "ok-stats" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer(ANSWER_ONE))]);
		};
		const steps = (flat: string): readonly MainStep[] => [
			...saveAndDispatch([specBody("task-ok"), specBody("task-broken")], ["task-ok", "task-broken"])(flat),
			[{ name: "run_batch", arguments: { taskIds: ["task-ok", "task-broken"] } }],
		];
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(steps, child),
			runConfig: configOf({ maxTechnicalRestarts: 0 }),
			mainExtensions: [extension],
		});
		runtime = system.batch;
		try {
			await driveMain(system, `${MAIN_MARKER} run one broken task beside one good one`);

			const batchId = await onlyBatchId(system);
			const items = (await readBatch(system, batchId))?.items ?? [];
			const okReceipt = items.find((item) => item.taskId === "task-ok")?.receipt;
			const brokenReceipt = items.find((item) => item.taskId === "task-broken")?.receipt;

			// One member failed; the other is untouched by it.
			expect(okReceipt?.status).toBe("completed");
			expect(okReceipt?.resultId).toBe("res.task-ok.r1");
			expect(brokenReceipt?.status).toBe("failed");
			expect(brokenReceipt?.failureKind).toBe("technical");
			expect(brokenReceipt?.requiresMainDecision).toBe(true);
			// A round without a finish still has a result document, and the receipt
			// names the document it wrote.
			expect(brokenReceipt?.resultId).toBe("res.task-broken.r1");

			const ok = await readResult(system, "res.task-ok.r1");
			const broken = await readResult(system, "res.task-broken.r1");
			expect(ok?.taskId).toBe("task-ok");
			expect(ok?.result?.runtime.status).toBe("completed");
			expect(ok?.result?.work.summary).toBe(ANSWER_ONE);
			expect(broken?.taskId).toBe("task-broken");
			expect(broken?.result?.runtime.status).toBe("failed");
			expect(broken?.result?.evidence).toEqual([]);
			expect(broken?.result?.work.summary).toContain("401");

			// The entries the completed result points at are really in the child
			// conversation: the reference's kind and tool identity resolve.
			const ledger = await readLedger(system, "task-ok");
			const conversationId = ledger?.childConversationId;
			if (conversationId === undefined) throw new Error("the completed task has no child conversation");
			const entries = await readEntries(system, conversationId);
			const references = ok?.result?.evidence ?? [];
			expect(references.some((reference) => reference.toolName === "text_stats")).toBe(true);
			for (const reference of references) {
				const entry = entries.find((candidate) => candidate.entryId === reference.entryId);
				if (entry === undefined) throw new Error(`evidence entry ${reference.entryId} is not persisted`);
				expect(entry.kind).toBe(reference.kind);
				if (reference.toolName !== undefined) {
					expect(entry.toolName).toBe(reference.toolName);
					expect(entry.toolCallId).toBe(reference.toolCallId);
				}
			}

			// `runTaskBatch` returned both persisted results in the requested order and
			// ran nothing a second time: the exchange is a read of the round receipts.
			expect(calls).toHaveLength(1);
			expect(calls[0]?.results.map((result) => result.resultId)).toEqual(["res.task-ok.r1", "res.task-broken.r1"]);
			expect(calls[0]?.error).toBeUndefined();
			expect(countRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toBe(2);
			// Two child submissions, one per member; the Main request's own input is a
			// submission too, so the count is scoped to the round ids.
			expect(countRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:%"'])).toBe(2);
		} finally {
			await system.runtime.close();
		}
	});

	it("reworks one task into round 2 of the same child conversation, with the earlier answer in its history (AC-05)", async () => {
		const calls: RunBatchCall[] = [];
		let runtime: BatchRuntime | undefined;
		const extension = runBatchExtension(calls, () => {
			if (runtime === undefined) throw new Error("run_batch ran before the runtime was bound");
			return runtime;
		});
		const childFlats: string[] = [];
		const child: ChildRouter = (request) => {
			const flat = flattenRequest(request.messages);
			const taskId = submittedTaskId(flat);
			if (taskId !== "task-rework") throw new Error(`unexpected child request for ${String(taskId)}`);
			childFlats.push(flat);
			const rework = flat.includes(FEEDBACK_ONE);
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage(
					[fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: rework ? "stats-r2" : "stats-r1" })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([fauxText(childAnswer(rework ? ANSWER_TWO : ANSWER_ONE))]);
		};
		const steps = (flat: string): readonly MainStep[] => [
			...saveAndDispatch([specBody("task-rework")], ["task-rework"])(flat),
			[
				{
					name: "run_batch",
					arguments: { taskIds: ["task-rework"], reworkTaskId: "task-rework", feedback: FEEDBACK_ONE },
				},
			],
		];
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(steps, child),
			runConfig: configOf({ maxTechnicalRestarts: 0 }),
			mainExtensions: [extension],
		});
		runtime = system.batch;
		try {
			await driveMain(system, `${MAIN_MARKER} rework one task`);

			const batchId = await onlyBatchId(system);
			const item = (await readBatch(system, batchId))?.items[0];
			expect(item?.receipt?.round).toBe(2);
			expect(item?.receipt?.status).toBe("completed");
			expect(item?.receipt?.resultId).toBe("res.task-rework.r2");

			const ledger = await readLedger(system, "task-rework");
			expect(ledger?.status).toBe("awaiting_review");
			expect(ledger?.currentRound).toBe(2);
			expect(ledger?.activeOpKey).toBeUndefined();
			expect(ledger?.rounds.map((round) => [round.round, round.kind])).toEqual([
				[1, "initial"],
				[2, "revision"],
			]);
			// The rework carries its feedback and its own submission identity; the initial
			// round keeps the text it was authorized against.
			expect(ledger?.rounds[0]?.task).not.toContain(FEEDBACK_ONE);
			expect(ledger?.rounds[1]?.task).toContain(FEEDBACK_ONE);
			expect(ledger?.rounds[1]?.requestId).toBe("multiagent-round:task-rework:2");
			expect(ledger?.rounds[1]?.execution?.attempts.map((attempt) => attempt.requestId)).toEqual([
				"multiagent-round:task-rework:2",
			]);

			// Two executions, two revision attempts — and both rounds in one child
			// conversation, so the original history is what round 2 runs on.
			const quota = await readQuota(system, "req-batch");
			expect(quota?.instancesUsed).toBe(2);
			expect(quota?.operations).toHaveLength(1);
			expect(quota?.operations[0]?.attemptsUsed).toBe(2);
			expect(countRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toBe(1);
			expect(countRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-rework:%"'])).toBe(2);

			const first = await readResult(system, "res.task-rework.r1");
			const second = await readResult(system, "res.task-rework.r2");
			expect(first?.result?.work.summary).toBe(ANSWER_ONE);
			expect(second?.result?.work.summary).toBe(ANSWER_TWO);
			expect(second?.result?.runtime.round).toBe(2);
			expect(second?.result?.runtime.attempts).toBe(2);

			// Round 2's provider request carried round 1's answer and the feedback: the
			// rework is a continuation of the same conversation, not a fresh one.
			const roundTwo = childFlats.filter((flat) => flat.includes(FEEDBACK_ONE));
			expect(roundTwo.length).toBeGreaterThan(0);
			expect(roundTwo[0]).toContain(ANSWER_ONE);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.results.map((result) => result.resultId)).toEqual(["res.task-rework.r2"]);
		} finally {
			await system.runtime.close();
		}
	});

	it("refuses a further rework at admission when the attempt allowance is spent, and charges nothing for it (AC-05)", async () => {
		const calls: RunBatchCall[] = [];
		let runtime: BatchRuntime | undefined;
		const extension = runBatchExtension(calls, () => {
			if (runtime === undefined) throw new Error("run_batch ran before the runtime was bound");
			return runtime;
		});
		const child: ChildRouter = (request) => {
			const flat = flattenRequest(request.messages);
			const taskId = submittedTaskId(flat);
			if (taskId !== "task-budget") throw new Error(`unexpected child request for ${String(taskId)}`);
			const rework = flat.includes(FEEDBACK_ONE);
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage(
					[fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: rework ? "stats-r2" : "stats-r1" })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([fauxText(childAnswer(rework ? ANSWER_TWO : ANSWER_ONE))]);
		};
		const steps = (flat: string): readonly MainStep[] => [
			...saveAndDispatch([specBody("task-budget")], ["task-budget"])(flat),
			[{ name: "run_batch", arguments: { taskIds: ["task-budget"], reworkTaskId: "task-budget", feedback: FEEDBACK_ONE } }],
			// The contract allows a second revision (`MAX_REVISIONS` is 2), so the refusal
			// has to come from the request's attempt budget, not from the contract.
			[{ name: "run_batch", arguments: { taskIds: ["task-budget"], reworkTaskId: "task-budget", feedback: FEEDBACK_TWO } }],
		];
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(steps, child),
			runConfig: configOf({ maxTechnicalRestarts: 0 }),
			mainExtensions: [extension],
		});
		runtime = system.batch;
		try {
			await driveMain(system, `${MAIN_MARKER} exhaust the rework allowance`);

			expect(calls).toHaveLength(2);
			// The refused call is a normal answer, not an exception: no round ran, so
			// there is no result document for it to return.
			expect(calls[1]?.error).toBeUndefined();
			expect(calls[1]?.results).toEqual([]);

			const batchId = await onlyBatchId(system);
			const receipt = (await readBatch(system, batchId))?.items[0]?.receipt;
			expect(receipt?.round).toBe(3);
			expect(receipt?.status).toBe("failed");
			expect(receipt?.failureKind).toBe("technical");
			expect(receipt?.requiresMainDecision).toBe(true);
			expect(receipt?.resultId).toBeUndefined();
			expect(receipt?.detail).toContain("quota_exhausted");

			// The refused round spent nothing: no instance, no attempt, no round record.
			const quota = await readQuota(system, "req-batch");
			expect(quota?.instancesUsed).toBe(2);
			expect(quota?.operations[0]?.attemptsUsed).toBe(2);
			const ledger = await readLedger(system, "task-budget");
			expect(ledger?.currentRound).toBe(2);
			expect(ledger?.rounds).toHaveLength(2);
			expect(ledger?.activeOpKey).toBeUndefined();
			expect((await readScheduler(system)).active).toEqual([]);
		} finally {
			await system.runtime.close();
		}
	});

	it("restarts a technically failed round in the same conversation and charges a restart, not an attempt (AC-05)", async () => {
		let childArrivals = 0;
		const flatHistory: string[] = [];
		const child: ChildRouter = (request) => {
			const flat = flattenRequest(request.messages);
			flatHistory.push(flat);
			if (submittedTaskId(flat) === undefined) throw new Error("child router saw a Main request");
			childArrivals += 1;
			if (childArrivals === 1) {
				return fauxAssistantMessage([fauxText("denied")], {
					stopReason: "error",
					errorMessage: "401 unauthorized: invalid api key",
				});
			}
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "stats-restart" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer("recovered after the restart"))]);
		};
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(saveAndDispatch([specBody("task-restart")], ["task-restart"]), child),
			runConfig: configOf({ maxTechnicalRestarts: 1 }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} restart a technical failure`);

			const batchId = await onlyBatchId(system);
			const receipt = (await readBatch(system, batchId))?.items[0]?.receipt;
			expect(receipt?.status).toBe("completed");
			expect(receipt?.resultId).toBe("res.task-restart.r1");

			// One round, two attempts, the second submission in the same conversation.
			const ledger = await readLedger(system, "task-restart");
			expect(ledger?.rounds).toHaveLength(1);
			expect(ledger?.rounds[0]?.kind).toBe("initial");
			expect(ledger?.rounds[0]?.execution?.status).toBe("completed");
			expect(ledger?.rounds[0]?.execution?.technicalRestarts).toBe(1);
			const attempts = ledger?.rounds[0]?.execution?.attempts ?? [];
			expect(attempts.map((attempt) => attempt.requestId)).toEqual([
				"multiagent-round:task-restart:1",
				"multiagent-round:task-restart:1:a2",
			]);
			expect(attempts[0]?.error).toContain("401");
			expect(attempts[1]?.settledAt).toBeDefined();

			// A restart is paid from the restart budget alone: the attempt counter stays
			// at one because a revision is not what happened, and no second instance ran.
			const quota = await readQuota(system, "req-batch");
			expect(quota?.instancesUsed).toBe(1);
			expect(quota?.operations[0]?.attemptsUsed).toBe(1);
			expect(quota?.operations[0]?.technicalRestartsUsed).toBe(1);
			expect(quota?.operations[0]?.providerRetriesUsed).toBe(0);
			expect(countRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toBe(1);

			const result = await readResult(system, "res.task-restart.r1");
			expect(result?.result?.runtime.attempts).toBe(1);
			expect(result?.result?.runtime.technicalRestarts).toBe(1);
			expect(result?.result?.runtime.status).toBe("completed");

			// The retry ran on the same conversation and the same task: both attempt
			// submissions live in the one child conversation, and the second provider
			// request is another submission of the same contract.
			expect(flatHistory).toHaveLength(3);
			expect(flatHistory[1]).toContain("# Task task-restart");
			expect(
				countRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-restart:1%"']),
			).toBe(2);
		} finally {
			await system.runtime.close();
		}
	});

	it("refuses new work for a task a cancel already made terminal, and the refusal is in Main's transcript (AC-05)", async () => {
		let arrived = false;
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			if (!arrived) {
				arrived = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText(childAnswer("released after the cancel"))]);
		};
		const mainFlats: string[] = [];
		const firstTurns = saveAndDispatch([specBody("task-terminal")], ["task-terminal"]);
		const scripted = mainRouter(
			(flat): readonly MainStep[] => [
				...firstTurns(flat),
				// The same task, dispatched again as a new call: a new operation key and a
				// new batch, which is what makes the refusal come from the ledger's
				// terminal status instead of from this batch's receipt.
				[{ name: "dispatch_tasks", arguments: { planId: PLAN_ID, version: 1, tasks: [specBody("task-terminal")] } }],
			],
			child,
		);
		// Record every Main request so the tool result Main actually saw is assertable.
		const capturing: FauxResponseFactory = (request, options, state, model) => {
			const flat = flattenRequest(request.messages);
			if (submittedTaskId(flat) === undefined) mainFlats.push(flat);
			return scripted(request, options, state, model);
		};
		const system = await openBatchSystem({
			databasePath,
			router: capturing,
			runConfig: configOf({ maxTechnicalRestarts: 0 }),
		});
		try {
			const driving = driveMain(system, `${MAIN_MARKER} cancel, then dispatch the same task again`);
			await waitFor(() => arrived, "the child never reached its first request");
			const batchId = await onlyBatchId(system);
			const stopping = system.batch.cancelBatch(batchId, "operator cancelled the run", context);
			// The cancel writes its intent first and aborts the child right after; the
			// parked provider call is released only once the intent is on record, so the
			// abort is what settles the round rather than a completed answer.
			await waitUntil(
				async () => (await readBatch(system, batchId))?.cancel !== undefined,
				"the cancel intent was never persisted",
			);
			await sleep(100);
			release?.();
			const stopped = await stopping;
			await driving;

			expect(stopped.state).toBe("cancelled");
			expect(stopped.items[0]?.state).toBe("cancelled");

			const ledger = await readLedger(system, "task-terminal");
			expect(ledger?.status).toBe("cancelled");
			expect(ledger?.activeOpKey).toBeUndefined();
			expect((await readScheduler(system)).active).toEqual([]);

			const ids = await readBatchIndex(system);
			const firstId = ids[0];
			const secondId = ids[1];
			if (firstId === undefined || secondId === undefined) throw new Error(`expected two admitted batches, found ${ids.length}`);
			expect((await readBatch(system, firstId))?.items[0]?.receipt?.status).toBe("cancelled");
			// The second dispatch was admitted as a batch and then refused by the load
			// phase: nothing ran, so its member has no receipt.
			expect((await readBatch(system, secondId))?.items[0]?.receipt).toBeUndefined();

			// The refusal Main received is the persisted tool result the next provider
			// request carried — a `task_terminal` diagnostic, not a model claim.
			const refusal = mainFlats.find((flat) => flat.includes("task_terminal"));
			if (refusal === undefined) throw new Error("Main's transcript never carried the task_terminal refusal");
			expect(refusal).toContain("task task-terminal is cancelled");
		} finally {
			release?.();
			await system.runtime.close();
		}
	});
});
