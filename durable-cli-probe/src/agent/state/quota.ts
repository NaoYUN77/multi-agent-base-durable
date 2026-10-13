// TASK-005.1 src/agent/state/quota.ts
//
// Quota accounting as one pure, atomic operation per request.
//
// Two rules from the contract are enforced by shape rather than by discipline:
//
//   1. **Reserve and check are the same call.** `consume` either refuses with a
//      stable code and changes nothing, or records the spend. A caller therefore
//      cannot check a budget in one place and forget to reserve it in another —
//      which is how "there was still budget" bugs are born.
//   2. **Quality and technical attempts are separate counters.** A provider
//      retry is not a rework, and a rework is not a provider retry: reusing one
//      budget for both would either exhaust quality rework waiting on flaky
//      providers, or let a flaky provider burn the task's revision allowance.
//
// A third rule, added because accounting alone was too late: **the failure
// allowance gates admission, not just recording.** Once a round has spent its
// failed-tool-call allowance, no further business call may *start* — checking
// only when the next failure is recorded would let the side effect happen first
// and refuse afterwards. `businessStopReason` is the reason a caller hands to
// Main; the control channel (`{ kind: "control" }`) is never gated by it, so a
// round can still report and finish.
//
// Per-round counters (tool calls, failed tool calls) are reset when a round
// starts; per-operation counters (attempts, technical restarts) live as long as
// the operation.
//
// What this file deliberately does not decide: whether a call is a *new* attempt
// or a replay of an already-consumed one. That is the operation key's job, and it
// belongs to the ledger; a replay must not reach `consume` at all.

import type { RunConfig } from "../contracts/run-config.ts";

/** Counters for one operation: the whole task run, not one round. */
export type OperationQuota = {
	/** Attempts spent. A quality rework is an attempt; a provider retry is not. */
	attemptsUsed: number;
	/** Technical restarts spent. Retried only for technical failures. */
	technicalRestartsUsed: number;
};

/** Counters for one round. Reset when the next round starts. */
export type RoundQuota = {
	round: number;
	toolInvocationsUsed: number;
	failedToolCallsUsed: number;
};

export type QuotaState = {
	operation: OperationQuota;
	round: RoundQuota;
};

export type QuotaRequest =
	| { readonly kind: "attempt" }
	| { readonly kind: "technical_restart" }
	| { readonly kind: "tool_call" }
	| { readonly kind: "failed_tool_call" }
	/**
	 * A control-channel call: reporting, finishing, asking Main. It consumes
	 * nothing and is never refused, so an exhausted business budget still leaves a
	 * way to say so.
	 */
	| { readonly kind: "control" };

/** Raised when the request does not fit the remaining budget. */
export class QuotaError extends Error {
	readonly code:
		| "quota_attempts_exhausted"
		| "quota_technical_restarts_exhausted"
		| "quota_tool_invocations_exhausted"
		| "quota_failed_tool_calls_exhausted";
	constructor(code: QuotaError["code"], detail: string) {
		super(detail);
		this.name = "QuotaError";
		this.code = code;
	}
}

/** A fresh state, before anything is spent. */
export function initialQuotaState(round: number): QuotaState {
	return { operation: { attemptsUsed: 0, technicalRestartsUsed: 0 }, round: { round, toolInvocationsUsed: 0, failedToolCallsUsed: 0 } };
}

/** Reset the per-round counters for a new round. Per-operation counters carry on. */
export function resetRoundCounters(state: QuotaState, round: number): void {
	state.round = { round, toolInvocationsUsed: 0, failedToolCallsUsed: 0 };
}

/** What is left, as a plain object a caller can log or refuse on. */
export function quotaRemaining(state: QuotaState, budget: RunConfig): {
	readonly attempts: number;
	readonly technicalRestarts: number;
	readonly toolInvocations: number;
	readonly failedToolCalls: number;
} {
	return {
		attempts: budget.maxAttemptsPerOperation - state.operation.attemptsUsed,
		technicalRestarts: budget.maxTechnicalRestarts - state.operation.technicalRestartsUsed,
		toolInvocations: budget.maxToolInvocationsPerRound - state.round.toolInvocationsUsed,
		failedToolCalls: budget.maxFailedToolCallsPerRound - state.round.failedToolCallsUsed,
	};
}

/**
 * Reserve budget for one request, or refuse it. Mutates `state` only on success,
 * so a caller can pass the draft it reads inside its own commit: the check and
 * the reservation land in the same atomic write.
 *
 * @throws QuotaError with a stable code when the budget does not fit.
 */
export function consume(state: QuotaState, request: QuotaRequest, budget: RunConfig): void {
	const remaining = quotaRemaining(state, budget);
	switch (request.kind) {
		case "attempt":
			if (remaining.attempts <= 0) throw new QuotaError("quota_attempts_exhausted", `attempts exhausted (${budget.maxAttemptsPerOperation} allowed per operation)`);
			state.operation.attemptsUsed += 1;
			return;
		case "technical_restart":
			if (remaining.technicalRestarts <= 0) {
				throw new QuotaError("quota_technical_restarts_exhausted", `technical restarts exhausted (${budget.maxTechnicalRestarts} allowed)`);
			}
			state.operation.technicalRestartsUsed += 1;
			return;
		case "tool_call":
			// Admission, not just accounting: once the round has spent its failure
			// allowance, no further business call may start. Checking only when the
			// *next* failure is recorded would let the side effect happen first.
			if (remaining.failedToolCalls <= 0) {
				throw new QuotaError(
					"quota_failed_tool_calls_exhausted",
					`round ${state.round.round} has spent its failure allowance (${budget.maxFailedToolCallsPerRound}), so no further business call may start`,
				);
			}
			if (remaining.toolInvocations <= 0) {
				throw new QuotaError("quota_tool_invocations_exhausted", `tool invocations for round ${state.round.round} exhausted (${budget.maxToolInvocationsPerRound} allowed)`);
			}
			state.round.toolInvocationsUsed += 1;
			return;
		case "failed_tool_call":
			if (remaining.failedToolCalls <= 0) {
				throw new QuotaError("quota_failed_tool_calls_exhausted", `failed tool calls for round ${state.round.round} exhausted (${budget.maxFailedToolCallsPerRound} allowed)`);
			}
			state.round.failedToolCallsUsed += 1;
			return;
		case "control":
			// Nothing to reserve: the control channel is not a business call.
			return;
	}
}

/** Why no further business call may start, in a form a caller can hand to Main. */
export type BusinessStopReason = "attempts_exhausted" | "tool_invocations_exhausted" | "failed_tool_calls_exhausted";

/**
 * The reason the round may not start another business call, or `undefined` when
 * it may.
 *
 * A zero failure allowance admits no business call at all: the first failure
 * would already exceed it, so "try until it fails" is not a budget. That is the
 * explicit semantics of `maxFailedToolCallsPerRound: 0`, and it is why the check
 * lives here rather than only on the failure path.
 */
export function businessStopReason(state: QuotaState, budget: RunConfig): BusinessStopReason | undefined {
	const remaining = quotaRemaining(state, budget);
	if (remaining.attempts <= 0) return "attempts_exhausted";
	if (remaining.failedToolCalls <= 0) return "failed_tool_calls_exhausted";
	if (remaining.toolInvocations <= 0) return "tool_invocations_exhausted";
	return undefined;
}

/** True when no further business call may be made: the control channel stays open. */
export function isBusinessBudgetExhausted(state: QuotaState, budget: RunConfig): boolean {
	return businessStopReason(state, budget) !== undefined;
}

/** Valid attempt counts: never negative, never unbounded, and never fractional. */
export function sanitizeCounts(attemptsUsed: number, technicalRestartsUsed: number): OperationQuota {
	const clamp = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
	return { attemptsUsed: clamp(attemptsUsed), technicalRestartsUsed: clamp(technicalRestartsUsed) };
}
