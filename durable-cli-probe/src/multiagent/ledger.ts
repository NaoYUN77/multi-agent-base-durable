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
	/** The tool operation that owns this round: only it may execute or settle it. */
	readonly opKey: string;
	/** Stable dedup key of the round's submission in the child conversation. */
	readonly requestId: string;
	/** The task text sent to the child for this round. */
	readonly task: string;
	/** Feedback attached to a revision round; absent for the initial round. */
	readonly feedback?: string;
	/** Durable ids, filled once the round settled. */
	readonly submissionId?: string;
	readonly answerEntryId?: EntryId;
	/** The settled answer's text, so a replay can return a receipt without re-running. */
	answerText?: string;
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
	/** Structured harness diagnostics recorded on the result entry, when any. */
	readonly diagnostics?: string[];
};

/** One review decision by the main model, with the full transition it caused. */
export type ReviewEvent = {
	readonly round: number;
	readonly decision: "accept" | "reject";
	readonly reason?: string;
	readonly at: number;
	readonly before: TaskBusinessStatus;
	readonly after: TaskBusinessStatus;
	/** The tool operation that recorded this decision (task/call association). */
	readonly opKey: string;
};

/** Terminal outcome detail for `failed` / `cancelled`. */
export type TaskFailure = {
	readonly reason: string;
	readonly detail?: string;
	readonly at: number;
};

/**
 * Binding of one tool *operation* (a delegate/revise/review/cancel tool call)
 * to its durable outcome. The key is `<kind>:<toolTaskId>:<callId>`: a rerun of
 * the same call after an interruption replays with the same key, so it resumes
 * the round and requestId it already created instead of minting new ones. Two
 * different calls never share a key, so two parallel calls stay distinct.
 */
export type OperationBinding = {
	readonly opKey: string;
	readonly kind: "delegate" | "revise" | "review" | "cancel";
	/** The durable task that invoked the tool. */
	readonly toolTaskId: string;
	/** The tool call id within that task. */
	readonly callId: string;
	/** Round this operation is bound to. */
	readonly round: number;
	readonly createdAt: number;
	/** Recorded decision of a completed review operation (idempotent replay). */
	readonly decision?: "accept" | "reject";
};

/** A recorded cancellation intent, persisted before any abort so nothing new starts. */
export type CancelRequest = {
	readonly opKey: string;
	readonly at: number;
	readonly reason?: string;
};

/** One program-recorded state transition, with the operation that caused it. */
export type StateEvent = {
	readonly at: number;
	readonly from: TaskBusinessStatus;
	readonly to: TaskBusinessStatus;
	readonly opKey?: string;
	readonly round?: number;
	readonly reason?: string;
};

/** Build the stable operation key of one tool invocation. */
export function operationKey(kind: OperationBinding["kind"], toolTaskId: string, callId: string): string {
	return `${kind}:${toolTaskId}:${callId}`;
}

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
	/** Every program-recorded transition, in order. Reviews reference their op key. */
	readonly events: StateEvent[];
	/** Operation bindings: tool call → round/requestId/decision. Replay anchors. */
	readonly operations: OperationBinding[];
	/** The operation currently holding the execution right, if any. */
	activeOpKey?: string;
	/** The round that right is for. */
	activeRound?: number;
	/** The durable tool task that holds the right; a terminal holder means a stale right. */
	activeToolTaskId?: string;
	/** Persistent cancellation intent: no new work may start until the cancel completes. */
	cancelRequested?: CancelRequest;
	readonly failure?: TaskFailure;
	readonly createdAt: number;
	readonly terminalAt?: number;
	/** Bumped on every recorded transition: the optimistic-concurrency token. */
	version: number;
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
	version: 2,
	// v1 documents predate operation bindings, state events and the version
	// counter; a v1 read is filled in rather than rejected.
	migrate: (value, fromVersion) => {
		if (fromVersion >= 2) return value as unknown as TaskLedgerState;
		return {
			...value,
			events: Array.isArray(value.events) ? value.events : [],
			operations: Array.isArray(value.operations) ? value.operations : [],
			version: typeof value.version === "number" ? value.version : 0,
		} as unknown as TaskLedgerState;
	},
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
		events: [],
		operations: [],
		createdAt: 0,
		version: 0,
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

/** Revision rounds used so far: every round after the initial one. */
export function revisionsUsed(currentRound: number): number {
	return Math.max(0, currentRound - 1);
}

/** True when another revision round may still be started. */
export function canRevise(currentRound: number): boolean {
	return revisionsUsed(currentRound) < MAX_REVISIONS;
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

/** Thrown when an operation tries to act without holding the round's execution right. */
export class ExecutionRightError extends Error {
	readonly taskId: string;
	constructor(taskId: string, message: string) {
		super(`task ${taskId}: ${message}`);
		this.name = "ExecutionRightError";
		this.taskId = taskId;
	}
}

/** The ledger draft fields the claim helpers touch. */
type ClaimDraft = {
	readonly taskId: string;
	activeOpKey?: string;
	activeRound?: number;
	activeToolTaskId?: string;
	currentRound: number;
	rounds: RoundRecord[];
	operations: OperationBinding[];
	readonly cancelRequested?: CancelRequest;
};

/**
 * Reserve one round for one operation, atomically with its binding and its round
 * record: after this commit no other operation can claim the same round or start
 * another one, and a replay of this operation finds its own reservation.
 * The caller must already have checked the task's status and any cancel intent.
 */
export function claimRound(
	doc: ClaimDraft,
	claim: {
		readonly opKey: string;
		readonly kind: "delegate" | "revise";
		readonly toolTaskId: string;
		readonly callId: string;
		readonly round: number;
		readonly task: string;
		readonly feedback?: string;
		readonly requestId: string;
		readonly at: number;
	},
): void {
	if (doc.activeOpKey !== undefined) {
		throw new ExecutionRightError(doc.taskId, `round ${doc.activeRound} is already executing under another operation`);
	}
	const taken = doc.rounds.some((round) => round.round === claim.round) || doc.operations.some((operation) => operation.round === claim.round && operation.kind !== "review" && operation.kind !== "cancel");
	if (taken) throw new ExecutionRightError(doc.taskId, `round ${claim.round} is already claimed`);
	doc.activeOpKey = claim.opKey;
	doc.activeRound = claim.round;
	doc.activeToolTaskId = claim.toolTaskId;
	// The claimed round is the task's current round from the moment it is
	// reserved: a settled round and a running round are the same round.
	doc.currentRound = claim.round;
	doc.operations = [
		...doc.operations,
		{
			opKey: claim.opKey,
			kind: claim.kind,
			toolTaskId: claim.toolTaskId,
			callId: claim.callId,
			round: claim.round,
			createdAt: claim.at,
		},
	];
	doc.rounds = [
		...doc.rounds,
		{
			round: claim.round,
			kind: claim.kind === "delegate" ? "initial" : "revision",
			opKey: claim.opKey,
			requestId: claim.requestId,
			task: claim.task,
			...(claim.feedback === undefined ? {} : { feedback: claim.feedback }),
			evidence: [],
			startedAt: claim.at,
		},
	];
}

/** Release the execution right, but only for the operation that holds it. */
export function releaseRound(doc: ClaimDraft, opKey: string): boolean {
	if (doc.activeOpKey !== opKey) return false;
	doc.activeOpKey = undefined;
	doc.activeRound = undefined;
	doc.activeToolTaskId = undefined;
	return true;
}

/** Drop a right whose holder task is gone (a stale right from an aborted call). */
export function clearStaleRight(doc: ClaimDraft): void {
	doc.activeOpKey = undefined;
	doc.activeRound = undefined;
	doc.activeToolTaskId = undefined;
}

/** Mutable shape of the ledger draft, for the transition helpers. */
type LedgerDraft = {
	readonly taskId: string;
	status: TaskBusinessStatus;
	events: StateEvent[];
	terminalAt?: number;
	failure?: TaskFailure;
	version: number;
	activeOpKey?: string;
	activeRound?: number;
	activeToolTaskId?: string;
};

/**
 * Apply one program-validated transition to a ledger draft: assert legality,
 * append the event, bump the optimistic-concurrency version, and stamp the
 * terminal time for terminal statuses. Callers pass the draft they read inside
 * their own commit, so the check and the write are one atomic unit.
 */
export function recordTransition(
	doc: LedgerDraft,
	to: TaskBusinessStatus,
	at: number,
	meta?: { readonly opKey?: string; readonly round?: number; readonly reason?: string },
): void {
	assertTransition(doc.taskId, doc.status, to);
	doc.events = [
		...doc.events,
		{
			at,
			from: doc.status,
			to,
			...(meta?.opKey === undefined ? {} : { opKey: meta.opKey }),
			...(meta?.round === undefined ? {} : { round: meta.round }),
			...(meta?.reason === undefined ? {} : { reason: meta.reason }),
		},
	];
	doc.status = to;
	doc.version += 1;
	// A task that is no longer executing a round holds no execution right.
	if (to !== "revising") {
		doc.activeOpKey = undefined;
		doc.activeRound = undefined;
		doc.activeToolTaskId = undefined;
	}
	if (isTerminal(to)) doc.terminalAt = at;
}
