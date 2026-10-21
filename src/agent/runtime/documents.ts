// TASK-005.4 src/agent/runtime/documents.ts
//
// The Durable documents the batch runtime owns. Private to the package: nothing
// outside `src/agent/runtime` imports a token from this file, and `index.ts`
// re-exports none of them. A caller that could write a slot or a reservation
// directly could admit work without a right or charge an attempt twice, and the
// whole point of the runtime is that those decisions have one owner.
//
// Four shapes, five scopes, each chosen for a different reason:
//
//   * **Batch** — conversation-scoped in the Main conversation, keyed by batch
//     id. It stores identity and terminal receipts only. Live status is *not*
//     copied here: it is derived from the ledger (round status) and the
//     scheduler (slot/queue). A second copy of "is it running" is a copy that
//     drifts.
//   * **Batch index** — session-scoped singleton, the list of admitted batch
//     ids. It exists because a `Harness` has no way to enumerate a document
//     family (the scan is on `Storage`), and a stop has to reach a batch that has
//     no items running and therefore holds nothing anywhere else.
//   * **Quota** — conversation-scoped, keyed by *request id*, not batch id. Two
//     dispatches in one user request share one budget; keying by batch would let
//     a second dispatch see a fresh allowance.
//   * **Scheduler** — session-scoped, because `maxConcurrentSubAgents` is a
//     limit "across the whole run" while `maxSubAgentsPerRequest` is per request.
//     A session document is the only scope that can see both caps, so each slot
//     and each queue entry carries its `requestId`.
//   * **Round binding** — conversation-scoped in the *child*, a singleton. One
//     child conversation runs one round at a time, and the tool wrapper that
//     enforces the per-round budget lives inside that child and can read nothing
//     else.
//
// Arrays are mutable throughout. `defineDocFamily` requires `JsonObject`, and a
// `readonly T[]` is not a `JsonValue` the platform can store; declaring the
// storage shape mutable keeps one type for the stored value and the in-memory
// one instead of an alias that drifts from it.

import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, TaskId } from "@earendil-works/pi-durable";
import type { EffectiveRoundBudget } from "../contracts/round-execution.ts";
import type { ResourceClaim } from "../contracts/tool-effects.ts";
import type { AttemptKey, BatchId, OperationId } from "./contracts.ts";

/** `RuntimeOutcome["failureKind"]`, spelled out so this module needs no result import. */
export type BatchFailureKind = "technical" | "quality" | "cancelled" | "quota";

/**
 * One item's terminal receipt.
 *
 * `status` is narrowed to the three terminal values on purpose: `blocked` cannot
 * appear, because a batch with an unsatisfied external dependency is refused
 * before any item starts (`dependency_not_accepted`), so no item can settle in
 * that state. A receipt therefore always answers "what happened to this item",
 * with no case a reader has to go and resolve elsewhere.
 */
export type BatchItemReceipt = {
	readonly taskId: string;
	readonly operationId: OperationId;
	/** The round this receipt settles (1-based). */
	readonly round: number;
	readonly status: "completed" | "failed" | "cancelled";
	/** Pointer to the `AgentTaskResultDoc` of this round; absent for a cancelled item that never settled a result. */
	readonly resultId?: string;
	readonly failureKind?: BatchFailureKind;
	/**
	 * True when the round stopped on a technical budget (attempts, restarts,
	 * provider retries) rather than on the work being wrong. Main has to decide
	 * what happens next; a quality failure does not set it.
	 */
	readonly requiresMainDecision?: boolean;
	readonly detail?: string;
	readonly settledAt: number;
};

/** One member of the batch, as the batch document tracks it. */
export type BatchItemState = {
	readonly taskId: string;
	readonly operationId: OperationId;
	/**
	 * Fairness order, assigned once in member order at admission. A retry never
	 * gets a new one, so a retried item cannot jump ahead of work already waiting.
	 */
	readonly sequence: number;
	readonly enqueuedAt: number;
	/** The last admitted attempt; absent while queued. */
	attemptKey?: AttemptKey;
	/**
	 * The round the last admission took this item into.
	 *
	 * Written with `attemptKey` and read by the cancel close: an item whose task is
	 * gone has no round record to learn its round from — it may have died before
	 * ever claiming one — and a receipt has to name the round it settles. Absent
	 * means "never admitted", which is a fact the close needs: the round an item
	 * that never started belongs to is the task's next one, not its last.
	 */
	round?: number;
	/** The nested `pi.tool` task once created. An optimization for lookup, never identity. */
	nestedTaskId?: string;
	receipt?: BatchItemReceipt;
};

/** Why a batch was asked to stop. Persisted before any abort signal is raised. */
export type BatchCancelIntent = {
	readonly kind: "operator" | "deadline";
	readonly at: number;
	readonly reason: string;
};

export type BatchState = {
	readonly schemaVersion: number;
	readonly batchId: BatchId;
	readonly planId: string;
	readonly planVersion: number;
	readonly requestId: string;
	readonly requestVersion: number;
	/** Fingerprint of the `RunConfig` in force when the batch was created. */
	readonly runConfigFingerprint: string;
	items: BatchItemState[];
	/** Written before any abort, so a resumed process reads the intent before it reads a dead child. */
	cancel?: BatchCancelIntent;
	readonly createdAt: number;
	/** Set only when every item has a receipt. */
	settledAt?: number;
};

/**
 * One batch, keyed by `batch:<dispatch operation key>`.
 *
 * The id is derived from the dispatching tool call rather than stored anywhere,
 * so a crash between the admission commit and this document leaves nothing to
 * repair: the replay of the same call derives the same id and finds whatever the
 * first attempt wrote.
 */
export const AgentBatchDoc = defineDocFamily<BatchState, { readonly batchId: string }>({
	kind: "app.agent.batch",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({
		schemaVersion: 1,
		batchId: seed.batchId as BatchId,
		planId: "",
		planVersion: 0,
		requestId: "",
		requestVersion: 0,
		runConfigFingerprint: "",
		items: [],
		createdAt: 0,
	}),
});

/** Per-round counters of one operation. Reset only when a new round starts. */
export type RoundSpend = {
	readonly round: number;
	toolInvocationsUsed: number;
	failedToolCallsUsed: number;
	/**
	 * Reservation ids already charged in this round.
	 *
	 * This is what makes a charge idempotent: a replay presents the same id and is
	 * answered without incrementing anything. It is bounded by the round's tool
	 * allowance, so it cannot grow without limit.
	 */
	charged: string[];
};

/**
 * Everything one operation has spent, keyed by `task:<taskId>`.
 *
 * The three counters are deliberately separate: `attemptsUsed` counts quality
 * work (the initial round and each rework), `technicalRestartsUsed` counts
 * restarts after a technical failure, and `providerRetriesUsed` counts the
 * retries of *one* attempt against a flaky provider. Merging them would let a
 * flaky provider burn a task's revision allowance, or let a rework hide inside
 * a retry allowance.
 */
export type OperationSpend = {
	readonly operationId: OperationId;
	readonly taskId: string;
	attemptsUsed: number;
	technicalRestartsUsed: number;
	/** Consecutive provider retries in the current round; reset when the round advances. */
	providerRetriesUsed: number;
	rounds: RoundSpend[];
	/** Attempts already reserved, so a replay does not charge twice. */
	chargedAttempts: AttemptKey[];
};

/**
 * The authoritative budget of one user request.
 *
 * Not of one batch: a second `dispatch_tasks` in the same request must see what
 * the first spent, or `maxSubAgentsPerRequest` would be a per-call limit wearing
 * a per-request name. `MainServiceDoc.dispatchAttempts` is a different budget
 * (how many dispatch calls were admitted) and is deliberately not copied here.
 */
export type RequestQuotaState = {
	readonly schemaVersion: number;
	readonly requestId: string;
	/** Sub-agent executions admitted for this request: every initial round and every rework. */
	instancesUsed: number;
	operations: OperationSpend[];
};

export const AgentQuotaDoc = defineDocFamily<RequestQuotaState, { readonly requestId: string }>({
	kind: "app.agent.quota",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ schemaVersion: 1, requestId: seed.requestId, instancesUsed: 0, operations: [] }),
});

/**
 * One held concurrency slot.
 *
 * The slot is held from the admission commit to the settlement commit, and
 * `retry_wait` **keeps** it: the item's durable task is still live and about to
 * submit again, so releasing capacity would let another item in while this one
 * resumes — an over-admission that a replay would then find no slot for.
 *
 * `durableTaskId` is the nested `pi.tool` task's own id, and that is what makes
 * the slot idempotent: the slot is written *inside* the item task, so a
 * replayed item rewrites the same slot instead of taking a second one. Keying
 * the slot by attempt instead would let a retried dispatcher hold two.
 *
 * The parent `dispatch_tasks` task never appears here. Its wait on its children
 * is not a sub-agent execution and must not consume a child's capacity.
 */
export type ActiveSlot = {
	readonly operationId: OperationId;
	readonly batchId: BatchId;
	readonly requestId: string;
	readonly taskId: string;
	readonly round: number;
	readonly attemptKey: AttemptKey;
	readonly durableTaskId: TaskId;
	readonly claim: ResourceClaim;
	readonly startedAt: number;
};

/** One item waiting for capacity. */
export type QueueEntry = {
	readonly operationId: OperationId;
	readonly batchId: BatchId;
	readonly requestId: string;
	readonly taskId: string;
	readonly round: number;
	readonly enqueuedAt: number;
	/** Stable tie-breaker within one enqueue time, so ordering never depends on a scan order. */
	readonly ordinal: number;
	/** Bumped when reconciliation finds a reservation with no live child task. */
	requeues: number;
};

export type SchedulerState = {
	readonly schemaVersion: number;
	active: ActiveSlot[];
	queue: QueueEntry[];
};

/**
 * Slots and queue for the whole session. One owner: the admission pump.
 *
 * Session scope is the only scope that can see every request at once, which is
 * what `maxConcurrentSubAgents` is defined over; `requestId` on each entry is
 * what makes the per-request cap checkable from the same table.
 */
export const SchedulerDoc = defineDoc<SchedulerState>({
	kind: "app.agent.runtime.scheduler",
	version: 1,
	scope: "session",
	initial: () => ({ schemaVersion: 1, active: [], queue: [] }),
});

/**
 * What one round of one child is allowed to spend, written into the child
 * immediately before its submission and read by the quota wrapper on every
 * business tool call.
 *
 * The budget is *copied* rather than referenced: the wrapper runs inside the
 * child and can read nothing but this conversation's documents, so a pointer to
 * the run config would be a pointer it cannot follow.
 */
export type RoundBindingState = {
	readonly schemaVersion: number;
	readonly mainConversationId: ConversationId;
	readonly requestId: string;
	readonly operationId: OperationId;
	readonly taskId: string;
	readonly round: number;
	readonly attemptNo: number;
	readonly attemptKey: AttemptKey;
	readonly budget: EffectiveRoundBudget;
	/**
	 * The newest entry id in the child conversation when this binding was
	 * written. Reconciliation scans from here, so a previous round's refusals are
	 * not charged to this one.
	 */
	readonly startEntryId?: EntryId;
	/** The generation task of this attempt, once the harness reports it. */
	generationTaskId?: string;
	/** Stop intent; while set, the wrapper refuses business calls. */
	stop?: { readonly kind: "cancel" | "deadline"; readonly at: number };
};

/**
 * The binding of the child's current round. A singleton, because one child
 * conversation runs one round at a time: a family would let a stale key be read
 * by mistake, and there is nothing to key by that the singleton does not already
 * carry.
 */
export const AgentRoundBindingDoc = defineDoc<RoundBindingState>({
	kind: "app.agent.runtime.round-binding",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({
		schemaVersion: 1,
		mainConversationId: 0 as ConversationId,
		requestId: "",
		operationId: "" as OperationId,
		taskId: "",
		round: 0,
		attemptNo: 0,
		attemptKey: "" as AttemptKey,
		budget: { maxToolInvocations: 0, maxFailedToolCalls: 0, deadlineAt: 0, providerRetry: { maxRetries: 0, backoffMs: 0 } },
	}),
});

/**
 * Every batch this session has admitted, in admission order.
 *
 * The platform's document *scan* lives on `Storage`, not on `Session`, so a
 * `Harness` cannot enumerate a document family. Without an index, a request-wide
 * stop could only see the batches that still hold capacity — and the batch it most
 * needs to reach is the one whose items have not been created yet, which holds
 * nothing at all. So the ids are listed here, and the list is what discovery reads.
 *
 * Session-scoped, because a session is what a reopen restores. It holds ids and
 * nothing else: live status is derived from the batch document, the ledger and the
 * scheduler, and a copy of "is it running" in a second place is a copy that
 * drifts. It is written in the *same commit* as the batch it names, so the index
 * and the batch cannot disagree about whether the batch was admitted.
 */
export type BatchIndexState = {
	readonly schemaVersion: number;
	batches: BatchId[];
};

export const BatchIndexDoc = defineDoc<BatchIndexState>({
	kind: "app.agent.runtime.batch-index",
	version: 1,
	scope: "session",
	initial: () => ({ schemaVersion: 1, batches: [] }),
});

/** Document kinds of this package, for audit output and refusal details. */
export const RUNTIME_DOCUMENT_KINDS = {
	batch: AgentBatchDoc.definition.kind,
	batchIndex: BatchIndexDoc.definition.kind,
	quota: AgentQuotaDoc.definition.kind,
	scheduler: SchedulerDoc.definition.kind,
	roundBinding: AgentRoundBindingDoc.definition.kind,
} as const;
