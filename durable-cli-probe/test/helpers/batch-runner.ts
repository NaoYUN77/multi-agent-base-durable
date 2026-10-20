// TASK-005.4 test/helpers/batch-runner.ts
//
// The process a crash-recovery test kills. It opens the batch system, starts
// `batch-watch.mjs` in a worker thread, and drives Main — and it is expected not
// to finish: the watcher kills this process with a real SIGKILL the moment the
// database reaches the named state.
//
// It is a separate process on purpose. `stopChild`-style aborts and graceful
// shutdown paths are exactly what a crash test must not exercise, so the kill has
// to come from outside every shutdown path this process has.
//
// Usage:
//   node --conditions=source --experimental-strip-types test/helpers/batch-runner.ts \
//     --database <sqlite path> --boundary <state> --marker <marker path>
//
// Exit codes: killed (non-zero, no further output), or 3 when the run finished
// without ever reaching the requested state — the test treats that as "the
// watcher missed the boundary", not as a pass.

import { Worker } from "node:worker_threads";
import { driveMain } from "./batch-system.ts";
import {
	openRecoverySystem,
	RECOVERY_BOUNDARIES,
	RECOVERY_INPUT,
	RECOVERY_TASK_ID,
	REVIEW_BOUNDARIES,
	type RecoveryBoundary,
	type ReviewBoundary,
} from "./recovery-scenario.ts";

/** The value of `--<name>`, failing loudly when the argument is missing. */
function argument(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`batch-runner: --${name} is required`);
	return value;
}

const databasePath = argument("database");
const markerPath = argument("marker");
const requested = argument("boundary");
// The boundary's own vocabulary is the run's: the four round boundaries of
// TASK-005.4 and the three review boundaries of TASK-005.7. They are looked up
// separately because they select different Main scripts, not because they are
// different watchers.
const review = REVIEW_BOUNDARIES.find((candidate) => candidate === requested);
const roundBoundary = RECOVERY_BOUNDARIES.find((candidate) => candidate === requested);
if (review === undefined && roundBoundary === undefined) throw new Error(`batch-runner: unknown boundary ${JSON.stringify(requested)}`);
const state: RecoveryBoundary | undefined = roundBoundary;
// The watcher takes either vocabulary: it is the same poll loop, and the
// boundary string is the key it looks its state predicate up by.
const boundary: RecoveryBoundary | ReviewBoundary = review ?? (state as RecoveryBoundary);

// Only the retry-wait scenario needs the provider to fail once; that failure is
// the device that parks the round, not a behaviour the other states depend on.
const system = await openRecoverySystem({
	databasePath,
	failFirst: state === "retry-wait",
	...(review === undefined ? {} : { review }),
	// `review-pending` is the state *before* the review commit: this process must
	// not decide, or the state it is killed in would be the one after the commit.
	...(review === "review-pending" ? { decide: false } : {}),
});

const watcher = new Worker(new URL("./batch-watch.mjs", import.meta.url), {
	workerData: {
		dbPath: databasePath,
		taskId: RECOVERY_TASK_ID,
		round: 1,
		boundary,
		markerPath,
		kill: true,
		pid: process.pid,
	},
});
// Wait for the watcher's first successful read before starting: a watcher whose
// first poll lands after the run began would race the state it is watching for.
await new Promise<void>((resolve, reject) => {
	watcher.once("message", (message: { readonly ready?: boolean }) => {
		if (message.ready === true) resolve();
	});
	watcher.once("error", reject);
});

await driveMain(system, RECOVERY_INPUT);

// Reaching this line means the watcher never saw the state. Say so with a
// distinct exit code and leave the database intact for inspection.
await watcher.terminate();
await system.runtime.close();
console.error(`batch-runner: the run finished without reaching ${boundary}`);
process.exitCode = 3;
