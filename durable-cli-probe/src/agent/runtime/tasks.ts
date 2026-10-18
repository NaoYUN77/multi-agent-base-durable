// TASK-005.5 src/agent/runtime/tasks.ts
//
// The runtime's read surface for the terminal entry (Issue #20).
//
// Issue #19 kept the document tokens private to `src/agent/runtime`, and that
// stays true: nothing here returns a token, opens a transaction, or can write.
// What it adds is one *question* the service may ask — "which tasks are known in
// this session, and what state is each in for reading?" — answered from
// non-creating snapshots of the documents the runtime already owns:
//
//   * `BatchIndexDoc` names the admitted batches (it is why a batch that holds no
//     capacity can still be found).
//   * `AgentBatchDoc` names each batch's items, their round, their receipt and
//     any recorded stop.
//   * `SchedulerDoc` says which items hold a slot or wait in the queue, which is
//     how the row knows where in the runtime an item is — and never a percentage,
//     because no document counts steps.
//
// The status *words* themselves are not decided here. `deriveTaskRow`
// (`src/service/analysis.ts`) combines these facts with the task ledger, which is
// the record of the business lifecycle; this module only hands over what the
// runtime knows.

import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import type { BatchId } from "./contracts.ts";
import { AgentBatchDoc, AgentQuotaDoc, BatchIndexDoc, SchedulerDoc, type ActiveSlot, type BatchItemState, type BatchState, type SchedulerState } from "./documents.ts";
/** One item of one admitted batch, as the runtime documents record it. */
export type RuntimeTask = {
	readonly batchId: string;
	/** The request this batch was dispatched for; the key of its `AgentQuotaDoc`. */
	readonly requestId: string;
	readonly item: BatchItemState;
	/** The batch's recorded stop intent, while one is recorded. */
	readonly batchCancel?: BatchState["cancel"];
	/** The item's live slot, when it holds capacity. */
	readonly slot?: ActiveSlot;
	/** The item's position in the queue (1-based), when it waits for capacity. */
	readonly queuePosition?: number;
};

export type RuntimeReadOptions = {
	readonly harness: Harness;
	readonly mainConversationId: number;
	readonly context: Context;
};

/** Every admitted batch id, oldest first. Non-creating. */
export async function readAdmittedBatchIds(options: RuntimeReadOptions): Promise<readonly BatchId[]> {
	const index = await options.harness.snapshot(BatchIndexDoc, options.context);
	return index?.batches ?? [];
}

/** One batch's state, or `undefined` when no admission wrote it. Non-creating. */
export async function readBatchState(options: RuntimeReadOptions, batchId: string): Promise<Readonly<BatchState> | undefined> {
	return (await options.harness.snapshot(AgentBatchDoc, options.mainConversationId as never, batchId, options.context)) ?? undefined;
}

/** The session's slots and queue. Non-creating. */
export async function readSchedulerState(options: RuntimeReadOptions): Promise<Readonly<SchedulerState>> {
	return (await options.harness.snapshot(SchedulerDoc, options.context)) ?? { schemaVersion: 1, active: [], queue: [] };
}

/**
 * Watch the runtime's session-wide documents and one member of its conversation
 * families. Each callback runs after a committed change; what to read stays the
 * caller's decision. `key` is a batch id, a request id or a task id, as the
 * matching family expects.
 */
/**
 * Watch the runtime's own documents. The session-wide index and scheduler are
 * watched at once; `grow` adds one watch per batch and per request a pass read,
 * so a batch admitted later is followed from the pass that first saw it.
 */
export function startRuntimeWatches(
	options: RuntimeReadOptions & { readonly onChange: () => void },
): { readonly grow: (keys: { readonly batches: readonly string[]; readonly requests: readonly string[] }) => void; readonly stop: () => Promise<void> } {
	const { harness, context, onChange, mainConversationId } = options;
	const conversationId = mainConversationId as never;
	const held: { stop(): Promise<unknown> }[] = [];
	const late: Promise<unknown>[] = [];
	const acquired = new Set<string>();
	let stopped = false;
	// `watchDoc` is asynchronous; a watch that resolves after `stop()` is stopped at once.
	const want = (key: string, token: unknown, ...args: unknown[]): void => {
		if (acquired.has(key) || stopped) return;
		acquired.add(key);
		void Promise.resolve((harness.watchDoc as (...input: unknown[]) => Promise<unknown>)(token, ...args))
			.then((watch) => {
				if (watch === undefined) {
					// The document does not exist yet; a later pass may ask again.
					acquired.delete(key);
					return;
				}
				const typed = watch as { start(listener: () => Promise<void>): void; stop(): Promise<unknown> };
				if (stopped) late.push(typed.stop());
				else {
					typed.start(async () => {
						onChange();
					});
					held.push(typed);
				}
			})
			.catch(() => {
				// Unwatchable documents fall back to the next pass's own read.
				acquired.delete(key);
			});
	};
	want("index", BatchIndexDoc, context);
	want("scheduler", SchedulerDoc, context);
	return {
		grow: (keys) => {
			for (const batchId of keys.batches) want(`batch:${batchId}`, AgentBatchDoc, conversationId, batchId, context);
			for (const requestId of keys.requests) want(`request:${requestId}`, AgentQuotaDoc, conversationId, requestId, context);
		},
		stop: async () => {
			stopped = true;
			await Promise.all([...held.map(async (watch) => await watch.stop()), ...late]);
		},
	};
}

/**
 * Every admitted batch's items, from the index and scheduler.
 *
 * One snapshot per document, all from the same harness. A pass that read the
 * index and then a batch that was admitted in between simply sees the next index
 * on its next pass, which is what the coalesced pass loop is for.
 */
export async function readRuntimeTasks(options: RuntimeReadOptions): Promise<readonly RuntimeTask[]> {
	const [ids, scheduler] = await Promise.all([readAdmittedBatchIds(options), readSchedulerState(options)]);
	const batches = await Promise.all(ids.map(async (id) => ({ id: String(id), state: await readBatchState(options, String(id)) })));
	const queue = [...scheduler.queue].sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.ordinal - right.ordinal);
	const tasks: RuntimeTask[] = [];
	for (const { id, state } of batches) {
		if (state === undefined) continue;
		for (const item of state.items) {
			const slot = scheduler.active.find((entry) => entry.batchId === id && entry.taskId === item.taskId);
			const queueIndex = queue.findIndex((entry) => entry.batchId === id && entry.taskId === item.taskId);
			tasks.push({
				batchId: id,
				requestId: state.requestId,
				item,
				...(state.cancel === undefined ? {} : { batchCancel: state.cancel }),
				...(slot === undefined ? {} : { slot }),
				...(queueIndex < 0 ? {} : { queuePosition: queueIndex + 1 }),
			});
		}
	}
	return tasks;
}

/**
 * The batch that holds a task, or `undefined` when none does.
 *
 * No guessing: the id must match an item's `taskId` exactly. A task id that is
 * reused by two batches is reported as ambiguous, because cancelling the wrong
 * batch is worse than refusing.
 */
export async function findBatchOfTask(
	options: RuntimeReadOptions,
	taskId: string,
): Promise<{ readonly batchId: string } | { readonly batchIds: readonly string[] } | undefined> {
	const ids = await readAdmittedBatchIds(options);
	const found: string[] = [];
	for (const id of ids) {
		const state = await readBatchState(options, String(id));
		if (state?.items.some((item) => item.taskId === taskId) === true) found.push(String(id));
	}
	if (found.length === 0) return undefined;
	if (found.length === 1) return { batchId: found[0] as string };
	return { batchIds: found };
}
