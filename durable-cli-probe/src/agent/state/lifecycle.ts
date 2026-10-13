// TASK-005.1 src/agent/state/lifecycle.ts
//
// The shared state machine: which business statuses exist, which transitions are
// legal, and what a round failure may and may not do.
//
// The distinction this file exists to make: **a failed round is not a failed
// task.** A technical failure (provider error, harness abort, timeout) is retried
// within the configured restart budget and, when exhausted, is reported to Main
// as a decision — the business status only reaches `failed` when Main or the
// program decides so. A quality failure is the opposite: a round that produced a
// bad result is not a failure of the run at all, it goes to `awaiting_review`
// for Main to accept or reject.
//
// Legacy: statuses written by TASK-003 remain readable. `revising` is the legacy
// name for "a revision round is executing", which is `running` in this machine;
// it is accepted on read and produced by old writers, but new transitions must
// not produce it (see `assertTransitionToNewStatus`). Keeping it in the table is
// what lets an old ledger be read without a migration of its history.

/** Business statuses. `revising` is legacy — see the module comment. */
export type TaskBusinessStatus = "planned" | "running" | "awaiting_review" | "awaiting_input" | "accepted" | "failed" | "cancelled" | "revising";

/** Statuses a *new* transition may produce. `revising` is deliberately absent. */
export type NewBusinessStatus = Exclude<TaskBusinessStatus, "revising">;

/** Lifecycle of one execution round of one task. */
export type RoundStatus = "queued" | "running" | "retry_wait" | "completed" | "failed" | "cancelled";

/** Legal business transitions. A terminal status has no outgoing edge. */
export const BUSINESS_TRANSITIONS: Readonly<Record<TaskBusinessStatus, readonly TaskBusinessStatus[]>> = {
	planned: ["running", "cancelled"],
	running: ["awaiting_review", "awaiting_input", "failed", "cancelled"],
	// A clarification blocks the task, not the run: answering resumes it.
	awaiting_input: ["running", "failed", "cancelled"],
	// Two edges describe the same real state: `running` is what new code writes,
	// `revising` is the legacy label TASK-003 wrote for it. Both stay legal so an
	// old ledger reads and an old writer still runs; new code uses `running`.
	awaiting_review: ["running", "revising", "accepted", "failed", "cancelled"],
	// Legacy: "a revision round is executing". Accept on read, never write.
	revising: ["awaiting_review", "failed", "cancelled"],
	accepted: [],
	failed: [],
	cancelled: [],
};

/** Legal round transitions. A settled round has no outgoing edge. */
export const ROUND_TRANSITIONS: Readonly<Record<RoundStatus, readonly RoundStatus[]>> = {
	queued: ["running", "cancelled"],
	running: ["completed", "failed", "cancelled", "retry_wait"],
	retry_wait: ["queued", "running", "cancelled"],
	completed: [],
	failed: [],
	cancelled: [],
};

/** True when a business status is terminal: no transition may leave it. */
export function isTerminalBusinessStatus(status: TaskBusinessStatus): boolean {
	return BUSINESS_TRANSITIONS[status].length === 0;
}

/** True when a round status is settled. */
export function isTerminalRoundStatus(status: RoundStatus): boolean {
	return ROUND_TRANSITIONS[status].length === 0;
}

/** True for the legacy label, written by TASK-003 and read as `running`. */
export function isLegacyBusinessStatus(status: TaskBusinessStatus): status is "revising" {
	return status === "revising";
}

/** How a legacy status is understood by new code. `revising` *is* an executing round. */
export function readLegacyStatus(status: TaskBusinessStatus): TaskBusinessStatus {
	return isLegacyBusinessStatus(status) ? "running" : status;
}

/** Raised for any illegal transition call, with the two states that caused it. */
export class IllegalTransitionError extends Error {
	readonly from: string;
	readonly to: string;
	readonly detail: string;
	constructor(from: string, to: string, detail: string) {
		super(`illegal transition ${from} -> ${to}: ${detail}`);
		this.name = "IllegalTransitionError";
		this.from = from;
		this.to = to;
		this.detail = detail;
	}
}

/**
 * Validate one business transition. Side effects: none; throws
 * {@link IllegalTransitionError} so a caller refuses before persisting.
 * Idempotent: the same pair always yields the same answer.
 */
export function assertBusinessTransition(from: TaskBusinessStatus, to: TaskBusinessStatus): void {
	if (from === to) throw new IllegalTransitionError(from, to, "a status must change");
	if (isTerminalBusinessStatus(from)) throw new IllegalTransitionError(from, to, `${from} is terminal and may not be resurrected`);
	if (!BUSINESS_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to, "no such edge in the business transition table");
}

/** Validate one round transition, with the same throwing contract. */
export function assertRoundTransition(from: RoundStatus, to: RoundStatus): void {
	if (from === to) throw new IllegalTransitionError(from, to, "a round status must change");
	if (isTerminalRoundStatus(from)) throw new IllegalTransitionError(from, to, `${from} is settled and may not be reopened`);
	if (!ROUND_TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to, "no such edge in the round transition table");
}

/** True when the transition is legal — the predicate form of {@link assertBusinessTransition}. */
export function isLegalBusinessTransition(from: TaskBusinessStatus, to: TaskBusinessStatus): boolean {
	if (from === to || isTerminalBusinessStatus(from)) return false;
	return BUSINESS_TRANSITIONS[from].includes(to);
}

/**
 * Refuse a *new* transition that would write the legacy label. Old writers keep
 * producing it (TASK-003's delegation is unchanged), so this guard is for the
 * new code paths that must not reintroduce it.
 */
export function assertTransitionToNewStatus(to: NewBusinessStatus): void {
	if (isLegacyBusinessStatus(to as TaskBusinessStatus)) throw new IllegalTransitionError("new", to as string, "revising is legacy; write running instead");
}

/** What a round failure asks of the business status. */
export type RoundFailureKind = "technical" | "quality" | "cancelled";

/** How the run status is expected to read and what the next round status is. */
export type RoundSettlement = {
	readonly roundStatus: RoundStatus;
	/**
	 * Set when the business status must move *as part of this settlement*. Never
	 * set for a technical failure: an exhausted budget is not a business decision.
	 */
	readonly nextBusinessStatus?: NewBusinessStatus;
	/**
	 * Set when Main must decide what happens to the task now, and no further
	 * business call may be made until it does. This is how a technical budget
	 * runs out: the round settles as failed, the business calls stop, and the
	 * decision — accept what exists, fail the task, or ask for more material —
	 * belongs to Main, because `failed` is terminal and cannot be undone.
	 */
	readonly requiresMainDecision?: boolean;
	/** Set when the settlement itself is terminal for the task. */
	readonly terminal?: boolean;
};

export type RoundFailureDecisionInput = {
	/** Business status the task is in when the round fails. */
	readonly businessStatus: TaskBusinessStatus;
	readonly failureKind: RoundFailureKind;
	/** Technical restarts already spent, before this failure. */
	readonly technicalRestartsUsed: number;
	/** Attempts already spent on this operation, including this failure. */
	readonly attemptsUsed: number;
	readonly budget: { readonly maxTechnicalRestarts: number; readonly maxAttemptsPerOperation: number };
};

/**
 * Decide what a failed round does.
 *
 * The rule the task contract cares about: a technical failure inside the restart
 * budget retries the round; a technical failure *past* it settles the round as
 * failed and stops the business calls, but leaves the business status to Main —
 * because `failed` is terminal and a spent retry budget is a fact about the
 * infrastructure, not a judgement about the task. An unbounded restart chain is
 * what the budget prevents, and a premature `failed` is what the Main decision
 * prevents.
 *
 * Pure: no IO, no document writes. The caller applies the result inside its own
 * commit, so the decision and the write are atomic.
 */
export function decideRoundFailure(input: RoundFailureDecisionInput): RoundSettlement {
	const { businessStatus, failureKind, technicalRestartsUsed, attemptsUsed, budget } = input;
	if (businessStatus === "cancelled") return { roundStatus: "failed", nextBusinessStatus: "cancelled", terminal: true };
	if (failureKind === "cancelled") return { roundStatus: "cancelled", nextBusinessStatus: "cancelled", terminal: true };
	if (failureKind === "quality") {
		// A bad result is a review matter, not a run failure: the round completed.
		return { roundStatus: "completed" };
	}
	if (technicalRestartsUsed >= budget.maxTechnicalRestarts || attemptsUsed >= budget.maxAttemptsPerOperation) {
		// Budget spent: stop business calls, settle the round, and hand the task to
		// Main. No automatic business status change — that would make an
		// infrastructure failure indistinguishable from a verdict.
		return { roundStatus: "failed", requiresMainDecision: true };
	}
	return { roundStatus: "retry_wait" };
}

/** True when a settlement means no further business call may be made. */
export function stopsBusinessCalls(settlement: RoundSettlement): boolean {
	return settlement.requiresMainDecision === true;
}

/**
 * Whether a cancellation intent may now become the terminal status. A cancel
 * intent is persisted first, but the task only becomes `cancelled` once nothing
 * is executing: an in-flight round must be observed to stop first, otherwise the
 * terminal status would overrule work that is still running (contract §"生命周期").
 */
export function mayTerminateAfterCancel(input: {
	readonly businessStatus: TaskBusinessStatus;
	readonly hasActiveExecution: boolean;
	readonly hasCancelIntent: boolean;
}): boolean {
	const { businessStatus, hasActiveExecution, hasCancelIntent } = input;
	if (!hasCancelIntent) return false;
	if (isTerminalBusinessStatus(businessStatus)) return false;
	if (hasActiveExecution) return false;
	return true;
}

/**
 * Whether a task in `awaiting_input` may resume execution.
 *
 * `settledQuestionIds` are the questions the clarification contract no longer
 * lists as open — answered with the application's `sufficient` judgement, or
 * resolved on the user's original input. It is deliberately *not* a list of
 * question ids that merely have an answer: receiving an answer is not the same
 * as being satisfied with it (contract §"Main Agent 合同").
 */
export function mayResumeAfterAnswer(businessStatus: TaskBusinessStatus, blockingQuestionIds: readonly string[], settledQuestionIds: readonly string[]): boolean {
	if (businessStatus !== "awaiting_input") return false;
	const settled = new Set(settledQuestionIds);
	return blockingQuestionIds.every((questionId) => settled.has(questionId));
}

/**
 * Whether a plan version is admissible right now: the read version must match
 * the stored one (a stale read is refused), no related question may still be
 * open, and every dependency must be accepted. Returns the first violated rule
 * as a stable code, so the refusal is explainable instead of a generic failure.
 */
export function admissionBlockReasons(input: {
	readonly expectedPlanVersion: number;
	readonly storedPlanVersion: number | undefined;
	readonly openQuestionIds: readonly string[];
	readonly unacceptedDependencies: readonly string[];
	readonly quotaRemaining: { readonly attempts: number };
}): readonly string[] {
	const reasons: string[] = [];
	if (input.storedPlanVersion !== input.expectedPlanVersion) reasons.push("plan_version_stale");
	if (input.openQuestionIds.length > 0) reasons.push("clarification_open");
	if (input.unacceptedDependencies.length > 0) reasons.push("dependencies_not_accepted");
	if (input.quotaRemaining.attempts <= 0) reasons.push("quota_exhausted");
	return reasons;
}

/** The transition table, as a flat list of edges — for documentation and tests. */
export function businessTransitionTable(): readonly (readonly [TaskBusinessStatus, TaskBusinessStatus])[] {
	return Object.entries(BUSINESS_TRANSITIONS).flatMap(([from, targets]) => targets.map((to) => [from as TaskBusinessStatus, to] as const));
}
