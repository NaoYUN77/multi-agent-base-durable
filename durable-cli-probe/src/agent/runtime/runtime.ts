// TASK-005.4 src/agent/runtime/runtime.ts
//
// The runtime's composition root: the dispatch adapter Main calls, the load
// phase that decides whether a batch may run at all, and the one place that
// turns a batch into nested durable tool tasks.
//
// Three things about this file are load-bearing.
//
//   * **Nothing here runs a model loop.** Each item is a nested `pi.tool` task
//     created through the invoking `dispatch_tasks` call's own `executeTool`, so
//     a crash mid-round leaves a task Durable reattaches instead of work this
//     process has to remember. The runtime's parallelism is the concurrency of
//     those nested tasks, observed by the harness, not a `Promise.all` over
//     something the program invented.
//   * **The load phase runs before any item starts.** Plan version, requirement
//     identity, saved contracts, dependencies, the run config fingerprint and the
//     per-task ledgers are all read in one commit and refused together. A batch
//     that starts an item and *then* discovers its contract is stale has already
//     spent budget on work nobody may accept.
//   * **Nothing is minted from a clock.** The batch id, the operation id, the
//     round, the attempt number and the nested call key are all derived from
//     persisted state, so a replay of the same dispatch call re-enters the same
//     tasks rather than starting a second batch.
//
// There is deliberately no separate "admission pump". `admission.ts` explains why
// the authoritative check has to run *inside* the item's own durable task — only
// there does the slot have an owner id to be keyed by — so a pump in this file
// could only ever be a hint. Each item asks for capacity itself, waits in the
// persisted queue when it is deferred, and asks again; the capacity read in
// `admitOne` is the authority for all of them.

import type { Context } from "@earendil-works/chord";
import {
	defineExtension,
	type ConversationId,
	type Extension,
	type Harness,
	type HarnessSettings,
	type ModelRef,
	type Registry,
	type Tx,
} from "@earendil-works/pi-durable";
import { AgentPlanDoc, AgentTaskResultDoc, AgentTaskSpecDoc } from "../contracts/documents.ts";
import type { RunConfig } from "../contracts/run-config.ts";
import { validateTaskSpec, type TaskSpec } from "../contracts/task-spec.ts";
import {
	readEnum,
	readNoUnknownKeys,
	readObject,
	readOptionalString,
	readPositiveInteger,
	readString,
	Violations,
} from "../contracts/validate.ts";
import type { TaskAuthorizationPolicy } from "../builder/authorization.ts";
import { canRevise, isTerminalBusinessStatus, TaskLedgerDoc } from "../../multiagent/ledger.ts";
import type { TaskResult } from "../contracts/task-result.ts";
import type { BatchHost, BatchStageRequest, DispatchResult, MainToolHost } from "../main/tools.ts";
import { discoverBatches, reconcileBatches, stopBatch, type CancelDependencies } from "./cancel.ts";
import {
	batchIdOf,
	operationIdOf,
	resultIdOf,
	roundCallKey,
	BatchNotResumable,
	type BatchCancelResult,
	type BatchExecutionContext,
	type BatchId,
	type BatchReconciliation,
	type PlanRef,
	type RefusalCode,
} from "./contracts.ts";
import { childQuotaExtension } from "./child.ts";
import { AgentBatchDoc, BatchIndexDoc, type BatchItemState } from "./documents.ts";
import { AGENT_TASK_ROUND_TOOL, createAgentTaskRoundTool, type ItemDependencies, type ItemToolOutput } from "./item.ts";
import { runConfigFingerprint } from "./resources.ts";
import { lastRoundOf } from "./round.ts";

/** Everything the runtime needs from the process that built it. All of it explicit. */
export type BatchRuntimeOptions = {
	readonly harness: Harness;
	/** The registry the runtime's tool extension is installed into. */
	readonly registry: Registry;
	/** The Main conversation: the scope of every batch, quota and result document. */
	readonly mainConversationId: ConversationId;
	/** Chord context for the control paths that run outside a tool call. */
	readonly context: Context;
	readonly model: ModelRef;
	/** The validated, finite run limits. There is no default; see `validateRunConfig`. */
	readonly runConfig: RunConfig;
	/** The catalog-backed grant policy the round's tool set is authorized against. */
	readonly toolPolicy: TaskAuthorizationPolicy;
	/** Injected clock, so a test can pin every program-owned timestamp. */
	readonly now?: () => number;
	/** Injected wait, so a test can drive the queue without real time. */
	readonly wait?: (ms: number) => Promise<void>;
	/** How long a deferred item waits before it asks for capacity again. */
	readonly admissionPollMs?: number;
};

/**
 * The batch runtime, as the service and the dispatch tool use it.
 *
 * The two host hooks (`dispatch`, `batches`) are what `openMainService` wires
 * into the Main extension. `extension` must be **selected** for the Main
 * conversation as well as installed: `executeTool` resolves a nested call among
 * the conversation's enabled tools, so an extension that is installed but not
 * selected makes every item call unavailable.
 */
export type BatchRuntime = {
	/** The runtime's tool extension: `agent_task_round`, callers `tools` only. */
	readonly extension: Extension;
	/** The injected executor `dispatch_tasks` calls after admission. */
	readonly dispatch: MainToolHost["dispatch"];
	/** The admission hooks: staging inside the dispatch commit, and the resume check. */
	readonly batches: BatchHost;
	/** Dependencies of a batch that are not `accepted`, read from their ledgers. */
	readonly unacceptedDependencies: NonNullable<MainToolHost["unacceptedDependencies"]>;
	/**
	 * Run (or resume) the named members of an admitted batch.
	 *
	 * @param planRef - the saved plan and the exact version the dispatcher read.
	 * @param taskIds - the members to run, in result order.
	 * @param executionContext - the invoking tool call, the batch id and the trigger.
	 * @returns the persisted result of each member that has one, in `taskIds` order.
	 * @throws {BatchNotResumable} when the load phase refuses; nothing has started.
	 */
	readonly runTaskBatch: (planRef: PlanRef, taskIds: readonly string[], executionContext: BatchExecutionContext) => Promise<readonly TaskResult[]>;
	/** Stop one batch: operator cancel or deadline. Idempotent. */
	readonly cancelBatch: (batchId: BatchId, reason: string, context: Context) => Promise<BatchCancelResult>;
	/** Stop every batch of this Main conversation that still has work. */
	readonly stopAll: (reason: string, context: Context) => Promise<readonly BatchCancelResult[]>;
	/** Finish what a crash left mid-stop and report what is outstanding. Idempotent. */
	readonly reconcile: (context: Context) => Promise<readonly BatchReconciliation[]>;
};

/**
 * The harness settings a batch runtime requires.
 *
 * The runtime enforces its own provider-retry budget with a persisted counter, and
 * that budget means nothing if the harness is *also* retrying underneath it: one
 * attempt would silently become several. `HarnessSettings` is process-global and
 * the `Harness` interface exposes no accessor, so the runtime cannot verify this —
 * it can only state it. This value is the statement: the composition root that
 * builds the `Harness` passes it, and `createBatchRuntime` refuses a run config
 * that contradicts it.
 *
 * @returns the settings a runtime-managed harness must be opened with.
 */
export function runtimeHarnessSettings(): HarnessSettings {
	return { stream: { maxRetries: 0 }, retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 } };
}

/**
 * Build the batch runtime.
 *
 * @param options - the harness, the Main conversation, and the limits every round
 *   runs under. All authorization this runtime exercises comes from here: it is
 *   the composition root's statement that these limits, this model and this tool
 *   policy are the ones in force.
 * @returns the runtime, with its tool extension already installed in the registry.
 *   The caller must still *select* `extension` for the Main conversation.
 * @throws {Error} when the run config asks the harness to retry on its own
 *   (`harnessRetry.maxRetries` must be 0), which would make the runtime's
 *   attempt, restart and provider-retry counters describe something other than
 *   what happened. There is no partial mode: the counters are the contract.
 */
export function createBatchRuntime(options: BatchRuntimeOptions): BatchRuntime {
	const now = options.now ?? Date.now;
	if (options.runConfig.harnessRetry.maxRetries !== 0) {
		throw new Error(
			"batch runtime: runConfig.harnessRetry.maxRetries must be 0 — the harness's own retry loop would make the runtime's " +
				"attempt and provider-retry counters describe something other than what ran. Open the Harness with runtimeHarnessSettings().",
		);
	}
	const itemDependencies: ItemDependencies = {
		mainConversationId: options.mainConversationId,
		model: options.model,
		runConfig: options.runConfig,
		toolPolicy: options.toolPolicy,
		// The behaviour contract of the child-side enforcement. Bumped when the
		// wrapper's behaviour changes, so a reopened run can prove it configured the
		// child the same way; the snapshot records it.
		contractRevision: 1,
		now,
		...(options.wait === undefined ? {} : { wait: options.wait }),
		...(options.admissionPollMs === undefined ? {} : { admissionPollMs: options.admissionPollMs }),
	};
	const cancelDependencies: CancelDependencies = {
		harness: options.harness,
		mainConversationId: options.mainConversationId,
		model: options.model,
		runConfig: options.runConfig,
		now,
		...(options.wait === undefined ? {} : { wait: options.wait }),
	};
	const extension = defineExtension({
		name: "runtime-batch",
		tools: [createAgentTaskRoundTool(itemDependencies)],
	});
	options.registry.install(extension);
	// The child-side budget gate is installed **once**, over the whole authorized
	// tool set, and not per item.
	//
	// Why once: `Registry.install` replaces an extension *by name*
	// (`harness/registry.ts`), so a per-item install would be a last-writer-wins
	// race — two children running at the same moment with different granted sets
	// would leave whichever installed last as the only wrap in the registry, and
	// the other child would silently run ungated. One install over the union is
	// safe because a wrap whose target tool the child did not compose is skipped
	// by the harness (`harness/agent.ts`), so wrapping a tool this child has no
	// grant for changes nothing.
	//
	// Why here rather than in the build: `configure(tx, conversationId, change)`
	// stores extension *names*, and the child is resolved from the live registry
	// snapshot at generation time. A name that was selected but never installed is
	// silently dropped, which would look exactly like a gate that admitted
	// everything. Installing at construction makes the name resolvable for every
	// child this runtime creates.
	options.registry.install(childQuotaExtension(options.toolPolicy.tools.map((tool) => tool.registration), options.runConfig));
	const state: RuntimeState = { ...options, now, cancelDependencies };
	return {
		extension,
		dispatch: async (input) => await dispatchBatch(state, input),
		batches: {
			stage: async (tx, input) => await stageBatch(state, tx, input),
			resumable: async (operationKey) => await batchIsResumable(state, operationKey),
		},
		unacceptedDependencies: (tasks, tx) => unacceptedDependencies(state, tasks, tx),
		runTaskBatch: async (planRef, taskIds, executionContext) => (await executeBatch(state, planRef, taskIds, executionContext)).results,
		cancelBatch: async (batchId, reason, context) => await stopBatch(cancelDependencies, { batchId, kind: "operator", reason }, context),
		stopAll: async (reason, context) => await stopAllBatches(state, reason, context),
		reconcile: async (context) => await reconcileBatches(cancelDependencies, context),
	};
}

/** The options as the runtime holds them, with the clock and the cancel dependencies bound. */
type RuntimeState = BatchRuntimeOptions & {
	readonly now: () => number;
	readonly cancelDependencies: CancelDependencies;
};

// ── Admission staging ────────────────────────────────────────────────────────

/**
 * Stage an admitted batch inside the dispatch tool's own commit.
 *
 * The saved contracts and the member list land together with the dispatch
 * attempt and the started marker, so "this call was admitted" and "this is what
 * it was authorized to run" cannot disagree — not even after a crash.
 *
 * Idempotent, and deliberately non-destructive on a replay: a batch that already
 * has `createdAt` is left exactly as it is, because rewriting its items would
 * erase the receipts of items that already settled. The same call cannot carry a
 * different body, and a different call carries a different operation key.
 *
 * @param state - the runtime's bound options.
 * @param tx - the caller's transaction. Staging writes only through it.
 * @param input - the admitted call: its operation key, plan, requirement and the
 *   validated task bodies.
 * @returns nothing. Every write is part of the caller's commit.
 */
async function stageBatch(state: RuntimeState, tx: Tx, input: BatchStageRequest): Promise<void> {
	const batchId = batchIdOf(input.operationKey);
	const at = input.now;
	await saveSpecs(state, tx, input, at);
	// The index entry is written whether or not the batch is new, and guarded by
	// `includes` rather than by the batch's `createdAt`: the two are written in the
	// same commit, so an entry can only be missing for a batch that already exists if
	// the index was introduced after the batch — and then the batch is exactly the
	// one a stop could not otherwise find.
	const index = await tx.doc(BatchIndexDoc);
	if (!index.batches.includes(batchId)) index.batches = [...index.batches, batchId];
	const batch = await tx.doc(AgentBatchDoc, input.conversationId, batchId, { batchId });
	if (batch.createdAt !== 0) return;
	const seen = new Set<string>();
	const items: BatchItemState[] = [];
	input.tasks.forEach((task, index) => {
		if (seen.has(task.id)) return;
		seen.add(task.id);
		items.push({
			taskId: task.id,
			operationId: operationIdOf(task.id),
			// Fairness order, fixed at admission: a retry never gets a new one, so a
			// retried item cannot jump the queue it was already waiting in.
			sequence: index,
			enqueuedAt: at,
		});
	});
	batch.planId = input.planId;
	batch.planVersion = input.planVersion;
	batch.requestId = input.requestId;
	batch.requestVersion = input.requestVersion;
	// The fingerprint is the run limits this batch was *admitted* under. A resumed
	// batch is never run under new ones: the counters it spent were counted against
	// these numbers, and re-reading them from a later run config would make the
	// budget a different budget.
	batch.runConfigFingerprint = runConfigFingerprint(state.runConfig);
	batch.items = items;
	batch.createdAt = at;
}

/**
 * Save the contract of every task in the admitted batch.
 *
 * A body is written once for a given `(plan, version, requirement)`; a second
 * dispatch of the same task with a *different* body bumps `specVersion` only
 * while the task has never started, because a running instance keeps the
 * contract it began with. The ledger read is what tells those apart — and it is
 * the same document the round's admission stamps, so the two cannot disagree
 * about whether the task started.
 */
async function saveSpecs(state: RuntimeState, tx: Tx, input: BatchStageRequest, at: number): Promise<void> {
	for (const task of input.tasks) {
		const doc = await tx.doc(AgentTaskSpecDoc, input.conversationId, task.id, { taskId: task.id });
		const samePlace =
			doc.planId === input.planId &&
			doc.planVersion === input.planVersion &&
			doc.requestId === input.requestId &&
			doc.requestVersion === input.requestVersion;
		if (doc.specVersion !== 0 && samePlace) continue;
		if (doc.specVersion !== 0) {
			const ledger = await tx.doc(TaskLedgerDoc, input.conversationId, task.id, { taskId: task.id, model: state.model });
			const started = ledger.createdAt !== 0 || ledger.rounds.length > 0;
			if (started) continue;
		}
		doc.spec = task;
		doc.specVersion = doc.specVersion + 1;
		doc.planId = input.planId;
		doc.planVersion = input.planVersion;
		doc.requestId = input.requestId;
		doc.requestVersion = input.requestVersion;
		doc.savedAt = at;
	}
}

/**
 * Whether an admitted-but-unfinished dispatch has a batch on record.
 *
 * A batch document is the whole answer: it is written in the same commit as the
 * admission decision and the started marker, and everything an item does is keyed
 * by ids derived from the same operation key. So "the batch is on record and
 * admitted" is the same statement as "re-entering this call re-enters work that is
 * deduplicated by design".
 *
 * The read is `snapshot`, which is non-creating: `tx.doc` materializes a missing
 * family member from its definition's initial value, so a check built on it would
 * *create* a seed batch document for every interrupted call, and the next attempt
 * would then read an "admitted" batch that was never admitted. `createdAt` is
 * checked as well as existence for the same reason read defensively: a seed that
 * some other path created carries `createdAt: 0` and is not an admission.
 *
 * @param state - the runtime's bound options.
 * @param operationKey - the `dispatch:<toolTask>:<call>` key of the call being replayed.
 * @returns true when the batch exists and is admitted, so the caller may resume it
 *   instead of reporting an unknown outcome.
 */
async function batchIsResumable(state: RuntimeState, operationKey: string): Promise<boolean> {
	const batchId = batchIdOf(operationKey);
	const batch = await state.harness.snapshot(AgentBatchDoc, state.mainConversationId, batchId, state.context);
	return batch !== undefined && batch.createdAt !== 0;
}

/**
 * The dependencies of `tasks` that are not `accepted`.
 *
 * Read from the dependency's own ledger, which is the only durable answer to "did
 * this land?". A dependency with no ledger has never been dispatched, and its
 * seed status is not `accepted`, so it is reported — the check is fail-closed in
 * the direction that matters. A dependency *inside* the batch is not this
 * function's business: the batch's own DAG rule is validated by
 * `validateTaskBatch` before admission.
 *
 * The reads go through the caller's transaction when it has one, because the
 * answer must be the state the admission decision is made against, and creating a
 * seed ledger for a never-dispatched dependency is the price of that: the
 * alternative is an untyped document read that cannot be checked.
 *
 * @param state - the runtime's bound options.
 * @param tasks - the validated batch whose dependencies are being checked.
 * @param tx - the admission transaction, when the caller is inside one.
 * @returns the ids of dependencies that are not `accepted`, in encounter order.
 */
function unacceptedDependencies(state: RuntimeState, tasks: readonly TaskSpec[], tx?: Tx): readonly string[] | Promise<readonly string[]> {
	const members = new Set(tasks.map((task) => task.id));
	const wanted: string[] = [];
	for (const task of tasks) {
		for (const dependency of task.dependencies) {
			if (!members.has(dependency) && !wanted.includes(dependency)) wanted.push(dependency);
		}
	}
	if (wanted.length === 0) return [];
	// The reads go through the caller's transaction when it has one, so the answer
	// is the state the admission decision is made against rather than a state read a
	// moment before it.
	if (tx !== undefined) return unacceptedOf(state, wanted, tx);
	return state.harness.commit(async (own) => unacceptedOf(state, wanted, own), state.context);
}

/** The unaccepted subset of `wanted`, read inside one transaction. */
async function unacceptedOf(state: RuntimeState, wanted: readonly string[], tx: Tx): Promise<readonly string[]> {
	const unaccepted: string[] = [];
	for (const dependency of wanted) {
		const ledger = await tx.doc(TaskLedgerDoc, state.mainConversationId, dependency, { taskId: dependency, model: state.model });
		if (ledger.status !== "accepted") unaccepted.push(dependency);
	}
	return unaccepted;
}

// ── The dispatch adapter ─────────────────────────────────────────────────────

/**
 * Execute an admitted batch: run its members and render one `DispatchResult` per
 * member.
 *
 * The rendering is from the persisted receipt, never from the model's text and
 * never from this process's memory of what it started. That is what makes a
 * replayed dispatch return the same lines as the original: the receipt is a
 * document.
 */
async function dispatchBatch(state: RuntimeState, input: Parameters<MainToolHost["dispatch"]>[0]): Promise<readonly DispatchResult[]> {
	if (input.operationKey === undefined) {
		throw new Error("batch runtime: a dispatch without an operation key cannot be identified, so no batch can be derived from it");
	}
	const batchId = batchIdOf(input.operationKey);
	const taskIds = input.tasks.map((task) => task.id);
	const executed = await executeBatch(state, { planId: input.planId, version: input.planVersion }, taskIds, {
		api: input.api,
		batchId,
		trigger: { kind: "dispatch" },
	});
	return await dispatchResults(state, batchId, taskIds, executed.runs);
}

/** Render one `DispatchResult` per member, from the batch document first. */
async function dispatchResults(
	state: RuntimeState,
	batchId: BatchId,
	taskIds: readonly string[],
	runs: readonly MemberRun[],
): Promise<readonly DispatchResult[]> {
	const byTask = new Map<string, MemberRun>();
	for (const run of runs) byTask.set(run.taskId, run);
	return await state.harness.commit(async (tx) => {
		const batch = await tx.doc(AgentBatchDoc, state.mainConversationId, batchId, { batchId });
		return taskIds.map((taskId): DispatchResult => {
			const receipt = batch.items.find((entry) => entry.taskId === taskId)?.receipt;
			if (receipt !== undefined) {
				return { taskId, status: receipt.status, detail: receiptDetail(receipt) };
			}
			const run = byTask.get(taskId);
			// No receipt, but a durable answer: the item refused before it was admitted
			// (an unauthorized grant, an unusable contract, a held execution right). The
			// refusal is recorded as a receipt by `recordRefusals` when the item holds a
			// place in the batch, so reaching here means it does not — and the nested
			// call's own program output is still the answer.
			if (run?.output !== undefined) {
				return { taskId, status: "failed", detail: run.output.detail === undefined ? `${run.output.status} with no detail` : run.output.detail };
			}
			// A rejection or an item that ended without a receipt. This process is not
			// finishing that member; the durable replay of the dispatch call is what
			// does, and reporting it as anything but a failure would be a claim nobody
			// can back.
			if (run?.problem !== undefined) return { taskId, status: "failed", detail: run.problem };
			return { taskId, status: "failed", detail: "no receipt was recorded for this member" };
		});
	}, state.context);
}

/**
 * One line of what a receipt says, for the Main model.
 *
 * The round, the failure classification, whether Main has to decide, and the
 * result id when one was persisted — the facts a reader needs to go and look,
 * with no prose about how the work went.
 */
function receiptDetail(receipt: {
	readonly round: number;
	readonly status: string;
	readonly failureKind?: string;
	readonly requiresMainDecision?: boolean;
	readonly resultId?: string;
	readonly detail?: string;
}): string {
	const parts = [`round ${receipt.round}`, receipt.status];
	if (receipt.failureKind !== undefined) parts.push(receipt.failureKind);
	if (receipt.requiresMainDecision === true) parts.push("needs a Main decision");
	if (receipt.resultId !== undefined) parts.push(`result ${receipt.resultId}`);
	if (receipt.detail !== undefined) parts.push(receipt.detail);
	return parts.join(", ");
}

/** The statuses the item tool's own output may carry. */
const ITEM_OUTPUT_STATUSES: readonly ItemToolOutput["status"][] = ["completed", "failed", "cancelled", "queued", "refused"];

/**
 * Validate the item tool's `structuredOutput` into its declared shape.
 *
 * A nested result's `structuredOutput` is `JsonValue` — a trust boundary, even
 * though this runtime registered the tool itself. It is validated rather than
 * asserted, because a schema-typed value that was never checked is exactly the
 * assertion the contract forbids; and it is checked against the same five statuses
 * the tool declares, so a shape that drifted is a `failed` member rather than a
 * status this file invents.
 *
 * @param value - the nested result's `structuredOutput`, or `undefined` when the
 *   harness wrote the error result itself.
 * @returns the typed output, or `undefined` when it is absent or malformed.
 */
function readItemToolOutput(value: unknown): ItemToolOutput | undefined {
	const collect = new Violations();
	const holder = readObject(value, "$", collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, "$", collect, ["taskId", "round", "status", "resultId", "detail"]);
	const taskId = readString(holder, "taskId", "$.taskId", collect);
	const round = readPositiveInteger(holder, "round", "$.round", collect);
	const status = readEnum(holder, "status", "$.status", collect, ITEM_OUTPUT_STATUSES);
	const resultId = readOptionalString(holder, "resultId", "$.resultId", collect);
	const detail = readOptionalString(holder, "detail", "$.detail", collect);
	if (collect.reported || taskId === undefined || round === undefined || status === undefined) return undefined;
	return {
		taskId,
		round,
		status,
		...(resultId === undefined ? {} : { resultId }),
		...(detail === undefined ? {} : { detail }),
	};
}

// ── The load phase ───────────────────────────────────────────────────────────

/** One member as the load phase resolved it. */
type LoadedItem = {
	readonly taskId: string;
	/** The round this member runs. Read from persisted state, never counted here. */
	readonly round: number;
	/** True when the batch already holds this member's receipt *for this round*, so it must not run. */
	readonly receipt: boolean;
};

type LoadedBatch = {
	readonly batchId: BatchId;
	readonly requestId: string;
	readonly requestVersion: number;
	readonly planVersion: number;
	readonly items: readonly LoadedItem[];
};

/** What one member's nested call reported, beyond the receipt it may have written. */
type MemberRun = {
	readonly taskId: string;
	/** The item tool's own output, when the nested call returned a validated one. */
	readonly output?: ItemToolOutput;
	/** Why this process could not obtain an answer for the member. Never a receipt. */
	readonly problem?: string;
};

/**
 * Load and validate the batch, or refuse it before anything starts.
 *
 * One commit, so every check sees the same state: the plan as stored, the batch
 * as staged, the saved contracts, the dependencies' ledgers and each member's own
 * ledger. Every refusal names a `RefusalCode`; the caller resolves the code, not
 * the sentence.
 *
 * @throws {BatchNotResumable} for every refusal. Nothing has been written by the
 *   time it is thrown: the load phase decides, it does not repair.
 */
async function loadBatch(state: RuntimeState, planRef: PlanRef, taskIds: readonly string[], executionContext: BatchExecutionContext): Promise<LoadedBatch> {
	const batchId = executionContext.batchId;
	const trigger = executionContext.trigger;
	const loaded = await state.harness.commit(async (tx) => {
		// Typed as a plain function value so the compiler knows a call never returns:
		// every check below is written as `if (bad) refuse(...)`, and the narrowing
		// after it is what lets the rest of the block use the value it validated.
		const refuse: (code: RefusalCode, detail: string) => never = (code, detail) => {
			throw new BatchNotResumable(code, detail);
		};
		if (taskIds.length === 0) refuse("task_not_in_batch", "no task was named");
		if (new Set(taskIds).size !== taskIds.length) refuse("task_not_in_batch", "the same task was named twice");
		if (trigger.kind === "rework" && (taskIds.length !== 1 || taskIds[0] !== trigger.taskId)) {
			refuse("task_not_in_batch", `a rework runs exactly the task named by its trigger, not ${taskIds.join(", ")}`);
		}

		const plan = await tx.doc(AgentPlanDoc, state.mainConversationId, planRef.planId, { planId: planRef.planId });
		if (plan.version === 0) refuse("plan_version_stale", `plan ${planRef.planId} was never saved`);
		if (plan.version !== planRef.version) {
			refuse("plan_version_stale", `plan ${planRef.planId} is at version ${plan.version}, not ${planRef.version}`);
		}
		if (plan.requestId === "" || plan.requestVersion === 0) {
			refuse("plan_request_mismatch", `plan ${planRef.planId} names no requirement`);
		}

		const batch = await tx.doc(AgentBatchDoc, state.mainConversationId, batchId, { batchId });
		if (batch.createdAt === 0) refuse("batch_not_admitted", `batch ${batchId} was never admitted`);
		if (batch.planId !== planRef.planId || batch.planVersion !== planRef.version) {
			refuse("batch_contract_changed", `batch ${batchId} was admitted for plan ${batch.planId} v${batch.planVersion}`);
		}
		if (batch.requestId !== plan.requestId || batch.requestVersion !== plan.requestVersion) {
			refuse("plan_request_mismatch", `batch ${batchId} was admitted for request ${batch.requestId}`);
		}
		const fingerprint = runConfigFingerprint(state.runConfig);
		if (batch.runConfigFingerprint !== fingerprint) {
			refuse("run_config_missing_or_invalid", `batch ${batchId} was admitted under different run limits; a resumed batch is never run under new ones`);
		}
		if (batch.cancel !== undefined) refuse("cancel_pending", `batch ${batchId} is being cancelled`);

		const planned = new Set(plan.taskIds);
		const specs: TaskSpec[] = [];
		const members: LoadedItem[] = [];
		for (const taskId of taskIds) {
			if (!planned.has(taskId)) refuse("task_not_in_batch", `task ${taskId} is not in plan ${planRef.planId}`);
			const item = batch.items.find((entry) => entry.taskId === taskId);
			if (item === undefined) refuse("task_not_in_batch", `task ${taskId} is not a member of batch ${batchId}`);
			// The saved contract, not the dispatching call's text: a replay must execute
			// the body the first attempt was authorized against.
			const specDoc = await tx.doc(AgentTaskSpecDoc, state.mainConversationId, taskId, { taskId });
			if (specDoc.specVersion === 0 || specDoc.spec === undefined) refuse("saved_spec_invalid", `task ${taskId} has no saved contract`);
			const validated = validateTaskSpec(specDoc.spec);
			if (!validated.ok) {
				refuse("saved_spec_invalid", `the saved contract of ${taskId} is invalid: ${violated(validated.violations)}`);
			}
			const spec = validated.value;
			if (spec.id !== taskId) refuse("saved_spec_invalid", `the saved contract names task ${spec.id}, not ${taskId}`);
			if (specDoc.planVersion !== planRef.version || specDoc.requestId !== plan.requestId || specDoc.requestVersion !== plan.requestVersion) {
				refuse("saved_spec_invalid", `the saved contract of ${taskId} does not belong to plan ${planRef.planId} v${planRef.version}`);
			}
			specs.push(spec);
			const ledger = await tx.doc(TaskLedgerDoc, state.mainConversationId, taskId, { taskId, model: state.model });
			if (isTerminalBusinessStatus(ledger.status)) refuse("task_terminal", `task ${taskId} is ${ledger.status}`);
			if (trigger.kind === "rework") {
				if (ledger.status !== "awaiting_review") {
					refuse("task_not_ready_for_rework", `task ${taskId} is ${ledger.status}; only a task awaiting review can be reworked`);
				}
				if (!canRevise(ledger.currentRound)) {
					refuse("task_not_ready_for_rework", `task ${taskId} has used its revision allowance`);
				}
			}
			// The round comes from persisted state, never from a counter in this process:
			// a replayed dispatch has to re-enter the round the first attempt opened, or
			// its nested call key would name a task that does not exist and the work would
			// run twice.
			//
			// A receipt settles one round, not the item forever. A rework targets the
			// round after the settled one; a plain dispatch replays the round the item was
			// admitted for. Reading the receipt as "this item is finished" would make the
			// rework unreachable — the item's first-round receipt would answer the second
			// round from storage before any work ran.
			const round =
				trigger.kind === "rework" && item.receipt !== undefined
					? item.receipt.round + 1
					: (item.round ?? lastRoundOf(ledger) + 1);
			if (ledger.activeOpKey !== undefined && ledger.activeOpKey !== roundCallKey(taskId, round)) {
				refuse("execution_right_held", `task ${taskId} round ${round} is held by ${ledger.activeOpKey}`);
			}
			if (ledger.cancelRequested !== undefined) refuse("cancel_pending", `task ${taskId} has a cancel intent`);
			members.push({ taskId, round, receipt: item.receipt !== undefined && item.receipt.round >= round });
		}

		// Dependencies are checked last, after every member is known: a dependency the
		// batch itself contains is the batch's DAG rule, not an external fact, and
		// `unacceptedDependencies` excludes them for the same reason.
		const unaccepted = await unacceptedDependencies(state, specs, tx);
		if (unaccepted.length > 0) {
			refuse("dependency_not_accepted", `tasks outside the batch are not accepted: ${unaccepted.join(", ")}`);
		}
		// The requirement identity comes from the stored plan, never from the caller's
		// context, so it cannot be spoofed by a tool argument.
		return { batchId, requestId: plan.requestId, requestVersion: plan.requestVersion, planVersion: plan.version, items: members };
	}, state.context);
	return loaded;
}

/** One line of violation text, never a paragraph. */
function violated(violations: readonly { readonly path: string; readonly code: string }[]): string {
	return violations.map((entry) => `${entry.path}:${entry.code}`).join(", ");
}

// ── Running the batch ────────────────────────────────────────────────────────

/**
 * Run (or resume) every named member in one batch.
 *
 * The members are started together and joined with `allSettled`, so one item's
 * failure never withholds another's result (AC-04). "Started together" is about
 * *creation*: each nested call admits itself against the scheduler, so the run
 * limits — not this loop — decide how many actually run at once.
 *
 * Idempotency is the whole design: every item call carries a key derived from
 * `(task, round)`, so a replay reattaches to the task that already exists, and an
 * item that already has a receipt is answered from storage without a call at all.
 * A member with a receipt is skipped rather than re-called: its round is over, and
 * the round rule in `loadBatch` — the task's next round — is only correct for a
 * member that has never run.
 *
 * A *rejected* nested call is not allowed to discard the batch. `allSettled`
 * is the whole point: a member this process could not finish keeps its own
 * problem, every other member's receipt is still read and reported, and the
 * begun-marker plus the dispatch call's own replay own the recovery. Throwing
 * would trade the batch's other answers for an error message about one of them.
 *
 * @param state - the runtime's bound options.
 * @param planRef - the saved plan and the version being executed.
 * @param taskIds - the members to run, in result order.
 * @param executionContext - the invoking call, the batch id and the trigger.
 * @returns the persisted result of each member that has one, in `taskIds` order,
 *   and what each member's call reported.
 * @throws {BatchNotResumable} when the load phase refuses. Nothing has started.
 * @throws {Error} only from a read that could not be taken at all — a store that
 *   failed or a harness that closed mid-join. A member that failed to run is not
 *   an exception; it is a `failed` member.
 */
async function executeBatch(
	state: RuntimeState,
	planRef: PlanRef,
	taskIds: readonly string[],
	executionContext: BatchExecutionContext,
): Promise<{ readonly results: readonly TaskResult[]; readonly runs: readonly MemberRun[] }> {
	const loaded = await loadBatch(state, planRef, taskIds, executionContext);
	const { api, batchId, trigger } = executionContext;
	const mode = trigger.kind === "rework" ? ("rework" as const) : ("initial" as const);
	const pending = loaded.items.filter((item) => !item.receipt);
	const started = await Promise.allSettled(
		pending.map((item) =>
			api.executeTool(
				AGENT_TASK_ROUND_TOOL,
				{
					batchId: String(batchId),
					taskId: item.taskId,
					round: item.round,
					mode,
					...(trigger.kind === "rework" ? { feedback: trigger.feedback } : {}),
				},
				state.context,
				{ key: roundCallKey(item.taskId, item.round) },
			),
		),
	);
	const runs: MemberRun[] = [];
	const refusals: { readonly taskId: string; readonly round: number; readonly detail: string }[] = [];
	pending.forEach((item, index) => {
		const settled = started[index];
		if (settled === undefined) {
			// Unreachable: `allSettled` answers one result per promise it was given.
			runs.push({ taskId: item.taskId, problem: "the item call produced no result" });
			return;
		}
		if (settled.status === "rejected") {
			runs.push({ taskId: item.taskId, problem: `the item call did not finish: ${describe(settled.reason)}` });
			return;
		}
		const output = readItemToolOutput(settled.value.structuredOutput);
		if (output === undefined) {
			runs.push({
				taskId: item.taskId,
				problem: settled.value.isError
					? `the item failed without a readable answer: ${diagnosticsOf(settled.value.diagnostics)}`
					: "the item returned no readable answer",
			});
			return;
		}
		runs.push({ taskId: item.taskId, output });
		if (output.status === "refused") {
			refusals.push({ taskId: item.taskId, round: output.round, detail: output.detail ?? "refused with no detail" });
		}
	});
	// A refusal is a terminal answer *for this batch's member*, and it is durable:
	// the item task recorded it, so every replay of this call re-reads the same
	// refusal. Materializing it as the member's receipt is what keeps the batch
	// able to settle — without it the batch would report the same never-started item
	// as outstanding forever — and it is written here rather than in `item.ts`
	// because only this side sees the nested call's output and knows the member's
	// round. It is not a `TaskResult`: no round ran, so there is no document to point
	// at, and `resultId` names a document.
	await recordRefusals(state, batchId, refusals);
	return { results: await resultsOf(state, batchId, loaded.items), runs };
}

/** The message of an unknown thrown value, for a member's problem line. */
function describe(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/** The diagnostics of a nested error result, as one line. */
function diagnosticsOf(diagnostics: readonly { readonly severity: string; readonly message: string }[]): string {
	return diagnostics.length === 0 ? "no diagnostics" : diagnostics.map((entry) => `${entry.severity}: ${entry.message}`).join("; ");
}

/**
 * Write the receipt of every member that refused before it was admitted.
 *
 * One commit for the whole set, and write-once per member: a member that already
 * has a receipt keeps it, so a replay that re-reads the same refusal changes
 * nothing. The failure kind is `technical` and `requiresMainDecision` is set,
 * because a refusal is not a verdict on the work — the contract could not be
 * authorized or could not be assembled, and whether to fix it and dispatch again
 * is Main's call, not this process's.
 */
async function recordRefusals(
	state: RuntimeState,
	batchId: BatchId,
	refusals: readonly { readonly taskId: string; readonly round: number; readonly detail: string }[],
): Promise<void> {
	if (refusals.length === 0) return;
	await state.harness.commit(async (tx) => {
		const now = state.now();
		const batch = await tx.doc(AgentBatchDoc, state.mainConversationId, batchId, { batchId });
		for (const refusal of refusals) {
			const item = batch.items.find((entry) => entry.taskId === refusal.taskId);
			// Write-once per round: a rework starts from the previous round's receipt,
			// and answering *its* refusal with that receipt would hide the refusal.
			if (item === undefined || (item.receipt !== undefined && item.receipt.round >= refusal.round)) continue;
			item.receipt = {
				taskId: refusal.taskId,
				operationId: item.operationId,
				round: refusal.round,
				status: "failed",
				failureKind: "technical",
				requiresMainDecision: true,
				detail: refusal.detail,
				settledAt: now,
			};
			if (item.round === undefined) item.round = refusal.round;
		}
		if (batch.settledAt === undefined && batch.items.every((entry) => entry.receipt !== undefined)) batch.settledAt = now;
	}, state.context);
}

/**
 * The persisted results of the members, in `taskIds` order.
 *
 * Read from the documents the receipts name. A member with no receipt, or a
 * receipt with no result id, is skipped — and that is the honest answer rather
 * than a synthesized result: `TaskResult.resultId` names a document, so minting
 * one nobody wrote would hand the caller a pointer to nothing. The receipt is that
 * member's answer, and `dispatchResults` renders it.
 */
async function resultsOf(state: RuntimeState, batchId: BatchId, items: readonly LoadedItem[]): Promise<readonly TaskResult[]> {
	return await state.harness.commit(async (tx) => {
		const batch = await tx.doc(AgentBatchDoc, state.mainConversationId, batchId, { batchId });
		const found: TaskResult[] = [];
		for (const item of items) {
			const receipt = batch.items.find((entry) => entry.taskId === item.taskId)?.receipt;
			if (receipt === undefined || receipt.resultId === undefined) continue;
			const resultId = receipt.resultId;
			const document = await tx.doc(AgentTaskResultDoc, state.mainConversationId, resultId, { resultId, taskId: item.taskId });
			// Both halves of the identity are checked: the document has to carry the id
			// the receipt named *and* the round the receipt settled. A receipt that
			// pointed at another round's document would otherwise be believed.
			if (document.resultId !== resultIdOf(item.taskId, receipt.round) || document.round !== receipt.round) continue;
			if (document.result !== undefined) found.push(detachResult(document.result));
		}
		return found;
	}, state.context);
}

/**
 * A plain copy of one result read inside a commit.
 *
 * A document read through `tx.doc` is an overlay view, and an overlay view is
 * dead the moment its commit settles: the next property read throws "Cannot use
 * a settled overlay". The result leaves this commit and is returned all the way
 * to the caller's tool result, so every field it owns is copied out while the
 * commit is still open. Copying is shallow on purpose — the contract is plain
 * data (strings, numbers, arrays of records), so one level per container is the
 * whole object.
 */
function detachResult(result: TaskResult): TaskResult {
	return {
		schemaVersion: result.schemaVersion,
		resultId: result.resultId,
		runtime: { ...result.runtime },
		evidence: result.evidence.map((reference) => ({ ...reference })),
		work: {
			summary: result.work.summary,
			findings: [...result.work.findings],
			unresolved: [...result.work.unresolved],
			artifacts: result.work.artifacts.map((artifact) => ({ ...artifact })),
		},
	};
}

// ── Control paths ────────────────────────────────────────────────────────────

/**
 * Stop every batch of this Main conversation that still has work.
 *
 * A request-wide cancel is a cancel of the conversation, and the runtime's batches
 * are the only work the conversation started. Batches are discovered from the
 * session's admitted-batch index rather than from the scheduler: the batch a stop
 * most needs to reach is one that was admitted and never got an item running, and
 * such a batch holds no slot, so a capacity-based enumeration cannot see it.
 *
 * The stops run *concurrently*, unlike `reconcile`'s. Both phases of a stop —
 * recording the intent, then joining the children — go through commits, which the
 * session serializes anyway, so concurrency costs no correctness; and each join is
 * bounded by a fixed number of paused re-reads, which a request-wide cancel of many
 * batches would otherwise pay one batch at a time. A control call has to return.
 *
 * A batch whose stop cannot be confirmed is not an error here. `stopBatch` reports
 * `stopping` and keeps the intent, so the next attempt — this call, a later cancel,
 * or `reconcile` on reopen — resumes the join.
 *
 * @param state - the runtime's bound options.
 * @param reason - carried into each batch's recorded intent.
 * @param context - the control call's context.
 * @returns one stop result per admitted batch, in admission order. The intent of
 *   every one of them is persisted before this resolves, which is what makes the
 *   caller's subsequent abort safe: a process that dies after the abort still finds
 *   the stops on record.
 */
async function stopAllBatches(state: RuntimeState, reason: string, context: Context): Promise<readonly BatchCancelResult[]> {
	const found = await discoverBatches(state.cancelDependencies, context);
	return await Promise.all(found.map(async (batchId) => await stopBatch(state.cancelDependencies, { batchId, kind: "operator", reason }, context)));
}
