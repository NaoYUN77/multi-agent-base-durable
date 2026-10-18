// TASK-005.4 test/agent-recovery.test.ts
//
// AC-06 — a process killed at any of four points in a round's life reopens under
// the same configuration, the same conversation and the same identifiers, and
// finishes without a duplicate receipt and without charging a quota twice:
//
//   claim-not-submitted  the round holds its slot and its attempt is open, and
//                        the child conversation does not exist yet;
//   created-not-input    the child conversation exists and is configured, and the
//                        round's input has not been submitted;
//   result-not-returned  the child answered, and no result document exists yet;
//   retry_wait           the round is parked between a retryable provider failure
//                        and its retry, with the retry already charged.
//
// The kill is a real `SIGKILL` of a real child process (`test/helpers/batch-runner.ts`),
// sent by a watcher thread that polls the same SQLite file. Nothing in this file
// pauses or aborts the run: the only shutdown path exercised is the process
// disappearing.
//
// AC-07 — cancelling a queued round, a running round, a round at the submit gate,
// and the whole request, leaves no live execution behind and no business call
// after the terminal state; and a deadline is not reported as a stop.
//
// Every number is stated in this file or in `helpers/recovery-scenario.ts`.
// Nothing here is a product default.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { apply } from "@earendil-works/chord/delta";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { AuthorizedTool } from "../src/agent/builder/authorization.ts";
import { context } from "../src/runtime.ts";
import {
	type ChildRouter,
	childAnswer,
	driveMain,
	flattenRequest,
	onlyBatchId,
	openBatchSystem,
	readBatch,
	readBatchIndex,
	readLedger,
	readQuota,
	readResult,
	readScheduler,
	runConfigOf,
	submittedTaskId,
	taskSpecOf,
	transcriptRouter,
	type BatchSystem,
	type MainStep,
} from "./helpers/batch-system.ts";
import {
	openRecoverySystem,
	RECOVERY_ANSWER,
	RECOVERY_BOUNDARIES,
	RECOVERY_REQUEST_ID,
	RECOVERY_RESULT_ID,
	RECOVERY_ROUND_REQUEST,
	RECOVERY_TASK_ID,
	type RecoveryBoundary,
} from "./helpers/recovery-scenario.ts";

const RUNNER = fileURLToPath(new URL("./helpers/batch-runner.ts", import.meta.url));
/** Node runs the repository's sources directly; the runner is a child process, so it needs both flags itself. */
const RUNNER_FLAGS = ["--conditions=source", "--experimental-strip-types"];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an asynchronous predicate, failing with a useful message instead of hanging. */
async function waitUntil(predicate: () => Promise<boolean>, message: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(message);
		await sleep(10);
	}
}

/** A read-only connection, opened per call: the test must never hold the file open while the runner writes it. */
function query(databasePath: string, sql: string, params: readonly (string | number)[] = []): readonly Record<string, unknown>[] {
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		return database.prepare(sql).all(...params) as Record<string, unknown>[];
	} finally {
		database.close();
	}
}

/**
 * One document's value as it stands on disk, base revision plus every delta.
 *
 * The tests need the state the *killed* process left, and there is no harness in
 * this process yet; the durable encoding is therefore read directly, the same way
 * the watcher reads it.
 */
function documentValue(databasePath: string, kind: string, key?: string): unknown {
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		// A session-scoped family has no key, and the store encodes "no key" as the
		// JSON text of the empty string — the same text a family keyed with `""`
		// would have, which is the point: there is one representation, not two.
		const row = database
			.prepare("SELECT id FROM documents WHERE kind = ? AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
			.get(JSON.stringify(kind), JSON.stringify(key ?? "")) as { readonly id: string } | undefined;
		if (row === undefined) return undefined;
		const base = database
			.prepare("SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1")
			.get(row.id) as { readonly seq: number; readonly version: string; readonly content: string } | undefined;
		if (base === undefined) return undefined;
		let value: unknown = JSON.parse(base.content);
		const tail = database
			.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq")
			.all(row.id, base.seq) as unknown as readonly { readonly kind: string; readonly version: string; readonly content: string }[];
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) continue;
			value = apply(value, JSON.parse(revision.content));
		}
		return value;
	} finally {
		database.close();
	}
}

/** The facts about a killed database the assertions compare against the recovered one. */
type KilledState = {
	readonly childConversations: readonly string[];
	readonly submissions: readonly { readonly requestId: string; readonly conversationId: string; readonly status: string }[];
	readonly nestedTaskId: string | undefined;
	readonly activeOpKey: string | undefined;
	readonly childConversationId: string | undefined;
};

function killedState(databasePath: string): KilledState {
	const index = documentValue(databasePath, "app.agent.runtime.batch-index") as { readonly batches?: readonly string[] } | undefined;
	const batchId = index?.batches?.[0];
	const batchDoc =
		batchId === undefined
			? undefined
			: (documentValue(databasePath, "app.agent.batch", batchId) as
					| { readonly items: readonly { readonly nestedTaskId?: string }[] }
					| undefined);
	const ledger = documentValue(databasePath, "app.multiagent.task-ledger", RECOVERY_TASK_ID) as
		| { readonly activeOpKey?: string; readonly childConversationId?: number | string }
		| undefined;
	const conversations = query(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL ORDER BY id").map((row) =>
		String(row.id),
	);
	const submissions = query(databasePath, "SELECT request_id, conversation_id, status FROM submissions ORDER BY id").map((row) => ({
		requestId: JSON.parse(String(row.request_id)) as string,
		conversationId: String(row.conversation_id),
		status: String(row.status),
	}));
	return {
		childConversations: conversations,
		submissions,
		nestedTaskId: batchDoc?.items[0]?.nestedTaskId,
		activeOpKey: ledger?.activeOpKey,
		// Conversation ids are numbers in the stored document and text in the row;
		// the state is compared field by field, so it normalises once, here.
		childConversationId: ledger?.childConversationId === undefined ? undefined : String(ledger.childConversationId),
	};
}

type RunnerOutcome = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
	readonly timedOut: boolean;
};

/**
 * Run the scenario in a child process until the watcher kills it.
 *
 * The 60 s bound is a test guard, not a scenario value: a run that neither
 * reaches the boundary nor finishes is a hang, and a hang has to fail rather
 * than take the suite down with it.
 */
function runUntilKilled(databasePath: string, markerPath: string, boundary: RecoveryBoundary): Promise<RunnerOutcome> {
	const child: ChildProcess = spawn(
		process.execPath,
		[...RUNNER_FLAGS, RUNNER, "--database", databasePath, "--boundary", boundary, "--marker", markerPath],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return new Promise<RunnerOutcome>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ code: null, signal: null, stderr, timedOut: true });
		}, 60_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stderr, timedOut: false });
		});
	});
}

/** The round's submission rows, which is what "no duplicate submission" is about. */
function roundSubmissions(databasePath: string): readonly { readonly requestId: string; readonly conversationId: string; readonly status: string }[] {
	return killedState(databasePath).submissions.filter((entry) => entry.requestId.startsWith(RECOVERY_ROUND_REQUEST));
}

/** Wait for the reopened process's recovery to settle the business task. */
async function waitForRecovery(system: BatchSystem): Promise<void> {
	await waitUntil(async () => {
		const ledger = await readLedger(system, RECOVERY_TASK_ID);
		return ledger?.status === "awaiting_review" || ledger?.status === "failed" || ledger?.status === "cancelled";
	}, "the reopened process never settled the interrupted task");
	await system.runtime.harness.waitForIdle(context);
}

describe("TASK-005.4 recovery — a killed process reopens into one execution (AC-06)", { timeout: 180_000 }, () => {
	let directory: string;
	let databasePath: string;
	let markerPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-recovery-"));
		databasePath = join(directory, "recovery.sqlite");
		markerPath = join(directory, "killed.marker");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it.each([...RECOVERY_BOUNDARIES])("kills at %s and reopens with the same ids and one receipt", async (boundary) => {
		const outcome = await runUntilKilled(databasePath, markerPath, boundary);

		// The kill happened, at the state the watcher named. A marker without a
		// killed process would claim an ordering that did not happen.
		expect(outcome.timedOut, "the runner did not exit; the watcher neither killed it nor did it finish").toBe(false);
		expect(outcome.code, `the runner exited ${String(outcome.code)} instead of being killed: ${outcome.stderr}`).not.toBe(0);
		expect(existsSync(markerPath)).toBe(true);
		expect(readFileSync(markerPath, "utf8").trim()).toBe(boundary);

		// What the killed process left, per boundary. These are the states AC-06
		// names, read from the same file the next process will open.
		const before = killedState(databasePath);
		const killedSubmissions = roundSubmissions(databasePath);
		expect(before.activeOpKey).toBe(`task.${RECOVERY_TASK_ID}.r1`);
		switch (boundary) {
			case "claim-not-submitted":
				expect(before.childConversations).toHaveLength(0);
				expect(killedSubmissions).toHaveLength(0);
				break;
			case "created-not-input":
				expect(before.childConversations).toHaveLength(1);
				expect(before.childConversationId).toBe(before.childConversations[0]);
				expect(killedSubmissions).toHaveLength(0);
				break;
			case "result-not-returned":
				expect(before.childConversations).toHaveLength(1);
				expect(killedSubmissions.map((entry) => entry.status)).toEqual(["done"]);
				expect(documentValue(databasePath, "app.agent.task-result", RECOVERY_RESULT_ID)).toBeUndefined();
				break;
			case "retry-wait":
				expect(before.childConversations).toHaveLength(1);
				expect(killedSubmissions.map((entry) => entry.status)).toEqual(["unanswered"]);
				break;
		}

		const system = await openRecoverySystem({ databasePath });
		try {
			await waitForRecovery(system);

			// The batch was not re-admitted: one item, the same durable task, one receipt.
			const batchId = await onlyBatchId(system);
			const item = (await readBatch(system, batchId))?.items[0];
			expect(before.nestedTaskId).toBeDefined();
			expect(item?.nestedTaskId).toBe(before.nestedTaskId);
			expect(item?.taskId).toBe(RECOVERY_TASK_ID);
			expect(item?.receipt?.status).toBe("completed");
			expect(item?.receipt?.resultId).toBe(RECOVERY_RESULT_ID);

			// One round, one business status, no right still held.
			const ledger = await readLedger(system, RECOVERY_TASK_ID);
			expect(ledger?.status).toBe("awaiting_review");
			expect(ledger?.currentRound).toBe(1);
			expect(ledger?.activeOpKey).toBeUndefined();
			expect(ledger?.rounds).toHaveLength(1);
			expect(ledger?.rounds[0]?.execution?.status).toBe("completed");

			// The quota counts the run once: one instance, one attempt, and a provider
			// retry only where the fixture actually made one.
			const quota = await readQuota(system, RECOVERY_REQUEST_ID);
			expect(quota?.instancesUsed).toBe(1);
			expect(quota?.operations).toHaveLength(1);
			expect(quota?.operations[0]?.attemptsUsed).toBe(1);
			expect(quota?.operations[0]?.technicalRestartsUsed).toBe(0);
			expect(quota?.operations[0]?.providerRetriesUsed).toBe(boundary === "retry-wait" ? 1 : 0);

			// One result document, from the round that was interrupted.
			const result = await readResult(system, RECOVERY_RESULT_ID);
			expect(result?.result?.runtime.status).toBe("completed");
			expect(result?.result?.runtime.attempts).toBe(1);
			expect(result?.result?.work.summary).toBe(RECOVERY_ANSWER);

			// The recovered conversation is the killed one, and every submission of the
			// round lives in it: recovery resumes the conversation, it does not start a
			// second one.
			const after = killedState(databasePath);
			expect(after.childConversations).toHaveLength(1);
			if (boundary === "claim-not-submitted") {
				// There was no child before the kill; the reopened process created exactly
				// one, and the ledger points at it.
				expect(String(ledger?.childConversationId)).toBe(after.childConversations[0]);
			} else {
				expect(after.childConversations).toEqual(before.childConversations);
				expect(after.childConversationId).toBe(before.childConversationId);
			}
			const expectedRequests =
				boundary === "retry-wait" ? [RECOVERY_ROUND_REQUEST, `${RECOVERY_ROUND_REQUEST}:a2`] : [RECOVERY_ROUND_REQUEST];
			expect(after.submissions.filter((entry) => entry.requestId.startsWith(RECOVERY_ROUND_REQUEST)).map((entry) => entry.requestId)).toEqual(
				expectedRequests,
			);
			for (const submission of after.submissions.filter((entry) => entry.requestId.startsWith(RECOVERY_ROUND_REQUEST))) {
				expect(submission.conversationId).toBe(after.childConversations[0]);
			}

			// Nothing is left executing.
			const scheduler = await readScheduler(system);
			expect(scheduler.active).toHaveLength(0);
			expect(scheduler.queue).toHaveLength(0);
		} finally {
			await system.runtime.close();
		}
	});
});

// ── AC-07 ─────────────────────────────────────────────────────────────────────
//
// A stop is checked at the three points a round can be stopped from — still
// queued, running, and after its input has been submitted but before any
// business call — plus the request-wide stop. Each test asserts the same three
// facts: the receipt says `cancelled`, nothing is left holding capacity, and no
// business call happens after the terminal state. The deadline test asserts the
// opposite of a stop: the round failed as a technical fault and the task was
// left for Main to decide about, because a clock is not a verdict on the work.

const CANCEL_PLAN_ID = "plan-cancel";
const CANCEL_MATERIAL = "MATERIAL-C: alpha beta alpha";
const CANCEL_BUDGET = { maxToolInvocations: 3, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 8_000 };

/** A promise the test resolves when it wants a parked child to continue. */
type Gate = { readonly promise: Promise<void>; readonly open: () => void };

function gate(): Gate {
	let open: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open: () => open?.() };
}

/** The run bounds the cancel tests share; every override is a number the test is exercising. */
function cancelConfig(overrides: Record<string, unknown> = {}): ReturnType<typeof runConfigOf> {
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

function cancelSpec(id: string, requestedTools: readonly string[] = ["text_stats"]) {
	return taskSpecOf({
		id,
		skillId: "material-summary",
		requestedTools,
		materials: [{ id: "material-1", content: CANCEL_MATERIAL, source: "user note" }],
		budget: CANCEL_BUDGET,
	});
}

/** Save the plan, dispatch the given members, then answer. Read from the transcript for the reason `transcriptRouter` states. */
function cancelScript(taskIds: readonly string[]): (flat: string) => MainStep {
	// Every AC-07 task is granted the counting tool: the observable in these tests is
	// whether a business call *ran*, and a tool the child was not granted could not
	// run for the wrong reason.
	const tasks = taskIds.map((id) => cancelSpec(id, ["counting_tool"]));
	return (flat) => {
		if (flat.includes(`dispatched plan ${CANCEL_PLAN_ID}`)) return [];
		if (flat.includes(`saved plan ${CANCEL_PLAN_ID}`)) {
			return [{ name: "dispatch_tasks", arguments: { planId: CANCEL_PLAN_ID, version: 1, tasks } }];
		}
		return [{ name: "save_plan", arguments: { planId: CANCEL_PLAN_ID, goals: ["run the cancel scenario"], taskIds: [...taskIds] } }];
	};
}

/**
 * A business tool that records each execution in the test process.
 *
 * The child transcript would show an attempted call either way; what a stop has
 * to prevent is the *execution*, and this is the only place that observes it.
 */
function countingTool(name: string, executed: string[]): AuthorizedTool {
	const tool = defineTool({
		name,
		description: "Records that it ran.",
		parameters: Type.Object({}),
		replay: "safe",
		execute: async () => {
			executed.push(name);
			return { output: [{ type: "text" as const, text: `${name} ran` }] };
		},
	});
	return {
		name,
		version: "1.0.0",
		registration: tool,
		extension: defineExtension({ name: `test-${name}`, tools: [tool] }),
		effects: { reads: [], writes: [] },
	};
}

describe("TASK-005.4 cancel — a stop ends the work and leaves nothing running (AC-07)", { timeout: 60_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-cancel-"));
		databasePath = join(directory, "cancel.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("cancels a queued round before it ever reaches a business call", async () => {
		const executed: string[] = [];
		const counting = countingTool("counting_tool", executed);
		const arrivals: string[] = [];
		const hold = gate();
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			arrivals.push(taskId);
			if (taskId === "task-hold") await hold.promise;
			return fauxAssistantMessage([fauxText(childAnswer(`finished ${taskId}`))]);
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(
				cancelScript(["task-hold", "task-queued"]),
				child,
			),
			// One slot, so the second member has to wait in the persisted queue while
			// the first holds the only place.
			runConfig: cancelConfig({ maxConcurrentSubAgents: 1 }),
			extraTools: [counting],
		});
		try {
			const driving = driveMain(system, "run two tasks, one at a time");
			await waitUntil(
				async () => (await readScheduler(system)).queue.some((entry) => entry.taskId === "task-queued"),
				"the second task never reached the queue",
			);
			const batchId = await onlyBatchId(system);
			const stopping = system.batch.cancelBatch(batchId, "operator cancelled the queued run", context);
			// The stop joins the running child, and that child is parked on this gate:
			// releasing it only after the intent is on record is what makes the join
			// observable rather than a deadlock.
			await waitUntil(async () => (await readBatch(system, batchId))?.cancel !== undefined, "the cancel intent was never persisted");
			hold.open();
			const stopped = await stopping;
			await driving;

			expect(stopped.state).toBe("cancelled");
			const items = (await readBatch(system, batchId))?.items ?? [];
			expect(items.map((item) => item.taskId)).toEqual(["task-hold", "task-queued"]);
			expect(items.map((item) => item.receipt?.status)).toEqual(["cancelled", "cancelled"]);
			expect(items[1]?.receipt?.failureKind).toBe("cancelled");

			// The queued member never got a submission, so the child router never saw
			// it and no business call could have happened for it.
			expect(arrivals).toEqual(["task-hold"]);
			const queued = await readLedger(system, "task-queued");
			expect(queued?.status).toBe("cancelled");
			expect(queued?.childConversationId).toBeUndefined();
			expect(queued?.activeOpKey).toBeUndefined();
			expect((await readLedger(system, "task-hold"))?.status).toBe("cancelled");

			// Nothing is left holding capacity, and the stop itself is idempotent: a
			// second call finds the receipts and changes nothing.
			const scheduler = await readScheduler(system);
			expect(scheduler.active).toHaveLength(0);
			expect(scheduler.queue).toHaveLength(0);
			const settledAt = (await readBatch(system, batchId))?.settledAt;
			expect(settledAt).toBeDefined();
			const again = await system.batch.cancelBatch(batchId, "operator cancelled again", context);
			expect(again.state).toBe("cancelled");
			expect((await readBatch(system, batchId))?.settledAt).toBe(settledAt);

			// No business call happened at any point.
			expect(executed).toHaveLength(0);
			await sleep(100);
			expect(executed).toHaveLength(0);
			expect(arrivals).toEqual(["task-hold"]);
		} finally {
			hold.open();
			await system.runtime.close();
		}
	});

	it("stops a running round and the child's next business call is refused, not executed", async () => {
		const executed: string[] = [];
		const counting = countingTool("counting_tool", executed);
		const requests: number[] = [];
		const hold = gate();
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			const attempt = requests.length + 1;
			requests.push(attempt);
			// The first turn really runs a tool, so this is a *running* round; the
			// second turn is parked and, once released, asks for another tool — which
			// the persisted stop must refuse rather than execute.
			if (attempt === 1) return fauxAssistantMessage([fauxToolCall("counting_tool", {}, { id: "child-call-1" })], { stopReason: "toolUse" });
			if (attempt === 2) {
				await hold.promise;
				return fauxAssistantMessage([fauxToolCall("counting_tool", {}, { id: "child-call-2" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText(childAnswer("finished task-running"))]);
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(cancelScript(["task-running"]), child),
			runConfig: cancelConfig(),
			extraTools: [counting],
		});
		try {
			const driving = driveMain(system, "run the task");
			await waitUntil(async () => executed.length === 1, "the child's first business call never ran");
			await waitUntil(async () => requests.length === 2, "the child never parked on its second request");
			const batchId = await onlyBatchId(system);
			const stopping = system.batch.cancelBatch(batchId, "operator cancelled the running round", context);
			// The intent commit also writes the child binding's stop, so releasing the
			// child after seeing the intent is a race the design already closes: the
			// call it makes next reads the stop and refuses.
			await waitUntil(async () => (await readBatch(system, batchId))?.cancel !== undefined, "the cancel intent was never persisted");
			hold.open();
			const stopped = await stopping;
			await driving;

			expect(stopped.state).toBe("cancelled");
			expect(stopped.items[0]?.state).toBe("cancelled");
			const receipt = (await readBatch(system, batchId))?.items[0]?.receipt;
			expect(receipt?.status).toBe("cancelled");
			expect(receipt?.failureKind).toBe("cancelled");
			// A stopped round still gets a result document: "no finish" is not "no
			// record". It carries the program's account, not the model's.
			expect(receipt?.resultId).toBe("res.task-running.r1");
			expect((await readResult(system, "res.task-running.r1"))?.result?.runtime.status).toBe("cancelled");

			const ledger = await readLedger(system, "task-running");
			expect(ledger?.status).toBe("cancelled");
			expect(ledger?.activeOpKey).toBeUndefined();
			expect(ledger?.rounds[0]?.execution?.status).toBe("cancelled");
			// The refused call was never charged: it did not run.
			expect((await readQuota(system, "req-batch"))?.operations[0]?.rounds[0]?.toolInvocationsUsed).toBe(1);

			const scheduler = await readScheduler(system);
			expect(scheduler.active).toHaveLength(0);
			expect(scheduler.queue).toHaveLength(0);

			// Only the call that ran before the stop executed; the one after it did not.
			expect(executed).toHaveLength(1);
			await sleep(100);
			expect(executed).toHaveLength(1);
		} finally {
			hold.open();
			await system.runtime.close();
		}
	});

	it("cancels at the submit gate, so the first business call never runs", async () => {
		const executed: string[] = [];
		const counting = countingTool("counting_tool", executed);
		let arrived = false;
		const hold = gate();
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			if (!arrived) {
				arrived = true;
				await hold.promise;
			}
			return fauxAssistantMessage([fauxToolCall("counting_tool", {}, { id: "child-gate-1" })], { stopReason: "toolUse" });
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(cancelScript(["task-gate"]), child),
			runConfig: cancelConfig(),
			extraTools: [counting],
		});
		try {
			const driving = driveMain(system, "run the task");
			// The input is submitted and the child has started its first turn: this is
			// the gate the round can be stopped at.
			await waitUntil(async () => arrived, "the child never started its first turn");
			const batchId = await onlyBatchId(system);
			const stopping = system.batch.cancelBatch(batchId, "operator cancelled at the submit gate", context);
			await waitUntil(async () => (await readBatch(system, batchId))?.cancel !== undefined, "the cancel intent was never persisted");
			hold.open();
			const stopped = await stopping;
			await driving;

			expect(stopped.state).toBe("cancelled");
			const receipt = (await readBatch(system, batchId))?.items[0]?.receipt;
			expect(receipt?.status).toBe("cancelled");
			expect(receipt?.failureKind).toBe("cancelled");
			expect((await readLedger(system, "task-gate"))?.status).toBe("cancelled");

			// The child did ask for a business tool once; it did not run.
			expect(executed).toHaveLength(0);
			expect((await readQuota(system, "req-batch"))?.operations[0]?.rounds[0]?.toolInvocationsUsed).toBe(0);
			expect((await readScheduler(system)).active).toHaveLength(0);
			await sleep(100);
			expect(executed).toHaveLength(0);
		} finally {
			hold.open();
			await system.runtime.close();
		}
	});

	it("stops every batch of the request with one call, and a second stop changes nothing", async () => {
		const executed: string[] = [];
		const counting = countingTool("counting_tool", executed);
		const arrived: string[] = [];
		const hold = gate();
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			arrived.push(taskId);
			await hold.promise;
			return fauxAssistantMessage([fauxToolCall("counting_tool", {}, { id: `child-${taskId}` })], { stopReason: "toolUse" });
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(cancelScript(["task-a", "task-b"]), child),
			runConfig: cancelConfig(),
			extraTools: [counting],
		});
		try {
			const driving = driveMain(system, "run both tasks");
			await waitUntil(async () => arrived.length === 2, "both tasks never started");
			const batchId = await onlyBatchId(system);
			const stopping = system.batch.stopAll("operator cancelled the request", context);
			await waitUntil(async () => (await readBatch(system, batchId))?.cancel !== undefined, "the cancel intent was never persisted");
			hold.open();
			const stopped = await stopping;
			await driving;

			expect(stopped).toHaveLength(1);
			expect(stopped[0]?.state).toBe("cancelled");
			expect(stopped[0]?.items.map((item) => item.state)).toEqual(["cancelled", "cancelled"]);
			const settledAt = (await readBatch(system, batchId))?.settledAt;
			expect(settledAt).toBeDefined();

			// A second request-wide stop re-reads the receipts and writes nothing.
			const again = await system.batch.stopAll("operator cancelled the request again", context);
			expect(again).toHaveLength(1);
			expect(again[0]?.state).toBe("cancelled");
			expect((await readBatch(system, batchId))?.settledAt).toBe(settledAt);

			expect(executed).toHaveLength(0);
			const scheduler = await readScheduler(system);
			expect(scheduler.active).toHaveLength(0);
			expect(scheduler.queue).toHaveLength(0);
		} finally {
			hold.open();
			await system.runtime.close();
		}
	});

	it("reports a deadline as a technical failure for Main, never as a stop", async () => {
		const executed: string[] = [];
		const counting = countingTool("counting_tool", executed);
		const child: ChildRouter = async (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages));
			if (taskId === undefined) throw new Error("child router saw a Main request");
			// The child answers later than the round's deadline. The stop path joins the
			// child before it writes anything, so a promise that never settles would
			// deadlock that join; a late answer is the honest shape of a clock running
			// out mid-call, and the round must not take the late call either.
			await sleep(600);
			return fauxAssistantMessage([fauxToolCall("counting_tool", {}, { id: "child-late" })], { stopReason: "toolUse" });
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(cancelScript(["task-deadline"]), child),
			// The run's own round bound is what expires; the task's contract allows
			// more time, so the failure must be the clock and not the contract.
			runConfig: cancelConfig({ roundTimeoutMs: 400 }),
			extraTools: [counting],
		});
		try {
			const driving = driveMain(system, "run past the deadline");
			await waitUntil(async () => (await readBatchIndex(system)).length === 1, "the batch was never admitted");
			const batchId = await onlyBatchId(system);
			await waitUntil(
				async () => (await readBatch(system, batchId))?.items[0]?.receipt !== undefined,
				"the round never settled at its deadline",
			);
			await driving;

			const batch = await readBatch(system, batchId);
			// The batch itself was never asked to stop: the round's own clock expired,
			// and a clock is not an operator.
			expect(batch?.cancel).toBeUndefined();
			const receipt = batch?.items[0]?.receipt;
			expect(receipt?.status).toBe("failed");
			expect(receipt?.failureKind).toBe("technical");
			expect(receipt?.requiresMainDecision).toBe(true);
			// Even a round with no finish writes its result; it says the round failed.
			expect(receipt?.resultId).toBe("res.task-deadline.r1");
			expect((await readResult(system, "res.task-deadline.r1"))?.result?.runtime.status).toBe("failed");

			// The business status is left for Main: the task was not cancelled, and no
			// cancel request was written that would refuse its next round.
			const ledger = await readLedger(system, "task-deadline");
			expect(ledger?.status).toBe("running");
			expect(ledger?.cancelRequested).toBeUndefined();
			expect(ledger?.activeOpKey).toBeUndefined();
			expect(ledger?.rounds[0]?.execution?.status).toBe("failed");

			// The child's late call does not run, and nothing is left executing.
			expect(executed).toHaveLength(0);
			const scheduler = await readScheduler(system);
			expect(scheduler.active).toHaveLength(0);
			expect(scheduler.queue).toHaveLength(0);
			await sleep(100);
			expect(executed).toHaveLength(0);
		} finally {
			await system.runtime.close();
		}
	});
});
