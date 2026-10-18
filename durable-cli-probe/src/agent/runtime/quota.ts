// TASK-005.4 src/agent/runtime/quota.ts
//
// The persisted budget of one user request, and the two functions that move it:
// `consumeOnce` reserves, `reconcileRoundFromEntries` records what the child
// actually did.
//
// Why this exists next to `src/agent/state/quota.ts` instead of inside it: that
// module is the *pure* check-and-reserve rule, and it deliberately knows nothing
// about persistence, replays or reservation ids. This module adds exactly the
// three things persistence needs and nothing else:
//
//   1. **A reservation id.** A charge is identified by a stable id, so a replay
//      of the same durable tool call, a re-executed safe tool, or a retried
//      admission commit presents the same id and is answered without
//      incrementing anything. Without this, "recovery must not double-spend"
//      would be a hope about how often commits run.
//   2. **A document to hold it.** `RequestQuotaState` is keyed by request id, so
//      a second dispatch in the same request sees what the first spent.
//   3. **A reader for what the child already spent.** A tool call that Durable
//      refused on `invalid_arguments` never reached any wrapper, so the only
//      record of it is the entry it left behind. `reconcileRoundFromEntries`
//      turns those entries into failed-call charges, once each.
//
// The rule that the failure allowance gates *admission* (not just recording)
// lives in `state/quota.ts` and is reused verbatim through `consume`; this file
// must not restate it, or the two would eventually disagree.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { RunConfig } from "../contracts/run-config.ts";
import { QuotaError, businessStopReason, consume, type QuotaState } from "../state/quota.ts";
import type { AttemptKey } from "./contracts.ts";
import type { OperationSpend, RequestQuotaState, RoundSpend } from "./documents.ts";

/** One reservation the runtime may charge. */
export type QuotaRequest =
	/** A sub-agent execution for this request: an initial round or a rework. */
	| { readonly kind: "instance" }
	/**
	 * One round of one operation. Charged by admission, so its key is the round's
	 * first attempt; a rework charges a second one.
	 *
	 * A retry *within* a round does not touch this counter: "attempts per
	 * operation" means the initial round plus every quality rework, and counting a
	 * provider retry here would let a flaky provider burn a task's revision
	 * allowance.
	 */
	| { readonly kind: "attempt"; readonly attemptKey: AttemptKey }
	/**
	 * A restart after a technical failure. `attemptKey` is the *retry's* key, not
	 * the failed attempt's: it is what makes the charge idempotent, because a
	 * replayed item presents the same key and must not pay for the same restart
	 * twice.
	 */
	| { readonly kind: "technical_restart"; readonly attemptKey: AttemptKey }
	/** A retry of one attempt against a flaky provider. Keyed like a restart. */
	| { readonly kind: "provider_retry"; readonly attemptKey: AttemptKey }
	| { readonly kind: "tool_call"; readonly round: number; readonly callId: string }
	| { readonly kind: "failed_tool_call"; readonly round: number; readonly callId: string };

/** Raised when a request does not fit the remaining budget. */
export type QuotaRefusalCode =
	| "quota_attempts_exhausted"
	| "quota_technical_restarts_exhausted"
	| "quota_tool_invocations_exhausted"
	| "quota_failed_tool_calls_exhausted"
	| "quota_instances_exhausted"
	| "quota_provider_retries_exhausted";

/**
 * A refusal, with the code a caller branches on.
 *
 * It wraps rather than replaces `QuotaError` so the pure rule keeps its own
 * error type: this module adds the two budgets the pure rule does not know about
 * (request instances, provider retries), and a single code space is what lets a
 * caller render every refusal the same way.
 */
export class QuotaRefusal extends Error {
	readonly code: QuotaRefusalCode;
	constructor(code: QuotaRefusalCode, detail: string) {
		super(detail);
		this.name = "QuotaRefusal";
		this.code = code;
	}
}

/** Re-throw a `QuotaError` from the pure rule as this module's refusal type. */
function asRefusal(error: unknown): never {
	if (error instanceof QuotaError) throw new QuotaRefusal(error.code as QuotaRefusalCode, error.message);
	throw error;
}

/**
 * Reserve one unit of budget, once per reservation id.
 *
 * @param quota - the draft read inside the caller's commit; mutated in place only
 * on success, so the check and the reservation land in one atomic write.
 * @param reservationId - the stable identity of this charge. A caller that
 * presents an id already charged gets a no-op, which is what makes a replay
 * free.
 * @param budget - the run config in force. Passed rather than stored so the
 * document holds spend and not policy.
 *
 * @throws QuotaError with a stable code when the budget does not fit.
 */
export function consumeOnce(
	quota: RequestQuotaState,
	operation: OperationSpend,
	reservationId: string,
	request: QuotaRequest,
	budget: RunConfig,
): void {
	if (alreadyCharged(operation, reservationId, request)) return;
	switch (request.kind) {
		case "instance": {
			if (quota.instancesUsed >= budget.maxSubAgentsPerRequest) {
				throw new QuotaRefusal(
					"quota_instances_exhausted",
					`request ${quota.requestId} has used all ${budget.maxSubAgentsPerRequest} sub-agent executions`,
				);
			}
			quota.instancesUsed += 1;
			return;
		}
		case "attempt": {
			// The pure primitive owns the attempt ceiling and the failure-allowance
			// rule; this module only persists the result. `attemptsUsed` and
			// `technicalRestartsUsed` are the two counters `QuotaState.operation`
			// carries, so they are mirrored into a scratch state and copied back.
			const state = scratch(operation, currentRound(operation));
			try {
				consume(state, { kind: "attempt" }, budget);
			} catch (error) {
				asRefusal(error);
			}
			operation.attemptsUsed = state.operation.attemptsUsed;
			operation.chargedAttempts = [...operation.chargedAttempts, request.attemptKey];
			return;
		}
		case "technical_restart": {
			// Bounded by `maxTechnicalRestarts` alone, deliberately not by
			// `harnessRetry`. A restart here is the *runtime* starting another attempt
			// inside the same item task, not the harness retrying underneath it — and
			// the runtime requires `harnessRetry.maxRetries` to be 0 precisely so the
			// harness never retries. Capping this allowance by that zero would mean no
			// restart could ever be paid for, which is the opposite of what the field
			// is for. The pure rule in `state/quota.ts` already draws the same line,
			// and this module reuses its counter, so the two must agree.
			const ceiling = budget.maxTechnicalRestarts;
			if (operation.technicalRestartsUsed >= ceiling) {
				throw new QuotaRefusal(
					"quota_technical_restarts_exhausted",
					`technical restarts exhausted (${ceiling} allowed)`,
				);
			}
			operation.technicalRestartsUsed += 1;
			operation.chargedAttempts = [...operation.chargedAttempts, request.attemptKey];
			return;
		}
		case "provider_retry": {
			if (operation.providerRetriesUsed >= budget.providerRetry.maxRetries) {
				throw new QuotaRefusal(
					"quota_provider_retries_exhausted",
					`provider retries exhausted for round ${currentRound(operation)} (${budget.providerRetry.maxRetries} allowed)`,
				);
			}
			operation.providerRetriesUsed += 1;
			operation.chargedAttempts = [...operation.chargedAttempts, request.attemptKey];
			return;
		}
		case "tool_call": {
			const round = ensureRound(operation, request.round);
			if (round.charged.includes(reservationId)) return;
			const state = scratch(operation, request.round);
			// `consume`'s `tool_call` branch enforces both the failure-allowance
			// admission rule and the per-round invocation ceiling.
			try {
				consume(state, { kind: "tool_call" }, budget);
			} catch (error) {
				asRefusal(error);
			}
			round.toolInvocationsUsed = state.round.toolInvocationsUsed;
			round.charged = [...round.charged, reservationId];
			return;
		}
		case "failed_tool_call": {
			const round = ensureRound(operation, request.round);
			if (round.charged.includes(reservationId)) return;
			const state = scratch(operation, request.round);
			try {
				consume(state, { kind: "failed_tool_call" }, budget);
			} catch (error) {
				asRefusal(error);
			}
			round.failedToolCallsUsed = state.round.failedToolCallsUsed;
			round.charged = [...round.charged, reservationId];
			return;
		}
	}
}

/** Why no further business call may start, or `undefined`. Reads the persisted counters. */
export function roundStopReason(operation: OperationSpend, round: number, budget: RunConfig): ReturnType<typeof businessStopReason> {
	return businessStopReason(scratch(operation, round), budget);
}

/** The spend record of one operation, created on first use. */
export function operationSpendOf(quota: RequestQuotaState, operationId: string, taskId: string): OperationSpend {
	const existing = quota.operations.find((entry) => entry.operationId === operationId);
	if (existing !== undefined) return existing;
	const created: OperationSpend = {
		operationId: operationId as OperationSpend["operationId"],
		taskId,
		attemptsUsed: 0,
		technicalRestartsUsed: 0,
		providerRetriesUsed: 0,
		rounds: [],
		chargedAttempts: [],
	};
	quota.operations = [...quota.operations, created];
	return created;
}

/** Start a fresh round's counters, keeping the operation's totals. Idempotent. */
export function openRound(operation: OperationSpend, round: number): RoundSpend {
	const existing = operation.rounds.find((entry) => entry.round === round);
	if (existing !== undefined) return existing;
	const created: RoundSpend = { round, toolInvocationsUsed: 0, failedToolCallsUsed: 0, charged: [] };
	operation.rounds = [...operation.rounds, created];
	// A new round is a fresh attempt at the provider: consecutive retries are a
	// property of one round's conversation, not of the operation.
	operation.providerRetriesUsed = 0;
	return created;
}

/**
 * Charge the failed tool calls the child left in its entries but never reached a
 * wrapper for.
 *
 * Durable validates arguments *before* `execute()`, so an `invalid_arguments`
 * refusal settles a tool result without the tool ever running. The same is true
 * of a blocked or authorization-refused call. Those are failures the round must
 * pay for — otherwise "use a schema error to get free attempts" is a budget
 * bypass — and the entry is the only evidence they happened.
 *
 * `fromEntryId` scopes the scan to the round: entries from earlier rounds were
 * already reconciled when that round settled, and charging them again would
 * punish a rework for its predecessor's mistakes.
 *
 * The spread counters live on `operation`, which the caller obtained from the
 * request's quota; there is no separate quota-level counter to move, so the quota
 * document itself is not a parameter here.
 *
 * @returns the number of newly charged failures.
 * @throws QuotaError when a newly discovered failure exceeds the allowance. The
 * caller decides whether to settle the round or refuse the next call; a refusal
 * here is not lost, because the charge is applied before it is thrown.
 */
export function reconcileRoundFromEntries(
	operation: OperationSpend,
	round: number,
	entries: readonly EntryRecord[],
	budget: RunConfig,
): number {
	let charged = 0;
	const spend = ensureRound(operation, round);
	for (const entry of entries) {
		const callId = failedCallIdOf(entry);
		if (callId === undefined) continue;
		const reservationId = `failed:${callId}`;
		if (spend.charged.includes(reservationId)) continue;
		const state = scratch(operation, round);
		try {
			consume(state, { kind: "failed_tool_call" }, budget);
		} catch (error) {
			// Nothing is charged: the allowance is already gone, so this failure is
			// not a new spend but the proof that the round must stop. The caller
			// settles the round on this refusal; leaving the counters untouched
			// keeps the persisted state consistent with what was actually admitted.
			asRefusal(error);
		}
		spend.failedToolCallsUsed = state.round.failedToolCallsUsed;
		spend.charged = [...spend.charged, reservationId];
		charged += 1;
	}
	return charged;
}

/**
 * The call id of a tool-result entry that represents a refused call, or
 * `undefined` for an entry that is not one.
 *
 * The shape matters: Durable stores a result's structured diagnostics in
 * `data.diagnostics` (`entries.ts:24`) and the call identity in the *message*
 * (`harness/tool.ts:829`, `toolCallId`), not in `data`. Reading `data.callId`
 * would therefore find nothing and silently charge no failures at all — a budget
 * bypass that looks like working code.
 *
 * Only refusals that happened *before* the tool ran count here. A call the tool
 * itself rejected (`isError` from its own `execute`) is charged by the wrapper,
 * which saw it happen; charging it here as well would count one failure twice.
 */
function failedCallIdOf(entry: EntryRecord): string | undefined {
	if (entry.kind !== "pi.tool-result") return undefined;
	const data = entry.data as { readonly diagnostics?: unknown } | undefined;
	const diagnostics = data !== undefined && Array.isArray(data.diagnostics) ? data.diagnostics : [];
	const preExecution = diagnostics.some((item) => {
		const code = typeof item === "object" && item !== null ? (item as { code?: unknown }).code : undefined;
		return PRE_EXECUTION_REFUSALS.has(code as string);
	});
	if (!preExecution) return undefined;
	const messages = entry.model;
	if (messages === undefined) return undefined;
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		const callId = (message as { readonly toolCallId?: unknown }).toolCallId;
		if (typeof callId === "string" && callId !== "") return callId;
	}
	return undefined;
}

/**
 * The refusals that settle a tool result without the tool ever executing, so no
 * wrapper can see them. `invalid_arguments` is settled before `execute()`
 * (`harness/tool.ts:251`); `blocked` comes from a `beforeTool` hook that ran
 * first (`tool.ts:148`); `tool_unavailable` means the model called a tool the
 * round never offered, which is also a call it spent. `aborted` is deliberately
 * absent: an aborted call is a cancel, not a failure the round pays for.
 */
const PRE_EXECUTION_REFUSALS: ReadonlySet<string> = new Set(["invalid_arguments", "blocked", "tool_unavailable"]);

/** A `QuotaState` view of the persisted counters, so the pure rule can be reused. */
function scratch(operation: OperationSpend, round: number): QuotaState {
	const spend = operation.rounds.find((entry) => entry.round === round);
	return {
		operation: { attemptsUsed: operation.attemptsUsed, technicalRestartsUsed: operation.technicalRestartsUsed },
		round: { round, toolInvocationsUsed: spend?.toolInvocationsUsed ?? 0, failedToolCallsUsed: spend?.failedToolCallsUsed ?? 0 },
	};
}

/** The operation's highest round, or 0 when none started. */
function currentRound(operation: OperationSpend): number {
	let highest = 0;
	for (const entry of operation.rounds) if (entry.round > highest) highest = entry.round;
	return highest;
}

function ensureRound(operation: OperationSpend, round: number): RoundSpend {
	const existing = operation.rounds.find((entry) => entry.round === round);
	return existing ?? openRound(operation, round);
}

/** True when this exact reservation was already charged in this round. */
function alreadyCharged(operation: OperationSpend, reservationId: string, request: QuotaRequest): boolean {
	if (request.kind === "attempt") return operation.chargedAttempts.includes(request.attemptKey);
	// A retry is memoized by the attempt key it pays for, so a replayed item that
	// decides the same retry again is answered instead of being charged twice. The
	// reservation id cannot serve here: it is minted from the same key, but the
	// check has to happen before the arm runs, where no round is in scope.
	if (request.kind === "technical_restart" || request.kind === "provider_retry") {
		return operation.chargedAttempts.includes(request.attemptKey);
	}
	if (request.kind === "tool_call" || request.kind === "failed_tool_call") {
		return operation.rounds.find((entry) => entry.round === request.round)?.charged.includes(reservationId) === true;
	}
	// `instance` is deliberately absent: it is keyed `instance:<operationId>:<round>`,
	// and a round is admitted at most once — `admitOne` answers a second admission
	// for the same round from the slot it already holds, before the charge. There is
	// nothing a second presentation could be, so there is nothing to memoize.
	return false;
}
