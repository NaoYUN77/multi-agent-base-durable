// TASK-005.5 src/service/changes.ts
//
// Change notification for the read model: watches set one dirty flag, and one
// coalescing loop turns that flag into at most one snapshot pass per interval.
//
// Why not render inside a watch listener: listeners must not block, Durable
// delivers them per frame, and a busy child commits many frames per second.
// Rendering per frame would mean reading every document for every commit.
//
// Why not a bare timer: a timer that re-reads everything proves nothing about
// responsiveness — it would pass the same way if watches were broken. The timer
// here only paces passes that a watch (or a caller, for the elapsed clock)
// asked for; with nothing dirty and nothing ticking, it does nothing.
//
// Single-flight: a pass that is still running holds the loop. Changes that land
// during a pass set the flag again, and the loop runs one more pass after it.
//
// What is watched is decided by the caller's pass, which calls `setWatched` with
// the documents it read: a new batch adds task documents the previous pass did
// not know about, and a document that disappeared is stopped here.

import type { DocumentWatch, JsonObject } from "@earendil-works/pi-durable";

/** How long changes are merged into one pass. Short enough that a cancel looks immediate. */
export const COALESCE_MS = 50;

export type WatchSpec = {
	/** Identity of the watched document; a spec with a known key is never acquired twice. */
	readonly key: string;
	/** `undefined` when the document does not exist (yet); the next pass asks again. */
	readonly acquire: () => Promise<DocumentWatch<JsonObject> | undefined>;
};

export type ChangeFeed = {
	/** Ask for a pass soon (a watch fired, or a caller wants a fresh snapshot). */
	readonly mark: () => void;
	/** Resolve once a pass requested at or after this call has finished. */
	readonly flush: () => Promise<void>;
	/** Replace the watched set; new keys are acquired, disappeared keys are stopped. */
	readonly setWatched: (specs: readonly WatchSpec[]) => Promise<void>;
	readonly stop: () => Promise<void>;
};

export function startChangeFeed(options: {
	readonly onPass: (setWatched: (specs: readonly WatchSpec[]) => Promise<void>) => Promise<void>;
	/** Called after each pass finished, with the number of passes this feed ran. */
	readonly onSettled?: (passes: number) => void;
	readonly intervalMs?: number;
}): ChangeFeed {
	const interval = options.intervalMs ?? COALESCE_MS;
	const watched = new Map<string, DocumentWatch<JsonObject>>();
	const idle: (() => void)[] = [];
	let dirty = true;
	let stopped = false;
	let running = false;
	let rerun = false;
	let passes = 0;
	let timer: NodeJS.Timeout | undefined;

	const settleIdle = (): void => {
		const waiting = idle.splice(0);
		for (const resolve of waiting) resolve();
	};

	const mark = (): void => {
		if (stopped) return;
		dirty = true;
		if (running) rerun = true;
		else schedule(interval);
	};

	const schedule = (delay: number): void => {
		if (timer !== undefined || stopped) return;
		timer = setTimeout(() => {
			timer = undefined;
			void run();
		}, delay);
	};

	async function run(): Promise<void> {
		if (running || stopped) return;
		running = true;
		try {
			do {
				rerun = false;
				dirty = false;
				try {
					await options.onPass(setWatched);
				} catch {
					// The caller reports read failures; the loop must survive one, or every
					// later change would go unnoticed.
					dirty = true;
				}
				passes += 1;
				options.onSettled?.(passes);
				settleIdle();
			} while (rerun && !stopped);
		} finally {
			running = false;
			settleIdle();
			if (dirty && !stopped) schedule(interval);
		}
	}

	async function setWatched(specs: readonly WatchSpec[]): Promise<void> {
		if (stopped) return;
		const wanted = new Map<string, WatchSpec>();
		for (const spec of specs) wanted.set(spec.key, spec);
		const stopping: Promise<unknown>[] = [];
		for (const [key, watch] of [...watched]) {
			if (wanted.has(key)) continue;
			watched.delete(key);
			stopping.push(watch.stop());
		}
		for (const [key, spec] of wanted) {
			if (watched.has(key) || stopped) continue;
			const watch = await spec.acquire();
			if (watch === undefined) continue;
			watched.set(key, watch);
			watch.start(async () => {
				mark();
			});
		}
		await Promise.all(stopping);
	}

	return {
		mark,
		flush: async () => {
			if (stopped) return;
			await new Promise<void>((resolve) => {
				idle.push(resolve);
				mark();
			});
		},
		setWatched,
		stop: async () => {
			stopped = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			settleIdle();
			const held = [...watched.values()];
			watched.clear();
			await Promise.all(held.map(async (watch) => await watch.stop()));
		},
	};
}
