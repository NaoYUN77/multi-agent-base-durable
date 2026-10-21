// TASK-005.7 src/agent/runtime/review.ts
//
// The review entry: Main's one program-backed way to accept a finished round or
// send it back for a rework.
//
// The split this file keeps, and why:
//
//   * **The model proposes a decision; the program writes it.** `accepted` is a
//     terminal business status, and `BUSINESS_TRANSITIONS` says the only edge into
//     it is `awaiting_review -> accepted`. `recordTransition` asserts that edge, so
//     a review of a `planned`, `running` or terminal task is refused rather than
//     turned into a status the table does not have.
//   * **A rework is the existing runtime channel, not a second executor.** It goes
//     through `runTaskBatch` with `{ kind: "rework" }`, which reuses the task's
//     child conversation, its ledger and its quota operation. This file adds no
//     round machinery of its own; it only decides *whether* the round may be
//     started and records who decided.
//   * **The decision and its receipt commit together.** `finish` is handed the
//     caller's transaction for the decision, so a crash cannot leave an accepted
//     task without the review that accepted it (or the reverse).
//
// One winner per task per round is enforced by the decision transaction alone: the
// operation binding and the status move land in one commit, so a second review of
// the same round — from another call, from a stale round, or racing a rework — sees
// either a terminal status or an existing review binding and is refused. A refusal
// writes no terminal state; it writes only the caller's own receipt.
//
// The revision limit is deliberately *not* a verdict. `MAX_REVISIONS` is a budget
// on how many times Main may ask again; when it is spent the review is refused and
// the task stays `awaiting_review`, because `failed` is Main's judgement and an
// exhausted allowance is not one.

import type { ConversationId, Harness, ModelRef, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { MAX_REVISIONS, TaskLedgerDoc, canRevise, isTerminalBusinessStatus, recordTransition } from "../../multiagent/ledger.ts";
import { AgentBatchDoc, BatchIndexDoc, type BatchItemReceipt } from "./documents.ts";
import { BatchNotResumable, type BatchExecutionContext, type BatchId, type PlanRef } from "./contracts.ts";

/** What Main decided about one finished round. */
export type ReviewDecision = "accept" | "rework";

/**
 * Why a review was refused. Prose is not an interface, so every refusal names a
 * stable code; the text beside it is for the model.
 */
export type ReviewRefusalCode =
	| "review_unknown_task"
	| "review_invalid_round"
	| "review_task_terminal"
	| "review_cancel_pending"
	| "review_not_awaiting_review"
	| "review_execution_in_progress"
	| "review_stale_round"
	| "review_already_decided"
	| "review_feedback_required"
	| "review_revision_limit"
	| "review_batch_missing"
	| "review_execution_refused";

/** What one review did. */
export type ReviewOutcome = {
	readonly ok: boolean;
	/** The line Main reads. Built from persisted facts, never from the model. */
	readonly text: string;
	readonly code?: ReviewRefusalCode;
	readonly taskId: string;
	readonly round: number;
	readonly decision: ReviewDecision;
	/** The round a rework ran, when one ran. */
	readonly executedRound?: number;
};

/**
 * What the review entry needs from the runtime. All of it is program state: the
 * harness, the Main conversation the ledgers live in, the model the ledger was
 * seeded with, the clock, and the executor a rework is handed to.
 */
export type ReviewDependencies = {
	readonly harness: Harness;
	readonly mainConversationId: ConversationId;
	readonly model: ModelRef;
	readonly now: () => number;
	/**
	 * Run the members of an admitted batch. Used only for a rework, and only after
	 * the decision is durable; it is the runtime's own `runTaskBatch`.
	 */
	readonly execute: (planRef: PlanRef, taskIds: readonly string[], executionContext: BatchExecutionContext) => Promise<unknown>;
};

/**
 * One review call, as the Main tool supplies it.
 *
 * `begin` and `finish` are the caller's receipt writers (the Main service owns the
 * document they write). They are called with the decision transaction, which is the
 * point: the decision and the record of the call that made it cannot disagree.
 */
export type ReviewOptions = {
	/** The invoking tool call. A rework's nested round is started from it. */
	readonly api: ToolExecutionApi;
	/** The call's context, as the tool received it. */
	readonly context: Context;
	readonly taskId: string;
	readonly round: number;
	readonly decision: ReviewDecision;
	readonly feedback?: string;
	/** The stable identity of this tool call (`review:<toolTask>:<callId>`). */
	readonly opKey: string;
	/** Record that this call started, before its side effect runs. */
	readonly begin: (tx: Tx) => Promise<void>;
	/** Record the call's result; `tx` makes it commit with the decision. */
	readonly finish: (outcome: { readonly text: string; readonly isError: boolean }, tx?: Tx) => Promise<void>;
	/**
	 * The operation keys whose recorded result is an error, read before the decision
	 * transaction opens.
	 *
	 * Only one thing needs it: a rework decision whose round could not be started
	 * (the load phase refused it) is not a decision that *won*. Without this, one
	 * transient refusal — a stale plan version, a stop that arrived between the
	 * decision and the round — would leave the task permanently unreviewable,
	 * because the binding for its round would exist and every later review of that
	 * round would be refused as a duplicate. The read is deliberately taken outside
	 * the commit: a receipt written by an operation that is still in flight has no
	 * result yet, so it cannot appear here and cannot unlock a live decision.
	 */
	readonly failedOperations?: () => Promise<ReadonlySet<string>>;
};

/** What the decision transaction resolved to. */
type Decision =
	| { readonly kind: "refused"; readonly code: ReviewRefusalCode; readonly text: string }
	| { readonly kind: "accepted"; readonly text: string }
	| { readonly kind: "settled"; readonly text: string; readonly isError: boolean; readonly executedRound: number }
	| {
			readonly kind: "rework";
			readonly planRef: PlanRef;
			readonly batchId: BatchId;
			readonly feedback: string;
	  };

/**
 * Accept or rework one finished round of one task.
 *
 * The decision is made and written in one commit; a rework's execution happens
 * after that commit, through the runtime's own batch path. Every check reads
 * through the caller's transaction, so two reviews that run at once cannot both
 * pass the same check.
 *
 * @param dependencies - the harness, the Main conversation, the clock and the
 *   executor. Supplied by `createBatchRuntime`.
 * @param options - the model's proposal, the call identity, and the two receipt
 *   writers. The task id, round and decision are the model's; the operation key
 *   is the program's.
 * @returns the outcome, with a stable `code` for every refusal.
 * @throws only from a read that could not be taken at all. A refused review and a
 *   rework whose round failed are outcomes, not exceptions.
 */
export async function reviewTask(dependencies: ReviewDependencies, options: ReviewOptions): Promise<ReviewOutcome> {
	const { api, taskId, round, decision } = options;
	const now = dependencies.now();
	const refuseOutside = async (code: ReviewRefusalCode, text: string): Promise<ReviewOutcome> => {
		await options.finish({ text, isError: true });
		return { ok: false, text, code, taskId, round, decision };
	};

	// The round is model-supplied, so it is checked before it reaches any ledger
	// arithmetic. A non-integer cannot name a round that exists.
	if (!Number.isInteger(round) || round < 1) {
		return await refuseOutside(
			"review_invalid_round",
			`review refused: review_invalid_round: ${String(round)} is not a round number; pass the round the result reports.`,
		);
	}
	// An unknown task is refused from a non-creating read, before the decision
	// transaction opens: `tx.doc` seeds a missing family document, and a review of a
	// mistyped id must not leave a ledger behind that claims a task exists.
	const known = await api.snapshot(TaskLedgerDoc, dependencies.mainConversationId, taskId, options.context);
	if (known === undefined || known.createdAt === 0) {
		return await refuseOutside("review_unknown_task", `review refused: review_unknown_task: no dispatched task ${taskId} is recorded.`);
	}
	// Read before the commit: `failedOperations` reads the service's receipt
	// document, and a document read inside the transaction would queue behind the
	// commit that holds it.
	const failed = options.failedOperations === undefined ? new Set<string>() : await options.failedOperations();

	const decided = await api.commit(async (tx): Promise<Decision> => {
		// Every return path records its receipt in this transaction — the refusals
		// too. A refusal whose receipt lands later could be re-decided against moved
		// state, and a success whose receipt is missing replays into a second accept.
		const refuse = async (code: ReviewRefusalCode, text: string): Promise<Decision> => {
			await options.finish({ text, isError: true }, tx);
			return { kind: "refused", code, text };
		};

		const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, taskId, { taskId, model: dependencies.model });
		// A seed ledger is not a dispatched task: `createdAt` is stamped by the first
		// admission. The pre-check above refuses the ordinary case; this one holds if
		// the ledger was retired between the two reads.
		if (ledger.createdAt === 0 || ledger.rounds.length === 0) {
			return await refuse("review_unknown_task", `review refused: review_unknown_task: no dispatched task ${taskId} is recorded.`);
		}
		// This exact call already decided. A rerun of the same call (a crash during
		// the rework's execution) must not decide again; it may still owe the round,
		// which is handled below.
		const own = ledger.operations.find((operation) => operation.opKey === options.opKey);
		// The same call cannot ask for a different decision than the one it recorded:
		// a replay carries the same arguments, so this only fires on a caller that
		// reused an operation key. Refusing keeps the recorded decision authoritative.
		if (own?.decision !== undefined && own.decision !== (decision === "accept" ? "accept" : "reject")) {
			return await refuse(
				"review_already_decided",
				`review refused: review_already_decided: this call already recorded ${own.decision}; it cannot now ${decision}.`,
			);
		}

		if (own === undefined) {
			if (isTerminalBusinessStatus(ledger.status)) {
				return await refuse(
					"review_task_terminal",
					`review refused: review_task_terminal: task ${taskId} is ${ledger.status}; it accepts nothing further.`,
				);
			}
			if (ledger.cancelRequested !== undefined) {
				return await refuse(
					"review_cancel_pending",
					`review refused: review_cancel_pending: task ${taskId} has a cancellation intent; it accepts no review.`,
				);
			}
			if (ledger.status !== "awaiting_review") {
				return await refuse(
					"review_not_awaiting_review",
					`review refused: review_not_awaiting_review: task ${taskId} is ${ledger.status}, not awaiting_review.`,
				);
			}
			// A round that still holds the execution right is not finished, whatever the
			// business status says. Reviewing it would decide work nobody has seen the end
			// of — and for a rework, it would race the running round for the same right.
			if (ledger.activeOpKey !== undefined) {
				return await refuse(
					"review_execution_in_progress",
					`review refused: review_execution_in_progress: task ${taskId} round ${String(ledger.activeRound)} is still executing; review it once it settles.`,
				);
			}
			// A decision aimed at an older round must not land on the newer one that
			// arrived meanwhile.
			if (round !== ledger.currentRound) {
				return await refuse(
					"review_stale_round",
					`review refused: review_stale_round: task ${taskId} is at round ${ledger.currentRound}, not ${round}.`,
				);
			}
			// One decision per task per round, whatever the decision. This is what makes
			// the accept-vs-rework race have exactly one winner: the loser reads the
			// winner's binding in the same commit that the winner wrote it, because a
			// rework's decision commit does not move the business status (the task is
			// still `awaiting_review` while the revision round runs).
			//
			// The one exception is a rework that never started. Its binding exists, but
			// no round follows it and its recorded result is an error, so it decided
			// nothing about the work and the round is still waiting for a real decision.
			const prior = ledger.operations.filter((operation) => operation.kind === "review" && operation.round === round);
			if (prior.length > 0 && !neverStarted(ledger, prior, round, failed)) {
				return await refuse(
					"review_already_decided",
					`review refused: review_already_decided: task ${taskId} round ${round} already has a decision.`,
				);
			}
			if (decision === "rework") {
				if ((options.feedback ?? "").trim() === "") {
					return await refuse(
						"review_feedback_required",
						`review refused: review_feedback_required: a rework of task ${taskId} needs feedback saying what to change.`,
					);
				}
				// The allowance is spent: refuse, and leave the task where it is. `failed`
				// is Main's judgement, not the side effect of a budget.
				if (!canRevise(ledger.currentRound)) {
					return await refuse(
						"review_revision_limit",
						`review refused: review_revision_limit: task ${taskId} has used its ${MAX_REVISIONS} revision rounds; accept it or record a failure instead.`,
					);
				}
			}
		}

		if (decision === "accept") {
			if (own === undefined) {
				ledger.operations = [
					...ledger.operations,
					{
						opKey: options.opKey,
						kind: "review",
						toolTaskId: String(api.taskId),
						callId: api.callId,
						round,
						createdAt: now,
						decision: "accept",
					},
				];
				ledger.reviews = [
					...ledger.reviews,
					{ round, decision: "accept", at: now, before: ledger.status, after: "accepted", opKey: options.opKey },
				];
				// The shared table's `awaiting_review -> accepted` edge, and nothing else.
				// It also releases the execution right and stamps `terminalAt`.
				recordTransition(ledger, "accepted", now, { opKey: options.opKey, round });
			}
			const text = `accepted task ${taskId} round ${round}; the task is now accepted.`;
			await options.finish({ text, isError: false }, tx);
			return { kind: "accepted", text };
		}

		// ── Rework ──────────────────────────────────────────────────────────────
		const found = await batchOfTaskIn(tx, dependencies.mainConversationId, taskId);
		if (found.kind !== "found") {
			return await refuse(
				"review_batch_missing",
				found.kind === "ambiguous"
					? `review refused: review_batch_missing: task id ${taskId} is in more than one batch (${found.batchIds.join(", ")}); refusing to guess.`
					: `review refused: review_batch_missing: no admitted batch holds task ${taskId}.`,
			);
		}
		const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, found.batchId, { batchId: found.batchId });
		if (batch.createdAt === 0) {
			return await refuse("review_batch_missing", `review refused: review_batch_missing: batch ${found.batchId} was never admitted.`);
		}
		const item = batch.items.find((entry) => entry.taskId === taskId);
		if (item === undefined) {
			return await refuse("review_batch_missing", `review refused: review_batch_missing: batch ${found.batchId} does not list ${taskId}.`);
		}
		// The rework's round is the one after the reviewed round, and it is read from
		// the receipt rather than recomputed by the load phase. A replay that finds the
		// round already settled reports it instead of re-entering `runTaskBatch`, which
		// would otherwise target the round *after* the settled one and run work nobody
		// asked for.
		if (own !== undefined && item.receipt !== undefined && item.receipt.round >= round + 1) {
			const text = reworkText(taskId, item.receipt);
			const isError = item.receipt.status !== "completed";
			await options.finish({ text, isError }, tx);
			return { kind: "settled", text, isError, executedRound: item.receipt.round };
		}
		if (own === undefined) {
			// The rejection is recorded against the round it judged. `after` is the
			// status the task actually keeps: a TASK-005 revision round runs while the
			// ledger still says `awaiting_review`, and the settlement moves it back. A
			// fabricated `revising` here would be an event no transition produced.
			ledger.operations = [
				...ledger.operations,
				{
					opKey: options.opKey,
					kind: "review",
					toolTaskId: String(api.taskId),
					callId: api.callId,
					round,
					createdAt: now,
					decision: "reject",
				},
			];
			ledger.reviews = [
				...ledger.reviews,
				{
					round,
					decision: "reject",
					reason: (options.feedback ?? "").trim(),
					at: now,
					before: ledger.status,
					after: ledger.status,
					opKey: options.opKey,
				},
			];
			// A started marker in the same commit: a crash between this decision and the
			// round's settlement is then re-entered by the replay rather than reported as
			// an unknown outcome, and the binding above is what proves the decision was
			// already taken.
			await options.begin(tx);
		}
		return {
			kind: "rework",
			planRef: { planId: batch.planId, version: batch.planVersion },
			batchId: found.batchId,
			feedback: (options.feedback ?? "").trim(),
		};
	}, options.context);

	if (decided.kind === "refused") return { ok: false, text: decided.text, code: decided.code, taskId, round, decision };
	if (decided.kind === "accepted") return { ok: true, text: decided.text, taskId, round, decision };
	if (decided.kind === "settled") {
		return { ok: !decided.isError, text: decided.text, taskId, round, decision, executedRound: decided.executedRound };
	}

	// Past the decision commit, and only here does anything execute. The round is
	// claimed and run by the batch runtime, which reuses the task's child
	// conversation, budget and quota operation.
	try {
		await dependencies.execute(decided.planRef, [taskId], {
			api,
			batchId: decided.batchId,
			trigger: { kind: "rework", taskId, feedback: decided.feedback },
		});
	} catch (error) {
		if (!(error instanceof BatchNotResumable)) throw error;
		// The load phase refused before anything started. The decision is already
		// durable, so the honest report is that the round did not run — and nothing was
		// written that would make the task look failed.
		const text = `rework refused: ${error.code}: ${error.detail}. Nothing was executed.`;
		await options.finish({ text, isError: true });
		return { ok: false, text, code: "review_execution_refused", taskId, round, decision };
	}

	const receipt = await readReceipt(dependencies, options.context, decided.batchId, taskId);
	if (receipt === undefined) {
		const text = `rework of task ${taskId} started but no receipt was recorded; its outcome is unknown.`;
		await options.finish({ text, isError: true });
		return { ok: false, text, taskId, round, decision };
	}
	const text = reworkText(taskId, receipt);
	const isError = receipt.status !== "completed";
	await options.finish({ text, isError });
	return { ok: !isError, text, taskId, round, decision, executedRound: receipt.round };
}

/**
 * Whether the reviews already recorded for this round decided nothing, because
 * every one of them is a rework whose round never started.
 *
 * Three conditions, all read from the same transaction:
 *
 *   * every prior review of the round is a rejection — an accept that landed is a
 *     terminal status and was refused before this check;
 *   * no round follows the reviewed one — a rework that ran left its round in the
 *     ledger, and its decision stands whatever its outcome;
 *   * every one of those operations recorded an error — the read happens outside
 *     the commit, so an operation still in flight has no result and cannot appear.
 */
function neverStarted(
	ledger: { readonly rounds: readonly { readonly round: number }[] },
	prior: readonly { readonly opKey: string; readonly decision?: "accept" | "reject" }[],
	round: number,
	failed: ReadonlySet<string>,
): boolean {
	if (prior.some((operation) => operation.decision !== "reject")) return false;
	if (ledger.rounds.some((entry) => entry.round > round)) return false;
	return prior.every((operation) => failed.has(operation.opKey));
}

/** The line Main reads for a settled rework round. */
function reworkText(taskId: string, receipt: BatchItemReceipt): string {
	const parts = [`reworked task ${taskId} into round ${receipt.round}`, receipt.status];
	if (receipt.failureKind !== undefined) parts.push(receipt.failureKind);
	if (receipt.resultId !== undefined) parts.push(`result ${receipt.resultId}`);
	if (receipt.detail !== undefined) parts.push(receipt.detail);
	return `${parts.join(": ")}; review it again.`;
}

/** The batch that holds a task, read inside one transaction. */
type BatchLookup =
	| { readonly kind: "found"; readonly batchId: BatchId }
	| { readonly kind: "ambiguous"; readonly batchIds: readonly string[] }
	| { readonly kind: "missing" };

/**
 * Locate the admitted batch that holds `taskId`, without guessing.
 *
 * Mirrors `findBatchOfTask` but reads through the caller's transaction, so the
 * lookup is part of the decision rather than a state read a moment earlier. A task
 * id reused by two batches is reported as ambiguous: reworking the wrong one is
 * worse than refusing.
 */
async function batchOfTaskIn(tx: Tx, mainConversationId: ConversationId, taskId: string): Promise<BatchLookup> {
	const index = await tx.doc(BatchIndexDoc);
	const found: string[] = [];
	for (const id of index.batches) {
		const batch = await tx.doc(AgentBatchDoc, mainConversationId, String(id), { batchId: id });
		if (batch.createdAt === 0) continue;
		if (batch.items.some((item) => item.taskId === taskId)) found.push(String(id));
	}
	if (found.length === 0) return { kind: "missing" };
	if (found.length === 1) return { kind: "found", batchId: found[0] as BatchId };
	return { kind: "ambiguous", batchIds: found };
}

/** One item's receipt, read without creating anything. */
async function readReceipt(
	dependencies: ReviewDependencies,
	context: Context,
	batchId: BatchId,
	taskId: string,
): Promise<BatchItemReceipt | undefined> {
	const batch = await dependencies.harness.snapshot(AgentBatchDoc, dependencies.mainConversationId, String(batchId), context);
	return batch?.items.find((item) => item.taskId === taskId)?.receipt;
}
