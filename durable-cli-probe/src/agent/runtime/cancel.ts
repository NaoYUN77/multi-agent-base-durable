// TASK-005.4 src/agent/runtime/cancel.ts
//
// Stopping a batch, and finishing a stop that a crash interrupted.
//
// The order is the design, not an implementation detail:
//
//   1. **The intent is committed before anything is aborted.** A process that
//      dies between the intent and the close must find, on reopen, a record that
//      says a stop was asked for. Aborting first would leave stopped children with
//      nothing to explain them, and the batch would resume work nobody wants.
//   2. **The intent alone already stops new work.** Admission refuses a batch with
//      an intent and a task with a cancel request, so the abort below is for the
//      work that is *already* running, not for the work that has not started.
//   3. **`cancelled` is written only after the child is verified idle** and the
//      round's execution right is free. A terminal status overrules work that is
//      still running — precisely what the requirement forbids: a stop must not
//      release a resource that is still in use, nor claim to have stopped
//      something that has not stopped.
//   4. **A stop that cannot be verified stays open.** The intent is kept, the slot
//      is kept, and the caller is told `stopping`. Reopening a batch resumes the
//      join, which is what makes the crash between abort and close recoverable
//      instead of terminal.
//
// Two kinds of stop, deliberately not one:
//
//   * **operator** ends the task. The round is `cancelled`, the business status is
//     terminal, and the ledger carries a cancel request — so no admission can
//     revive it, then or after a restart.
//   * **deadline** ends the *round*. The business status is left exactly as it was
//     so Main can decide about another attempt; the round is `failed` with
//     `failureKind: "technical"` (a clock is not a verdict on the work) and the
//     receipt carries `requiresMainDecision`. No `cancelRequested` is written: it
//     would be refused at admission as `cancel_pending` and would turn a clock
//     into a verdict on the task.
//
// Why this file closes items at all, when `item.ts` is the settlement writer: an
// item whose own task is alive settles itself, including when it observes the stop
// (see `stopFailure` in `item.ts`). Only an item whose task is *gone* — killed, or
// aborted so hard that its tool task never returned — has nobody left to write its
// receipt, and a batch that cannot write a receipt for an item can never settle.
// This file is that writer, and it writes only for items whose child is verified
// idle and whose execution right is verified free. In every other case the item's
// own task settles it, and this file's only job is to wait.
//
// How batches are found on reopen: from `BatchIndexDoc`, the session's list of
// admitted batch ids (`discoverBatches`). The scheduler names only the batches that
// hold capacity — the items that started and have not settled — and the batch a stop
// most needs to reach is precisely the one whose items have not been created yet,
// which holds nothing at all. So capacity is what a report is *not* built from:
// `SchedulerDoc` is cited and repaired only where a reservation actually exists.
//
// The list is complete, which is what makes `reconcileOne` able to say "nothing
// here" and return nothing: a batch with every item receipted and no stop on record
// is not reported at all, instead of being re-reported as `settled` every time the
// session opens. A batch in neither state — admitted, no cancel intent, items still
// outstanding — is reported as `running`: its remaining work belongs to the
// dispatch task's own replay, which recreates the item tasks by their stable keys.

import type { Context, Draft } from "@earendil-works/chord";
import type {
	ConversationId,
	Cursor,
	EntryId,
	EntryRecord,
	Harness,
	ModelRef,
	Tx,
} from "@earendil-works/pi-durable";
import type { RunConfig } from "../contracts/run-config.ts";
import { isSettledRoundStatus } from "../contracts/round-execution.ts";
import { isTerminalBusinessStatus } from "../state/lifecycle.ts";
import { clearStaleRight, recordTransition, TaskLedgerDoc, type TaskLedgerState } from "../../multiagent/ledger.ts";
import { dequeue, releaseSlot } from "./admission.ts";
import { batchIdOf, type BatchCancelResult, type BatchId, type BatchReconciliation, type OperationId } from "./contracts.ts";
import {
	AgentBatchDoc,
	AgentQuotaDoc,
	AgentRoundBindingDoc,
	BatchIndexDoc,
	SchedulerDoc,
	type BatchCancelIntent,
	type BatchFailureKind,
	type BatchItemReceipt,
	type BatchItemState,
	type OperationSpend,
	type RoundSpend,
} from "./documents.ts";
import { operationSpendOf, QuotaRefusal, reconcileRoundFromEntries } from "./quota.ts";
import { lastRoundOf, moveRound, settleRoundRecord } from "./round.ts";

/** Everything the stop path needs from the runtime that owns it. */
export type CancelDependencies = {
	readonly harness: Harness;
	readonly mainConversationId: ConversationId;
	/** The provider/model both sides run; seeds a ledger this path has to read. */
	readonly model: ModelRef;
	/** The bounds the round was admitted under, read for the counter reconciliation. */
	readonly runConfig: RunConfig;
	readonly now: () => number;
	/** Injected so a test can drive the join without waiting on a clock. */
	readonly wait?: (ms: number) => Promise<void>;
};

/** One stop, as the caller asks for it. */
export type StopRequest = {
	readonly batchId: BatchId;
	readonly kind: BatchCancelIntent["kind"];
	readonly reason: string;
};

/**
 * How many times the join re-reads the world before it reports `stopping`.
 *
 * Not a budget: the stop is not abandoned when the attempts run out, it is
 * reported as unfinished. The caller (or the next reopen) tries again with the
 * intent still on record, so nothing is lost by giving up on a child that refuses
 * to die.
 */
const JOIN_ATTEMPTS = 50;

/** How long the join waits between two reads. */
const JOIN_PAUSE_MS = 20;

/** One page of a durable task scan. */
const TASK_PAGE = 100;

/** Safety rail on a task scan; a conversation with more pages than this fails loudly. */
const MAX_TASK_PAGES = 100;

/** One page of an entry scan, for the counter reconciliation of a closed round. */
const ENTRY_PAGE = 200;

/** Safety rail on the entry scan of one round. */
const MAX_ENTRY_PAGES = 200;

/**
 * Stop one batch: persist the intent, abort and join its children, then close the
 * items whose own task is no longer there to close them.
 *
 * Idempotent. A second call re-reads the intent, finds the items already settled
 * and reports `settled`; a call for a batch that was already cancelled reports
 * `settled` for the items whose receipts exist. The intent is written once — a
 * later stop does not overwrite the first reason, because the first reason is what
 * the children were aborted for.
 *
 * @param dependencies - harness, Main conversation, and the bounds the rounds ran
 *   under. Authorization for the writes below comes from the caller: this function
 *   is reachable only from the runtime's own control surface (`cancelBatch`), which
 *   the service calls for a request-wide cancel it has already recorded.
 * @param request - the batch and why it is being stopped.
 * @returns the per-item states of the stop. `cancelled` only for items this call
 *   settled as cancelled; `stopping` for items whose child has not confirmed idle.
 * @throws nothing for a business reason. A stop that cannot complete is a
 *   `stopping` result, not an error: the child may be a model call that is still
 *   in flight, which is normal, not exceptional.
 */
export async function stopBatch(
	dependencies: CancelDependencies,
	request: StopRequest,
	context: Context,
): Promise<BatchCancelResult> {
	const intent: BatchCancelIntent = { kind: request.kind, at: dependencies.now(), reason: request.reason };
	const opKey = cancelOpKeyOf(request.batchId, request.kind);
	const prepared = await dependencies.harness.commit(async (tx) => {
		const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, request.batchId, { batchId: request.batchId });
		if (batch.createdAt === 0) return { admitted: false };
		if (batch.cancel === undefined) batch.cancel = intent;
		const scheduler = await tx.doc(SchedulerDoc);
		const stopKind: "cancel" | "deadline" = intent.kind === "operator" ? "cancel" : "deadline";
		for (const item of batch.items) {
			if (item.receipt !== undefined) continue;
			// A waiting item gives up its place here. Only a stop reaches it from now
			// on, and holding the position would defer every item behind it.
			dequeue(scheduler, item.operationId);
			const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, item.taskId, {
				taskId: item.taskId,
				model: dependencies.model,
			});
			// The child's own gate reads its binding, not this ledger: writing the stop
			// there is what makes a business call inside the child fail closed while the
			// abort is still travelling. A child with no round binding yet has nothing
			// to gate, and the wrapper refuses a business call without one anyway.
			if (ledger.childConversationId !== undefined) {
				const binding = await tx.doc(AgentRoundBindingDoc, ledger.childConversationId);
				if (binding.round !== 0 && binding.stop === undefined) binding.stop = { kind: stopKind, at: intent.at };
			}
			if (intent.kind !== "operator") continue;
			// A ledger that was never dispatched has nothing to refuse, and stamping a
			// cancel request on it would claim a history that did not happen. A terminal
			// task is not cancellable by definition — it already ended as something else.
			if (ledger.createdAt === 0 || isTerminalBusinessStatus(ledger.status)) continue;
			if (ledger.cancelRequested === undefined) ledger.cancelRequested = { opKey, at: intent.at, reason: intent.reason };
		}
		return { admitted: true };
	}, context);
	if (!prepared.admitted) {
		// Nothing was ever admitted under this id: there is no work to stop and no item
		// to report. `settled` is the honest answer — nothing here is outstanding.
		return { batchId: request.batchId, state: "settled", items: [] };
	}
	return await joinBatch(dependencies, request.batchId, intent.kind, opKey, context);
}

/**
 * Every admitted batch of the Main conversation.
 *
 * Read from `BatchIndexDoc`, the session's list of admitted batch ids. The list is
 * the only complete enumeration available: the platform's document *scan* lives on
 * `Storage`, not on `Session`, so a `Harness` cannot walk a document family — and
 * the scheduler is not an enumeration either, because the batch a request-wide stop
 * most needs to reach is the one that was admitted and never got an item running,
 * which holds no slot.
 *
 * The read creates nothing. `Tx.doc` materializes a missing family member from its
 * definition's initial value, so a discovery built on it would write the documents
 * it was looking for; `snapshot` reports what is actually there.
 *
 * @param dependencies - harness and Main conversation; nothing else is read.
 * @param context - the caller's context.
 * @returns the batch ids in admission order. Each is re-derived through `batchIdOf`,
 *   so a stored value that is not a batch id is a loud error rather than a batch
 *   nobody can stop.
 */
export async function discoverBatches(dependencies: CancelDependencies, context: Context): Promise<readonly BatchId[]> {
	const index = await dependencies.harness.snapshot(BatchIndexDoc, context);
	if (index === undefined) return [];
	return index.batches.map((stored) => asBatchId(stored));
}

/**
 * Finish every stop that is on record and not yet closed.
 *
 * Called once on open, after the harness has resumed, and safe to call again at
 * any time. It reports on the batches that still have work — either items waiting
 * to run, or a stop that has not been confirmed — and does nothing about the
 * batches that are finished.
 *
 * @param dependencies - as for `stopBatch`.
 * @returns one report per batch with outstanding work, in scan order.
 */
export async function reconcileBatches(dependencies: CancelDependencies, context: Context): Promise<readonly BatchReconciliation[]> {
	const discovered = await discoverBatches(dependencies, context);
	const reports: BatchReconciliation[] = [];
	for (const batchId of discovered) {
		const report = await reconcileOne(dependencies, batchId, context);
		if (report !== undefined) reports.push(report);
	}
	return reports;
}

/**
 * Reconcile one batch: close a stop that is on record, or report the items that
 * are still owed.
 *
 * A batch with a stop on record is joined again — that is the recovery for a crash
 * between the abort and the close. A batch without one is reported only: its items
 * are the dispatch task's own replay to finish, and a runtime that started work on
 * its own initiative would be a second dispatcher.
 *
 * A fully settled batch with no stop on record is not reported at all. Discovery is
 * a complete scan, so every batch the conversation ever admitted is visited; saying
 * "settled, nothing to do" once per finished batch on every open would drown the
 * batches that do have work. Silence is the right report for finished work.
 *
 * @returns the report, or `undefined` when there is nothing to report.
 */
async function reconcileOne(dependencies: CancelDependencies, batchId: BatchId, context: Context): Promise<BatchReconciliation | undefined> {
	const inspection = await dependencies.harness.commit(async (tx) => {
		const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, batchId, { batchId });
		return {
			admitted: batch.createdAt !== 0,
			cancel: batch.cancel,
			items: batch.items.map((item) => ({ taskId: item.taskId, settled: item.receipt !== undefined })),
		};
	}, context);
	if (!inspection.admitted) {
		// A slot or a queue entry for a batch that was never admitted is a reservation
		// nobody can use. Releasing it is the one repair this path performs, and it is
		// what "no leftover active execution" means for a batch whose own record is
		// missing: the alternative is capacity nobody can ever give back.
		await releaseUnadmitted(dependencies, batchId, context);
		return undefined;
	}
	const settled = inspection.items.filter((item) => item.settled).map((item) => item.taskId);
	const outstanding = inspection.items.filter((item) => !item.settled).map((item) => item.taskId);
	if (inspection.cancel === undefined) {
		// Nothing to stop and nothing outstanding: this batch is finished, and a
		// finished batch is reported by being left out of the report.
		if (outstanding.length === 0) return undefined;
		return { batchId, state: "running", resumed: outstanding, alreadySettled: settled };
	}
	const opKey = cancelOpKeyOf(batchId, inspection.cancel.kind);
	const joined = await joinBatch(dependencies, batchId, inspection.cancel.kind, opKey, context);
	const closed = joined.items.filter((item) => item.state !== "stopping").map((item) => item.taskId);
	const stopping = joined.items.filter((item) => item.state === "stopping");
	if (stopping.length === 0) return { batchId, state: "settled", resumed: [], alreadySettled: closed };
	// The stop is owed and the items that outlive it are the report: a `cancelling`
	// batch says exactly this, so they are not listed as `resumed` — nothing will
	// resume them while the stop stands.
	return {
		batchId,
		state: "cancelling",
		resumed: [],
		alreadySettled: closed,
		refused: stopping.map((item) => ({
			taskId: item.taskId,
			code: "cancel_pending",
			detail: item.detail ?? "the child has not confirmed idle",
		})),
	};
}

/**
 * Abort, join and close one batch's outstanding items.
 *
 * Aborting is repeated on every attempt rather than done once: `abort` is
 * idempotent, and a child that answered a submission between two attempts is a
 * child that has to be told again.
 */
async function joinBatch(
	dependencies: CancelDependencies,
	batchId: BatchId,
	kind: BatchCancelIntent["kind"],
	opKey: string,
	context: Context,
): Promise<BatchCancelResult> {
	const closed = new Map<string, BatchCancelResult["items"][number]>();
	for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt++) {
		const targets = await stopTargets(dependencies, batchId, context);
		for (const target of targets) await abortChild(dependencies, target, context);
		let waiting = false;
		for (const target of targets) {
			const outcome = await closeOne(dependencies, batchId, kind, opKey, target, context);
			if (outcome.waiting) {
				waiting = true;
				// A previous attempt may have closed this item; a later attempt that cannot
				// see a receipt is a later attempt that must not erase the record of it.
				if (!closed.has(target.taskId)) closed.set(target.taskId, { taskId: target.taskId, state: "stopping", detail: outcome.detail });
				continue;
			}
			closed.set(target.taskId, { taskId: target.taskId, state: outcome.state, detail: outcome.detail });
		}
		if (!waiting) break;
		await (dependencies.wait ?? sleep)(JOIN_PAUSE_MS);
	}
	const items = await batchItems(dependencies, batchId, context);
	const states = items.map((item) => {
		// A receipt is the item's final record, and it outranks what an earlier join
		// iteration observed. An item can settle between two attempts — the stop aborts
		// its child, the item classifies the abort and writes its own receipt — so the
		// join sees "waiting" once and then finds the item is no longer a target at
		// all. Reporting that remembered "waiting" would call a fully settled batch
		// unfinished, which is exactly the state a caller would retry forever.
		if (item.receiptStatus !== undefined) {
			return { taskId: item.taskId, state: item.receiptStatus === "cancelled" ? ("cancelled" as const) : ("settled" as const) };
		}
		return closed.get(item.taskId) ?? { taskId: item.taskId, state: "settled" as const };
	});
	const stopping = states.some((item) => item.state === "stopping");
	const cancelled = states.some((item) => item.state === "cancelled");
	return { batchId, state: stopping ? "stopping" : cancelled ? "cancelled" : "settled", items: states };
}

/** What one close decided. `waiting` means "not yet", never "failed". */
type CloseOutcome = {
	readonly waiting: boolean;
	readonly state: "cancelled" | "settled";
	readonly detail?: string;
};

/** One item the join has to act on: an item without a receipt. */
type StopTarget = {
	readonly taskId: string;
	readonly operationId: OperationId;
	readonly childConversationId: ConversationId | undefined;
};

/**
 * Close one item, if — and only if — its own task is gone and its child is idle.
 *
 * One commit holds the verification and the writes it authorizes, so nothing can
 * start running between the check and the close: the right is verified free in the
 * same transaction that clears it, and the child is verified idle in the same
 * transaction that writes `cancelled`. A check in one commit and a write in
 * another would be exactly the race the requirement names.
 *
 * Writes, for an item that closes: the round's status and counters, the ledger's
 * business status (an operator cancel only), the batch item's receipt, the slot,
 * and the batch's `settledAt` when this is the last item. Nothing is written when
 * it does not close.
 */
async function closeOne(
	dependencies: CancelDependencies,
	batchId: BatchId,
	kind: BatchCancelIntent["kind"],
	opKey: string,
	target: StopTarget,
	context: Context,
): Promise<CloseOutcome> {
	return await dependencies.harness.commit(async (tx) => {
		const now = dependencies.now();
		const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, batchId, { batchId });
		const item = batch.items.find((entry) => entry.taskId === target.taskId);
		if (item === undefined) {
			return { waiting: false, state: "settled" as const, detail: `task ${target.taskId} is not a member of batch ${batchId}` };
		}
		if (item.receipt !== undefined) return { waiting: false, state: "settled" as const };
		const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, target.taskId, {
			taskId: target.taskId,
			model: dependencies.model,
		});

		// ── Verification, before every write ────────────────────────────────────
		if (target.childConversationId !== undefined) {
			const live = await liveTasks(tx, target.childConversationId);
			if (live.length > 0) {
				return { waiting: true, state: "settled" as const, detail: `child work is still live (${live.join(", ")})` };
			}
		}
		if (ledger.activeToolTaskId !== undefined) {
			// A round whose holder task is live may submit at any moment. Only a terminal
			// holder makes the right stale — and a stale right must be cleared, or the
			// stop could never close and the capacity would never come back.
			const status = await taskStatus(tx, dependencies.mainConversationId, ledger.activeToolTaskId);
			if (status !== undefined && status !== "terminal") {
				return { waiting: true, state: "settled" as const, detail: `round ${ledger.activeRound ?? 0} is still held by a live task` };
			}
		}
		if (ledger.activeOpKey !== undefined) clearStaleRight(ledger);

		// ── The item's terminal record ──────────────────────────────────────────
		const cancelled = kind === "operator";
		const round = roundForClose(item, ledger);
		const execution = ledger.rounds.find((entry) => entry.round === round)?.execution;
		if (execution !== undefined) {
			// The counters are reconciled from the child's entries, exactly as a live
			// settlement does: a round that was killed mid-flight still spent what its
			// settled tool results say it spent, and leaving the counters at zero would
			// understate a budget the next round has to fit into.
			const quota = await tx.doc(AgentQuotaDoc, dependencies.mainConversationId, batch.requestId, { requestId: batch.requestId });
			const operation = operationSpendOf(quota, target.operationId, target.taskId);
			const entries = await roundEntries(tx, target.childConversationId, execution.startEntryId);
			try {
				reconcileRoundFromEntries(operation, round, entries, dependencies.runConfig);
			} catch (error) {
				// The allowance is already gone. The counters stay where they are and the
				// close still records the truth about the round: a second refusal here
				// would replace "the round was stopped" with "the budget complained".
				if (!(error instanceof QuotaRefusal)) throw error;
			}
			// The right is free by now, so `settleRoundRecord`'s own status move would be
			// skipped; the status is set here, while the round is still being settled.
			if (!isSettledRoundStatus(execution.status)) moveRound(ledger, opKey, round, cancelled ? "cancelled" : "failed");
			settleRoundRecord(ledger, opKey, round, {
				status: cancelled ? "cancelled" : "failed",
				toolInvocations: roundSpend(operation, round)?.toolInvocationsUsed ?? 0,
				failedToolCalls: roundSpend(operation, round)?.failedToolCallsUsed ?? 0,
				technicalRestarts: operation.technicalRestartsUsed,
				at: now,
			});
		}
		if (!isTerminalBusinessStatus(ledger.status) && cancelled) {
			recordTransition(ledger, "cancelled", now, { opKey, round, reason: "cancelled_by_operator" });
		}
		const failureKind: BatchFailureKind = cancelled ? "cancelled" : "technical";
		// No `resultId`: this close settles a round that did not finish. A round that
		// did finish wrote its result id in the same commit as its receipt, so a
		// missing receipt here means there is no result document to point at.
		const receipt: BatchItemReceipt = {
			taskId: target.taskId,
			operationId: target.operationId,
			round,
			status: cancelled ? "cancelled" : "failed",
			failureKind,
			// A deadline is a technical stop that Main has to decide about, exactly as
			// the item's own task would have recorded it had it survived to do so.
			...(cancelled ? {} : { requiresMainDecision: true }),
			detail: cancelled
				? `batch ${batchId} was cancelled while the task was running`
				: `batch ${batchId} reached its deadline while the task was running`,
			settledAt: now,
		};
		item.receipt = receipt;
		if (item.round === undefined) item.round = round;
		const scheduler = await tx.doc(SchedulerDoc);
		releaseSlot(scheduler, target.operationId);
		dequeue(scheduler, target.operationId);
		if (batch.settledAt === undefined && batch.items.every((entry) => entry.receipt !== undefined)) batch.settledAt = now;
		return { waiting: false, state: cancelled ? ("cancelled" as const) : ("settled" as const), detail: receipt.detail };
	}, context);
}

/** The items of one batch that have no receipt yet: the work a stop still owes. */
async function stopTargets(dependencies: CancelDependencies, batchId: BatchId, context: Context): Promise<readonly StopTarget[]> {
	return await dependencies.harness.commit(async (tx) => {
		const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, batchId, { batchId });
		const targets: StopTarget[] = [];
		for (const item of batch.items) {
			if (item.receipt !== undefined) continue;
			const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, item.taskId, {
				taskId: item.taskId,
				model: dependencies.model,
			});
			targets.push({ taskId: item.taskId, operationId: item.operationId, childConversationId: ledger.childConversationId });
		}
		return targets;
	}, context);
}

/**
 * The batch's items, in member order, for the result of a stop.
 *
 * The receipt status is copied out here rather than left as a document read: the
 * caller compares it after the commit settles, and an overlay view of the batch
 * would be dead by then.
 */
async function batchItems(
	dependencies: CancelDependencies,
	batchId: BatchId,
	context: Context,
): Promise<readonly { readonly taskId: string; readonly receiptStatus?: BatchItemReceipt["status"] }[]> {
	return await dependencies.harness.commit(async (tx) => {
		const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, batchId, { batchId });
		return batch.items.map((item) => ({
			taskId: item.taskId,
			...(item.receipt === undefined ? {} : { receiptStatus: item.receipt.status }),
		}));
	}, context);
}

/**
 * Abort one child conversation and wait for it to be idle.
 *
 * The handle is conversation-scoped, so it works even though the child's owning
 * delegate task ended long ago — which is exactly the case a reopened process
 * creates, and the reason this cannot be done through the tool task's own api.
 */
async function abortChild(dependencies: CancelDependencies, target: StopTarget, context: Context): Promise<void> {
	if (target.childConversationId === undefined) return;
	const conversation = await dependencies.harness.conversation(target.childConversationId, context);
	if (conversation === undefined) return;
	await conversation.abort(context);
}

/**
 * Give back the reservations of a batch that was never admitted.
 *
 * Kept apart from the close because there is no item to write a receipt for: the
 * batch document carries no members, so the only thing that can be repaired is the
 * capacity the admission took before it could be recorded.
 */
async function releaseUnadmitted(dependencies: CancelDependencies, batchId: BatchId, context: Context): Promise<void> {
	await dependencies.harness.commit(async (tx) => {
		const scheduler = await tx.doc(SchedulerDoc);
		for (const slot of scheduler.active) if (slot.batchId === batchId) releaseSlot(scheduler, slot.operationId);
		for (const entry of scheduler.queue) if (entry.batchId === batchId) dequeue(scheduler, entry.operationId);
	}, context);
}

/** The ids of the live, ordinary tasks of one conversation, as `id:status`. */
async function liveTasks(tx: Tx, conversationId: ConversationId): Promise<readonly string[]> {
	const live: string[] = [];
	for (const [id, task] of await taskStatuses(tx, conversationId)) {
		// Background tasks are outside the ordinary ownership scope: Durable's own idle
		// and abort semantics exclude them, so a stop must not wait for one.
		if (task.background) continue;
		if (task.status !== "terminal") live.push(`${id}:${task.status}`);
	}
	return live;
}

/** The status of one task, or `undefined` when this conversation does not own it. */
async function taskStatus(tx: Tx, conversationId: ConversationId, taskId: string): Promise<string | undefined> {
	return (await taskStatuses(tx, conversationId)).get(taskId)?.status;
}

/**
 * Every task of one conversation, keyed by its id as text.
 *
 * Keyed as text because that is how the ledger stores its holder
 * (`activeToolTaskId` is a string): comparing the two avoids converting a stored
 * id back into a branded `TaskId`, which would be an assertion the type system
 * cannot check. One scan serves both questions — whether any task is live, and
 * whether one particular task is terminal.
 */
async function taskStatuses(tx: Tx, conversationId: ConversationId): Promise<ReadonlyMap<string, { readonly status: string; readonly background: boolean }>> {
	const statuses = new Map<string, { readonly status: string; readonly background: boolean }>();
	let cursor: Cursor | undefined;
	for (let pages = 0; pages < MAX_TASK_PAGES; pages++) {
		const page = await tx.scanTasks({ conversationId }, TASK_PAGE, cursor);
		for (const record of page.items) {
			statuses.set(String(record.id), { status: record.state.status, background: record.background });
		}
		if (page.next === undefined) return statuses;
		cursor = page.next;
	}
	throw new Error(`task scan of conversation ${conversationId} exceeded ${MAX_TASK_PAGES} pages; refusing to verify idle from a partial read`);
}

/** The entries of one round, from its entry floor, oldest first. */
async function roundEntries(tx: Tx, conversationId: ConversationId | undefined, startEntryId: EntryId | undefined): Promise<readonly EntryRecord[]> {
	if (conversationId === undefined) return [];
	const items: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	for (let pages = 0; pages < MAX_ENTRY_PAGES; pages++) {
		const page = await tx.scanEntries(
			{ conversationId, ...(startEntryId === undefined ? {} : { minEntryId: startEntryId }), order: "ascending" },
			ENTRY_PAGE,
			cursor,
		);
		items.push(...page.items);
		if (page.next === undefined) return items;
		cursor = page.next;
	}
	throw new Error(`entry scan of conversation ${conversationId} exceeded ${MAX_ENTRY_PAGES} pages; refusing to reconcile counters from a partial read`);
}

/** The spend record of one round of one operation, when it has one. */
function roundSpend(operation: OperationSpend, round: number): RoundSpend | undefined {
	return operation.rounds.find((entry) => entry.round === round);
}

/**
 * The round a closed item's record belongs to.
 *
 * An item that was admitted recorded its round at admission. An item that never
 * was has no round record to read one from — it died before claiming one — and the
 * round it belongs to is the task's next: the first round for a task that never
 * ran, the rework round for one that settled a round before. Reading the ledger's
 * last round instead would name the round that already settled, which is the one
 * round the receipt certainly does not settle.
 */
function roundForClose(item: BatchItemState, ledger: Draft<TaskLedgerState>): number {
	return item.round ?? lastRoundOf(ledger) + 1;
}

/**
 * `cancel:<batch id>:<kind>`.
 *
 * Not a tool call's operation key: a stop is asked for by the service or by a
 * clock, never by a model, so there is no `toolTaskId`/`callId` pair to build one
 * from. What matters is that it is stable across a replay and unique per batch and
 * kind, which is what the ledger's cancel request needs to be recognized as the
 * same operation twice.
 */
function cancelOpKeyOf(batchId: BatchId, kind: BatchCancelIntent["kind"]): string {
	return `cancel:${batchId}:${kind}`;
}

/**
 * A batch id as stored in a scheduler entry, re-derived rather than trusted.
 *
 * `batchIdOf` is the only constructor of this key space, so the stored value is
 * taken apart and rebuilt through it: a scheduler entry that names something which
 * is not a batch id is then a loud error instead of a lookup for a document that
 * cannot exist.
 */
function asBatchId(value: string): BatchId {
	if (!value.startsWith("batch:")) throw new Error(`scheduler entry names a batch that is not a batch id: ${JSON.stringify(value)}`);
	return batchIdOf(value.slice("batch:".length));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
