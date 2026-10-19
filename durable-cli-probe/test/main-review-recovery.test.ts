// TASK-005.7 test/main-review-recovery.test.ts
//
// AC-04 — a process killed around a review decision reopens into the same
// decision, and never decides or executes twice:
//
//   review-accepted  killed after the accept committed, before the tool call
//                    returned: the reopen finds `accepted`, one review, and does
//                    not accept a second time;
//   rework-decided   killed after the rejection committed and before the revision
//                    round was claimed: the reopen runs exactly that round, once,
//                    in the same child conversation;
//   rework-settled   killed after the revision round settled, before the tool call
//                    returned: the reopen reports the round it already ran and
//                    starts no third one.
//
// The kill is a real `SIGKILL` of a real child process, sent by the same watcher
// thread the TASK-005.4 recovery suite uses, extended with these three states.
// Nothing here pauses or aborts a run.
//
// Every number is stated in `helpers/recovery-scenario.ts` or below.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "@earendil-works/chord/delta";
import { context } from "../src/runtime.ts";
import { MainServiceDoc } from "../src/agent/main/service-doc.ts";
import {
	type BatchSystem,
	onlyBatchId,
	readBatch,
	readLedger,
	readQuota,
	readResult,
} from "./helpers/batch-system.ts";
import {
	openRecoverySystem,
	RECOVERY_ANSWER,
	RECOVERY_REQUEST_ID,
	RECOVERY_TASK_ID,
	REVIEW_BOUNDARIES,
	REVIEW_FEEDBACK,
	REVIEW_REWORK_ANSWER,
	type ReviewBoundary,
} from "./helpers/recovery-scenario.ts";

const RUNNER = fileURLToPath(new URL("./helpers/batch-runner.ts", import.meta.url));
const RUNNER_FLAGS = ["--conditions=source", "--experimental-strip-types"];
const TASK = RECOVERY_TASK_ID;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an asynchronous predicate, failing with a useful message instead of hanging. */
async function waitUntil(predicate: () => Promise<boolean>, message: string, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error(message);
		await sleep(10);
	}
}

/** One document's committed value, base revision plus every delta. The killed process left no harness to read it. */
function documentValue(databasePath: string, kind: string, key: string): unknown {
	const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
	const database = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const row = database
			.prepare("SELECT id FROM documents WHERE kind = ? AND key_value = ? AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1")
			.get(JSON.stringify(kind), JSON.stringify(key)) as { readonly id: string } | undefined;
		if (row === undefined) return undefined;
		const base = database
			.prepare("SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1")
			.get(row.id) as { readonly seq: number; readonly version: string; readonly content: string } | undefined;
		if (base === undefined) return undefined;
		let value: unknown = JSON.parse(base.content);
		const tail = database
			.prepare("SELECT kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq")
			.all(row.id, base.seq) as unknown as readonly { readonly kind: string; readonly version: string; readonly content: string }[];
		for (const revision of tail) {
			if (revision.kind !== "delta" || revision.version !== base.version) continue;
			value = apply(value, JSON.parse(revision.content));
		}
		return value;
	} finally {
		database.close();
	}
}

type LedgerOnDisk = {
	readonly status: string;
	readonly currentRound: number;
	readonly rounds: readonly { readonly round: number; readonly kind: string }[];
	readonly reviews: readonly { readonly round: number; readonly decision: string; readonly reason?: string }[];
	readonly operations: readonly { readonly kind: string; readonly round: number; readonly decision?: string }[];
};

function ledgerOnDisk(databasePath: string): LedgerOnDisk | undefined {
	return documentValue(databasePath, "app.multiagent.task-ledger", TASK) as LedgerOnDisk | undefined;
}

type RunnerOutcome = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
	readonly timedOut: boolean;
};

/** Run the scenario in a child process until the watcher kills it. */
function runUntilKilled(databasePath: string, markerPath: string, boundary: ReviewBoundary): Promise<RunnerOutcome> {
	const child: ChildProcess = spawn(
		process.execPath,
		[...RUNNER_FLAGS, RUNNER, "--database", databasePath, "--boundary", boundary, "--marker", markerPath],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return new Promise<RunnerOutcome>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve({ code: null, signal: null, stderr, timedOut: true });
		}, 60_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal, stderr, timedOut: false });
		});
	});
}

/** Every review receipt the reopened session holds, finished or merely started. */
async function reviewReceipts(system: BatchSystem) {
	const doc = await system.runtime.harness.snapshot(MainServiceDoc, system.root.id, context);
	return (doc?.receipts ?? []).filter((receipt) => receipt.opKey.startsWith("review:"));
}

/**
 * Wait for the reopened process to finish what the decision owes, then for the
 * harness to go idle.
 *
 * The state to wait for is the boundary's own: an accept owes nothing but its
 * receipt, while a rework owes the revision round — so waiting on the ledger's
 * round list, rather than on a fixed delay, is what makes a hang a failure
 * instead of a flaky pass.
 */
async function waitForSettled(system: BatchSystem, boundary: ReviewBoundary): Promise<void> {
	await waitUntil(async () => {
		const ledger = await readLedger(system, TASK);
		if (boundary === "review-accepted") return ledger?.status === "accepted";
		const revision = ledger?.rounds.find((round) => round.round === 2);
		return revision?.execution?.status === "completed" || revision?.execution?.status === "failed";
	}, `the reopened process never settled the ${boundary} decision`);
	await system.runtime.harness.waitForIdle(context);
}

describe("TASK-005.7 review recovery — a killed process reopens into one decision (AC-04)", { timeout: 180_000 }, () => {
	let directory: string;
	let databasePath: string;
	let markerPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "review-recovery-"));
		databasePath = join(directory, "review-recovery.sqlite");
		markerPath = join(directory, "killed.marker");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it.each([...REVIEW_BOUNDARIES])("kills at %s and reopens into one decision and one execution", async (boundary) => {
		const outcome = await runUntilKilled(databasePath, markerPath, boundary);

		// The kill happened, at the state the watcher named.
		expect(outcome.timedOut, "the runner did not exit; the watcher neither killed it nor did it finish").toBe(false);
		expect(outcome.code, `the runner exited ${String(outcome.code)} instead of being killed: ${outcome.stderr}`).not.toBe(0);
		expect(existsSync(markerPath)).toBe(true);
		expect(readFileSync(markerPath, "utf8").trim()).toBe(boundary);

		// The state the killed process left, read from the same file the next process opens.
		const before = ledgerOnDisk(databasePath);
		expect(before).toBeDefined();
		switch (boundary) {
			case "review-accepted":
				// The decision committed; the round before it did too.
				expect(before?.status).toBe("accepted");
				expect(before?.reviews).toHaveLength(1);
				expect(before?.reviews[0]?.decision).toBe("accept");
				expect(before?.rounds).toHaveLength(1);
				break;
			case "rework-decided":
				// The rejection committed and the revision round had not started: one
				// round, one review, and the task still awaiting review.
				expect(before?.status).toBe("awaiting_review");
				expect(before?.reviews).toHaveLength(1);
				expect(before?.reviews[0]?.decision).toBe("reject");
				expect(before?.rounds).toHaveLength(1);
				break;
			case "rework-settled":
				// The revision round settled; its result is on disk and the review is
				// still the only decision.
				expect(before?.status).toBe("awaiting_review");
				expect(before?.reviews).toHaveLength(1);
				expect(before?.rounds.map((round) => round.round)).toEqual([1, 2]);
				expect(documentValue(databasePath, "app.agent.task-result", `res.${TASK}.r2`)).toBeDefined();
				break;
		}

		const system = await openRecoverySystem({ databasePath, review: boundary });
		try {
			await waitForSettled(system, boundary);

			const ledger = await readLedger(system, TASK);
			const batchId = await onlyBatchId(system);
			const item = (await readBatch(system, batchId))?.items.find((entry) => entry.taskId === TASK);

			// One decision, whatever the boundary: the reopen must not review again.
			expect(ledger?.reviews).toHaveLength(1);
			expect(ledger?.operations.filter((operation) => operation.kind === "review")).toHaveLength(1);
			// The review tool's receipt exists exactly once, and it is not left as a
			// started marker with no result.
			const receipts = await reviewReceipts(system);
			expect(receipts).toHaveLength(1);
			expect(receipts[0]?.result).toBeTypeOf("string");

			// One instance and one attempt per round, never two for the same round.
			const quota = await readQuota(system, RECOVERY_REQUEST_ID);
			expect(quota?.instancesUsed).toBe(ledger?.rounds.length);

			if (boundary === "review-accepted") {
				// The accept stands. Nothing ran a second round and nothing re-decided.
				expect(ledger?.status).toBe("accepted");
				expect(ledger?.reviews[0]?.decision).toBe("accept");
				expect(ledger?.rounds).toHaveLength(1);
				expect(item?.receipt?.round).toBe(1);
				expect(item?.receipt?.resultId).toBe(`res.${TASK}.r1`);
			} else {
				// The rejection stands and exactly one revision round exists. Its result is
				// the round the rework ran — the same conversation, the feedback carried.
				expect(ledger?.status).toBe("awaiting_review");
				expect(ledger?.reviews[0]?.decision).toBe("reject");
				expect(ledger?.reviews[0]?.reason).toBe(REVIEW_FEEDBACK);
				expect(ledger?.rounds.map((round) => [round.round, round.kind])).toEqual([
					[1, "initial"],
					[2, "revision"],
				]);
				expect(item?.receipt?.round).toBe(2);
				expect(item?.receipt?.resultId).toBe(`res.${TASK}.r2`);
				expect((await readResult(system, `res.${TASK}.r1`))?.result?.work.summary).toBe(RECOVERY_ANSWER);
				expect((await readResult(system, `res.${TASK}.r2`))?.result?.work.summary).toBe(REVIEW_REWORK_ANSWER);
				// No third round: the reopen reported the round it already had instead of
				// running the one after it.
				expect(await readResult(system, `res.${TASK}.r3`)).toBeUndefined();
				expect(ledger?.rounds.some((round) => round.round === 3)).toBe(false);
			}

			// One child conversation throughout: a rework reuses the task's conversation.
			expect(ledger?.childConversationId).toBeDefined();
		} finally {
			await system.runtime.close();
		}
	});
});
