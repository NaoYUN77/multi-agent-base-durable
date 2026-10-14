// TASK-005.2 src/agent/main/service-doc.ts
//
// The Main service's own conversation-scoped state: which user request the
// service is currently serving, the plans it has written, and the inputs that
// are queued rather than submitted.
//
// Why each field is persisted rather than held in memory:
//
//   * **The active request pointer.** The clarification and plan documents are
//     *families* keyed by `requestId`, so reading one back requires already
//     knowing its key. After a restart the service has no in-memory key left,
//     and AC-01 requires that a question left open by the previous process can
//     still be answered by the next one.
//   * **The plan index.** Plan documents are a family keyed by `planId` and the
//     Harness exposes no "list family keys" call, so the service can only list
//     the plans it knows about. A process-local `Set` made that list vanish on
//     every reopen and mixed one request's plans into another's view; a
//     persisted index, filtered by request, is what makes the list survive and
//     stay scoped.
//   * **The queue.** A busy conversation accepts inputs that are not yet
//     submitted. The contract requires them to be *queryable and withdrawable*,
//     which needs a record of them — the Harness's own `pi.inbox` is not a
//     public query surface.
//
// Authorization: all of this is program state. No model tool writes it, and no
// model field is read from it.

import { defineDoc } from "@earendil-works/pi-durable";

export const MAIN_SERVICE_SCHEMA_VERSION = 1;

/** One plan the service has written, indexed by the request it belongs to. */
export type PlanIndexEntry = {
	readonly planId: string;
	/** The request this plan was saved for. The list is filtered by this. */
	readonly requestId: string;
	/** The requirement's business version at save time. */
	readonly requestVersion: number;
	/** The plan's own version, so a stale entry is visible without reading the plan. */
	readonly version: number;
};

/** One input admitted while the conversation was busy, awaiting its turn. */
export type QueuedInput = {
	/** The submission the Harness admitted, so the caller can withdraw it. */
	readonly submissionId: string;
	/** The requirement this input belongs to. Applied to the pointer at consume time. */
	readonly requestId: string;
	/**
	 * The requirement version this input was queued against — the basis of the
	 * submission key, so it is part of the input's identity.
	 */
	readonly requestVersion: number;
	/**
	 * The requirement version the caller's decision was made against, when it gave
	 * one. Re-checked at the consume boundary: a queued restatement whose basis went
	 * stale while it waited must not be applied as if it were current.
	 */
	readonly expectedRequestVersion?: number;
	readonly text: string;
	readonly queuedAt: number;
};

/**
 * One management-tool call, keyed by the real tool task and call id.
 *
 * The tools declare `replay: "safe"`, which the locked Harness defines as "a
 * rerun after an interruption may execute again" — *not* exactly-once. Without a
 * record, a dispatch interrupted between executing and settling would dispatch a
 * second time. This is what makes a replay return the result it already produced
 * instead of redoing the work.
 *
 * Two things it deliberately holds beyond the text:
 *
 *   * **The control.** A replayed `request_clarification` must end the run the
 *     same way the original did, so the handoff travels with the receipt. A
 *     receipt that returned only the text would let the round continue.
 *   * **A started-but-unfinished state.** `result` is absent while the call is
 *     recorded as begun but not completed. That is the window a crash reopens,
 *     and it is reported as such rather than silently re-executed.
 */
export type OperationReceipt = {
	readonly opKey: string;
	/** The result text. Absent while the call is recorded as started but not finished. */
	readonly result?: string;
	/** The control the original call returned, so a replay ends the run identically. */
	readonly control?: { readonly handoff?: string };
	readonly at: number;
};

/**
 * One answer the user gave that the application did not judge sufficient, kept
 * so the exchange is auditable after the stored answer is replaced.
 *
 * The clarification contract holds exactly one answer per question (a duplicate
 * is a validation failure), so a follow-up reply replaces the stored answer
 * rather than appending a second one. The replaced text is not lost: it lives
 * here, in the service's own record.
 */
export type AnswerAttempt = {
	readonly questionId: string;
	readonly text: string;
	/** The judgement this attempt carried, so a replay is recognised as the same one. */
	readonly sufficient: boolean;
	readonly at: number;
};

export type MainServiceState = {
	readonly schemaVersion: number;
	/**
	 * The request the service is serving. Absent means "no request recorded yet",
	 * which is a state the service refuses to answer a question against rather
	 * than a request it invents.
	 */
	readonly activeRequestId?: string;
	/** Business version of the active requirement. Bumped when the user restates it. */
	readonly requestVersion: number;
	/**
	 * A persisted cancellation intent for the conversation. Written before any
	 * abort signal, so a process that dies mid-cancel leaves a readable intent
	 * rather than a conversation that looks untouched.
	 */
	readonly cancelRequested?: { readonly at: number; readonly reason?: string };
	/** Every plan the service has saved, newest last. Filtered by request when read. */
	readonly plans: PlanIndexEntry[];
	/** Inputs admitted while busy and not yet submitted. */
	readonly queue: QueuedInput[];
	/** Completed management-tool calls, so a replay returns their result. */
	readonly receipts: OperationReceipt[];
	/** Answers the application did not judge sufficient, newest last. */
	readonly answerAttempts: AnswerAttempt[];
};

/**
 * The service pointer, plan index and queue. `scope: "conversation"` because a
 * Main service serves exactly one conversation; `history: "latest"` because only
 * the current pointer matters — the request, plan and clarification documents
 * keep their own history.
 */
export const MainServiceDoc = defineDoc<MainServiceState>({
	kind: "app.agent.main-service",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ schemaVersion: MAIN_SERVICE_SCHEMA_VERSION, requestVersion: 1, plans: [], queue: [], receipts: [], answerAttempts: [] }),
});
