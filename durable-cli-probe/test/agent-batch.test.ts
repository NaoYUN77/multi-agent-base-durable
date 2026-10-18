// TASK-005.4 test/agent-batch.test.ts
//
// AC-01 — two different tasks prove they ran *at the same time*, and a second
// dispatch or rework of one task produces one winner rather than two executions.
//
// The concurrency proof is a real handshake, not a label: each child's first
// provider request parks inside the router until the *other* child's first
// request has arrived. A serialized implementation never gets the second
// arrival, so `overlapped` stays false and the test fails. A parallel one gets
// it while the first child is still parked in the provider call — which is the
// exact fact AC-01 asks for.
//
// The single-winner proof is counted: one child conversation, one submission
// for the round's stable request id, one instance reservation, one attempt.

import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import {
	type ChildRouter,
	childAnswer,
	driveMain,
	flattenRequest,
	openBatchSystem,
	onlyBatchId,
	readBatch,
	readLedger,
	readQuota,
	readScheduler,
	runConfigOf,
	submittedTaskId,
} from "./helpers/batch-system.ts";

const MAIN_MARKER = "MAIN-MARKER-7C41";
const MATERIAL = "MATERIAL-1: alpha beta alpha";

/** Every number this suite spends is stated here, not inherited from a product default. */
const RUN_CONFIG = runConfigOf({
	schemaVersion: 1,
	maxConcurrentSubAgents: 2,
	maxSubAgentsPerRequest: 4,
	maxToolInvocationsPerRound: 4,
	maxFailedToolCallsPerRound: 2,
	maxAttemptsPerOperation: 2,
	maxTechnicalRestarts: 1,
	roundTimeoutMs: 10_000,
	providerRetry: { maxRetries: 1, backoffMs: 5 },
	harnessRetry: { maxRetries: 0, backoffMs: 0 },
});

const BUDGET = { maxToolInvocations: 3, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 8_000 };

/** The raw body sent through `dispatch_tasks`; the validated twin proves it is a legal contract. */
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

/** One provider request, flattened. */
function flatOf(messages: readonly Message[]): string {
	return flattenRequest(messages);
}

type MainStep = readonly { readonly name: string; readonly arguments: JsonObject }[];

/**
 * A router that serves Main from a script and children from `child`.
 *
 * The scripted turn advances once per provider request that follows a completed
 * tool round. A stateless "turn 0 or turn 1" reading would re-run the dispatch
 * forever, because the request after the dispatch also carries tool results.
 */
function scriptedRouter(script: (flat: string) => readonly MainStep[], child: ChildRouter): FauxResponseFactory {
	let turn = 0;
	return (request) => {
		const flat = flatOf(request.messages);
		if (submittedTaskId(flat) !== undefined) return child(request);
		if (request.messages.some((message) => message.role === "toolResult")) turn += 1;
		const calls = script(flat)[turn] ?? [];
		if (calls.length === 0) return fauxAssistantMessage([fauxText("nothing left to do")]);
		return fauxAssistantMessage(
			calls.map((call, index) => fauxToolCall(call.name, call.arguments, { id: `main-call-${turn}-${index}` })),
			{ stopReason: "toolUse" },
		);
	};
}

/** Save, then dispatch exactly the given task bodies. */
function dispatchScript(tasks: readonly JsonObject[], planTaskIds: readonly string[]): (flat: string) => readonly MainStep[] {
	return () => [
		[{ name: "save_plan", arguments: { planId: "plan-batch", goals: ["run the batch"], taskIds: [...planTaskIds] } }],
		[{ name: "dispatch_tasks", arguments: { planId: "plan-batch", version: 1, tasks: tasks.map((task) => task) } }],
	];
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

describe("TASK-005.4 batch — concurrent execution and one winner (AC-01)", { timeout: 60_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-batch-"));
		databasePath = join(directory, "batch.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("runs two different tasks at the same time — the handshake proves the overlap", async () => {
		const arrived: string[] = [];
		let releaseBarrier: (() => void) | undefined;
		const barrier = new Promise<void>((resolve) => {
			releaseBarrier = resolve;
		});
		/** True only when child B arrived while child A was still parked in its first request. */
		let overlapped = false;
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flatOf(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			if (!arrived.includes(taskId)) {
				arrived.push(taskId);
				if (arrived.length === 2 && !overlapped) {
					overlapped = true;
					releaseBarrier?.();
				}
			}
			// A serial implementation never releases the barrier; the timeout keeps the
			// test failing instead of hanging, and `overlapped` stays false.
			await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "child-stats" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer(`counted the marker for ${taskId}`))]);
		};
		const system = await openBatchSystem({
			databasePath,
			router: scriptedRouter(
				dispatchScript([specBody("task-a"), specBody("task-b")], ["task-a", "task-b"]),
				child,
			),
			runConfig: RUN_CONFIG,
		});
		try {
			await driveMain(system, `${MAIN_MARKER} run two tasks`);
			expect(overlapped).toBe(true);
			expect(arrived.sort()).toEqual(["task-a", "task-b"]);
			const batchId = await onlyBatchId(system);
			const batch = await readBatch(system, batchId);
			expect(batch?.items.map((item) => item.receipt?.status)).toEqual(["completed", "completed"]);
			expect((await readScheduler(system)).active).toEqual([]);
		} finally {
			await system.runtime.close();
		}
	});

	it("a second dispatch of the same task in the same request yields one execution and one charge (AC-01)", async () => {
		const child: ChildRouter = (request) => {
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "child-stats" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer("one execution only"))]);
		};
		const script = (): readonly MainStep[] => [
			[{ name: "save_plan", arguments: { planId: "plan-batch", goals: ["run twice"], taskIds: ["task-same"] } }],
			[
				{ name: "dispatch_tasks", arguments: { planId: "plan-batch", version: 1, tasks: [specBody("task-same")] } },
				{ name: "dispatch_tasks", arguments: { planId: "plan-batch", version: 1, tasks: [specBody("task-same")] } },
			],
		];
		const system = await openBatchSystem({
			databasePath,
			router: scriptedRouter(script, child),
			runConfig: RUN_CONFIG,
		});
		try {
			await driveMain(system, `${MAIN_MARKER} dispatch twice`);
			// Two admitted batches (two dispatch calls, two operation keys)…
			const scheduler = await readScheduler(system);
			expect(scheduler.active).toEqual([]);
			expect(scheduler.queue).toEqual([]);
			// …but one child conversation, one submission, one instance and one attempt.
			expect(countRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toBe(1);
			expect(
				countRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-same:1"%']),
			).toBe(1);
			const quota = await readQuota(system, "req-batch");
			expect(quota?.instancesUsed).toBe(1);
			expect(quota?.operations).toHaveLength(1);
			expect(quota?.operations[0]?.attemptsUsed).toBe(1);
			const ledger = await readLedger(system, "task-same");
			expect(ledger?.rounds).toHaveLength(1);
			expect(ledger?.status).toBe("awaiting_review");
		} finally {
			await system.runtime.close();
		}
	});

	it("writes slot, quota, right and batch entry together, and writes none of them for a refused item (AC-02)", async () => {
		// ── Half one: while the child is parked, all four records exist. ──────
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let childArrived = false;
		const holdingChild: ChildRouter = async (request) => {
			if (!childArrived) {
				childArrived = true;
				await parked;
			}
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "child-stats" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer("held then finished"))]);
		};
		const holding = await openBatchSystem({
			databasePath,
			router: scriptedRouter(dispatchScript([specBody("task-held")], ["task-held"]), holdingChild),
			runConfig: RUN_CONFIG,
		});
		try {
			const driving = driveMain(holding, `${MAIN_MARKER} hold one task`);
			await waitFor(() => childArrived, "the child never reached its first request");
			const batchId = await onlyBatchId(holding);
			const batch = await readBatch(holding, batchId);
			const slot = (await readScheduler(holding)).active;
			expect(slot).toHaveLength(1);
			expect(slot[0]?.taskId).toBe("task-held");
			expect((await readQuota(holding, "req-batch"))?.instancesUsed).toBe(1);
			expect((await readLedger(holding, "task-held"))?.activeOpKey).toBe("task.task-held.r1");
			expect(batch?.items[0]?.attemptKey).toBe("task:task-held:r1:attempt:1");
			release?.();
			await driving;
		} finally {
			await holding.runtime.close();
		}

		// ── Half two: an item refused before admission writes no reservation. ─
		const refusedDatabase = join(directory, "batch-refused.sqlite");
		const refusedBody = { ...specBody("task-refused"), requestedTools: ["text_stats", "ghost_tool"] };
		const refusedChild: ChildRouter = () => fauxAssistantMessage([fauxText(childAnswer("never called"))]);
		const refused = await openBatchSystem({
			databasePath: refusedDatabase,
			router: scriptedRouter(dispatchScript([refusedBody], ["task-refused"]), refusedChild),
			runConfig: RUN_CONFIG,
		});
		try {
			await driveMain(refused, `${MAIN_MARKER} refuse one task`);
			const batchId = await onlyBatchId(refused);
			const receipt = (await readBatch(refused, batchId))?.items[0]?.receipt;
			expect(receipt?.status).toBe("failed");
			expect(receipt?.detail).toContain("tool_unknown");
			// No slot, no instance, no right: the refusal happened before any
			// reservation. The quota document itself exists as a zero-spend seed —
			// `gateRound` reads it before the grant, so a stop can settle against the
			// counters it holds — but nothing was charged into it.
			expect((await readScheduler(refused)).active).toEqual([]);
			const quota = await readQuota(refused, "req-batch");
			expect(quota?.instancesUsed).toBe(0);
			expect(quota?.operations).toEqual([]);
			expect((await readLedger(refused, "task-refused"))?.activeOpKey).toBeUndefined();
			// And the child never ran: no owned conversation exists.
			expect(countRows(refusedDatabase, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toBe(0);
		} finally {
			await refused.runtime.close();
		}
	});
});

/** Poll a predicate, failing with a useful message instead of hanging. */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
