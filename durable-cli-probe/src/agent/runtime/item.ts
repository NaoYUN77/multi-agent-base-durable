// TASK-005.4 src/agent/runtime/item.ts
//
// One item of one batch: the nested durable tool `agent_task_round`, and the
// round it runs.
//
// ── Why one item task per (task, round), not per attempt ─────────────────────
//
// The item's durable task *is* the thing that holds the slot and the ledger's
// execution right, and its id is what makes both idempotent. A retry inside the
// round therefore cannot be a second item task: `admitOne` refuses a round whose
// right is held by another operation, and `claimRound` refuses a round that is
// already claimed, so a per-attempt item would refuse its own retry. Every
// attempt of a round happens inside the one item task, which is also why
// `retry_wait` keeps the slot: the task is still live and about to submit again.
//
// The second reason is Durable's own replay rule: `executeTool` reattaches a
// repeated key to the task it created, and it reattaches to a *finished* task by
// returning its recorded result. An item that returned "queued" and expected to
// be re-dispatched would therefore be answered with "queued" forever. So the
// item does not return until it has a receipt — it waits for capacity itself,
// bounded by the round's deadline.
//
// ── The three budgets, and who owns which ────────────────────────────────────
//
//   * capacity and the execution right — `admitOne`, in `admission.ts`;
//   * what one round may spend — `consumeOnce`, persisted per reservation id;
//   * whether a failed round retries — `decideRoundFailure`, the shared table.
//
// This file owns none of them. It sequences them, and it is the only place that
// turns a settled submission into a settlement, because the settlement is where
// the round's persisted facts and the model's answer first meet.
//
// ── One attempt number, not two ──────────────────────────────────────────────
//
// An attempt is numbered within its round, and that number is the only one:
// `RoundAttemptRecord.attemptNo`, the quota key from `attemptKeyOf` and the
// submission id from `attemptRequestId` all derive from it, and the round in the
// key is what keeps two rounds' attempt 1 apart. An operation-wide counter
// alongside it would be a second number that has to agree with the first.
//
// ── No hidden retries ────────────────────────────────────────────────────────
//
// `HarnessSettings.retry` is process-global and Durable reads it at every
// generation attempt (`harness/generation.ts:486`), so an application-level
// retry budget is only meaningful if the Harness was built with the provider's
// own retry loop off. The runtime cannot enforce that from here; `runtime.ts`
// checks it at creation and refuses a batch whose run config disagrees with the
// harness it was handed. What this file guarantees is the other half: every
// retry it decides is charged through `consumeOnce` before the next attempt
// starts, so the count is persisted and a restart cannot reset it.

import { createHash } from "node:crypto";
import type { Context, Draft } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { defineTool } from "@earendil-works/pi-durable";
import type {
	ConversationHandle,
	ConversationId,
	Cursor,
	EntryId,
	EntryRecord,
	ModelRef,
	SettledSubmissionRecord,
	Submission,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
	Tx,
} from "@earendil-works/pi-durable";
import { authorizeTask, type AuthorizedCapabilities, type TaskAuthorizationPolicy } from "../builder/authorization.ts";
import { createSubAgent } from "../builder/create-subagent.ts";
import { AgentTaskResultDoc, AgentTaskSpecDoc } from "../contracts/documents.ts";
import type { RunConfig } from "../contracts/run-config.ts";
import type { ModelWork, PersistedEntryIndex, ResultEvidenceReference, RuntimeOutcome, TaskResult } from "../contracts/task-result.ts";
import { assembleTaskResult } from "../contracts/task-result.ts";
import { validateTaskSpec, type TaskSpec } from "../contracts/task-spec.ts";
import { ContractViolationError, type ContractValidation, type ContractViolation } from "../contracts/errors.ts";
import { completeSubmission } from "../state/finish.ts";
import { decideRoundFailure, isLegalBusinessTransition, type NewBusinessStatus, type RoundStatus } from "../state/lifecycle.ts";
import { extractRoundEvidence, type EntryScanner } from "../../multiagent/evidence.ts";
import {
	recordTransition,
	releaseRound,
	roundRequestId,
	TaskLedgerDoc,
	type EvidenceReference,
	type RoundRecord,
	type TaskLedgerState,
} from "../../multiagent/ledger.ts";
import { admitOne, dequeue, releaseSlot, type AdmissionInput } from "./admission.ts";
import { childQuotaExtension } from "./child.ts";
import {
	attemptKeyOf,
	attemptRequestId,
	batchIdOf,
	operationIdOf,
	resultIdOf,
	roundCallKey,
	type AttemptKey,
	type BatchId,
	type OperationId,
	type RefusalCode,
} from "./contracts.ts";
import {
	AgentBatchDoc,
	AgentQuotaDoc,
	AgentRoundBindingDoc,
	SchedulerDoc,
	type BatchCancelIntent,
	type BatchFailureKind,
	type BatchItemReceipt,
	type BatchState,
	type OperationSpend,
	type RequestQuotaState,
	type RoundSpend,
} from "./documents.ts";
import { consumeOnce, operationSpendOf, QuotaRefusal, reconcileRoundFromEntries } from "./quota.ts";
import { deriveResourceClaim, effectiveRoundBudget } from "./resources.ts";
import {
	executionFor,
	moveRound,
	openAttempt,
	settleAttempt,
	settleRoundRecord,
	setRoundEntryFloor,
	type AttemptSettlement,
} from "./round.ts";
import { buildSubAgentConfig, type SubAgentConfig } from "../builder/subagent-config.ts";

/** The nested tool's name. Registered for `tools` callers only: the model never sees it. */
export const AGENT_TASK_ROUND_TOOL = "agent_task_round";

/**
 * How long a waiting item waits before it asks for capacity again.
 *
 * A scheduling detail, not a budget: the wait is bounded by the round's deadline,
 * never by this. It is deliberately not tiny — an item that is waiting writes
 * nothing, but it does run a commit per poll, and 20ms polls against a durable
 * store buy nothing over a quarter second.
 */
const DEFAULT_ADMISSION_POLL_MS = 250;

/** Safety rail on the evidence scan. A round with more pages than this fails loudly. */
const MAX_ENTRY_PAGES = 200;

/** One page of a direct entry scan. The page size is the store's, not the round's. */
const ENTRY_PAGE = 200;

/** What one item's tool call reports. The durable receipt is the authority; this is its echo. */
export type ItemToolOutput = {
	readonly taskId: string;
	readonly round: number;
	readonly status: "completed" | "failed" | "cancelled" | "queued" | "refused";
	readonly resultId?: string;
	readonly detail?: string;
};

/**
 * Everything the item tool needs from the process that built it.
 *
 * Injected rather than read from a module-global so a test can pin the clock and
 * the wait, and so the tool cannot reach a harness, a registry or an application
 * setting it was not handed.
 */
export type ItemDependencies = {
	readonly mainConversationId: ConversationId;
	readonly model: ModelRef;
	/** The finite run limits in force. Copied into the round's binding, never referenced. */
	readonly runConfig: RunConfig;
	readonly toolPolicy: TaskAuthorizationPolicy;
	/** Revision of the behaviour contract; recorded in the configuration snapshot. */
	readonly contractRevision: number;
	readonly now: () => number;
	/** Overridable for a deterministic test; real time otherwise. */
	readonly wait?: (ms: number) => Promise<void>;
	readonly admissionPollMs?: number;
};

/** The program-supplied arguments of one item. Validated against the tool's schema before `execute`. */
type RoundInput = {
	readonly batchId: BatchId;
	readonly taskId: string;
	readonly round: number;
	readonly mode: "initial" | "rework";
	readonly feedback?: string;
};

/**
 * Which attempt of the round this is.
 *
 * One number, used for all three of the attempt's identities — see the module
 * header. It is read from the persisted attempt list, so a resumed item
 * recomputes the same one and reuses the submission it already made.
 */
type AttemptIdentity = {
	readonly attemptNo: number;
	readonly attemptKey: AttemptKey;
	readonly requestId: string;
};

/**
 * The number of the next attempt of one round.
 *
 * Derived from the persisted attempt list rather than counted in memory, which is
 * what makes a resume safe: a crash mid-attempt leaves an attempt record with no
 * `settledAt`, so the resumed process recomputes the same number and reuses the
 * submission it already made instead of starting a second one. Only this round's
 * attempts count, because `openAttempt` numbers them within the round; an earlier
 * round's attempts belong to that round.
 *
 * @param rounds - the ledger's round records, in document order.
 * @param round - the round the next attempt belongs to.
 * @returns the next attempt's in-round number (1-based).
 */
export function nextAttemptNo(rounds: readonly RoundRecord[], round: number): number {
	const record = rounds.find((entry) => entry.round === round);
	return (record?.execution?.attempts.length ?? 0) + 1;
}

/**
 * The batch id carried by a tool argument.
 *
 * Re-derived through `batchIdOf` rather than asserted, so the argument's shape is
 * checked here instead of trusted: the tool's schema can only say "a string", and
 * a batch id is `batch:<dispatch operation key>`.
 */
function batchIdArg(value: string): BatchId {
	const prefix = "batch:";
	if (!value.startsWith(prefix)) throw new Error(`not a batch id: ${JSON.stringify(value)}`);
	return batchIdOf(value.slice(prefix.length));
}

/** The descriptor the item tool installs. Registered by the runtime extension, reachable only through `executeTool`. */
export function createAgentTaskRoundTool(dependencies: ItemDependencies): ToolRegistration {
	return defineTool({
		name: AGENT_TASK_ROUND_TOOL,
		description: "internal: run one admitted round of one business task",
		parameters: Type.Object({
			batchId: Type.String({ description: "The batch this item belongs to." }),
			taskId: Type.String({ description: "The business task to run." }),
			round: Type.Number({ description: "The 1-based round to run." }),
			mode: Type.Union([Type.Literal("initial"), Type.Literal("rework")]),
			feedback: Type.Optional(Type.String({ description: "The reviewer's rejection text, for a rework." })),
		}),
		// `callers: ["tools"]` is load-bearing: the harness resolves `agent.tools`
		// from `callableBy("model")`, so the child's model is never offered this
		// tool, while `executeTool` still reaches it.
		callers: ["tools"],
		// Load-bearing in the other direction: `executeTool` passes
		// `abandonOnRestart: !(tool.replay === "safe")`, so a crash leaves the item
		// task resumable instead of abandoned mid-round.
		replay: "safe",
		structuredOutputSchema: Type.Object({
			taskId: Type.String(),
			round: Type.Number(),
			status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("queued"), Type.Literal("refused")]),
			resultId: Type.Optional(Type.String()),
			detail: Type.Optional(Type.String()),
		}),
		execute: async (args, api, context) => {
			if (!Number.isInteger(args.round) || args.round < 1) {
				throw new Error(`round must be a positive integer, got ${String(args.round)}`);
			}
			return await runItemRound(
				dependencies,
				{
					batchId: batchIdArg(args.batchId),
					taskId: args.taskId,
					round: args.round,
					mode: args.mode,
					...(args.feedback === undefined ? {} : { feedback: args.feedback }),
				},
				api,
				context,
			);
		},
	});
}

/**
 * Run one item until it has a receipt.
 *
 * The loop exists for two reasons and no others: an item that is deferred for
 * capacity asks again, and an item whose round failed on a retryable budget opens
 * another attempt. Both are bounded, and neither bound is a counter in this
 * function: capacity is bounded by the round's deadline, and retries are bounded
 * by the charge itself — every `retry` outcome is paid for before it is returned,
 * so a round that cannot pay gets a receipt instead of another pass.
 *
 * A run of this loop always ends in a receipt: `gateRound` returns one for every
 * refusal and for every replay, and `runAttempt` returns one for every settled
 * submission.
 */
async function runItemRound(
	dependencies: ItemDependencies,
	input: RoundInput,
	api: ToolExecutionApi,
	context: Context,
): Promise<ToolExecutionResult> {
	const operationId = operationIdOf(input.taskId);
	const opKey = roundCallKey(input.taskId, input.round);
	// The item's own wait for capacity is bounded by the run's per-round timeout,
	// counted from this first pass. The alternative — waiting forever — would let a
	// batch hold every one of its members open behind a slot that never frees.
	const queueDeadline = dependencies.now() + dependencies.runConfig.roundTimeoutMs;
	let pending: PendingCharge | undefined;

	for (;;) {
		const gate = await api.commit(
			async (tx) => await gateRound(tx, dependencies, api, input, opKey, operationId, pending),
			context,
		);
		if (gate.kind === "done") return toolResult(gate.output);
		if (gate.kind === "queued") {
			// Capacity, not a retry: the item asks again until its queue deadline.
			// Nothing has been spent on this pass, so giving up here costs a receipt
			// and no budget.
			if (dependencies.now() >= queueDeadline) {
				return toolResult(
					await settleFailure(dependencies, api, context, input, opKey, operationId, {
						detail: `round ${input.round} waited for capacity until its deadline and was never admitted`,
						failureKind: "technical",
						requiresMainDecision: true,
					}),
				);
			}
			await (dependencies.wait ?? sleep)(dependencies.admissionPollMs ?? DEFAULT_ADMISSION_POLL_MS);
			continue;
		}
		pending = undefined;

		const outcome = await runAttempt(dependencies, api, context, input, opKey, operationId, gate);
		if (outcome.kind === "retry") {
			pending = outcome.pending;
			// Wait before asking again, inside this task and before the next gate: the
			// backoff belongs to the failure that caused it, and a retry that starts
			// immediately is a busy loop against a provider that just refused.
			if (pending.backoffMs > 0) await (dependencies.wait ?? sleep)(pending.backoffMs);
			continue;
		}
		return toolResult(outcome.output);
	}
}

// ── The gate: admission and the next attempt, in one commit ──────────────────
//
// Admission, the quota reservations that pay for it, the ledger's claim, the slot
// and the attempt record are written together or not at all. A crash therefore
// cannot leave a slot without a right, a reservation without a round, or a round
// with no record of the attempt it is about to submit.

/**
 * A retry this item has decided and not yet paid for. The charge lands with the
 * attempt it opens, so the reservation and the work it pays for are one commit.
 */
type PendingCharge = {
	readonly kind: "technical_restart" | "provider_retry";
	/** How long to wait before asking again. Zero for a restart; the provider policy for a retry. */
	readonly backoffMs: number;
};

type Gate =
	| {
			readonly kind: "ready";
			readonly attempt: AttemptIdentity;
			readonly config: SubAgentConfig;
			readonly submission: string;
			/** The round's absolute deadline, read from its persisted execution record. */
			readonly deadlineAt: number;
	  }
	| { readonly kind: "queued" }
	| { readonly kind: "done"; readonly output: ItemToolOutput };

/**
 * Decide whether this item may run now, and set up the attempt it will run.
 *
 * Every read is through the caller's `tx`, so the decision and the writes it
 * authorizes are one atomic unit. The refusals run in the order that spends the
 * least: what the batch already knows, then the saved contract, then the grant,
 * then the budget — and nothing is written before `admitOne`, which is the only
 * function here that reserves anything.
 */
async function gateRound(
	tx: Tx,
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	input: RoundInput,
	opKey: string,
	operationId: string,
	pending: PendingCharge | undefined,
): Promise<Gate> {
	const { batchId, taskId, round } = input;
	const now = dependencies.now();
	const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, batchId, { batchId });
	const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, taskId, { taskId, model: dependencies.model });

	const item = batch.items.find((entry) => entry.taskId === taskId);
	if (item === undefined) {
		return refused(taskId, round, "task_not_in_batch", `task ${taskId} is not a member of batch ${batchId}`);
	}
	// The receipt is the replay anchor: a round that already settled is answered
	// from storage, and nothing below it runs. A receipt for an *earlier* round is
	// not this round's answer — it is what a rework starts from — so the check
	// compares rounds rather than presence.
	if (item.receipt !== undefined && item.receipt.round >= round) return { kind: "done", output: receiptOutput(item.receipt) };

	// Read before any decision that settles, not where it is first needed: a stop
	// intent and a `cancel_pending` refusal both settle this round, and the counters
	// they record are read from here.
	const quota = await tx.doc(AgentQuotaDoc, dependencies.mainConversationId, batch.requestId, { requestId: batch.requestId });
	if (batch.cancel !== undefined) {
		// A stop settles the item here instead of merely answering it. This task is
		// the only thing alive that can write this round's receipt, and an answer
		// without a receipt would leave the batch unable to tell "stopped" from
		// "never started" — so a parent that reopens the batch would wait for it
		// forever. What a stop *means* is `stopFailure`'s call, not this branch's.
		return {
			kind: "done",
			output: await settleFailureIn(tx, dependencies, input, opKey, operationId, ledger, batch, quota, stopFailure(batch.cancel)),
		};
	}

	// The saved contract, not the dispatching call's text: that is the whole point
	// of `AgentTaskSpecDoc`, and a replay must execute the body the first attempt
	// was authorized against.
	const specDoc = await tx.doc(AgentTaskSpecDoc, dependencies.mainConversationId, taskId, { taskId });
	if (specDoc.spec === undefined) return refused(taskId, round, "saved_spec_invalid", `task ${taskId} has no saved contract`);
	const validated = validateTaskSpec(specDoc.spec);
	if (!validated.ok) return refused(taskId, round, "saved_spec_invalid", `the saved contract of ${taskId} is invalid: ${summarize(validated.violations)}`);
	if (validated.value.id !== taskId) {
		return refused(taskId, round, "saved_spec_invalid", `the saved contract names task ${validated.value.id}, not ${taskId}`);
	}
	const spec = validated.value;
	const authorized = authorizeTask(spec, dependencies.toolPolicy);
	if (!authorized.ok) return refused(taskId, round, "authorization_refused", summarize(authorized.violations));
	const capabilities = authorized.value;

	// The child's configuration is built here rather than in `runAttempt`, so a
	// contract violation is a refusal that spends nothing, and so the one commit
	// that admits the round is also the one that proves the round is runnable.
	const config = buildConfig(dependencies, spec, capabilities, specDoc.planVersion, specDoc.requestVersion, specDoc.specVersion);
	if (config === undefined) {
		return refused(taskId, round, "config_incompatible", `the child configuration of task ${taskId} cannot be assembled from its grant`);
	}
	const submission = input.feedback === undefined ? config.submission : reworkSubmission(config.submission, input.feedback);

	const operation = operationSpendOf(quota, operationId, taskId);
	const attemptNo = nextAttemptNo(ledger.rounds, round);
	const admission: AdmissionInput = {
		mainConversationId: dependencies.mainConversationId,
		model: dependencies.model,
		batchId,
		requestId: batch.requestId,
		taskId,
		operationId,
		round,
		attemptKey: attemptKeyOf(taskId, round, attemptNo),
		opKey,
		durableTaskId: api.taskId,
		// The round's canonical submission id is its *first* attempt's, which is the
		// legacy `multiagent-round:<taskId>:<round>` form: a round that began under
		// TASK-003 and resumes here must resolve to the same submission.
		requestIdOfRound: roundRequestId(taskId, round),
		roundKind: input.mode === "rework" ? "revise" : "delegate",
		taskText: submission,
		...(input.feedback === undefined ? {} : { feedback: input.feedback }),
		claim: deriveResourceClaim(capabilities.tools),
		// The deadline counts the task's own timeout from when the task first
		// started, so a rework cannot buy a fresh full timeout. A ledger with no
		// dispatcher record yet uses the batch's creation time, which is the only
		// start this item can be said to have.
		limits: effectiveRoundBudget(spec.budget, dependencies.runConfig, ledger.createdAt === 0 ? batch.createdAt : ledger.createdAt, now),
		specHash: specHashOf(spec),
		planVersion: specDoc.planVersion,
		technicalRestarts: operation.technicalRestartsUsed,
		runConfig: dependencies.runConfig,
		now,
	};
	const decision = await admitOne(tx, admission);
	if (decision.kind === "deferred") return { kind: "queued" };
	if (decision.kind === "settled") return { kind: "done", output: receiptOutput(decision.receipt) };
	if (decision.kind === "refused") {
		if (decision.code === "cancel_pending") {
			// The task carries its own cancel intent (Main asked for it, or a stop
			// reached the ledger before the stop reached the batch document). Either
			// way no work will be admitted for it, and the item is settled as
			// cancelled rather than left open.
			return {
				kind: "done",
				output: await settleFailureIn(tx, dependencies, input, opKey, operationId, ledger, batch, quota, {
					detail: decision.detail,
					failureKind: "cancelled",
					roundStatus: "cancelled",
					nextBusiness: "cancelled",
				}),
			};
		}
		return refused(taskId, round, decision.code, decision.detail);
	}

	// Admitted, so the round's execution record now exists.
	const execution = executionFor(ledger, opKey, round);
	const open = execution.attempts.find((entry) => entry.settledAt === undefined);
	if (open !== undefined) {
		// An attempt was opened and never settled: a crash after `openAttempt` and
		// before the settlement. Its submission may already exist in the child
		// conversation, so its ids are reused rather than a second attempt started.
		return {
			kind: "ready",
			attempt: {
				attemptNo: open.attemptNo,
				attemptKey: open.attemptKey as AttemptKey,
				requestId: open.requestId,
			},
			config,
			submission,
			deadlineAt: execution.limits.deadlineAt,
		};
	}

	const attemptKey = attemptKeyOf(taskId, round, attemptNo);
	const requestId = attemptRequestId(taskId, round, attemptNo);
	if (pending !== undefined) {
		// The retry is reserved in the same commit that opens its attempt, keyed by
		// the attempt key it pays for: a replay of this commit presents the same key
		// and is answered without spending a second restart.
		try {
			consumeOnce(quota, operation, `retry:${attemptKey}`, { kind: pending.kind, attemptKey }, dependencies.runConfig);
		} catch (error) {
			if (!(error instanceof QuotaRefusal)) throw error;
			// The retry could not be paid for. The round ends here rather than after a
			// wait: `runAttempt` already returned `retry`, so there is nothing running
			// to wait for, and this commit is the last one that holds the right.
			return {
				kind: "done",
				output: await settleFailureIn(tx, dependencies, input, opKey, operationId, ledger, batch, quota, {
					detail: `${error.code}: ${error.message}`,
					failureKind: "quota",
					requiresMainDecision: true,
				}),
			};
		}
	}
	// A round that was waiting to retry re-enters `running` before the attempt is
	// opened, so the round's status is never a claim about work that has not
	// started.
	moveRound(ledger, opKey, round, "running");
	openAttempt(ledger, opKey, round, { attemptNo, attemptKey, opKey, requestId, startedAt: now });
	return { kind: "ready", attempt: { attemptNo, attemptKey, requestId }, config, submission, deadlineAt: execution.limits.deadlineAt };
}

/**
 * What a batch stop means for the item that observes it.
 *
 * The two kinds are not two flavours of the same thing, and collapsing them would
 * lose the distinction the requirement draws between "stopped" and "broke":
 *
 *   * An **operator cancel** ends the task. The round is `cancelled`, the business
 *     status is terminal, and the receipt is `cancelled` — nothing can revive it.
 *   * A **batch deadline** stops the round only. The task keeps its business status
 *     so Main can decide whether to spend another attempt, the round is `failed`
 *     with `failureKind: technical` (a clock is not a verdict on the work), and
 *     `requiresMainDecision` is set so that decision is actually asked for.
 *
 * The message is deliberately the intent's own reason: a reader of the receipt
 * learns why the run stopped, not merely that something did.
 */
function stopFailure(intent: BatchCancelIntent): FailureInput {
	if (intent.kind === "deadline") {
		return {
			detail: `batch deadline reached (${intent.reason})`,
			failureKind: "technical",
			roundStatus: "failed",
			requiresMainDecision: true,
		};
	}
	return {
		detail: `batch cancelled (${intent.reason})`,
		failureKind: "cancelled",
		roundStatus: "cancelled",
		nextBusiness: "cancelled",
	};
}

// ── The attempt: submit, wait, classify ──────────────────────────────────────
type AttemptOutcome =
	| { readonly kind: "retry"; readonly pending: PendingCharge }
	| { readonly kind: "done"; readonly output: ItemToolOutput };

async function runAttempt(
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	context: Context,
	input: RoundInput,
	opKey: string,
	operationId: string,
	gate: Extract<Gate, { kind: "ready" }>,
): Promise<AttemptOutcome> {
	const created = await createSubAgent(api, context, gate.config, { taskId: input.taskId, opKey });
	if (!created.ok) {
		return {
			kind: "done",
			output: await settleFailure(dependencies, api, context, input, opKey, operationId, {
				detail: `${created.failure.code}: ${created.failure.detail}`,
				failureKind: "technical",
				requiresMainDecision: true,
			}),
		};
	}
	const childConversationId = created.conversationId;

	// The binding is what the child's tool wrapper reads to know which round it is
	// inside. It is written before the submission, so a call can never run under a
	// binding that belongs to a different round, and it carries the limits as
	// copies: the wrapper runs in the child and can read nothing else.
	await api.commit(
		async (tx) => {
			const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, input.taskId, {
				taskId: input.taskId,
				model: dependencies.model,
			});
			const execution = executionFor(ledger, opKey, input.round);
			const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, input.batchId, { batchId: input.batchId });
			// The newest entry *before* this attempt submits. Reconciliation scans from
			// here, so the refusals of an earlier attempt of this round are still
			// charged to the round (the floor is written once, by the first attempt)
			// while a previous round's are not.
			const newest = await tx.scanEntries({ conversationId: childConversationId, order: "descending" }, 1);
			const head = newest.items[0]?.id;
			if (head !== undefined) setRoundEntryFloor(ledger, opKey, input.round, head);
			const binding = await tx.doc(AgentRoundBindingDoc, childConversationId);
			binding.mainConversationId = dependencies.mainConversationId;
			binding.requestId = batch.requestId;
			binding.operationId = execution.operationId as typeof binding.operationId;
			binding.taskId = input.taskId;
			binding.round = input.round;
			binding.attemptNo = gate.attempt.attemptNo;
			binding.attemptKey = gate.attempt.attemptKey;
			binding.budget = execution.limits;
			// The stop intent belongs to the *previous* attempt. Clearing it is what
			// lets a retry run business calls again.
			binding.stop = undefined;
			binding.startEntryId = head;
		},
		context,
	);

	const handle = await api.conversation(childConversationId, context);
	if (handle === undefined) {
		return {
			kind: "done",
			output: await settleFailure(dependencies, api, context, input, opKey, operationId, {
				detail: `child conversation ${childConversationId} is not available`,
				failureKind: "technical",
				requiresMainDecision: true,
			}),
		};
	}

	let settled: Awaited<ReturnType<typeof waitForSettlement>>;
	try {
		// `whenBusy: "reject"` rather than a queue: a round that starts while the
		// previous one still runs would share one transcript with work that is about
		// to be aborted, and the abort would then have no unambiguous owner.
		const pendingSubmission = await handle.submit(
			{ type: "input", content: gate.submission, requestId: gate.attempt.requestId, whenBusy: "reject" },
			context,
		);
		settled = await waitForSettlement(dependencies, api, context, childConversationId, handle, pendingSubmission, gate.deadlineAt);
	} catch (error) {
		return {
			kind: "done",
			output: await settleFailure(dependencies, api, context, input, opKey, operationId, {
				detail: `submitting round ${input.round} failed: ${(error as Error).message}`,
				failureKind: "technical",
				requiresMainDecision: true,
			}),
		};
	}

	if (settled.kind === "timeout") {
		return await classifyFailure(dependencies, api, context, input, opKey, operationId, gate.attempt, {
			reason: "deadline_exceeded",
			detail: `round ${input.round} passed its deadline while the child was running; the child was aborted and joined before this was written`,
			retryable: false,
		});
	}
	const meaning = submissionMeaning(settled.record);
	if (meaning.kind === "answered") {
		return {
			kind: "done",
			output: await settleCompleted(dependencies, api, context, input, opKey, operationId, gate.attempt, meaning.answer),
		};
	}
	return await classifyFailure(dependencies, api, context, input, opKey, operationId, gate.attempt, {
		reason: meaning.reason,
		detail: meaning.detail,
		retryable: meaning.retryable,
	});
}

/** What a settled submission means, once its `type` and `status` are narrowed. */
type SubmissionMeaning =
	| { readonly kind: "answered"; readonly entry: EntryId; readonly answer: EntryId }
	| { readonly kind: "unanswered"; readonly reason: string; readonly detail: string; readonly retryable: boolean };

/**
 * Read a settled submission as either an answer or a reported failure.
 *
 * The read is a narrowing, not a shape guess: `wait` resolves only on a terminal
 * record, and only `type: "input"` submissions are ours, so a record of another
 * kind is not a case to interpret but a bug to report.
 */
function submissionMeaning(record: SettledSubmissionRecord): SubmissionMeaning {
	if (record.type !== "input") {
		return { kind: "unanswered", reason: "submission_type_mismatch", detail: `the submission settled as a ${record.type} submission`, retryable: false };
	}
	if (record.status === "done") return { kind: "answered", entry: record.entry, answer: record.answer };
	return {
		kind: "unanswered",
		reason: record.reason,
		detail: typeof record.detail === "string" ? record.detail : `the submission settled unanswered (${record.reason})`,
		// A provider-side failure is the only reason a *new* attempt is the right
		// remedy; the classifier still has to find the persisted assistant message
		// to confirm it, which `classifyFailure` does. The other reasons Durable
		// settles with — `aborted`, `faulted`, `no_model`, `reset`, `stale` — are not
		// the provider being flaky, and retrying them on a provider allowance would
		// spend the wrong budget.
		retryable: record.reason === "model_error",
	};
}

/**
 * Wait for the submission, bounded by the round's deadline.
 *
 * On expiry the child is stopped *and joined* before this returns: a round is
 * never reported stopped while its child task is still running, and the stop
 * intent is persisted first so a business call that is already in flight sees it
 * and refuses rather than racing the abort.
 */
async function waitForSettlement(
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	context: Context,
	childConversationId: ConversationId,
	handle: ConversationHandle,
	submission: Submission,
	deadlineAt: number,
): Promise<{ readonly kind: "settled"; readonly record: SettledSubmissionRecord } | { readonly kind: "timeout" }> {
	// Started before the deadline is measured, so the wait is joined even when the
	// deadline has already passed: the submission is admitted by then, and leaving
	// it unwatched would make the abort's outcome unobservable.
	const waited = submission.wait(context).then((record) => ({ kind: "settled" as const, record }));
	const remaining = deadlineAt - dependencies.now();
	if (remaining <= 0) {
		await stopChild(dependencies, api, context, childConversationId, handle, submission, waited);
		return { kind: "timeout" };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<{ readonly kind: "timeout" }>((resolve) => {
		timer = setTimeout(() => resolve({ kind: "timeout" as const }), remaining);
	});
	try {
		const outcome = await Promise.race([waited, expiry]);
		if (outcome.kind === "timeout") {
			await stopChild(dependencies, api, context, childConversationId, handle, submission, waited);
			return { kind: "timeout" };
		}
		return outcome;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Persist the deadline stop intent, then abort and join the child. */
async function stopChild(
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	context: Context,
	childConversationId: ConversationId,
	handle: ConversationHandle,
	submission: Submission,
	waited: Promise<unknown>,
): Promise<void> {
	// The intent is written before the abort, not after: a tool call admitted in
	// the window between the abort signal and the join reads this and refuses,
	// which is the difference between a stopped round and a round that happened to
	// be stopped in time.
	await api
		.commit(async (tx) => {
			const binding = await tx.doc(AgentRoundBindingDoc, childConversationId);
			binding.stop = { kind: "deadline", at: dependencies.now() };
		}, context)
		.catch(() => undefined);
	await submission.abort(context).catch(() => undefined);
	await handle.abort(context).catch(() => undefined);
	await waited.catch(() => undefined);
}

// ── Classification ───────────────────────────────────────────────────────────
//
// One place decides what a non-answer means, because the three failure layers
// meet here: a retryable provider error is the provider layer, an exhausted round
// is the runtime layer, and what survives both is Main's to decide.

/**
 * Decide what a round that produced no answer does, and write it.
 *
 * The three failure layers meet here, so the order is the whole argument:
 *
 *   1. **The provider.** A retryable assistant error is retried, bounded by
 *      `providerRetry.maxRetries`, and only ever decided from the persisted
 *      assistant message. A text match on `detail` would retry a permanent 400
 *      whose prose happens to mention "rate".
 *   2. **The round's deadline.** Never retried, and deliberately before the shared
 *      table: the deadline is written into the round's execution record and read
 *      from there by every attempt, so a retry would inherit a deadline that has
 *      already passed and time out again at once. The table cannot see that,
 *      because the budget it consults is about restarts, not about time.
 *   3. **The shared table**, `decideRoundFailure`, for everything else.
 *
 * Everything is written at the end. There is no pre-write of the failed attempt
 * because the commit is atomic: a crash here leaves the attempt open, and a
 * replay derives the same attempt number, reuses the same submission id and
 * reaches the same decision. An attempt left open on purpose would be worse than
 * useless — `gateRound` treats an open attempt as one to resume, so leaving a
 * *failed* attempt open would resume it forever.
 */
async function classifyFailure(
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	context: Context,
	input: RoundInput,
	opKey: string,
	operationId: string,
	attempt: AttemptIdentity,
	failure: { readonly reason: string; readonly detail: string; readonly retryable: boolean },
): Promise<AttemptOutcome> {
	const error = `${failure.reason}: ${failure.detail}`;
	const cancelled = failure.reason === "aborted";
	return await api.commit(
		async (tx) => {
			const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, input.batchId, { batchId: input.batchId });
			const settled = batch.items.find((entry) => entry.taskId === input.taskId)?.receipt;
			// Only a receipt for this round or a later one is this settlement's answer;
			// an earlier round's receipt belongs to the round this one reworks.
			if (settled !== undefined && settled.round >= input.round) return { kind: "done" as const, output: receiptOutput(settled) };
			const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, input.taskId, { taskId: input.taskId, model: dependencies.model });
			const quota = await tx.doc(AgentQuotaDoc, dependencies.mainConversationId, batch.requestId, { requestId: batch.requestId });
			const operation = operationSpendOf(quota, operationId, input.taskId);
			const execution = executionFor(ledger, opKey, input.round);
			const childConversationId = ledger.childConversationId;
			const entries = await readRound(tx, childConversationId, execution);

			// A retry is written as `retry_wait` and settles the failed attempt in the
			// same commit, so the next attempt starts from a round whose attempts are
			// all closed and whose status says what is about to happen.
			const retry = async (charge: PendingCharge): Promise<AttemptOutcome> => {
				settleAttempt(ledger, opKey, input.round, attempt.attemptNo, { settledAt: dependencies.now(), error });
				moveRound(ledger, opKey, input.round, "retry_wait");
				const nextNo = nextAttemptNo(ledger.rounds, input.round);
				const key = attemptKeyOf(input.taskId, input.round, nextNo);
				consumeOnce(quota, operation, `retry:${key}`, { kind: charge.kind, attemptKey: key }, dependencies.runConfig);
				return { kind: "retry" as const, pending: charge };
			};
			const failed = async (settlement: FailureInput): Promise<AttemptOutcome> => ({
				kind: "done" as const,
				output: await settleFailureIn(tx, dependencies, input, opKey, operationId, ledger, batch, quota, {
					...settlement,
					attempt: { attemptNo: attempt.attemptNo, error },
				}),
			});

			if (failure.retryable && retryableAssistant(entries)) {
				try {
					return await retry({ kind: "provider_retry", backoffMs: dependencies.runConfig.providerRetry.backoffMs });
				} catch (quotaError) {
					if (!(quotaError instanceof QuotaRefusal)) throw quotaError;
					return await failed({ detail: `${error}; ${quotaError.message}`, failureKind: "quota", requiresMainDecision: true });
				}
			}

			if (failure.reason === "deadline_exceeded") {
				return await failed({
					detail: `${error}; a round past its deadline is not retried, because every attempt of the round reads the same persisted deadline`,
					failureKind: "technical",
					roundStatus: "failed",
					requiresMainDecision: true,
				});
			}

			const decision = decideRoundFailure({
				businessStatus: ledger.status,
				failureKind: cancelled ? "cancelled" : "technical",
				technicalRestartsUsed: operation.technicalRestartsUsed,
				attemptsUsed: operation.attemptsUsed,
				budget: {
					maxTechnicalRestarts: dependencies.runConfig.maxTechnicalRestarts,
					maxAttemptsPerOperation: dependencies.runConfig.maxAttemptsPerOperation,
				},
			});
			if (decision.roundStatus === "retry_wait") {
				try {
					return await retry({ kind: "technical_restart", backoffMs: 0 });
				} catch (quotaError) {
					if (!(quotaError instanceof QuotaRefusal)) throw quotaError;
					// The restart allowance is gone, so the retry the table asked for cannot
					// be paid for. That is the same terminal state as the table's own
					// exhaustion, and it is written as one.
					return await failed({ detail: `${error}; ${quotaError.message}`, failureKind: "quota", requiresMainDecision: true });
				}
			}
			return await failed({
				detail: error,
				roundStatus: decision.roundStatus,
				...(decision.nextBusinessStatus === undefined ? {} : { nextBusiness: decision.nextBusinessStatus }),
				failureKind: decision.roundStatus === "cancelled" ? "cancelled" : "technical",
				...(decision.requiresMainDecision === undefined ? {} : { requiresMainDecision: decision.requiresMainDecision }),
			});
		},
		context,
	);
}

// ── Settlement ───────────────────────────────────────────────────────────────
//
// One commit writes everything a settled round owns: the result document, the
// ledger's round facts and business transition, the reconciled quota counters,
// the batch receipt and the released slot. A reader that sees one of them sees
// all of them, so "did this round settle" has one answer.

async function settleCompleted(
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	context: Context,
	input: RoundInput,
	opKey: string,
	operationId: string,
	attempt: AttemptIdentity,
	answer: EntryId,
): Promise<ItemToolOutput> {
	return await api.commit(
		async (tx) => {
			const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, input.batchId, { batchId: input.batchId });
			const settledReceipt = batch.items.find((entry) => entry.taskId === input.taskId)?.receipt;
			// A rework's settlement must not be swallowed by the receipt of the round it
			// reworks, so the receipt answers only for its own round and later ones.
			if (settledReceipt !== undefined && settledReceipt.round >= input.round) return receiptOutput(settledReceipt);
			const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, input.taskId, { taskId: input.taskId, model: dependencies.model });
			const quota = await tx.doc(AgentQuotaDoc, dependencies.mainConversationId, batch.requestId, { requestId: batch.requestId });
			const childConversationId = ledger.childConversationId;
			if (childConversationId === undefined) {
				return await settleFailureIn(tx, dependencies, input, opKey, operationId, ledger, batch, quota, {
					detail: "the child conversation pointer is missing, so the answer cannot be attributed",
					failureKind: "technical",
					requiresMainDecision: true,
				});
			}
			const execution = executionFor(ledger, opKey, input.round);
			const entries = await readEntries(tx, childConversationId, execution, answer);
			const extraction = await extractRoundEvidence(scannerOver(entries), {
				conversationId: childConversationId,
				...(execution.startEntryId === undefined ? {} : { minEntryId: execution.startEntryId }),
				maxEntryId: answer,
				answerEntryId: answer,
			});
			const known = new Map<string, PersistedEntryIndex>();
			for (const entry of entries) known.set(String(entry.id), indexOf(entry, childConversationId));
			const roundDurableTaskIds = uniqueTaskIds(entries);
			const references = extraction.evidence.map((reference) => referenceOf(reference, input.taskId));

			// The completion rule is `src/agent/state/finish.ts` verbatim: settled
			// first, then the answer validated. A round whose model text is not the
			// work contract is a *quality* failure — the run worked, the work did not —
			// and it still goes to review, because the raw answer is what Main reads.
			const completed = completeSubmission({ settlement: { status: "done" }, answerEntryId: String(answer), answerText: extraction.answerText });
			const work = completed.ok ? completed.value.work : programWork(`the final answer of round ${input.round} was refused: ${summarize(completed.violations)}`);
			return await writeSettlement(tx, dependencies, {
				input,
				opKey,
				operationId,
				ledger,
				batch,
				quota,
				attemptNo: attempt.attemptNo,
				attemptSettlement: {
					answerEntryId: String(answer),
					answerText: extraction.answerText,
					evidence: references.map((reference) => reference.entryId),
					settledAt: dependencies.now(),
				},
				roundStatus: "completed",
				// A round that ran is a round to review, whatever the payload said. A
				// quality refusal is not a verdict — review is the mechanism for that.
				nextBusiness: "awaiting_review",
				// A refused answer is the round's outcome, not a runtime failure: the run
				// worked, the model's payload did not satisfy the work contract, and what
				// Main reviews is the raw answer the ledger kept.
				outcome: completed.ok
					? { status: "completed" }
					: { status: "failed", failureKind: "quality", detail: summarize(completed.violations) },
				answer: { entryId: answer, text: extraction.answerText, evidence: extraction.evidence },
				work,
				references,
				known,
				roundDurableTaskIds,
			});
		},
		context,
	);
}

/**
 * Settle a failed round in a transaction of its own.
 *
 * A wrapper rather than a second implementation: it reads the documents the
 * settlement needs and hands them to `settleFailureIn`, so a failure that happens
 * outside a commit the caller already holds — a missing child, a refused
 * submit — is written by exactly the same code as a failure discovered inside one.
 */
async function settleFailure(
	dependencies: ItemDependencies,
	api: ToolExecutionApi,
	context: Context,
	input: RoundInput,
	opKey: string,
	operationId: string,
	failure: FailureInput,
): Promise<ItemToolOutput> {
	return await api.commit(
		async (tx) => {
			const batch = await tx.doc(AgentBatchDoc, dependencies.mainConversationId, input.batchId, { batchId: input.batchId });
			const receipt = batch.items.find((entry) => entry.taskId === input.taskId)?.receipt;
			if (receipt !== undefined && receipt.round >= input.round) return receiptOutput(receipt);
			const ledger = await tx.doc(TaskLedgerDoc, dependencies.mainConversationId, input.taskId, { taskId: input.taskId, model: dependencies.model });
			const quota = await tx.doc(AgentQuotaDoc, dependencies.mainConversationId, batch.requestId, { requestId: batch.requestId });
			return await settleFailureIn(tx, dependencies, input, opKey, operationId, ledger, batch, quota, failure);
		},
		context,
	);
}

/** What a round that produced no valid result is recorded as. */
type FailureInput = {
	readonly detail: string;
	readonly failureKind: BatchFailureKind;
	/** Defaults to `failed`: a round with no answer did not complete. */
	readonly roundStatus?: RoundStatus;
	readonly nextBusiness?: NewBusinessStatus;
	readonly requiresMainDecision?: boolean;
	/** The attempt that failed, so the ledger records which one it was and why. */
	readonly attempt?: { readonly attemptNo: number; readonly error: string };
};

/** Settle a failed round inside a transaction the caller already holds. Never throws for a business reason. */
async function settleFailureIn(
	tx: Tx,
	dependencies: ItemDependencies,
	input: RoundInput,
	opKey: string,
	operationId: string,
	ledger: Draft<TaskLedgerState>,
	batch: Draft<BatchState>,
	quota: Draft<RequestQuotaState>,
	failure: FailureInput,
): Promise<ItemToolOutput> {
	const settled = batch.items.find((entry) => entry.taskId === input.taskId)?.receipt;
	if (settled !== undefined && settled.round >= input.round) return receiptOutput(settled);
	const operation = operationSpendOf(quota, operationId, input.taskId);
	const childConversationId = ledger.childConversationId;
	const execution = ledger.rounds.find((entry) => entry.round === input.round)?.execution;
	// Reconciliation needs the round's own entries, and it needs them whether or not
	// the round produced an answer: a refusal Durable settled before `execute` is a
	// failure this round pays for, and the entry is the only record of it.
	const entries = await readRound(tx, childConversationId, execution);
	if (childConversationId !== undefined && execution !== undefined) {
		try {
			reconcileRoundFromEntries(operation, input.round, entries, dependencies.runConfig);
		} catch (error) {
			// The allowance is already gone; the counters are not moved. The round's
			// stop is what the receipt reports, and the refused calls are visible in
			// the entries either way.
			if (!(error instanceof QuotaRefusal)) throw error;
		}
	}
	const known = new Map<string, PersistedEntryIndex>();
	if (childConversationId !== undefined) {
		for (const entry of entries) known.set(String(entry.id), indexOf(entry, childConversationId));
	}
	return await writeSettlement(tx, dependencies, {
		input,
		opKey,
		operationId,
		ledger,
		batch,
		quota,
		...(failure.attempt === undefined
			? { attemptNo: undefined, attemptSettlement: undefined }
			: {
					attemptNo: failure.attempt.attemptNo,
					attemptSettlement: { error: failure.attempt.error, settledAt: dependencies.now() },
				}),
		roundStatus: failure.roundStatus ?? "failed",
		...(failure.nextBusiness === undefined ? {} : { nextBusiness: failure.nextBusiness }),
		// A cancelled round and a failed one are different receipts: one reports that
		// the run was stopped, the other that it broke. Collapsing them would make a
		// cancellation read as a fault. The table's own decision is what says which:
		// a round is cancelled when the round is, or when the business status it was
		// heading for is `cancelled` because the task was.
		outcome: {
			status: failure.roundStatus === "cancelled" || failure.nextBusiness === "cancelled" ? "cancelled" : "failed",
			failureKind: failure.failureKind,
			...(failure.requiresMainDecision === undefined ? {} : { requiresMainDecision: failure.requiresMainDecision }),
			detail: failure.detail,
		},
		work: programWork(failure.detail),
		references: [],
		known,
		roundDurableTaskIds: uniqueTaskIds(entries),
	});
}

/**
 * Everything one settlement writes. Assembled by the caller; recorded by one function.
 *
 * `outcome` is what the receipt and `RuntimeOutcome` say, and it is decided by the
 * caller because only the caller knows why the round stopped. `writeSettlement`
 * overrides it in exactly one case — a settlement that claimed completion and whose
 * result could not be assembled — and the reason is in that function.
 */
type SettlementInput = {
	readonly input: RoundInput;
	readonly opKey: string;
	readonly operationId: string;
	readonly ledger: Draft<TaskLedgerState>;
	readonly batch: Draft<BatchState>;
	readonly quota: Draft<RequestQuotaState>;
	readonly attemptNo: number | undefined;
	readonly attemptSettlement: AttemptSettlement | undefined;
	readonly roundStatus: RoundStatus;
	readonly nextBusiness?: NewBusinessStatus;
	readonly outcome: SettlementOutcome;
	readonly answer?: { readonly entryId: EntryId; readonly text: string; readonly evidence: readonly EvidenceReference[] };
	readonly work: ModelWork;
	readonly references: readonly ResultEvidenceReference[];
	readonly known: ReadonlyMap<string, PersistedEntryIndex>;
	readonly roundDurableTaskIds: readonly string[];
};

/** What a settlement claims about the item, before the result is assembled. */
type SettlementOutcome = {
	readonly status: "completed" | "failed" | "cancelled";
	readonly failureKind?: BatchFailureKind;
	readonly requiresMainDecision?: boolean;
	readonly detail?: string;
};

/**
 * The single writer of a settled round.
 *
 * The order is the contract: assemble first, so a result that cannot be trusted is
 * never written; then the ledger's round facts and its status; then the business
 * status; then the receipt; and the slot last, because settlement is the only
 * event that ends a slot's life and a `retry_wait` deliberately keeps it.
 */
async function writeSettlement(tx: Tx, dependencies: ItemDependencies, settlement: SettlementInput): Promise<ItemToolOutput> {
	const { input, ledger, batch, quota, operationId } = settlement;
	const now = dependencies.now();
	const resultId = resultIdOf(input.taskId, input.round);
	const operation = operationSpendOf(quota, operationId, input.taskId);
	const spend = operation.rounds.find((entry) => entry.round === input.round);
	const attribution = {
		childConversationId: String(ledger.childConversationId ?? dependencies.mainConversationId),
		businessTaskId: input.taskId,
		round: input.round,
		roundDurableTaskIds: settlement.roundDurableTaskIds,
	};
	const assembled = assembleTaskResult({
		resultId,
		runtime: runtimeOutcome(input, operation, spend, settlement.outcome, now),
		work: settlement.work,
		evidence: settlement.references,
		knownEntries: settlement.known,
		attribution,
	});
	// The one case where a settlement's own claim is overruled by its assembly: a
	// round that claimed completion and whose result could not be assembled is a
	// *technical* failure, not a quality one — the model's work contract was valid
	// (an invalid one never reaches completion) and the program could not attribute
	// the evidence it produced. Main is told to decide, because a task whose result
	// document does not exist must not be accepted on the runtime's word.
	const outcome: SettlementOutcome =
		!assembled.ok && settlement.outcome.status === "completed"
			? { status: "failed", failureKind: "technical", requiresMainDecision: true, detail: summarize(assembled.violations) }
			: settlement.outcome;
	// Every settled round gets a result document, not only a completed one. The
	// requirement is explicit — "无finish的异常也有结果" — and the receipt below names
	// this id, so a receipt that pointed at a document which does not exist would be
	// a promise the store cannot keep. What a failed or cancelled round carries is
	// *program* work: one sentence saying what happened, no evidence, no claim that
	// the model produced anything. That is the same shape a completed round with a
	// refused answer already persists, and `assembleTaskResult` validates it exactly
	// as it validates model work.
	//
	// The one result that is *not* written is the overruled case above: there the
	// assembly refused the evidence the round produced, so the program re-assembles
	// the failure on the program's own terms rather than persisting the refused one.
	// If even that cannot be assembled, no document is written and the receipt simply
	// carries no `resultId` — which is the honest state, not a missing write.
	const result: ContractValidation<TaskResult> = assembled.ok
		? assembled
		: assembleTaskResult({
				resultId,
				runtime: runtimeOutcome(input, operation, spend, outcome, now),
				work: programWork(outcome.detail ?? `round ${input.round} settled without a result`),
				evidence: [],
				knownEntries: settlement.known,
				attribution,
			});
	if (result.ok) {
		const document = await tx.doc(AgentTaskResultDoc, dependencies.mainConversationId, resultId, { resultId, taskId: input.taskId });
		// Write-once: a second settlement of the same round finds the result it
		// already wrote and leaves it alone. Rewriting it would let a replay change
		// what a reviewer already read.
		if (document.result === undefined) document.result = result.value;
		document.round = input.round;
	}

	// The round's own facts, through the one writer of a round: the counters, the
	// attempt's receipt, the status move and the answer. `settleRoundRecord`
	// tolerates a released right (the cancel close) and refuses a right held by
	// somebody else, which is the only case that must not be attributed here.
	settleRoundRecord(ledger, settlement.opKey, input.round, {
		status: settlement.roundStatus,
		...(settlement.attemptNo === undefined || settlement.attemptSettlement === undefined
			? {}
			: { attemptNo: settlement.attemptNo, attemptSettlement: settlement.attemptSettlement }),
		toolInvocations: spend?.toolInvocationsUsed ?? 0,
		failedToolCalls: spend?.failedToolCallsUsed ?? 0,
		technicalRestarts: operation.technicalRestartsUsed,
		durableTaskIds: settlement.roundDurableTaskIds,
		...(result.ok ? { resultId } : {}),
		...(settlement.answer === undefined
			? {}
			: {
					answer: {
						entryId: settlement.answer.entryId,
						text: settlement.answer.text,
						evidence: settlement.answer.evidence,
					},
				}),
		at: now,
	});
	applyBusiness(ledger, settlement.nextBusiness, settlement.opKey, input.round, now, outcome.detail);

	// The receipt records the outcome even when no result document could be
	// written: a round whose own settlement could not be assembled at all — the one
	// case above — still gets a receipt, and its missing `resultId` is what says so.
	// "The runtime could not assemble a result" is an outcome, not a missing item.
	const receipt: BatchItemReceipt = {
		taskId: input.taskId,
		operationId: operationId as OperationId,
		round: input.round,
		status: outcome.status,
		...(result.ok ? { resultId } : {}),
		...(outcome.status === "completed" ? {} : { failureKind: outcome.failureKind ?? "technical" }),
		...(outcome.requiresMainDecision === undefined ? {} : { requiresMainDecision: outcome.requiresMainDecision }),
		...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
		settledAt: now,
	};
	const item = batch.items.find((entry) => entry.taskId === input.taskId);
	if (item !== undefined) {
		item.receipt = receipt;
		// Stamped here as well as at admission: an item that a stop settled before it
		// was ever admitted has no admission to record its round from, and the batch
		// document is where the cancel close looks for it.
		if (item.round === undefined) item.round = input.round;
		// The batch is settled once the last item has a receipt. Written here rather
		// than derived by every reader, so "settled" is a fact with one author.
		if (batch.settledAt === undefined && batch.items.every((entry) => entry.receipt !== undefined)) {
			batch.settledAt = now;
		}
	}

	// The slot goes last and only here: settlement is the only event that ends a
	// slot's life, and a `retry_wait` deliberately keeps it.
	const scheduler = await tx.doc(SchedulerDoc);
	releaseSlot(scheduler, settlement.operationId);
	// A queued item that settled without ever being admitted leaves its queue entry
	// behind otherwise. It holds no capacity, but it does hold a *position*: the
	// fairness rule defers an item that ranks behind it, so a settled entry would
	// starve everything behind it forever.
	dequeue(scheduler, settlement.operationId);

	return receiptOutput(receipt);
}

/** The runtime-owned half of a result, built from an outcome. */
function runtimeOutcome(
	input: RoundInput,
	operation: OperationSpend,
	spend: RoundSpend | undefined,
	outcome: SettlementOutcome,
	now: number,
): RuntimeOutcome {
	return {
		taskId: input.taskId,
		round: input.round,
		status: outcome.status,
		...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }),
		attempts: operation.attemptsUsed,
		technicalRestarts: operation.technicalRestartsUsed,
		toolInvocations: spend?.toolInvocationsUsed ?? 0,
		...(outcome.requiresMainDecision === undefined ? {} : { requiresMainDecision: outcome.requiresMainDecision }),
		// "none" is a claim about the world, so it is only made where it can be
		// proved: a completed round's every business call was admitted through the
		// wrapper and counted. Anything else may have side effects nobody recorded.
		sideEffect: outcome.status === "completed" ? ((spend?.toolInvocationsUsed ?? 0) === 0 ? "none" : "recorded") : "unknown",
		settledAt: now,
	};
}

/**
 * Move the ledger's business status, tolerating the cases where no single edge
 * exists.
 *
 * `planned` is the one status a task can be in without ever having run, and the
 * table has no `planned -> awaiting_review` edge — so the run is entered first,
 * which is also what happened. A target that is unreachable even then leaves the
 * right released and nothing else changed: the receipt still records the outcome,
 * and inventing a transition would be a lie about the business state.
 */
function applyBusiness(
	ledger: Draft<TaskLedgerState>,
	target: NewBusinessStatus | undefined,
	opKey: string,
	round: number,
	at: number,
	reason: string | undefined,
): void {
	if (target === undefined) {
		// A round that failed on its technical budget leaves the business status to
		// Main: `failed` is terminal and an infrastructure failure is not a verdict.
		releaseRound(ledger, opKey);
		return;
	}
	if (ledger.status === target) {
		// The status is already where this settlement wants it — the ordinary case for
		// a rework, whose task sits at `awaiting_review` before and after the round. No
		// transition runs, so nothing would release the execution right; without this
		// the settled rework would leave `activeOpKey` held by an operation that is
		// gone, and the task's next round would be refused `execution_right_held`.
		releaseRound(ledger, opKey);
		return;
	}
	const meta = { opKey, round, ...(reason === undefined ? {} : { reason }) };
	if (!isLegalBusinessTransition(ledger.status, target) && isLegalBusinessTransition(ledger.status, "running")) {
		recordTransition(ledger, "running", at, meta);
	}
	if (isLegalBusinessTransition(ledger.status, target)) recordTransition(ledger, target, at, meta);
	else releaseRound(ledger, opKey);
}

/** Read every entry of one round, or `[]` when there is no child conversation. */
async function readRound(
	tx: Tx,
	conversationId: ConversationId | undefined,
	execution: { readonly startEntryId?: EntryId } | undefined,
): Promise<readonly EntryRecord[]> {
	if (conversationId === undefined) return [];
	return await readEntries(tx, conversationId, execution, undefined);
}

/** Read every entry of one round, refusing to return a partial set. */
async function readEntries(
	tx: Tx,
	conversationId: ConversationId,
	execution: { readonly startEntryId?: EntryId } | undefined,
	max: EntryId | undefined,
): Promise<readonly EntryRecord[]> {
	const items: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	for (let pages = 0; pages < MAX_ENTRY_PAGES; pages++) {
		const page = await tx.scanEntries(
			{
				conversationId,
				...(execution?.startEntryId === undefined ? {} : { minEntryId: execution.startEntryId }),
				...(max === undefined ? {} : { maxEntryId: max }),
				order: "ascending",
			},
			ENTRY_PAGE,
			cursor,
		);
		items.push(...page.items);
		if (page.next === undefined) return items;
		cursor = page.next;
	}
	throw new Error(
		`entry scan of conversation ${conversationId} exceeded ${MAX_ENTRY_PAGES} pages; refusing to attribute evidence from a partial read`,
	);
}

/**
 * An `EntryScanner` over entries that were already read.
 *
 * `extractRoundEvidence` takes the scanner interface so it can be driven by `Tx`
 * or by a conversation handle; here the range *is* one round, and it has already
 * been read inside this commit, so paging it twice would only add a second read of
 * the same rows. The adapter answers the first page with all of them and no
 * cursor, which is the end of the scan.
 */
function scannerOver(entries: readonly EntryRecord[]): EntryScanner {
	return { scanEntries: async () => ({ items: entries }) };
}

/** One persisted entry, as the attribution check needs to see it. */
function indexOf(entry: EntryRecord, conversationId: ConversationId): PersistedEntryIndex {
	const result = firstToolResult(entry);
	return {
		entryId: String(entry.id),
		conversationId: String(conversationId),
		...(entry.byTaskId === undefined ? {} : { taskId: String(entry.byTaskId) }),
		kind: entry.kind,
		...(result === undefined || !isStableId(result.toolCallId) ? {} : { toolCallId: result.toolCallId }),
		...(result === undefined || !isStableId(result.toolName) ? {} : { toolName: result.toolName }),
	};
}

/** The tool-call identity of one entry, when it is a tool result. */
function firstToolResult(entry: EntryRecord): { readonly toolCallId: string; readonly toolName: string } | undefined {
	for (const message of entry.model ?? []) {
		if (message.role !== "toolResult") continue;
		return { toolCallId: message.toolCallId, toolName: message.toolName };
	}
	return undefined;
}

/**
 * One ledger evidence reference, as the result contract stores it.
 *
 * `byTaskId` is rewritten rather than copied: the extractor attributes an entry
 * to the *durable* task that produced it (`entry.byTaskId`, e.g. `"43"`), while
 * the result contract asks which *business* task the evidence is for and
 * `verifyEvidenceAttribution` compares it with the business id. Every entry of
 * this round came from this item's own child conversation, so the claim is the
 * item's id, and the durable attribution is verified separately against
 * `roundDurableTaskIds`.
 */
function referenceOf(reference: EvidenceReference, businessTaskId: string): ResultEvidenceReference {
	return {
		entryId: String(reference.entryId),
		kind: reference.kind,
		...(reference.byTaskId === undefined ? {} : { byTaskId: businessTaskId }),
		// The result contract validates these as stable ids. A provider call id that
		// would not survive that check is left out rather than repaired: an
		// unverifiable claim is worse than an absent one.
		...(reference.toolCallId === undefined || !isStableId(reference.toolCallId) ? {} : { toolCallId: reference.toolCallId }),
		...(reference.toolName === undefined || !isStableId(reference.toolName) ? {} : { toolName: reference.toolName }),
	};
}

/** Durable task ids that produced this round's entries: the evidence-attribution bridge. */
function uniqueTaskIds(entries: readonly EntryRecord[]): readonly string[] {
	const ids = new Set<string>();
	for (const entry of entries) if (entry.byTaskId !== undefined) ids.add(String(entry.byTaskId));
	return [...ids].sort();
}

/** True when the attempt left a persisted assistant message the retry classifier accepts. */
function retryableAssistant(entries: readonly EntryRecord[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		for (const message of entries[index]?.model ?? []) {
			if (message.role !== "assistant") continue;
			if (message.stopReason === "error" && message.errorMessage !== undefined) return isRetryableAssistantError(message);
		}
	}
	return false;
}

/** The work content of a round that produced no valid submission. */
function programWork(detail: string): ModelWork {
	// Written by the program, not by the model, and labelled as such by the receipt
	// and by `runtime.failureKind`. The alternative — persisting no result — would
	// break `runTaskBatch`'s one-result-per-member contract and lose the reason
	// entirely, which is worse than a field whose provenance the reader can see.
	// `summary` is never empty: `validateModelWork` refuses a blank one, and a
	// refusal here would lose the very reason this exists to carry.
	return { summary: detail, findings: [], unresolved: [detail], artifacts: [] };
}

/** Build the child configuration, or `undefined` when it cannot be assembled. */
function buildConfig(
	dependencies: ItemDependencies,
	spec: TaskSpec,
	capabilities: AuthorizedCapabilities,
	planVersion: number,
	requestVersion: number,
	taskSpecVersion: number,
): SubAgentConfig | undefined {
	const tools = capabilities.tools.map((tool) => tool.registration);
	try {
		return buildSubAgentConfig(spec, {
			capabilities,
			model: dependencies.model,
			runConfig: dependencies.runConfig,
			contractRevision: dependencies.contractRevision,
			requestVersion,
			taskSpecVersion,
			planVersion,
			// The quota gate is not a grant: it wraps the granted tools and adds no
			// tool of its own, so it is part of what the child runs, not part of what
			// the task was authorized to do.
			runtimeExtensions: [childQuotaExtension(tools, dependencies.runConfig)],
		});
	} catch (error) {
		if (error instanceof ContractViolationError) return undefined;
		throw error;
	}
}

/** The rework submission: the task text again, with the reviewer's rejection attached. */
function reworkSubmission(submission: string, feedback: string): string {
	return `${submission}\n\n## Reviewer feedback\nThis is a rework of the same task. The previous round was rejected for the reason below; address it.\n\n${feedback}`;
}

/** A canonical hash of a task contract, so the round records which body it ran. */
function specHashOf(spec: TaskSpec): string {
	return createHash("sha256").update(canonical(spec), "utf8").digest("hex");
}

/** Stable JSON: object keys sorted, so the same contract always hashes the same. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

/** True when a string may be stored as a stable id. */
function isStableId(value: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

/** One line of violation text, never a paragraph. */
function summarize(violations: readonly ContractViolation[]): string {
	return violations.map((item) => `${item.code} at ${item.path}: ${item.detail}`).join("; ");
}

/** An item tool output for a refusal. A refusal settles nothing and spends nothing. */
function refused(taskId: string, round: number, code: RefusalCode, detail: string): Gate {
	return { kind: "done", output: { taskId, round, status: "refused", detail: `${code}: ${detail}` } };
}

/** The tool's structured output for a receipt. */
function receiptOutput(receipt: BatchItemReceipt): ItemToolOutput {
	return {
		taskId: receipt.taskId,
		round: receipt.round,
		status: receipt.status,
		...(receipt.resultId === undefined ? {} : { resultId: receipt.resultId }),
		...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
	};
}

/** The tool's result: the item output is for programs, and no model ever reads this tool. */
function toolResult(output: ItemToolOutput): ToolExecutionResult {
	return { structuredOutput: output };
}

/** The default wait. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
