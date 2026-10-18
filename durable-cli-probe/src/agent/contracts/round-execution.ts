// TASK-005.4 src/agent/contracts/round-execution.ts
//
// The execution record of one round, as the ledger stores it.
//
// It lives here rather than in `src/multiagent/ledger.ts` or
// `src/agent/runtime/` because both need it and neither may import the other:
// the ledger owns the execution right and the round record, the runtime owns the
// transitions, and the two must agree on the shape without a cycle. Contracts is
// the lowest layer either can depend on.
//
// Two design points that are easy to get wrong:
//
//   * **The counters are per round, the operation id is per task.** A rework
//     starts a new round with fresh per-round counters, but keeps the operation
//     id and the attempts it already spent. Mixing the two would either reset a
//     task's attempt budget on every rework or carry a round's tool calls into
//     the next round.
//   * **The limits are persisted, not re-derived.** A reopened process must apply
//     the deadline and the allowances the round actually started under. Deriving
//     them again from the current config would silently re-open a round that had
//     already run out, and would let a config change rewrite history.

import type { EntryId } from "@earendil-works/pi-durable";
import type { RoundStatus } from "../state/lifecycle.ts";

/**
 * The limits one round runs under: the task contract narrowed by the run config.
 * Every field is a per-round ceiling except `providerRetry`, which bounds the
 * retries of one attempt.
 */
export type EffectiveRoundBudget = {
	readonly maxToolInvocations: number;
	readonly maxFailedToolCalls: number;
	/** Absolute wall-clock deadline. `min(run config round timeout, task timeout)`. */
	readonly deadlineAt: number;
	/** Copied from the run config so the child-side gate never reaches service config. */
	readonly providerRetry: { readonly maxRetries: number; readonly backoffMs: number };
};

/** One attempt of one round, as the ledger records it. */
export type RoundAttemptRecord = {
	/** 1-based within the round. */
	readonly attemptNo: number;
	/** `task:<taskId>:attempt:<n>`; the quota reservation id of this attempt. */
	readonly attemptKey: string;
	/** The nested durable tool task that ran this attempt, for audit and slot identity. */
	readonly opKey: string;
	/** The submission dedup key in the child conversation. */
	readonly requestId: string;
	readonly submissionId?: string;
	readonly answerEntryId?: string;
	readonly answerText?: string;
	/** Evidence references of this attempt only. */
	readonly evidence: string[];
	readonly startedAt: number;
	readonly settledAt?: number;
	/** Why the attempt did not settle as `done`, when it did not. */
	readonly error?: string;
};

/**
 * Everything the runtime knows about one round that the plain `RoundRecord` does
 * not carry: its status machine position, its persisted limits, its attempts and
 * its counters.
 *
 * `status` is the round status (`queued | running | retry_wait | completed |
 * failed | cancelled`) from `src/agent/state/lifecycle.ts`. A round in
 * `retry_wait` keeps its slot and its execution right: the item task is still
 * live, and releasing capacity would let another item in while this one is about
 * to submit again.
 */
export type RoundExecution = {
	/** `task:<businessTaskId>`. The same value on every round of one task. */
	readonly operationId: string;
	status: RoundStatus;
	readonly limits: EffectiveRoundBudget;
	attempts: RoundAttemptRecord[];
	/** Technical restarts spent by this operation before this round started. */
	technicalRestarts: number;
	/** Business tool calls admitted in this round, counted from settled results. */
	toolInvocations: number;
	/** Failed business tool calls in this round, schema and authorization refusals included. */
	failedToolCalls: number;
	readonly batchId: string;
	readonly planVersion: number;
	/** Hash of the saved task contract this round executes. */
	readonly specHash: string;
	/** Absolute deadline; authoritative across a crash. */
	readonly deadlineAt: number;
	/**
	 * The newest entry id in the child conversation when this round's *first*
	 * attempt began, written once.
	 *
	 * Reconciliation scans from here so a rework is not charged for its
	 * predecessor's refusals. It is the first attempt's floor rather than the
	 * current attempt's: a retry's pre-execution refusals belong to this round too,
	 * and scoping to the last submission would lose the earlier attempt's.
	 */
	startEntryId?: EntryId;
	/** Durable tasks that produced this round's entries: the evidence-attribution bridge. */
	durableTaskIds: string[];
	/** Set in the same commit as the result document. */
	resultId?: string;
};

/** True when the round has no further attempt to make. */
export function isSettledRoundStatus(status: RoundStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}
