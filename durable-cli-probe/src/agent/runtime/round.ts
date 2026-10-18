// TASK-005.4 src/agent/runtime/round.ts
//
// The one writer of a runtime round: its execution record, its attempts, and the
// facts its settlement records on the round itself.
//
// Every runtime transition of a round goes through this file: the claim that
// stamps it, the entry floor, the attempt records appended to it, the counter
// updates reconciled from entries, and the settlement that closes it. Nothing
// else may assign to `round.execution`, because a round's execution record is
// what a resumed process trusts to decide whether work is still owed — and a
// second writer would be a second opinion about that.
//
// Three rules that shape the API:
//
//   1. **The right is checked by the ledger, not here.** `stampExecution`,
//      `recordRoundStatus` and `ExecutionRightError` in `src/multiagent/ledger.ts`
//      already refuse an operation that does not hold the round. This module
//      composes them with the runtime's own shape and adds no second check that
//      could disagree.
//   2. **Attempts are append-only.** An attempt is the record of one submission;
//      rewriting it would let a resumed process "correct" the history that a
//      settlement already used. The only mutable part of an attempt is its
//      settlement fields, written once.
//   3. **The status moves through the shared table.** `ROUND_TRANSITIONS` in
//      `src/agent/state/lifecycle.ts` is the only state machine; this module
//      locates the round and applies the move, so `retry_wait` behaves the same
//      here as it does anywhere else.

import type { EntryId } from "@earendil-works/pi-durable";
import { isTerminalRoundStatus, ROUND_TRANSITIONS, type RoundStatus } from "../state/lifecycle.ts";
import type { RoundExecution } from "../contracts/round-execution.ts";
import {
	claimRound,
	recordRoundStatus,
	stampExecution,
	ExecutionRightError,
	type EvidenceReference,
	type OperationBinding,
	type RoundRecord,
} from "../../multiagent/ledger.ts";

/** The ledger draft fields this module touches. */
type RoundDraft = {
	readonly taskId: string;
	rounds: RoundRecord[];
	readonly operations: OperationBinding[];
	activeOpKey?: string;
	activeRound?: number;
	activeToolTaskId?: string;
	currentRound: number;
};

/** What the claim writes besides the round record itself. */
export type RoundStart = {
	readonly opKey: string;
	readonly kind: "delegate" | "revise";
	readonly toolTaskId: string;
	readonly callId: string;
	readonly round: number;
	readonly task: string;
	readonly feedback?: string;
	readonly requestId: string;
	readonly at: number;
	/** The execution record, already carrying its limits and deadline. */
	readonly execution: RoundExecution;
};

/**
 * Claim one round and stamp its execution record in one write.
 *
 * The two are one operation because a round that exists without its limits is
 * a round a resume cannot decide about: `executionOf` would refuse it, and the
 * alternative — deriving the limits again — is exactly what the persisted copy
 * exists to prevent.
 *
 * @throws ExecutionRightError when another operation holds the task, or the
 * round was already claimed.
 */
export function startRound(doc: RoundDraft, start: RoundStart): void {
	claimRound(doc, {
		opKey: start.opKey,
		kind: start.kind,
		toolTaskId: start.toolTaskId,
		callId: start.callId,
		round: start.round,
		task: start.task,
		...(start.feedback === undefined ? {} : { feedback: start.feedback }),
		requestId: start.requestId,
		at: start.at,
	});
	stampExecution(doc, { opKey: start.opKey, round: start.round, execution: start.execution });
}

/**
 * Move one round's status, routing through `running` when the table has no
 * direct edge.
 *
 * The route is not a convenience. `retry_wait`'s only outgoing edges are
 * `queued`, `running` and `cancelled`, so the legal way to settle a round that
 * was waiting to retry is to enter `running` first — which is also the truth:
 * the round did run again, and what follows is its outcome. Routing here rather
 * than at each call site keeps one answer to "how does this round end", and
 * `assertRoundTransition` is still the authority on every step.
 *
 * @throws IllegalTransitionError on an illegal edge; `ExecutionRightError` when
 * the round has no execution record or another operation holds it.
 */
export function moveRound(doc: RoundDraft, opKey: string, round: number, status: RoundStatus): void {
	const current = doc.rounds.find((entry) => entry.round === round)?.execution?.status;
	if (current === status) return;
	if (current !== undefined && !isTerminalRoundStatus(current) && !ROUND_TRANSITIONS[current].includes(status)) {
		recordRoundStatus(doc, { opKey, round, status: "running" });
	}
	recordRoundStatus(doc, { opKey, round, status });
}

/** One attempt's opening record: everything known before the child runs. */
export type AttemptStart = {
	readonly attemptNo: number;
	readonly attemptKey: string;
	readonly opKey: string;
	readonly requestId: string;
	readonly startedAt: number;
};

/**
 * Append the attempt record for an attempt that is about to submit.
 *
 * Appending before the submission — not after — is what makes a crash mid-round
 * diagnosable: a resumed process sees an attempt with no `settledAt` and knows a
 * submission may exist, instead of concluding no attempt was ever made.
 *
 * @throws ExecutionRightError when this operation does not hold the round, or
 * when the attempt number is not the next one. A duplicate attempt number would
 * make two submissions share one record.
 */
export function openAttempt(doc: RoundDraft, opKey: string, round: number, attempt: AttemptStart): void {
	const execution = executionFor(doc, opKey, round);
	if (execution.attempts.some((entry) => entry.attemptNo === attempt.attemptNo)) {
		throw new ExecutionRightError(doc.taskId, `round ${round} already records attempt ${attempt.attemptNo}`);
	}
	const expected = execution.attempts.length + 1;
	if (attempt.attemptNo !== expected) {
		throw new ExecutionRightError(doc.taskId, `round ${round} expects attempt ${expected}, not ${attempt.attemptNo}`);
	}
	execution.attempts = [
		...execution.attempts,
		{
			attemptNo: attempt.attemptNo,
			attemptKey: attempt.attemptKey,
			opKey: attempt.opKey,
			requestId: attempt.requestId,
			evidence: [],
			startedAt: attempt.startedAt,
		},
	];
}

/** The facts a settled attempt contributes to the round's record. */
export type AttemptSettlement = {
	readonly submissionId?: string;
	readonly answerEntryId?: string;
	readonly answerText?: string;
	readonly evidence?: readonly string[];
	readonly settledAt: number;
	readonly error?: string;
};

/**
 * Settle one attempt's record. Idempotent: an attempt already settled is left
 * as it is, so a replay of the settlement commit changes nothing.
 */
export function settleAttempt(doc: RoundDraft, opKey: string, round: number, attemptNo: number, settlement: AttemptSettlement): void {
	const execution = executionFor(doc, opKey, round);
	execution.attempts = execution.attempts.map((entry) => {
		if (entry.attemptNo !== attemptNo || entry.settledAt !== undefined) return entry;
		return {
			...entry,
			...(settlement.submissionId === undefined ? {} : { submissionId: settlement.submissionId }),
			...(settlement.answerEntryId === undefined ? {} : { answerEntryId: settlement.answerEntryId }),
			...(settlement.answerText === undefined ? {} : { answerText: settlement.answerText }),
			...(settlement.evidence === undefined ? {} : { evidence: [...settlement.evidence] }),
			...(settlement.error === undefined ? {} : { error: settlement.error }),
			settledAt: settlement.settledAt,
		};
	});
}

/**
 * Write the round's counters and its evidence-attribution bridge.
 *
 * Both are program-observed facts read from the child's entries and tasks, so
 * they are written here rather than accumulated in memory: a resumed process
 * must not have to re-derive what the previous one already counted, and a
 * counter that lived only in memory would reset on every restart.
 */
export function setRoundFacts(
	doc: RoundDraft,
	opKey: string,
	round: number,
	facts: {
		readonly toolInvocations?: number;
		readonly failedToolCalls?: number;
		readonly technicalRestarts?: number;
		readonly durableTaskIds?: readonly string[];
		readonly resultId?: string;
	},
): void {
	const execution = executionFor(doc, opKey, round);
	if (facts.toolInvocations !== undefined) execution.toolInvocations = facts.toolInvocations;
	if (facts.failedToolCalls !== undefined) execution.failedToolCalls = facts.failedToolCalls;
	if (facts.technicalRestarts !== undefined) execution.technicalRestarts = facts.technicalRestarts;
	if (facts.durableTaskIds !== undefined) execution.durableTaskIds = [...facts.durableTaskIds];
	if (facts.resultId !== undefined) execution.resultId = facts.resultId;
}

/** Read a round's execution record, refusing one this operation does not hold. */
export function executionFor(doc: RoundDraft, opKey: string, round: number): RoundExecution {
	if (doc.activeOpKey !== opKey) {
		throw new ExecutionRightError(doc.taskId, `round ${round} is held by ${doc.activeOpKey ?? "no operation"}, not ${opKey}`);
	}
	const record = doc.rounds.find((entry) => entry.round === round);
	if (record?.execution === undefined) {
		throw new ExecutionRightError(doc.taskId, `round ${round} has no execution record`);
	}
	return record.execution;
}

/**
 * Record the entry floor of a round, once.
 *
 * Written when the round's first binding is written, so reconciliation can scan
 * this round's entries and not its predecessor's. Write-once because a later
 * attempt's floor is *higher*: overwriting would silently exempt the first
 * attempt's uncharged refusals from the round's failure allowance.
 */
export function setRoundEntryFloor(doc: RoundDraft, opKey: string, round: number, startEntryId: EntryId): void {
	const execution = executionFor(doc, opKey, round);
	if (execution.startEntryId === undefined) execution.startEntryId = startEntryId;
}

/** Everything one settlement writes about the round itself. */
export type RoundSettlementRecord = {
	readonly status: RoundStatus;
	/** The attempt this settlement closes, when the caller knows it. */
	readonly attemptNo?: number;
	readonly attemptSettlement?: AttemptSettlement;
	readonly toolInvocations?: number;
	readonly failedToolCalls?: number;
	readonly technicalRestarts?: number;
	readonly durableTaskIds?: readonly string[];
	readonly resultId?: string;
	/**
	 * The answer this round settled on, when it produced one.
	 *
	 * Written even when the answer's payload did not satisfy the work contract:
	 * the raw text is what Main reviews, and a refused answer is exactly the case
	 * a reviewer needs to read.
	 */
	readonly answer?: {
		readonly entryId: EntryId;
		readonly text: string;
		readonly evidence: readonly EvidenceReference[];
		readonly submissionId?: string;
	};
	readonly at: number;
};

/**
 * Write every round-scoped fact of one settlement, in one call.
 *
 * The facts are written together because they are one event: a round with a
 * settled attempt but no counters, or a status with no answer, is a state a
 * resumed process would have to guess about. The caller has already decided
 * *what* the round settled as; this function only records it.
 *
 * A released right is tolerated rather than refused. `recordRoundStatus` allows
 * it, and the cancel close writes a receipt for a round whose holder task died —
 * refusing there would leave the batch unable to finish. What is *not* tolerated
 * is a right held by somebody else: that is a second writer, and the round's
 * facts would be attributed to the wrong operation. In that case only the
 * non-round writes happen, and the caller's receipt still records the outcome.
 */
export function settleRoundRecord(doc: RoundDraft, opKey: string, round: number, settlement: RoundSettlementRecord): void {
	const record = doc.rounds.find((entry) => entry.round === round);
	// No record: the round was never admitted, so there is nothing round-scoped to
	// write. The receipt is still the answer to "what happened to this item".
	if (record === undefined) return;
	if (doc.activeOpKey !== undefined && doc.activeOpKey !== opKey) {
		throw new ExecutionRightError(doc.taskId, `round ${round} is held by ${doc.activeOpKey}, not ${opKey}`);
	}
	const execution = record.execution;
	if (execution !== undefined) {
		if (settlement.toolInvocations !== undefined) execution.toolInvocations = settlement.toolInvocations;
		if (settlement.failedToolCalls !== undefined) execution.failedToolCalls = settlement.failedToolCalls;
		if (settlement.technicalRestarts !== undefined) execution.technicalRestarts = settlement.technicalRestarts;
		if (settlement.durableTaskIds !== undefined) execution.durableTaskIds = [...settlement.durableTaskIds];
		if (settlement.resultId !== undefined) execution.resultId = settlement.resultId;
		if (settlement.attemptNo !== undefined && settlement.attemptSettlement !== undefined) {
			const settled = settlement.attemptSettlement;
			execution.attempts = execution.attempts.map((entry) =>
				entry.attemptNo === settlement.attemptNo && entry.settledAt === undefined
					? {
							...entry,
							...(settled.submissionId === undefined ? {} : { submissionId: settled.submissionId }),
							...(settled.answerEntryId === undefined ? {} : { answerEntryId: settled.answerEntryId }),
							...(settled.answerText === undefined ? {} : { answerText: settled.answerText }),
							...(settled.evidence === undefined ? {} : { evidence: [...settled.evidence] }),
							...(settled.error === undefined ? {} : { error: settled.error }),
							settledAt: settled.settledAt,
						}
					: entry,
			);
		}
		if (doc.activeOpKey === opKey && execution.status !== settlement.status && !isTerminalRoundStatus(execution.status)) {
			moveRound(doc, opKey, round, settlement.status);
		}
	}
	// The round record's own settled fields. Replaced rather than mutated:
	// `RoundRecord.evidence` is readonly, and TASK-003's delegation replaces the
	// array the same way, so both writers produce the same shape.
	doc.rounds = doc.rounds.map((entry) => {
		if (entry.round !== round) return entry;
		if (settlement.answer !== undefined) {
			return {
				...entry,
				...(settlement.answer.submissionId === undefined ? {} : { submissionId: settlement.answer.submissionId }),
				answerEntryId: settlement.answer.entryId,
				answerText: settlement.answer.text,
				evidence: [...settlement.answer.evidence],
				settledAt: settlement.at,
			};
		}
		return entry.settledAt === undefined ? { ...entry, settledAt: settlement.at } : entry;
	});
}

/** The highest round number the ledger records, or 0 when none was claimed. */
export function lastRoundOf(doc: { readonly rounds: readonly RoundRecord[] }): number {
	let highest = 0;
	for (const round of doc.rounds) if (round.round > highest) highest = round.round;
	return highest;
}
