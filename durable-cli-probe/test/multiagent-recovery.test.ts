// TASK-003 test/multiagent-recovery.test.ts
//
// AC-07: the same SQLite reopened after a real unclean stop, at two boundaries,
// resumes the same task, the same child conversation and the same round, with no
// duplicated submission. The stops are real: a child process is SIGKILLed by
// itself once it observes the boundary in the committed records.
//
// Boundary 1 — the child conversation exists but the round is not settled:
//   the intent is committed and the submission is in flight (or done) when the
//   process dies. The resumed run must find one child, one round, one
//   submission for the round's stable request id, and finish the round.
// Boundary 2 — the round is settled (`awaiting_review`) but not reviewed:
//   the resumed run reviews the *same* round of the *same* task; no second
//   round, no second child, no second review event.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, openProbe, type ProbeRuntime } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

const RUNNER = join(import.meta.dirname, "helpers", "multiagent-runner.ts");

/** The node binary and flags this probe runs its TypeScript entry points with. */
const NODE = process.execPath;
const NODE_FLAGS = ["--conditions=source", "--experimental-strip-types"];

function runRunner(args: readonly string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(NODE, [...NODE_FLAGS, RUNNER, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`runner timed out: ${stderr.slice(-500)}`));
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

/** Read committed rows straight from SQLite: the ground truth after a kill. */
function readRows(databasePath: string, sql: string, params: readonly string[] = []): Record<string, unknown>[] {
	const require = createRequire(import.meta.url);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params) as Record<string, unknown>[];
	} finally {
		db.close();
	}
}

async function readLedgerTask(databasePath: string) {
	const runtime: ProbeRuntime = await openProbe({ databasePath, provider: "faux" });
	try {
		const root = await runtime.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		return runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-smoke", context);
	} finally {
		await runtime.close();
	}
}

describe("TASK-003 cross-process recovery", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-recovery-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("resumes the same task, child and round after a kill mid-submission (boundary 1)", async () => {
		const databasePath = join(directory, "recover-1.sqlite");

		// First run: dies uncleanly once the child conversation exists.
		const killed = await runRunner(["--db", databasePath, "--request-id", "run-1a", "--input", "DELEGATE", "--kill-when", "child-conversation"]);
		expect(killed.code).not.toBe(0);
		expect(killed.stderr).not.toContain("runner: submission unanswered");

		// What survived: the committed intent, and one child conversation.
		const ledgers = readRows(databasePath, "SELECT id FROM documents WHERE kind LIKE ?", ["%multiagent.task-ledger%"]);
		expect(ledgers.length).toBe(1);
		const children = readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL");
		expect(children.length).toBe(1);

		// Second run over the same file: the round must complete on the same
		// child with the same submission, not a second one.
		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-1b", "--input", "DELEGATE"]);
		expect(resumed.code).toBe(0);
		const summary = JSON.parse(resumed.stdout.trim().split("\n").at(-1) ?? "{}") as { status?: string; rounds?: number };
		expect(summary.status).toBe("awaiting_review");
		expect(summary.rounds).toBe(1);

		// Still exactly one child conversation and one ledger.
		expect(readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL").length).toBe(1);
		expect(readRows(databasePath, "SELECT id FROM documents WHERE kind LIKE ?", ["%multiagent.task-ledger%"]).length).toBe(1);

		// And exactly one submission for the round's stable request id: the
		// resumed run did not create a second one.
		// The stored request id is a JSON string ("…"), so the match is a LIKE.
		const submissions = readRows(
			databasePath,
			"SELECT id, request_id, status FROM submissions WHERE request_id LIKE ?",
			['%"multiagent-round:task-smoke:1"%'],
		);
		expect(submissions.length).toBe(1);
		expect(submissions[0]?.status).toBe("done");
	}, 90_000);

	it("resumes review on the same settled round after a kill before reviewing (boundary 2)", async () => {
		const databasePath = join(directory, "recover-2.sqlite");

		// First run: dies once the round reached awaiting_review.
		const killed = await runRunner(["--db", databasePath, "--request-id", "run-2a", "--input", "DELEGATE", "--kill-when", "awaiting_review"]);
		expect(killed.code).not.toBe(0);

		const before = await readLedgerTask(databasePath);
		expect(before?.status).toBe("awaiting_review");
		expect(before?.rounds).toHaveLength(1);
		expect(before?.reviews).toHaveLength(0);
		const childBefore = before?.childConversationId;
		expect(childBefore).toBeTypeOf("number");

		// Second run reviews the same round.
		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-2b", "--input", "REVIEW"]);
		expect(resumed.code).toBe(0);

		const after = await readLedgerTask(databasePath);
		expect(after?.status).toBe("accepted");
		// No new round, no new child, exactly one review event.
		expect(after?.rounds).toHaveLength(1);
		expect(after?.childConversationId).toBe(childBefore);
		expect(after?.reviews).toHaveLength(1);
		expect(after?.reviews[0]?.decision).toBe("accept");
		expect(after?.reviews[0]?.round).toBe(1);
		// The round's evidence survived the kill.
		expect(after?.rounds[0]?.evidence.length).toBeGreaterThan(0);
	}, 90_000);
});
