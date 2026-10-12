// TASK-003 src/multiagent/ledger.ts
//
// The application task ledger: one Durable Document per business task, stored in
// the main conversation. The ledger holds everything the acceptance contract
// requires to be *explicitly* persisted — the business task id, the child
// conversation, per-round records with stable request ids and evidence
// references, and every review event with before/after status. It deliberately
// does not rely on Document revision history to reconstruct events: events are
// first-class fields, appended in the same commit as the status transition they
// belong to.
//
// Status machine (all transitions validated by `assertTransition`):
//
//   running ──► awaiting_review ──► accepted
//      │              │  └────────► revising ──► awaiting_review (max 2 rounds)
//      │              └───────────► failed / cancelled
//      └──────────────────────────► failed / cancelled
//
// `accepted`, `failed` and `cancelled` are terminal: the program refuses any
// further execution or revision against a terminal task (contract §7), while
// history and evidence stay readable.

import type { ConversationId, EntryId, ModelRef } from "@earendil-works/pi-durable";
import { defineDocFamily } from "@earendil-works/pi-durable";

/** Business statuses of one task. Technical errors land in `failed`, never accepted. */
export type TaskBusinessStatus = "running" | "awaiting_review" | "revising" | "accepted" | "failed" | "cancelled";

/** One delegation round: the initial execution or one revision. */
export type RoundRecord = {
	/** 1-based round number. Round 1 is the initial execution. */
	readonly round: number;
	readonly kind: "initial" | "revision";
	/** Stable dedup key of the round's submission in the child conversation. */
	readonly requestId: string;
	/** The task text sent to the child for this round. */
	readonly task: string;
	/** Feedback attached to a revision round; absent for the initial round. */
	readonly feedback?: string;
	/** Durable ids, filled once the round settled. */
	readonly submissionId?: string;
	readonly answerEntryId?: EntryId;
	/** Evidence references for this round only (never mixed with older rounds). */
	readonly evidence: EvidenceReference[];
	readonly startedAt: number;
	readonly settledAt?: number;
};

/** Reference to one persisted tool result or answer, extracted by the program. */
export type EvidenceReference = {
	/** Entry id of the evidence record in the child conversation. */
	readonly entryId: EntryId;
	/** Entry kind, e.g. `pi.tool-result` or `pi.assistant`. */
	readonly kind: string;
	/** Durable task that produced the entry, when it was durable work. */
	readonly byTaskId?: string;
	/** Tool call this evidence belongs to, for `pi.tool-result` entries. */
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
	/** Redacted argument summary, carried from the assistant toolCall entry. */
	readonly argsSummary?: string;
	/** Excerpt of the result; the full text is retrieved through the evidence tool. */
	readonly excerpt: string;
	/** True when the excerpt is not the complete persisted text. */
	readonly truncated: boolean;
};

/** One review decision by the main model, with the full transition it caused. */
export type ReviewEvent = {
	readonly round: number;
	readonly decision: "accept" | "reject";
	readonly reason?: string;
	readonly at: number;
	readonly before: TaskBusinessStatus;
	readonly after: TaskBusinessStatus;
};

/** Terminal outcome detail for `failed` / `cancelled`. */
export type TaskFailure = {
	readonly reason: string;
	readonly detail?: string;
	readonly at: number;
};

export type TaskLedgerState = {
	/** Business task id, independent of any Durable task id. */
	readonly taskId: string;
	/** Set by the first delegation commit; the seed only carries the task id. */
	mainConversationId?: ConversationId;
	/** Child conversation of this task; created by the first delegation, reused by revisions. */
	childConversationId?: ConversationId;
	/** Provider/model both sides actually run, recorded from the agent configuration. */
	readonly model: ModelRef;
	/** Tool names the child was actually granted for this task. */
	readonly childTools: string[];
	readonly status: TaskBusinessStatus;
	readonly currentRound: number;
	readonly rounds: RoundRecord[];
	readonly reviews: ReviewEvent[];
	readonly failure?: TaskFailure;
	readonly createdAt: number;
	readonly terminalAt?: number;
};

/**
 * Ledger documents are conversation-scoped and keyed by business task id, so
 * each task is its own document. That keeps a long-lived main conversation from
 * accumulating one ever-growing object, and makes per-task inspection a single
 * document read. `history: "latest"` + `fork: "initial"` match the subagent
 * example's mapping document.
 */
export const TaskLedgerDoc = defineDocFamily<TaskLedgerState, { readonly taskId: string; readonly model: ModelRef }>({
	kind: "app.multiagent.task-ledger",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({
		taskId: seed.taskId,
		model: seed.model,
		childTools: [],
		status: "running",
		currentRound: 0,
		rounds: [],
		reviews: [],
		createdAt: 0,
	}),
});

/** Maximum revision rounds per task (contract §8: one initial execution + two revisions). */
export const MAX_REVISIONS = 2;

/** Legal status transitions. A terminal status has no outgoing edge. */
const TRANSITIONS: Readonly<Record<TaskBusinessStatus, readonly TaskBusinessStatus[]>> = {
	running: ["awaiting_review", "failed", "cancelled"],
	awaiting_review: ["revising", "accepted", "failed", "cancelled"],
	revising: ["awaiting_review", "failed", "cancelled"],
	accepted: [],
	failed: [],
	cancelled: [],
};

export function isTerminal(status: TaskBusinessStatus): boolean {
	return TRANSITIONS[status].length === 0;
}

/** Thrown when a transition would violate the contract; the caller must not persist anything. */
export class IllegalTransitionError extends Error {
	readonly taskId: string;
	readonly before: TaskBusinessStatus;
	readonly after: TaskBusinessStatus;
	constructor(taskId: string, before: TaskBusinessStatus, after: TaskBusinessStatus) {
		super(`task ${taskId}: illegal transition ${before} -> ${after}`);
		this.name = "IllegalTransitionError";
		this.taskId = taskId;
		this.before = before;
		this.after = after;
	}
}

/** Validate one transition, throwing `IllegalTransitionError` on violation. */
export function assertTransition(taskId: string, before: TaskBusinessStatus, after: TaskBusinessStatus): void {
	if (before === after) throw new IllegalTransitionError(taskId, before, after);
	if (!TRANSITIONS[before].includes(after)) throw new IllegalTransitionError(taskId, before, after);
}

/**
 * Decide the next status for a review decision, or throw when the decision is
 * not legal now (wrong status, or revision limit reached — a third rejection
 * fails the task instead of looping forever).
 */
export function reviewOutcome(taskId: string, status: TaskBusinessStatus, decision: "accept" | "reject", currentRound: number): "accepted" | "revising" {
	if (isTerminal(status)) throw new IllegalTransitionError(taskId, status, decision === "accept" ? "accepted" : "revising");
	if (status !== "awaiting_review") throw new IllegalTransitionError(taskId, status, decision === "accept" ? "accepted" : "revising");
	if (decision === "accept") return "accepted";
	const revisions = currentRound - 1;
	if (revisions >= MAX_REVISIONS) throw new RevisionLimitError(taskId);
	return "revising";
}

/** Raised when a rejection would exceed the revision limit; the task becomes `failed`. */
export class RevisionLimitError extends Error {
	readonly taskId: string;
	constructor(taskId: string) {
		super(`task ${taskId}: revision limit reached (${MAX_REVISIONS})`);
		this.name = "RevisionLimitError";
		this.taskId = taskId;
	}
}

/** Stable request id for one round. A rerun of the same round resolves to the same submission. */
export function roundRequestId(taskId: string, round: number): string {
	return `multiagent-round:${taskId}:${round}`;
}
