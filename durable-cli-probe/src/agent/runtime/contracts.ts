// TASK-005.4 src/agent/runtime/contracts.ts
//
// The identities and the refusal vocabulary of the batch runtime.
//
// Every key space below has exactly one constructor, and none of them is a
// free-form string a caller assembles. That matters because each one is a
// *dedupe* key as well as a name: a quota reservation is charged once per id, a
// nested durable tool call is replayed by its key, and a result document is
// found by its id. A caller that could mint an id could therefore mint a second
// charge for the same work, which is the failure mode "recovery must not
// double-spend" is about.
//
// The two identity layers this file sits between:
//
//   * `dispatch:<toolTaskId>:<callId>` is the Main admission's operation key
//     (`src/agent/main/tools.ts`). One `dispatch_tasks` call, one key.
//   * `task:<taskId>` is one business task's whole history: its first round and
//     every rework. `attempt:<n>` counts attempts *within* one round, and the
//     attempt number comes from persisted state, never from a clock.
//
// The three child-conversation ids mirror `src/multiagent/delegation.ts` so a
// round that began under TASK-003 and resumes here resolves to the same
// submission rather than starting a second one.

import type { ToolExecutionApi } from "@earendil-works/pi-durable";

/** One `dispatch_tasks` call, derived from its durable tool-call identity. */
export type BatchId = string & { readonly __batchId: unique symbol };

/** One business task's whole execution history (its first round and every rework). */
export type OperationId = string & { readonly __operationId: unique symbol };

/** One attempt of one round. Stable across a crash and a replay. */
export type AttemptKey = string & { readonly __attemptKey: unique symbol };

/** A plan the runtime executes, as the dispatcher read it. Not the plan itself. */
export type PlanRef = {
	readonly planId: string;
	/** The exact saved plan version. A stale version is refused, never migrated. */
	readonly version: number;
};

/** The requirement identity, read from the stored plan rather than supplied by a caller. */
export type RequestRef = {
	readonly requestId: string;
	readonly requestVersion: number;
};

/**
 * Why a batch was started. Both triggers produce the same batch machinery; the
 * trigger decides which preconditions apply and how the ledger round is labelled.
 */
export type BatchTrigger =
	| { readonly kind: "dispatch" }
	/**
	 * A rework of one existing task. `feedback` is the reviewed rejection text;
	 * the task id must be in the referenced plan and must be awaiting review.
	 */
	| { readonly kind: "rework"; readonly taskId: string; readonly feedback: string };

/**
 * Program-supplied execution context. Constructed by the dispatch adapter or the
 * CLI service; the model never sees or fills it.
 *
 * `api` is the invoking tool call, and that is the whole point: nested calls made
 * through it are themselves durable `pi.tool` tasks with stable keys, so an item
 * that dies mid-round is resumed rather than duplicated.
 */
export type BatchExecutionContext = {
	readonly api: ToolExecutionApi;
	readonly batchId: BatchId;
	readonly trigger: BatchTrigger;
};

/** The dispatch operation key shape the Main admission produces. */
const DISPATCH_OPERATION_KEY = /^dispatch:[^:]+:.+$/;

/**
 * `batch:<dispatch operation key>`.
 *
 * The batch id is *derived* rather than stored, so a crash between the admission
 * commit and the batch document leaves nothing to repair: the replay of the same
 * tool call derives the same id and finds whatever the first attempt wrote.
 */
export function batchIdOf(dispatchOperationKey: string): BatchId {
	if (!DISPATCH_OPERATION_KEY.test(dispatchOperationKey)) {
		throw new Error(`not a dispatch operation key: ${JSON.stringify(dispatchOperationKey)}`);
	}
	return `batch:${dispatchOperationKey}` as BatchId;
}

/** The dispatch operation key a batch id was derived from. */
export function dispatchKeyOf(batchId: BatchId): string {
	const key = batchId.slice("batch:".length);
	if (!DISPATCH_OPERATION_KEY.test(key)) throw new Error(`not a batch id: ${JSON.stringify(batchId)}`);
	return key;
}

/** `task:<businessTaskId>`. Derived from the validated spec id, never from a call. */
export function operationIdOf(taskId: string): OperationId {
	return `task:${taskId}` as OperationId;
}

/** The business task id an operation id was derived from. */
export function taskIdOf(operationId: OperationId): string {
	const taskId = operationId.slice("task:".length);
	if (taskId === "" || taskId.includes(":")) throw new Error(`not an operation id: ${JSON.stringify(operationId)}`);
	return taskId;
}

/**
 * `task:<taskId>:r<round>:attempt:<n>`.
 *
 * `n` is the attempt's ordinal **within its round**, which is the same number
 * `RoundAttemptRecord.attemptNo` carries and the same one `openAttempt` checks
 * for contiguity. There is deliberately only one attempt number in the system:
 * an operation-wide counter alongside the in-round one would be a second number
 * that has to agree with the first, and the round in the key already makes it
 * unique across the operation — round 2's attempt 1 is a different key from
 * round 1's, which is what `chargedAttempts` needs to dedupe a replay.
 *
 * The number comes from the persisted attempt list, never from a clock or a
 * counter that lives only in memory: a resumed item must derive the same key it
 * used before, or it would start a second attempt of work that already ran.
 */
export function attemptKeyOf(taskId: string, round: number, attemptNo: number): AttemptKey {
	if (!Number.isInteger(round) || round < 1) throw new Error(`round must be a positive integer, got ${String(round)}`);
	if (!Number.isInteger(attemptNo) || attemptNo < 1) {
		throw new Error(`attempt number must be a positive integer, got ${String(attemptNo)}`);
	}
	return `task:${taskId}:r${round}:attempt:${attemptNo}` as AttemptKey;
}

/**
 * The submission id of one attempt in the child conversation.
 *
 * Attempt 1 keeps the legacy `multiagent-round:<taskId>:<round>` form, so a round
 * that began under TASK-003 and resumes here resolves to the *same* submission
 * instead of starting a second one. A retry after a settled technical failure
 * cannot reuse that id — the failed submission is already settled and Durable
 * refuses to answer it twice — so later attempts get `:a<n>`.
 */
export function attemptRequestId(taskId: string, round: number, attemptNo: number): string {
	return attemptNo === 1 ? `multiagent-round:${taskId}:${round}` : `multiagent-round:${taskId}:${round}:a${attemptNo}`;
}

/**
 * The stable nested-call key of one item: `task.<taskId>.r<round>`.
 *
 * One key per `(task, round)`, and deliberately not per attempt. Durable
 * reattaches a repeated key to the task it already created, so keying by attempt
 * would mean a retry could not resume its own round; keying by round means a
 * replayed item *is* the same item task, which is what makes the slot, the
 * execution right and the attempt list idempotent. Every attempt of the round
 * therefore runs inside this one task — the alternative, one task per attempt,
 * is refused by both `admission` (`execution_right_held`) and `claimRound` (the
 * round is already claimed), so it is not a design choice that is still open.
 *
 * It doubles as the ledger's `opKey` for the round. That is not a coincidence:
 * the key that identifies the nested call is exactly the key that identifies who
 * holds the round, and having two would let them disagree.
 *
 * Durable's key rules are narrower than "any string": non-empty, no `/`, not
 * `__proto__`, and not a positive integer. Dots and the `r` marker satisfy them,
 * and the shape is readable in an audit trail.
 */
export function roundCallKey(taskId: string, round: number): string {
	if (!Number.isInteger(round) || round < 1) throw new Error(`round must be a positive integer, got ${String(round)}`);
	return `task.${taskId}.r${round}`;
}

/**
 * The write-once result id: one receipt per task per round.
 *
 * Only `[a-z0-9._-]` may appear. `readStableId` refuses a `:` in
 * `TaskResult.resultId`, so the operation id — which contains one — cannot be
 * embedded here, and `res.` is the prefix that keeps this namespace distinct
 * from the operation keys above.
 */
export function resultIdOf(taskId: string, round: number): string {
	if (!Number.isInteger(round) || round < 1) throw new Error(`round must be a positive integer, got ${String(round)}`);
	return `res.${taskId}.r${round}`;
}

/**
 * What a stop of one batch resulted in.
 *
 * `cancelled` is a claim that the stop *applied*: every item is verified terminal
 * and no child of the batch has live work. It is never written because a stop was
 * asked for — a timeout or a cancel that cannot confirm an idle child must not
 * report itself as stopped, which is what `stopping` is for. The intent and the
 * slot are kept in that case, so the next attempt resumes where this one gave up.
 *
 * `settled` covers the two ways nothing was left to stop: every item already had a
 * receipt when the stop arrived, or the batch id names no admitted batch at all. A
 * batch-level `settled` therefore never overrules a per-item `cancelled`: it is
 * reported only when no item was cancelled by this call. It also covers a
 * **deadline** stop that completed, because a deadline stops the round rather than
 * the task: the items settle `failed` rather than `cancelled`, and calling that a
 * cancellation would report a clock as a verdict.
 */
export type BatchCancelResult = {
	readonly batchId: BatchId;
	readonly state: "cancelled" | "settled" | "stopping";
	readonly items: readonly {
		readonly taskId: string;
		readonly state: "cancelled" | "settled" | "stopping";
		readonly detail?: string;
	}[];
};

/**
 * What one batch looked like the last time the runtime reconciled.
 *
 * Reported from persisted receipts, never from memory: a caller that opens a
 * session after a crash gets the same answer as one that never closed it. The
 * lists are item ids, in member order.
 */
export type BatchReconciliation = {
	readonly batchId: BatchId;
	/**
	 * `running` — items are outstanding and no stop was asked for. `cancelling` —
	 * a stop is on record and at least one item has no receipt, whether or not the
	 * join could confirm it idle; the stop is still owed. `settled` — every item has
	 * a receipt.
	 */
	readonly state: "running" | "settled" | "cancelling";
	/**
	 * Items left to run. For a `running` batch these are the items whose own durable
	 * task replays and settles them. A `cancelling` batch reports none here: an item
	 * that outlives its stop is what `cancelling` itself says.
	 */
	readonly resumed: readonly string[];
	readonly alreadySettled: readonly string[];
	/** Items this runtime will not start, with the reason. A refusal, never a settled status. */
	readonly refused?: readonly { readonly taskId: string; readonly code: RefusalCode; readonly detail: string }[];
};

/**
 * Stable refusal codes. Every refusal names one; prose is not an interface, and
 * a caller that has to parse a sentence to learn what happened will eventually
 * parse it wrong.
 */
export type RefusalCode =
	| "run_config_missing_or_invalid"
	| "batch_not_admitted"
	| "batch_contract_changed"
	| "task_not_in_batch"
	| "saved_spec_invalid"
	| "plan_version_stale"
	| "plan_request_mismatch"
	| "task_terminal"
	| "task_not_ready_for_rework"
	| "dependency_not_accepted"
	| "authorization_refused"
	| "config_incompatible"
	| "conversation_unavailable"
	| "instance_budget_exhausted"
	| "execution_right_held"
	| "concurrency_full"
	| "resource_conflict"
	| "cancel_pending"
	| "deadline_exceeded"
	| "quota_exhausted";

/**
 * A batch that cannot be resumed or started, with the reason as a code.
 *
 * Thrown from the load phase of `runTaskBatch`, which runs *before* any item * starts: the alternative — a partially started batch that then discovers its
 * contract is stale — spends budget on work that cannot be accepted.
 */
export class BatchNotResumable extends Error {
	readonly code: RefusalCode;
	readonly detail: string;
	constructor(code: RefusalCode, detail: string) {
		super(`${code}: ${detail}`);
		this.name = "BatchNotResumable";
		this.code = code;
		this.detail = detail;
	}
}
