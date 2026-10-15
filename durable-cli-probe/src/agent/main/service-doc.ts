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
	 * The requirement version this input *becomes* when it is consumed, allocated
	 * while the input is admitted rather than when it is later read back.
	 *
	 * The allocation has to happen at admission time because the Harness places a
	 * queued input and starts its run at the round boundary, before any service call
	 * observes the queue. A version derived at consume time therefore arrives *after*
	 * that run has already resolved its requirement: the run binds its plans to the
	 * previous version, can dispatch the previous version's plan, and then has those
	 * plans invalidated when the consume-time bump finally lands.
	 */
	readonly allocatedVersion: number;
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
	/**
	 * Whether the original call reported an error. A refusal or a failed dispatch
	 * must replay as an error, not as an ordinary tool result: the machine-readable
	 * outcome is part of the result, and dropping it turns a refusal into success.
	 */
	readonly isError?: boolean;
	/** The control the original call returned, so a replay ends the run identically. */
	readonly control?: { readonly handoff?: string };
	readonly at: number;
};

/**
 * One admitted input and the requirement identity it carries.
 *
 * The active requirement is *not* only a mutable pointer: while a run is live, the
 * requirement being served is the one that run's inputs were admitted for. The
 * pointer is written when a restatement is *consumed*, which is after the Harness
 * has already placed the input and started the run — so resolving the requirement
 * from the pointer alone lets a run write plans and dispatch under the previous
 * requirement's identity. This map is what lets the run's own inputs name the
 * requirement, before any tool in it executes.
 */
export type InputAdmission = {
	/**
	 * The logical submission key this service placed the input under, exactly as it
	 * was passed to `handle.submit`.
	 *
	 * Written *before* the submission is made, so the binding is durable from the
	 * moment the Harness can start a run for the input. `handle.submit` returns
	 * before this service records anything else, and the Harness places the input
	 * and starts its run at the round boundary in the meantime — so a binding
	 * written only after `handle.submit` returns leaves a window in which the run
	 * has no identity and falls back to the previous request. The key is what makes
	 * the binding recoverable within that window: the submission itself carries it.
	 */
	readonly key: string;
	/**
	 * The submission the Harness admitted. Absent while the input is placed but its
	 * submission id has not been linked back yet — the window above.
	 */
	readonly submissionId?: string;
	readonly requestId: string;
	readonly requestVersion: number;
	/**
	 * The requirement version the caller's decision was made against, when it gave
	 * one. Carried so the basis can be checked when a run resolves its requirement —
	 * synchronously with the run, not lazily on a later queue read. A stale input
	 * cannot be un-placed from the transcript, but it can be denied an identity, and
	 * a tool with no resolvable requirement refuses rather than acting under the
	 * previous request.
	 */
	readonly expectedRequestVersion?: number;
	/**
	 * Set once that basis check has been *performed and passed*.
	 *
	 * The check cannot be re-derived later from `expectedRequestVersion` alone: the
	 * requirement's version moves on when this very input is consumed, so the stored
	 * version no longer equals the basis the caller gave, and re-comparing them would
	 * deny the accepted run its own requirement — every remaining tool in it would
	 * refuse. This records the *outcome* of the check, which does not move.
	 */
	readonly basisAccepted?: boolean;
	/** Set when the basis no longer holds, so a run made of this input must refuse. */
	readonly rejected?: boolean;
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
	/**
	 * The requirement identity of every input the service has admitted, newest
	 * last. A run resolves its requirement from the inputs it is running rather
	 * than from the pointer, which lags a placed input.
	 */
	readonly admissions: InputAdmission[];
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
	initial: () => ({ schemaVersion: MAIN_SERVICE_SCHEMA_VERSION, requestVersion: 1, plans: [], queue: [], receipts: [], answerAttempts: [], admissions: [] }),
});
