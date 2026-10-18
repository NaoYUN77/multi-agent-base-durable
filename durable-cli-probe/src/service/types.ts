// TASK-005.5 src/service/types.ts
//
// The read model the terminal entry renders, and the one way it writes back.
//
// Everything below is derived: a snapshot pass reads Durable documents through
// non-creating `snapshot` calls and the Main service's own reads, and derives a
// view from them. Nothing here is a second state machine. A field the documents
// do not carry does not appear, and in particular there is no progress
// percentage: no document counts steps, so any percentage would be invented.
//
// The TUI's own state is limited to what is not business state at all: focus,
// overlay choice and the editor's text. Those live in the view layer, never here.

import type { Context } from "@earendil-works/chord";
import type { ConversationId, Extension } from "@earendil-works/pi-durable";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ClarificationQuestion, UserAnswer } from "../agent/contracts/clarification.ts";
import type { RunConfig } from "../agent/contracts/run-config.ts";
import type { RoundExecution } from "../agent/contracts/round-execution.ts";
import type { BatchReconciliation } from "../agent/runtime/index.ts";
import type { TaskBusinessStatus } from "../agent/state/lifecycle.ts";
import type { EvidenceReference } from "../multiagent/ledger.ts";
import type { QueuedInput } from "../agent/main/service-doc.ts";
import type { MainService } from "./main-service.ts";

/**
 * How one task reads in the table, detail and status bar.
 *
 * The words are the lifecycle's own (`TaskBusinessStatus`, with the legacy
 * `revising` read as `running` because it is the same real state), plus exactly
 * one derived word:
 *
 *   * `stopping` — a stop has been asked for and recorded (batch cancel intent,
 *     or a ledger cancel request) but no receipt proves it finished yet. It is
 *     the state the runtime distinguishes as `stopping` and would otherwise
 *     have to be rendered as an untruth ("cancelled") or omitted.
 *
 * `awaiting-result` is a ledger written but no round execution yet; it is a
 * state of the documents, not a verdict, and the next pass replaces it.
 */
export type TaskRowStatus =
	| "planned"
	| "queued"
	| "running"
	| "retry_wait"
	| "stopping"
	| "awaiting-review"
	| "awaiting-input"
	| "accepted"
	| "failed"
	| "cancelled";

/** Where the row's status came from, for the detail pane and tests. */
export type TaskStatusSource =
	/** The ledger is the source (business status). */
	| "ledger"
	/** No ledger yet; the batch receipt is the source. */
	| "receipt"
	/** The batch or scheduler record exists but the task has no ledger. */
	| "batch"
	/** The item is in the batch but nothing has settled or started it. */
	| "none";

/** One tool counter of the current round, as the documents record it. */
export type ToolCounter = {
	readonly used: number;
	/** The limit this round was started with; absent when no execution record exists. */
	readonly limit?: number;
};

/** One row of the task table. Every field names a document it was read from. */
export type TaskRow = {
	readonly taskId: string;
	/** The dispatch batch the task belongs to. */
	readonly batchId: string;
	/** The saved contract's purpose, when its spec document is readable; otherwise the id. */
	readonly title: string;
	readonly status: TaskRowStatus;
	readonly statusSource: TaskStatusSource;
	/** Business status as written, when a ledger exists (`revising` is kept as written). */
	readonly businessStatus?: TaskBusinessStatus;
	/** The current round's execution status, when the ledger carries one. */
	readonly roundStatus?: RoundExecution["status"];
	/** The round the row describes (1-based); 0 when none started. */
	readonly round: number;
	/**
	 * When the row's current round (or queue wait) began. Rows that never started
	 * (or that are queued) have none: a zero would be a fabricated duration.
	 */
	readonly startedAt?: number;
	/** When the row reached a terminal state, if it has. */
	readonly settledAt?: number;
	/** Tool invocations of the current round against its limit. */
	readonly toolInvocations: ToolCounter;
	/** Failed tool calls of the current round against its limit. */
	readonly failedToolCalls: ToolCounter;
	/** The round's deadline, when an execution record exists. */
	readonly deadlineAt?: number;
	/** Position in the runtime queue when queued. */
	readonly queuePosition?: number;
	/** True when the row is in `retry_wait` with a recorded backoff. */
	readonly retrying: boolean;
};

/** One round of a task, for the detail pane. */
export type TaskRoundView = {
	readonly round: number;
	readonly kind: "initial" | "revision";
	readonly status?: RoundExecution["status"];
	readonly startedAt: number;
	readonly settledAt?: number;
	readonly deadlineAt?: number;
	readonly toolInvocations: ToolCounter;
	readonly failedToolCalls: ToolCounter;
	readonly evidenceCount: number;
	/** The settled answer's summary, when a result document is readable. */
	readonly resultSummary?: string;
	/** How the round ended, as the runtime classified it. */
	readonly outcome?: "completed" | "failed" | "cancelled";
	readonly failureKind?: "technical" | "quality" | "cancelled" | "quota";
	readonly requiresMainDecision?: boolean;
};

/** The detail pane of one task. Read-only; nothing here can change the task. */
export type TaskDetail = {
	readonly row: TaskRow;
	/** The contract's purpose, when readable. */
	readonly purpose?: string;
	/** Scope, exclusions and constraints from the saved contract. */
	readonly constraints: readonly string[];
	/** Acceptance criteria from the saved contract. */
	readonly acceptance: readonly string[];
	readonly rounds: readonly TaskRoundView[];
	/** Evidence references of every round, in record order, with their round. */
	readonly evidence: readonly (EvidenceReference & { readonly round: number })[];
	/** The ledger's recorded failure, when one exists. */
	readonly failure?: { readonly reason: string; readonly detail?: string };
	/** A recorded stop that has not yet produced a receipt. */
	readonly stopRequested?: { readonly kind: "operator" | "deadline"; readonly at: number; readonly reason: string };
	/** Rework attempts left, from the ledger's operation count and the run config. */
	readonly attemptsUsed?: number;
};

/** The request Main is working on, as `readRequest()` reports it. */
export type RequestView = {
	readonly requestId?: string;
	readonly requestVersion: number;
	readonly text: string;
	readonly openQuestionIds: readonly string[];
	readonly questions: readonly ClarificationQuestion[];
	readonly answers: readonly UserAnswer[];
	readonly planCount: number;
};

/** One input waiting for the next conversation boundary. */
export type QueuedInputView = QueuedInput;

/** Everything one snapshot pass produced. */
export type TuiSnapshot = {
	/** Clock at the end of the pass; the elapsed clock counts from here. */
	readonly takenAt: number;
	readonly request: RequestView;
	readonly queue: readonly QueuedInputView[];
	/** `status().busy`: Main's own conversation has live work. */
	readonly mainBusy: boolean;
	readonly tasks: readonly TaskRow[];
	/** Batches whose every item has a receipt: counted, never shown as progress. */
	readonly settledBatches: number;
	readonly totalBatches: number;
	/** The task ids this pass read, so the watcher can follow their ledger and spec. */
	readonly watchedTasks: readonly string[];
	/** The request ids this pass read, so the watcher can follow their quota. */
	readonly watchedRequests: readonly string[];
	/** The batch ids this pass read, so the watcher can follow their state. */
	readonly watchedBatches: readonly string[];
	/** What the runtime reconciled at open: the record of a reopened session. */
	readonly openReconciliation: readonly BatchReconciliation[];
	/** Runs and backoffs of Main's own live tasks, for the header. */
	readonly mainTasks: readonly { readonly name: string; readonly state: "running" | "ready" | "waiting" | "completing" | "blocked" }[];
};

/** One transcript line of Main's conversation. */
export type TranscriptLine = {
	readonly entryId: string;
	readonly kind: "user" | "assistant" | "tool" | "notice";
	readonly text: string;
	readonly at?: number;
};

/** What a cancel asked for, answered from documents when it returns. */
export type TaskCancelResult = {
	readonly taskId: string;
	/** The batch the task belongs to, when it was found. */
	readonly batchId?: string;
	/** `unknown-task` means no admitted batch holds the id; nothing was changed. */
	readonly outcome: "cancelled" | "stopping" | "settled" | "already-terminal" | "unknown-task";
	readonly detail: string;
};

/** Config the entry needs, after validation. Never carries a credential value. */
export type AgentConfig = {
	readonly provider: "faux" | "deepseek" | "openai" | "custom";
	readonly modelId?: string;
	readonly baseUrl?: string;
	/** The name of the environment variable that holds the key; never the key. */
	readonly apiKeyEnv?: string;
	readonly databasePath?: string;
	readonly maxConcurrentSubAgents: number;
	readonly maxSubAgentsPerRequest: number;
	readonly runConfig: RunConfig;
};

/**
 * The composition root's product. The terminal entry renders it; a headless
 * entry can drive the same object.
 *
 * `close` never cancels: it stops local scheduling and closes the Harness. Work
 * that was running pauses at its last durable point and is replayed by the
 * runtime on the next open.
 */
export type AgentSession = {
	readonly main: MainService;
	readonly conversationId: ConversationId;
	/** One consistent read pass. Non-creating on every document. */
	readonly snapshot: (now: number) => Promise<TuiSnapshot>;
	/**
	 * Change notification. Every pass stores its result and calls `listener`.
	 * `mark` requests a pass (the elapsed clock uses it) and `flush` resolves once a
	 * pass requested after the call has finished.
	 */
	readonly watch: (listener: () => void) => Promise<SessionWatch>;
	/** The last `limit` transcript lines of Main's conversation. */
	readonly transcript: (limit: number) => Promise<readonly TranscriptLine[]>;
	/** One task's detail, read fresh from its ledger, spec and results. */
	readonly inspectTask: (taskId: string, now: number) => Promise<TaskDetail | undefined>;
	/** Cancel one task's batch. Never cancels Main; refuses rather than guesses. */
	readonly cancelTask: (taskId: string, reason?: string) => Promise<TaskCancelResult>;
	/** Stop every running batch and abort Main, as `requestCancel` defines it. */
	readonly cancelAll: (reason?: string) => Promise<{ readonly requested: boolean; readonly reason: string }>;
	/** The context every call runs under. */
	readonly context: Context;
	close(): Promise<void>;
};

/** What `watch` hands back. */
export type SessionWatch = {
	/** Ask for a pass soon. */
	readonly mark: () => void;
	/** Resolve once a pass requested at or after this call has finished. */
	readonly flush: () => Promise<void>;
	readonly stop: () => Promise<void>;
};

/** What `openAgentSession` needs. A test passes a scripted router; the entry passes none. */
export type AgentSessionOptions = AgentConfig & {
	readonly databasePath: string;
	/** Test seam: serve the faux provider from this router instead of a fixed script. */
	readonly fauxRouter?: FauxResponseFactory;
	readonly now?: () => number;
	readonly wait?: (ms: number) => Promise<void>;
	readonly admissionPollMs?: number;
	readonly extraMainExtensions?: readonly Extension[];
};
