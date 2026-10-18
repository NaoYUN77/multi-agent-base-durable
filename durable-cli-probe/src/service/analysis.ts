// TASK-005.5 src/service/analysis.ts
//
// The session's one read pass, and the one place a task's status word is decided.
//
// Every field of `TuiSnapshot` is read from a document or from the Main service's
// own reads:
//
//   | view                                | source                                      |
//   |-------------------------------------|---------------------------------------------|
//   | request, questions, plans           | `MainService.readRequest()`                 |
//   | queued inputs                       | `MainService.readQueue()`                   |
//   | whether Main is busy                | `MainService.status()`                      |
//   | open reconciliation                 | `MainService.openReconciliation` (at open)  |
//   | batches, items, receipts, stops     | `readRuntimeTasks` (runtime's documents)    |
//   | business status, rounds, evidence   | `TaskLedgerDoc`                             |
//   | round limits and counters           | `RoundRecord.execution`, `AgentQuotaDoc`    |
//   | task title, acceptance, constraints | `AgentTaskSpecDoc`                          |
//   | outcome summary                     | `AgentTaskResultDoc`                        |
//   | Main's live tasks                   | `harness.inspect()`                         |
//
// All document reads are non-creating `harness.snapshot` calls, so a read pass
// can never change what it reads. `deriveTaskRow` is pure: the table, the detail
// pane and the tests all call the same function, so there is exactly one answer
// to "what is this task doing".

import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { AgentQuotaDoc, type RequestQuotaState } from "../agent/runtime/documents.ts";
import { readRuntimeTasks, type RuntimeTask } from "../agent/runtime/index.ts";
import { resultIdOf } from "../agent/runtime/contracts.ts";
import { isTerminalBusinessStatus, type TaskBusinessStatus } from "../agent/state/lifecycle.ts";
import { AgentTaskResultDoc, AgentTaskSpecDoc } from "../agent/contracts/documents.ts";
import type { RunConfig } from "../agent/contracts/run-config.ts";
import { TaskLedgerDoc, type TaskLedgerState } from "../multiagent/ledger.ts";
import type { MainService } from "./main-service.ts";
import type { TaskDetail, TaskRow, TaskRoundView, TaskRowStatus, TaskStatusSource, TuiSnapshot } from "./types.ts";

export type AnalysisReaderOptions = {
	readonly harness: Harness;
	readonly main: MainService;
	readonly mainConversationId: number;
	readonly context: Context;
	readonly runConfig: RunConfig;
	readonly openReconciliation: TuiSnapshot["openReconciliation"];
};

export type AnalysisReader = {
	/**
	 * One pass.
	 *
	 * @param now - the clock reading stored as `takenAt`.
	 * @param setWatched - receives the documents this pass read; the initial pass
	 *   always resolves watchers for everything the pass depends on, later passes
	 *   only add watchers for keys that are new.
	 */
	readonly snapshot: (now: number, setWatched?: (keys: PassKeys) => void) => Promise<TuiSnapshot>;
	/** One task's detail, or `undefined` when neither a batch nor a ledger knows it. */
	readonly inspectTask: (taskId: string, now: number) => Promise<TaskDetail | undefined>;
};

/** What one pass read, as watch keys. */
export type PassKeys = {
	readonly status: true;
	readonly ledgers: readonly string[];
	readonly specs: readonly string[];
};

function rowWord(status: TaskBusinessStatus): TaskRowStatus {
	return status === "accepted" ? "accepted" : status === "failed" ? "failed" : "cancelled";
}

function isTerminalRow(status: TaskRowStatus): boolean {
	return status === "accepted" || status === "failed" || status === "cancelled";
}

/**
 * The status word of one task, from its runtime facts and its ledger.
 *
 * Precedence, highest first:
 *
 *   1. A ledger business status that is terminal — the document of record.
 *   2. A recorded stop with no terminal ledger status → `stopping`. Cancelled
 *      only when the receipt (or the ledger) proves it.
 *   3. The ledger's business status (`revising` is the legacy word for
 *      `running`).
 *   4. No ledger: the batch receipt, then the runtime's own position (slot,
 *      queue, retry) — the state an item is in before its first settlement.
 *
 * Pure and total: every item yields a row.
 */
export function deriveTaskRow(input: {
	readonly taskId: string;
	readonly batchId: string;
	readonly title: string;
	readonly ledger: Readonly<TaskLedgerState> | undefined;
	readonly task: RuntimeTask | undefined;
	readonly quota: Readonly<RequestQuotaState> | undefined;
}): TaskRow {
	const { ledger, task, quota } = input;
	const item = task?.item;
	const receipt = item?.receipt;
	const execution = ledger?.rounds.find((round) => round.round === ledger.currentRound)?.execution;
	const spend = quota?.operations.find((operation) => operation.taskId === input.taskId);
	const roundSpend = spend?.rounds.find((entry) => entry.round === (ledger?.currentRound ?? item?.round ?? 0));

	let status: TaskRowStatus;
	let source: TaskStatusSource;
	if (ledger !== undefined && isTerminalBusinessStatus(ledger.status)) {
		status = rowWord(ledger.status);
		source = "ledger";
	} else if (task?.batchCancel !== undefined || ledger?.cancelRequested !== undefined) {
		status = "stopping";
		source = "batch";
	} else if (ledger !== undefined) {
		const word = ledger.status === "revising" ? "running" : ledger.status === "awaiting_review" ? "awaiting-review" : ledger.status === "awaiting_input" ? "awaiting-input" : ledger.status;
		status = word === "running" && execution?.status === "retry_wait" ? "retry_wait" : word === "running" && execution?.status === "queued" ? "queued" : word;
		source = "ledger";
	} else if (receipt !== undefined) {
		status = receipt.status === "completed" ? "accepted" : receipt.status === "cancelled" ? "cancelled" : "failed";
		source = "receipt";
	} else if (task?.slot !== undefined) {
		status = "running";
		source = "batch";
	} else if (task?.queuePosition !== undefined) {
		status = "queued";
		source = "batch";
	} else if (item !== undefined) {
		status = "planned";
		source = "none";
	} else {
		status = "planned";
		source = "none";
	}

	const round = ledger?.currentRound ?? item?.round ?? receipt?.round ?? 0;
	const roundRecord = ledger?.rounds.find((entry) => entry.round === round);
	// A queued row shows no start time: the round has not begun, and a zero
	// duration would be a number nobody measured.
	const startedAt = roundRecord === undefined || status === "queued" ? undefined : roundRecord.startedAt;
	return {
		taskId: input.taskId,
		batchId: input.batchId,
		title: input.title,
		status,
		statusSource: source,
		...(ledger === undefined ? {} : { businessStatus: ledger.status }),
		...(execution === undefined ? {} : { roundStatus: execution.status }),
		round,
		...(startedAt === undefined ? {} : { startedAt }),
		...(receipt === undefined ? {} : { settledAt: receipt.settledAt }),
		toolInvocations: {
			used: execution?.toolInvocations ?? roundSpend?.toolInvocationsUsed ?? 0,
			...(execution === undefined ? {} : { limit: execution.limits.maxToolInvocations }),
		},
		failedToolCalls: {
			used: execution?.failedToolCalls ?? roundSpend?.failedToolCallsUsed ?? 0,
			...(execution === undefined ? {} : { limit: execution.limits.maxFailedToolCalls }),
		},
		...(execution === undefined ? {} : { deadlineAt: execution.deadlineAt }),
		...(task?.queuePosition === undefined ? {} : { queuePosition: task.queuePosition }),
		retrying: execution?.status === "retry_wait",
	};
}

/** Build the status bar's summary sentence for one snapshot. Pure. */
export function summarize(rows: readonly TaskRow[]): { readonly active: number; readonly words: Readonly<Record<TaskRowStatus, number>> } {
	const words: Record<TaskRowStatus, number> = {
		planned: 0,
		queued: 0,
		running: 0,
		retry_wait: 0,
		stopping: 0,
		"awaiting-review": 0,
		"awaiting-input": 0,
		accepted: 0,
		failed: 0,
		cancelled: 0,
	};
	for (const row of rows) words[row.status] += 1;
	const active = rows.filter((row) => !isTerminalRow(row.status)).length;
	return { active, words };
}

function mainTaskName(record: { readonly key?: unknown; readonly kind?: unknown }): string {
	const key = typeof record.key === "string" ? record.key : undefined;
	const kind = typeof record.kind === "string" ? record.kind : "task";
	return key === undefined ? kind : `${kind} ${key}`;
}

export function createAnalysisReader(options: AnalysisReaderOptions): AnalysisReader {
	const { harness, main, mainConversationId, context } = options;
	const runtimeRead = { harness, mainConversationId, context };

	// A read pass never throws on a request id it half-saw: `readRequest` and the
	// runtime's batches can be one commit apart, and a malformed key is not a fact
	// worth failing the whole frame for. The missing counters show as unread.
	const quotaFor = async (requestId: string | undefined): Promise<Readonly<RequestQuotaState> | undefined> => {
		if (typeof requestId !== "string" || requestId === "") return undefined;
		return (await harness.snapshot(AgentQuotaDoc, mainConversationId as never, requestId, context)) ?? undefined;
	};

	const titleOf = async (taskId: string): Promise<string> => {
		const spec = await harness.snapshot(AgentTaskSpecDoc, mainConversationId as never, taskId, context);
		const purpose = spec?.spec?.purpose;
		return purpose !== undefined && purpose.trim() !== "" ? purpose : taskId;
	};

	const inspectTask = async (taskId: string, _now: number): Promise<TaskDetail | undefined> => {
		const [request, tasks, ledger, spec] = await Promise.all([
			main.readRequest(),
			readRuntimeTasks(runtimeRead),
			harness.snapshot(TaskLedgerDoc, mainConversationId as never, taskId, context),
			harness.snapshot(AgentTaskSpecDoc, mainConversationId as never, taskId, context),
		]);
		const task = tasks.find((entry) => entry.item.taskId === taskId);
		if (task === undefined && ledger === undefined) return undefined;
		const quota = await quotaFor(request.requestId).catch(() => undefined);
		const row = deriveTaskRow({ taskId, batchId: task?.batchId ?? ledger?.rounds[0]?.execution?.batchId ?? "", title: spec?.spec?.purpose ?? taskId, ledger: ledger ?? undefined, task, quota });
		const resultSummaries = new Map<number, string>();
		for (const round of ledger?.rounds ?? []) {
			const doc = await harness.snapshot(AgentTaskResultDoc, mainConversationId as never, resultIdOf(taskId, round.round), context);
			const summary = doc?.result?.work.summary;
			if (summary !== undefined) resultSummaries.set(round.round, summary);
		}
		const spend = quota?.operations.find((operation) => operation.taskId === taskId);
		const rounds: TaskRoundView[] = (ledger?.rounds ?? []).map((round) => ({
			round: round.round,
			kind: round.kind,
			...(round.execution === undefined ? {} : { status: round.execution.status }),
			startedAt: round.startedAt,
			...(round.settledAt === undefined ? {} : { settledAt: round.settledAt }),
			...(round.execution === undefined ? {} : { deadlineAt: round.execution.deadlineAt }),
			toolInvocations: {
				used: round.execution?.toolInvocations ?? spend?.rounds.find((entry) => entry.round === round.round)?.toolInvocationsUsed ?? 0,
				...(round.execution === undefined ? {} : { limit: round.execution.limits.maxToolInvocations }),
			},
			failedToolCalls: {
				used: round.execution?.failedToolCalls ?? spend?.rounds.find((entry) => entry.round === round.round)?.failedToolCallsUsed ?? 0,
				...(round.execution === undefined ? {} : { limit: round.execution.limits.maxFailedToolCalls }),
			},
			evidenceCount: round.evidence.length,
			...(resultSummaries.get(round.round) === undefined ? {} : { resultSummary: resultSummaries.get(round.round) as string }),
		}));
		const evidence = (ledger?.rounds ?? []).flatMap((round) => round.evidence.map((entry) => ({ ...entry, round: round.round })));
		return {
			row,
			...(spec?.spec === undefined ? {} : { purpose: spec.spec.purpose }),
			constraints: [...(spec?.spec?.scope ?? []), ...(spec?.spec?.exclusions ?? []), ...(spec?.spec?.constraints ?? [])],
			acceptance: [...(spec?.spec?.acceptance ?? [])],
			rounds,
			evidence,
			...(ledger?.failure === undefined ? {} : { failure: { reason: ledger.failure.reason, ...(ledger.failure.detail === undefined ? {} : { detail: ledger.failure.detail }) } }),
			...(task?.batchCancel === undefined ? {} : { stopRequested: { kind: task.batchCancel.kind, at: task.batchCancel.at, reason: task.batchCancel.reason } }),
			...(spend === undefined ? {} : { attemptsUsed: spend.attemptsUsed }),
		};
	};

	const snapshot = async (now: number, setWatched?: (keys: PassKeys) => void): Promise<TuiSnapshot> => {
		// One Main read at a time: each one reconciles the queue, and three parallel
		// reconciliations would race on the same pointer for no benefit.
		const request = await main.readRequest();
		const queue = await main.readQueue();
		const status = await main.status();
		const [tasks, quota, inspection] = await Promise.all([
			readRuntimeTasks(runtimeRead),
			quotaFor(request.requestId).catch(() => undefined),
			harness.inspect(context),
		]);
		const ledgers = new Map<string, Readonly<TaskLedgerState> | undefined>();
		const rows: TaskRow[] = [];
		const seen = new Set<string>();
		for (const task of tasks) {
			const taskId = task.item.taskId;
			if (seen.has(taskId)) continue;
			seen.add(taskId);
			let ledger = ledgers.get(taskId);
			if (!ledgers.has(taskId)) {
				ledger = (await harness.snapshot(TaskLedgerDoc, mainConversationId as never, taskId, context)) ?? undefined;
				ledgers.set(taskId, ledger);
			}
			rows.push(deriveTaskRow({ taskId, batchId: task.batchId, title: await titleOf(taskId), ledger, task, quota }));
		}
		const batchIds = new Set(tasks.map((task) => task.batchId));
		const known = [...seen];
		setWatched?.({ status: true, ledgers: known, specs: known });
		const settledBatches = [...batchIds].filter((batchId) => {
			const items = tasks.filter((task) => task.batchId === batchId);
			return items.length > 0 && items.every((task) => task.item.receipt !== undefined);
		}).length;
		const mainTasks = inspection.tasks.map((entry) => {
			const state = entry.state.kind === "ready" || entry.state.kind === "running" || entry.state.kind === "waiting" || entry.state.kind === "completing" ? entry.state.kind : ("blocked" as const);
			return { name: mainTaskName(entry.record as { readonly key?: unknown; readonly kind?: unknown }), state } as const;
		});
		return {
			takenAt: now,
			request: {
				...(request.requestId === undefined ? {} : { requestId: request.requestId }),
				requestVersion: request.requestVersion,
				text: request.text,
				openQuestionIds: request.openQuestionIds,
				questions: request.questions,
				answers: request.answers,
				planCount: request.plans.length,
			},
			queue,
			mainBusy: status.busy,
			tasks: rows,
			settledBatches,
			totalBatches: batchIds.size,
			watchedTasks: [...seen],
			watchedRequests: [...new Set(tasks.map((task) => task.requestId))],
			watchedBatches: [...batchIds],
			openReconciliation: options.openReconciliation,
			mainTasks,
		};
	};

	return { snapshot, inspectTask };
}
