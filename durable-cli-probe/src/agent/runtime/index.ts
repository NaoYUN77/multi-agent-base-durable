// TASK-005.4 src/agent/runtime/index.ts
//
// The batch runtime's public surface, and nothing else.
//
// Everything below `src/agent/runtime` that is not re-exported here is private to
// the package on purpose. The document tokens in `documents.ts` are the clearest
// case: a caller that could write a slot, a quota reservation or a batch receipt
// directly could admit work without a right or charge an attempt twice, and the
// whole point of the runtime is that those decisions have one owner. `admission`,
// `item`, `round`, `quota` and `cancel` are the same: they are the runtime's
// internals, and their only supported entry points are the runtime's own methods.
//
// What a composition root actually needs is small:
//
//   * `createBatchRuntime` — build it, with the limits in force;
//   * `runtimeHarnessSettings` — what the `Harness` must be opened with, because
//     the runtime's own retry counters are only meaningful when the harness is not
//     silently retrying underneath them;
//   * `BatchRuntime.extension` — install *and select* it for the Main conversation,
//     or no item call resolves;
//   * `BatchRuntime.dispatch` / `.batches` — the `MainToolHost` hooks;
//   * `BatchRuntime.reconcile` — once, on open;
//   * `BatchRuntime.stopAll` — for a request-wide cancel;
//   * `readRuntimeTasks` / `findBatchOfTask` (TASK-005.5) — the terminal entry's
//     read-only view of the runtime's documents. They return facts, never
//     tokens, and they never write: the service derives presentation from them.
//
// The identity and refusal types are re-exported because they cross that boundary:
// a caller resolves a `RefusalCode`, reads a `BatchReconciliation`, or holds a
// `BatchId` it got from a stop result.

export { createBatchRuntime, runtimeHarnessSettings } from "./runtime.ts";
export type { BatchRuntime, BatchRuntimeOptions } from "./runtime.ts";

// The read surface (TASK-005.5): facts, never tokens or writers. See `tasks.ts`.
export { findBatchOfTask, readBatchState, readRuntimeTasks, readSchedulerState, startRuntimeWatches } from "./tasks.ts";
export type { RuntimeReadOptions, RuntimeTask } from "./tasks.ts";

export { BatchNotResumable } from "./contracts.ts";
export type {
	AttemptKey,
	BatchCancelResult,
	BatchExecutionContext,
	BatchId,
	BatchReconciliation,
	BatchTrigger,
	OperationId,
	PlanRef,
	RefusalCode,
	RequestRef,
} from "./contracts.ts";
