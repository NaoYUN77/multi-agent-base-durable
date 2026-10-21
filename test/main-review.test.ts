// TASK-005.7 test/main-review.test.ts
//
// AC-01 — Main accepts a task that settled at `awaiting_review`; the ledger really
// moves to `accepted`, and the dependency checker the dispatch admission uses
// vouches for that task afterwards.
//
// AC-02 — Main reworks an unacceptable round: the next round runs in the same
// child conversation, carries the feedback and round 1's history, and spends the
// existing budget. When the revision allowance is spent the review is refused with
// a stable reason and the task is *not* rewritten to `failed`; and an exhausted
// child budget never refuses a review.
//
// AC-03 — one winner per task per round: a duplicate accept, an accept aimed at an
// older round, an accept racing a rework, and a review of a terminal task are all
// refused without writing a terminal state.
//
// AC-05 — every case here is headless: the Main service is driven through
// `driveMain`, with no terminal involved.
//
// AC-04 (a process killed before and after the review and rework commits) lives in
// `test/main-review-recovery.test.ts`, because it needs a killed child process and
// a watcher rather than a scripted model.
//
// Every number in this file is stated here. Nothing is a product default.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { context } from "../src/runtime.ts";
import { TaskLedgerDoc, recordTransition } from "../src/multiagent/ledger.ts";
import { MainServiceDoc } from "../src/agent/main/service-doc.ts";
import { MAIN_TOOL_NAMES } from "../src/agent/main/tools.ts";
import type { TaskSpec } from "../src/agent/contracts/task-spec.ts";
import {
	type BatchSystem,
	type ChildRouter,
	childAnswer,
	driveMain,
	flattenRequest,
	type MainStep,
	mainRouter,
	onlyBatchId,
	openBatchSystem,
	readBatch,
	readLedger,
	readQuota,
	readResult,
	runConfigOf,
	submittedTaskId,
	taskSpecOf,
	transcriptRouter,
} from "./helpers/batch-system.ts";

const PLAN_ID = "plan-review";
const TASK_A = "task-a";
const TASK_B = "task-b";
const MATERIAL = "MATERIAL-RV: alpha beta alpha";
const INPUT = "dispatch the work, then review what came back";
const FEEDBACK_ONE = "name the second count as well";
const FEEDBACK_TWO = "now name both counts in one sentence";
const FEEDBACK_THREE = "and say which word repeats";
const ANSWER_ONE = "counted the marker once";
const ANSWER_TWO = "counted the marker twice, once per round";
const ANSWER_THREE = "alpha repeats twice and beta appears once";

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
function specBody(id: string, dependencies: readonly string[] = []): JsonObject {
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
		dependencies: [...dependencies],
		budget: { ...BUDGET },
	};
}

/** The saved contract of one task, for the dependency checker's own input. */
function savedSpec(id: string, dependencies: readonly string[] = []): TaskSpec {
	return taskSpecOf({
		id,
		skillId: "material-summary",
		requestedTools: ["text_stats"],
		dependencies,
		materials: [{ id: "material-1", content: MATERIAL, source: "user note" }],
		budget: { ...BUDGET },
	});
}

/**
 * A child whose answer depends on which feedback the round carries.
 *
 * Round 1 has no feedback; each later round is recognised by its own sentence.
 * The tool call id is derived from the same fact, so a rework's call is not
 * mistaken for a replay of the first round's call.
 */
function reviewingChild(flats: string[]): ChildRouter {
	const answerOf = (flat: string): { readonly answer: string; readonly call: string } => {
		if (flat.includes(FEEDBACK_THREE)) return { answer: ANSWER_THREE, call: "stats-r3" };
		if (flat.includes(FEEDBACK_TWO)) return { answer: ANSWER_TWO, call: "stats-r2b" };
		if (flat.includes(FEEDBACK_ONE)) return { answer: ANSWER_TWO, call: "stats-r2" };
		return { answer: ANSWER_ONE, call: "stats-r1" };
	};
	return (request) => {
		const flat = flattenRequest(request.messages);
		if (submittedTaskId(flat) === undefined) throw new Error("child router saw a Main request");
		flats.push(flat);
		const { answer, call } = answerOf(flat);
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: call })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(childAnswer(answer))]);
	};
}

/** Save a plan and dispatch the given bodies once, then hand over to the review turns. */
function scriptOf(tasks: readonly JsonObject[], taskIds: readonly string[], after: readonly MainStep[]): (flat: string) => readonly MainStep[] {
	return () => [
		[{ name: "save_plan", arguments: { planId: PLAN_ID, goals: ["run and review"], taskIds: [...taskIds] } }],
		[{ name: "dispatch_tasks", arguments: { planId: PLAN_ID, version: 1, tasks: tasks.map((task) => task) } }],
		...after,
	];
}

/** Every review receipt this session wrote, in order. */
async function reviewReceipts(system: BatchSystem) {
	const doc = await system.runtime.harness.snapshot(MainServiceDoc, system.root.id, context);
	return (doc?.receipts ?? []).filter((receipt) => receipt.opKey.startsWith("review:"));
}

describe("TASK-005.7 review — accept, rework and one winner per round (AC-01, AC-02, AC-03, AC-05)", { timeout: 90_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "main-review-"));
		databasePath = join(directory, "review.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("exposes a review entry to Main", () => {
		// The tool set is the contract's: Main can ask, save a plan, dispatch and now
		// review. A review that existed only as model prose would not be an entry.
		expect(MAIN_TOOL_NAMES).toContain("review_task");
	});

	it("accepts a task that settled at awaiting_review, and the dependency checker vouches for it afterwards (AC-01)", async () => {
		const flats: string[] = [];
		// The review is issued in a second user turn, so the dependency checker can be
		// read in between: the claim is that the accept is what satisfies it.
		let reviewing = false;
		const script = (flat: string): MainStep => {
			if (!flat.includes(`saved plan ${PLAN_ID}`)) {
				return [{ name: "save_plan", arguments: { planId: PLAN_ID, goals: ["run and review"], taskIds: [TASK_A, TASK_B] } }];
			}
			if (!flat.includes(`dispatched plan ${PLAN_ID}`)) {
				return [
					{
						name: "dispatch_tasks",
						arguments: { planId: PLAN_ID, version: 1, tasks: [specBody(TASK_A), specBody(TASK_B, [TASK_A])] },
					},
				];
			}
			if (reviewing && !flat.includes(`accepted task ${TASK_A}`)) {
				return [{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "accept" } }];
			}
			return [];
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(script, reviewingChild(flats)),
			runConfig: configOf({}),
		});
		try {
			await driveMain(system, INPUT);

			// Before the review, the checker reports the dependency: nothing has been
			// accepted, so a later batch may not treat it as satisfied.
			const before = await system.batch.unacceptedDependencies([savedSpec(TASK_B, [TASK_A])]);
			expect(before).toEqual([TASK_A]);

			reviewing = true;
			await driveMain(system, "review what came back", "req-review");

			const ledger = await readLedger(system, TASK_A);
			// The program wrote the transition, not the model: `awaiting_review` is the
			// only state it may come from, and the event records both ends.
			expect(ledger?.status).toBe("accepted");
			expect(ledger?.terminalAt).toBeTypeOf("number");
			expect(ledger?.events.at(-1)?.from).toBe("awaiting_review");
			expect(ledger?.events.at(-1)?.to).toBe("accepted");
			// The decision is on record with the call that made it.
			expect(ledger?.reviews).toHaveLength(1);
			expect(ledger?.reviews[0]?.decision).toBe("accept");
			expect(ledger?.reviews[0]?.round).toBe(1);
			expect(ledger?.reviews[0]?.before).toBe("awaiting_review");
			expect(ledger?.reviews[0]?.after).toBe("accepted");
			expect(ledger?.operations.filter((operation) => operation.kind === "review")).toHaveLength(1);
			// The right is gone with the terminal status: nothing may execute it again.
			expect(ledger?.activeOpKey).toBeUndefined();

			// The same checker the dispatch admission consults now says the dependency
			// is satisfied — which is the whole point of `accepted`.
			const after = await system.batch.unacceptedDependencies([savedSpec(TASK_B, [TASK_A])]);
			expect(after).toEqual([]);

			// The sibling task is untouched by the accept.
			expect((await readLedger(system, TASK_B))?.status).toBe("awaiting_review");

			const receipts = await reviewReceipts(system);
			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.isError).toBe(false);
			expect(receipts[0]?.result).toContain(`accepted task ${TASK_A}`);
		} finally {
			await system.runtime.close();
		}
	});

	it("reworks into the next round of the same child conversation with the feedback, and spends the same budget (AC-02)", async () => {
		const flats: string[] = [];
		const system = await openBatchSystem({
			databasePath,
			// Two instances per request is the whole budget, and the rework is the
			// second one. The accept that follows must still be allowed: a review is a
			// Main decision, not a child execution.
			router: mainRouter(
				scriptOf([specBody(TASK_A)], [TASK_A], [
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "rework", feedback: FEEDBACK_ONE } }],
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 2, decision: "accept" } }],
				]),
				reviewingChild(flats),
			),
			runConfig: configOf({ maxSubAgentsPerRequest: 2 }),
		});
		try {
			await driveMain(system, INPUT);

			const batchId = await onlyBatchId(system);
			const item = (await readBatch(system, batchId))?.items.find((entry) => entry.taskId === TASK_A);
			expect(item?.receipt?.round).toBe(2);
			expect(item?.receipt?.status).toBe("completed");
			expect(item?.receipt?.resultId).toBe(`res.${TASK_A}.r2`);

			const ledger = await readLedger(system, TASK_A);
			// The rework reuses the task: one initial round, one revision, one
			// conversation, and the feedback is on the round it belongs to.
			expect(ledger?.rounds.map((round) => [round.round, round.kind])).toEqual([
				[1, "initial"],
				[2, "revision"],
			]);
			expect(ledger?.rounds[1]?.feedback).toBe(FEEDBACK_ONE);
			expect(ledger?.rounds[1]?.requestId).toBe(`multiagent-round:${TASK_A}:2`);
			expect(ledger?.rounds[0]?.task).not.toContain(FEEDBACK_ONE);
			expect(ledger?.rounds[1]?.task).toContain(FEEDBACK_ONE);
			expect(ledger?.reviews[0]?.decision).toBe("reject");
			expect(ledger?.reviews[0]?.reason).toBe(FEEDBACK_ONE);
			// The accept that followed the rework is the terminal status, and it was
			// allowed with the child's instance budget already spent.
			expect(ledger?.status).toBe("accepted");
			expect(ledger?.reviews[1]?.decision).toBe("accept");
			expect(ledger?.reviews[1]?.round).toBe(2);

			// Two rounds, two instances, one operation — the rework is a revision of the
			// same operation, not a second dispatch.
			// The quota is keyed by the request the rounds were admitted under — the
			// dispatch's own request, read from the batch rather than assumed.
			const quota = await readQuota(system, (await readBatch(system, batchId))?.requestId as string);
			expect(quota?.instancesUsed).toBe(2);
			expect(quota?.operations).toHaveLength(1);
			expect(quota?.operations[0]?.attemptsUsed).toBe(2);

			const first = await readResult(system, `res.${TASK_A}.r1`);
			const second = await readResult(system, `res.${TASK_A}.r2`);
			expect(first?.result?.work.summary).toBe(ANSWER_ONE);
			expect(second?.result?.work.summary).toBe(ANSWER_TWO);
			expect(second?.result?.runtime.round).toBe(2);

			// Round 2's provider request carried round 1's answer and the feedback: the
			// rework continues the same conversation rather than starting a new one.
			const secondRound = flats.filter((flat) => flat.includes(FEEDBACK_ONE));
			expect(secondRound.length).toBeGreaterThan(0);
			expect(secondRound[0]).toContain(ANSWER_ONE);
		} finally {
			await system.runtime.close();
		}
	});

	it("refuses a rework once the revision allowance is spent, without rewriting the task to failed (AC-02)", async () => {
		const flats: string[] = [];
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(
				scriptOf([specBody(TASK_A)], [TASK_A], [
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "rework", feedback: FEEDBACK_ONE } }],
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 2, decision: "rework", feedback: FEEDBACK_TWO } }],
					// Round 3 is the initial round plus two revisions — the allowance.
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 3, decision: "rework", feedback: FEEDBACK_THREE } }],
				]),
				reviewingChild(flats),
			),
			// Three rounds is three sub-agent executions and three attempts of one
			// operation, so both request budgets must allow them. What refuses the fourth
			// review is the ledger's revision allowance, not either of these.
			runConfig: configOf({ maxSubAgentsPerRequest: 3, maxAttemptsPerOperation: 3 }),
		});
		try {
			await driveMain(system, INPUT);

			const ledger = await readLedger(system, TASK_A);
			expect(ledger?.currentRound).toBe(3);
			// The refusal is not a verdict: `failed` is Main's decision, not the side
			// effect of a spent allowance, so the task stays reviewable.
			expect(ledger?.status).toBe("awaiting_review");
			expect(ledger?.terminalAt).toBeUndefined();
			expect(ledger?.failure).toBeUndefined();
			expect(ledger?.rounds).toHaveLength(3);
			// Nothing was claimed for a fourth round.
			expect(ledger?.rounds.some((round) => round.round === 4)).toBe(false);
			expect(ledger?.activeOpKey).toBeUndefined();
			// The refusal is recorded once, as an error, with a stable reason.
			const receipts = await reviewReceipts(system);
			const refused = receipts.filter((receipt) => receipt.isError === true);
			expect(refused).toHaveLength(1);
			expect(refused[0]?.result).toContain("revision");
			expect(await readResult(system, `res.${TASK_A}.r4`)).toBeUndefined();
		} finally {
			await system.runtime.close();
		}
	});

	it("refuses a duplicate accept, a stale round and a review of a terminal task, writing no terminal state (AC-03)", async () => {
		const flats: string[] = [];
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(
				scriptOf([specBody(TASK_A), specBody(TASK_B)], [TASK_A, TASK_B], [
					// Turn 2 ends the first drive, so the second one starts at turn 3.
					[],
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "accept" } }],
					// A second accept of the same round, from a different call. The task is
					// already terminal, so this is refused as a terminal review — the
					// non-terminal "already has a decision" path is the concurrent case below.
					[{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "accept" } }],
					// B's round 1 is reviewed, which starts round 2. A review aimed at round 1
					// then names a round the task has left, while round 2 is undecided.
					[{ name: "review_task", arguments: { taskId: TASK_B, round: 1, decision: "rework", feedback: FEEDBACK_ONE } }],
					[{ name: "review_task", arguments: { taskId: TASK_B, round: 1, decision: "accept" } }],
				]),
				reviewingChild(flats),
			),
			runConfig: configOf({}),
		});
		try {
			await driveMain(system, INPUT);
			await driveMain(system, "review what came back", "req-review");

			const accepted = await readLedger(system, TASK_A);
			// One decision, one transition. The duplicate changed nothing.
			expect(accepted?.status).toBe("accepted");
			expect(accepted?.reviews).toHaveLength(1);
			expect(accepted?.operations.filter((operation) => operation.kind === "review")).toHaveLength(1);
			expect(accepted?.events.filter((event) => event.to === "accepted")).toHaveLength(1);

			// B moved to round 2 by the rework; the stale review wrote no second decision.
			const reworked = await readLedger(system, TASK_B);
			expect(reworked?.status).toBe("awaiting_review");
			expect(reworked?.currentRound).toBe(2);
			expect(reworked?.rounds.map((round) => round.round)).toEqual([1, 2]);
			expect(reworked?.reviews).toHaveLength(1);
			expect(reworked?.reviews[0]?.round).toBe(1);
			expect(reworked?.operations.filter((operation) => operation.kind === "review")).toHaveLength(1);

			const receipts = await reviewReceipts(system);
			// The accept and the rework landed; the duplicate accept and the stale round did not.
			expect(receipts.filter((receipt) => receipt.isError !== true)).toHaveLength(2);
			expect(receipts.filter((receipt) => receipt.isError === true)).toHaveLength(2);
			// Each refusal names its own reason, so the two cases are not one path twice.
			expect(receipts.some((receipt) => receipt.result?.includes("review_task_terminal"))).toBe(true);
			expect(receipts.some((receipt) => receipt.result?.includes("review_stale_round"))).toBe(true);
		} finally {
			await system.runtime.close();
		}
	});

	it("lets exactly one of a concurrent accept and rework win (AC-03)", async () => {
		const flats: string[] = [];
		const system = await openBatchSystem({
			databasePath,
			router: mainRouter(
				scriptOf([specBody(TASK_A)], [TASK_A], [
					// Both calls are issued in the same turn, so they run in parallel.
					[
						{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "accept" } },
						{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "rework", feedback: FEEDBACK_ONE } },
					],
				]),
				reviewingChild(flats),
			),
			runConfig: configOf({}),
		});
		try {
			await driveMain(system, INPUT);

			const ledger = await readLedger(system, TASK_A);
			// Exactly one review operation, whatever the winner was.
			expect(ledger?.operations.filter((operation) => operation.kind === "review")).toHaveLength(1);
			expect(ledger?.reviews).toHaveLength(1);
			// The loser wrote no terminal state: either the task was accepted, or it is
			// still awaiting review with the rework's round claimed.
			expect(["accepted", "awaiting_review"]).toContain(ledger?.status);
			if (ledger?.status === "accepted") {
				expect(ledger.reviews[0]?.decision).toBe("accept");
				expect(ledger.rounds).toHaveLength(1);
			} else {
				expect(ledger?.reviews[0]?.decision).toBe("reject");
				expect(ledger?.rounds.map((round) => round.round)).toEqual([1, 2]);
			}

			const receipts = await reviewReceipts(system);
			expect(receipts.filter((receipt) => receipt.isError !== true)).toHaveLength(1);
			expect(receipts.filter((receipt) => receipt.isError === true)).toHaveLength(1);
		} finally {
			await system.runtime.close();
		}
	});

	it("refuses a review of a failed or cancelled task and writes no terminal state (AC-03)", async () => {
		const flats: string[] = [];
		// Two drivers: the first settles both tasks at `awaiting_review` so the
		// ledgers carry a dispatched round, the second issues the reviews.
		let reviewing = false;
		let reviewed = false;
		const script = (flat: string): MainStep => {
			if (!flat.includes(`saved plan ${PLAN_ID}`)) {
				return [{ name: "save_plan", arguments: { planId: PLAN_ID, goals: ["run and review"], taskIds: [TASK_A, TASK_B] } }];
			}
			if (!flat.includes(`dispatched plan ${PLAN_ID}`)) {
				return [{ name: "dispatch_tasks", arguments: { planId: PLAN_ID, version: 1, tasks: [specBody(TASK_A), specBody(TASK_B)] } }];
			}
			if (!reviewing || reviewed) return [];
			reviewed = true;
			return [
				{ name: "review_task", arguments: { taskId: TASK_A, round: 1, decision: "accept" } },
				{ name: "review_task", arguments: { taskId: TASK_B, round: 1, decision: "accept" } },
			];
		};
		const system = await openBatchSystem({
			databasePath,
			router: transcriptRouter(script, reviewingChild(flats)),
			runConfig: configOf({}),
		});
		try {
			await driveMain(system, INPUT);

			// The tasks really ran: a ledger seeded before dispatch would have `createdAt`
			// 0 and no round, and a review of it would be refused as an unknown task
			// rather than as a terminal one — testing the wrong refusal.
			for (const taskId of [TASK_A, TASK_B]) {
				const settled = await readLedger(system, taskId);
				expect(settled?.status).toBe("awaiting_review");
				expect(settled?.rounds).toHaveLength(1);
				expect(settled?.createdAt).not.toBe(0);
			}

			// `failed` and `cancelled` are states only Main can reach, and no production
			// path sets `failed` yet. They are written here directly so the review tool
			// is tested against the states it must refuse rather than against a proxy.
			await system.runtime.harness.commit(async (tx) => {
				const failed = await tx.doc(TaskLedgerDoc, system.root.id, TASK_A, { taskId: TASK_A, model: system.runtime.modelRef });
				recordTransition(failed, "failed", 1_700_000_000_000, { reason: "test-fixture" });
				const cancelled = await tx.doc(TaskLedgerDoc, system.root.id, TASK_B, { taskId: TASK_B, model: system.runtime.modelRef });
				recordTransition(cancelled, "cancelled", 1_700_000_000_000, { reason: "test-fixture" });
			}, context);

			reviewing = true;
			await driveMain(system, "review what came back", "req-review");

			for (const [taskId, status] of [
				[TASK_A, "failed"],
				[TASK_B, "cancelled"],
			] as const) {
				const ledger = await readLedger(system, taskId);
				expect(ledger?.status).toBe(status);
				expect(ledger?.reviews).toHaveLength(0);
				expect(ledger?.operations.filter((operation) => operation.kind === "review")).toHaveLength(0);
				// The terminal moment is the one the fixture wrote, not a second one.
				expect(ledger?.terminalAt).toBe(1_700_000_000_000);
			}

			const receipts = await reviewReceipts(system);
			expect(receipts).toHaveLength(2);
			expect(receipts.every((receipt) => receipt.isError === true)).toBe(true);
			// Refused because they are terminal, not because the task was unknown.
			expect(receipts.every((receipt) => receipt.result?.includes("review_task_terminal"))).toBe(true);
		} finally {
			await system.runtime.close();
		}
	});
});
