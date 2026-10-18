// TASK-005.4 src/agent/runtime/admission.ts
//
// The admission decision: may this item start now, and if so, what does it
// reserve?
//
// This file is the only writer of `SchedulerDoc.active` and `SchedulerDoc.queue`.
// Everything that decides capacity, resource conflicts or queue position lives
// here, so there is one answer to "who may run" rather than one per caller.
//
// The shape of the decision, and why it is shaped that way:
//
//   * **Admission runs inside the item's own durable task**, where `api.taskId`
//     is the id of the task that will hold the slot. That is what makes the slot
//     idempotent: a replayed item rewrites the slot it already holds instead of
//     taking a second one. Admitting in the dispatcher *before* creating the
//     item task cannot do this, because the holder's id does not exist yet.
//   * **The pump only reads.** It looks at the scheduler and quota to decide how
//     many items to start, and that read is a hint. The authoritative check and
//     the reservation happen here, serialized on the session line, so an
//     over-start costs a `deferred` return and never an over-admission.
//   * **Nothing is written before every refusal has been ruled out.** The
//     decision is computed from reads first and applied at the end, so a refusal
//     leaves the documents exactly as it found them — which is what lets the
//     caller retry an admission after a refusal without unwinding anything.
//
// The four documents written on success (`SchedulerDoc`, `AgentQuotaDoc`,
// `TaskLedgerDoc`, `AgentBatchDoc`) are written in one commit, in the caller's
// transaction. No slot without a right, no right without a reservation, no
// reservation without a slot: a crash cannot leave one of the four without the
// others, so a resumed process never has to guess which of them it may trust.

import type { ConversationId, ModelRef, TaskId, Tx } from "@earendil-works/pi-durable";
import type { RunConfig } from "../contracts/run-config.ts";
import type { EffectiveRoundBudget } from "../contracts/round-execution.ts";
import type { ResourceClaim } from "../contracts/tool-effects.ts";
import { isTerminalBusinessStatus } from "../state/lifecycle.ts";
import { TaskLedgerDoc } from "../../multiagent/ledger.ts";
import type { RefusalCode, AttemptKey, BatchId } from "./contracts.ts";
import {
	AgentBatchDoc,
	AgentQuotaDoc,
	SchedulerDoc,
	type ActiveSlot,
	type BatchItemReceipt,
	type QueueEntry,
	type SchedulerState,
} from "./documents.ts";
import { claimsConflict } from "./resources.ts";
import { consumeOnce, openRound, operationSpendOf, QuotaRefusal } from "./quota.ts";
import { startRound } from "./round.ts";

/** Everything one admission needs, all of it program-supplied. */
export type AdmissionInput = {
	readonly mainConversationId: ConversationId;
	readonly model: ModelRef;
	readonly batchId: BatchId;
	readonly requestId: string;
	readonly taskId: string;
	readonly operationId: string;
	readonly round: number;
	readonly attemptKey: AttemptKey;
	/** The nested tool-call identity of the item task that holds the slot. */
	readonly opKey: string;
	/** The item task's own durable id: the slot's identity and the ledger's right holder. */
	readonly durableTaskId: TaskId;
	/** Submission dedup key of this attempt. */
	readonly requestIdOfRound: string;
	readonly roundKind: "delegate" | "revise";
	readonly taskText: string;
	readonly feedback?: string;
	readonly claim: ResourceClaim;
	readonly limits: EffectiveRoundBudget;
	readonly specHash: string;
	readonly planVersion: number;
	readonly technicalRestarts: number;
	readonly runConfig: RunConfig;
	readonly now: number;
};

/** What an admission decided. */
export type AdmissionOutcome =
	| { readonly kind: "admitted"; readonly slot: ActiveSlot }
	/** No capacity or a conflicting holder right now; the item waits in the queue. */
	| { readonly kind: "deferred"; readonly reason: "concurrency_full" | "resource_conflict"; readonly entry: QueueEntry }
	/** Nothing to do: the item already has a receipt. */
	| { readonly kind: "settled"; readonly receipt: BatchItemReceipt }
	| { readonly kind: "refused"; readonly code: RefusalCode; readonly detail: string };

/**
 * Decide and reserve one item's admission, in the caller's transaction.
 *
 * Every read below happens through `tx`, so the decision and the writes it
 * authorizes are one atomic unit: a second admission for the same capacity
 * either commits before this one reads or after this one writes, and in both
 * cases sees a state that makes the decision correct.
 */
export async function admitOne(tx: Tx, input: AdmissionInput): Promise<AdmissionOutcome> {
	const { mainConversationId, model, taskId } = input;

	const scheduler = await tx.doc(SchedulerDoc);
	const batch = await tx.doc(AgentBatchDoc, mainConversationId, input.batchId, { batchId: input.batchId });
	const ledger = await tx.doc(TaskLedgerDoc, mainConversationId, taskId, { taskId, model });
	const quota = await tx.doc(AgentQuotaDoc, mainConversationId, input.requestId, { requestId: input.requestId });

	// ── Refusals, all of them, before any write ──────────────────────────────
	if (batch.createdAt === 0) {
		return { kind: "refused", code: "batch_not_admitted", detail: `batch ${input.batchId} was never admitted` };
	}
	if (batch.cancel !== undefined) {
		return { kind: "refused", code: "cancel_pending", detail: `batch ${input.batchId} is being cancelled` };
	}
	const item = batch.items.find((entry) => entry.taskId === taskId);
	if (item === undefined) {
		return { kind: "refused", code: "task_not_in_batch", detail: `task ${taskId} is not a member of batch ${input.batchId}` };
	}
	// A receipt settles the round it names, not the item forever. A rework is the
	// round after a settled one, so it must be admitted rather than answered from
	// storage; a replay of the settled round keeps the receipt.
	if (item.receipt !== undefined && item.receipt.round >= input.round) {
		return { kind: "settled", receipt: item.receipt };
	}
	if (isTerminalBusinessStatus(ledger.status)) {
		return { kind: "refused", code: "task_terminal", detail: `task ${taskId} is ${ledger.status}` };
	}
	if (ledger.cancelRequested !== undefined) {
		return { kind: "refused", code: "cancel_pending", detail: `task ${taskId} has a cancel intent` };
	}
	// The right is checked before the quota is reserved: a duplicate that loses
	// this race must not spend an instance or an attempt on work it will not do.
	if (ledger.activeOpKey !== undefined && ledger.activeOpKey !== input.opKey) {
		return {
			kind: "refused",
			code: "execution_right_held",
			detail: `task ${taskId} round ${input.round} is held by ${ledger.activeOpKey}`,
		};
	}
	// A round already claimed by this operation is a replay: the slot and the
	// reservation are already there, so the admission is a no-op that reports the
	// held slot rather than writing a second one.
	const held = scheduler.active.find((slot) => slot.operationId === input.operationId && slot.round === input.round);
	if (held !== undefined) return { kind: "admitted", slot: held };

	// Capacity, from the persisted slot table. The two caps are different
	// questions: one is "the whole run", the other is "this user request".
	//
	// Fairness comes before capacity. An item that is waiting behind another one
	// defers even when a slot is free, so the freed slot goes to the head of the
	// queue: without this, every waiting item polls and they race, and the queue's
	// order would decide nothing. An item that has never been queued (position -1)
	// is unaffected.
	const waiting = serviceOrder(scheduler).findIndex((entry) => entry.operationId === input.operationId);
	if (waiting > 0) return { kind: "deferred", reason: "concurrency_full", entry: enqueue(scheduler, input) };
	if (scheduler.active.length >= input.runConfig.maxConcurrentSubAgents) {
		return { kind: "deferred", reason: "concurrency_full", entry: enqueue(scheduler, input) };
	}
	const requestActive = scheduler.active.filter((slot) => slot.requestId === input.requestId).length;
	if (requestActive >= input.runConfig.maxSubAgentsPerRequest) {
		return { kind: "deferred", reason: "concurrency_full", entry: enqueue(scheduler, input) };
	}
	if (scheduler.active.some((slot) => claimsConflict(slot.claim, input.claim))) {
		return { kind: "deferred", reason: "resource_conflict", entry: enqueue(scheduler, input) };
	}

	// ── Writes ───────────────────────────────────────────────────────────────
	const operation = operationSpendOf(quota, input.operationId, taskId);
	// Both budgets are reserved in one try, and a refusal from either restores what
	// the other already wrote. Without the restore, a round refused for its attempt
	// allowance would still have spent an instance: a rework loop refused over and
	// over would drain the request's execution budget one refusal at a time, and the
	// quota document would report an execution that never started. The round record
	// is opened only after both reservations fit, for the same reason — a refused
	// round must leave no trace, including no empty round entry and no reset of the
	// operation's provider-retry counter.
	const instancesBefore = quota.instancesUsed;
	const attemptsBefore = operation.attemptsUsed;
	const chargedBefore = operation.chargedAttempts;
	try {
		// The instance is the sub-agent execution this round is; the attempt is the
		// revision allowance it spends. They are separate budgets and both apply.
		consumeOnce(quota, operation, `instance:${input.operationId}:${input.round}`, { kind: "instance" }, input.runConfig);
		consumeOnce(quota, operation, `attempt:${input.attemptKey}`, { kind: "attempt", attemptKey: input.attemptKey }, input.runConfig);
	} catch (error) {
		quota.instancesUsed = instancesBefore;
		operation.attemptsUsed = attemptsBefore;
		operation.chargedAttempts = chargedBefore;
		if (error instanceof QuotaRefusal) {
			const code: RefusalCode = error.code === "quota_instances_exhausted" ? "instance_budget_exhausted" : "quota_exhausted";
			return { kind: "refused", code, detail: error.message };
		}
		throw error;
	}
	openRound(operation, input.round);

	// The ledger's dispatcher record is stamped here, before the child exists.
	// `createSubAgent` refuses a ledger whose `createdAt` is 0, and retiring a
	// seed-shaped ledger is how it tells "nobody dispatched this" from "dispatched
	// but not yet run" — so the stamp has to land in the same commit as the claim.
	if (ledger.createdAt === 0) ledger.createdAt = input.now;
	if (ledger.mainConversationId === undefined) ledger.mainConversationId = mainConversationId;

	startRound(ledger, {
		opKey: input.opKey,
		kind: input.roundKind,
		toolTaskId: String(input.durableTaskId),
		callId: input.opKey,
		round: input.round,
		task: input.taskText,
		...(input.feedback === undefined ? {} : { feedback: input.feedback }),
		requestId: input.requestIdOfRound,
		at: input.now,
		execution: {
			operationId: input.operationId,
			status: "running",
			limits: input.limits,
			attempts: [],
			technicalRestarts: input.technicalRestarts,
			toolInvocations: 0,
			failedToolCalls: 0,
			batchId: input.batchId,
			planVersion: input.planVersion,
			specHash: input.specHash,
			deadlineAt: input.limits.deadlineAt,
			durableTaskIds: [],
		},
	});
	ledger.activeToolTaskId = String(input.durableTaskId);

	const slot: ActiveSlot = {
		operationId: input.operationId as ActiveSlot["operationId"],
		batchId: input.batchId,
		requestId: input.requestId,
		taskId,
		round: input.round,
		attemptKey: input.attemptKey,
		durableTaskId: input.durableTaskId,
		claim: input.claim,
		startedAt: input.now,
	};
	scheduler.active = [...scheduler.active, slot];
	scheduler.queue = scheduler.queue.filter((entry) => entry.operationId !== input.operationId);

	// The fields are listed rather than spread because a rework re-opens an item
	// that settled a round before: a spread would carry the old receipt into the
	// new round, and the item's next gate would report the new work as already
	// settled. `attemptKey` and `round` are rewritten in the same write, so a
	// reader can never see the new round beside the old attempt.
	batch.items = batch.items.map((entry) =>
		entry.taskId === taskId
			? {
					taskId: entry.taskId,
					operationId: entry.operationId,
					sequence: entry.sequence,
					enqueuedAt: entry.enqueuedAt,
					attemptKey: input.attemptKey,
					round: input.round,
					nestedTaskId: String(input.durableTaskId),
				}
			: entry,
	);

	return { kind: "admitted", slot };
}

/**
 * Add the item to the queue, idempotently, and return the entry.
 *
 * An item already queued keeps its original `enqueuedAt`, `ordinal` and
 * `requeues`: a retry must not jump ahead of work that has been waiting longer,
 * and — because a waiting item re-presents itself on every poll — must not be
 * counted again either. `requeues` belongs to reconciliation, which bumps it when
 * it finds a reservation whose child task is gone; a poll is not a requeue.
 */
function enqueue(scheduler: SchedulerState, input: AdmissionInput): QueueEntry {
	const existing = scheduler.queue.find((entry) => entry.operationId === input.operationId);
	if (existing !== undefined) return existing;
	const entry: QueueEntry = {
		operationId: input.operationId as QueueEntry["operationId"],
		batchId: input.batchId,
		requestId: input.requestId,
		taskId: input.taskId,
		round: input.round,
		enqueuedAt: input.now,
		ordinal: scheduler.queue.length,
		requeues: 0,
	};
	scheduler.queue = [...scheduler.queue, entry];
	return entry;
}

/**
 * Release one item's slot. Called by settlement and by the verified cancel close.
 *
 * Releasing by operation id — not by attempt — is what makes a retried item keep
 * exactly one slot: a retry within the same round never releases and re-takes,
 * so the count cannot drift upward.
 */
export function releaseSlot(scheduler: SchedulerState, operationId: string): void {
	scheduler.active = scheduler.active.filter((slot) => slot.operationId !== operationId);
}

/** Remove one item from the queue, if it is waiting. */
export function dequeue(scheduler: SchedulerState, operationId: string): void {
	scheduler.queue = scheduler.queue.filter((entry) => entry.operationId !== operationId);
}

/** The slot one operation currently holds, if any. */
export function slotOf(scheduler: SchedulerState, operationId: string): ActiveSlot | undefined {
	return scheduler.active.find((slot) => slot.operationId === operationId);
}

/**
 * The queue in service order: oldest first, with the enqueue ordinal as the
 * tie-breaker so the order never depends on how the array happened to be built.
 */
export function serviceOrder(scheduler: SchedulerState): readonly QueueEntry[] {
	return [...scheduler.queue].sort((a, b) => (a.enqueuedAt === b.enqueuedAt ? a.ordinal - b.ordinal : a.enqueuedAt - b.enqueuedAt));
}
