// TASK-003 test/multiagent-recovery.test.ts
//
// AC-07: the same SQLite reopened after a real unclean stop, at four
// boundaries, resumes the same task, the same child conversation and the same
// round, with no duplicated submission. The stops are real: a child process is
// SIGKILLed by itself at the boundary, or (for the tool case) a timer kills it
// while the local tool is executing.
//
// Boundary 1 — the child conversation exists, the round is not settled.
// Boundary 2 — the round settled (`awaiting_review`), not reviewed yet.
// Boundary 3 — a *revision* round's intent is committed, its submission in
//              flight: the replay must resume round 2, not mint round 3.
// Boundary 4 — a local tool is mid-execution: on restart the interrupted tool
//              task replays per its `replay: "safe"` policy and produces
//              exactly one result.
// Boundary 5 — the round's intent is committed and NO submission exists yet
//              (the pre-submit barrier): the replay makes exactly one.
// Boundary 6 — the round's outcome is committed but the parent tool result is
//              not: the replay returns the persisted receipt and changes
//              nothing (the ledger version must not move).
// Boundary 7 — the delegation omitted `taskId`: the derived business id must
//              survive the interruption unchanged.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, openProbe, type ProbeRuntime } from "../src/runtime.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

const RUNNER = join(import.meta.dirname, "helpers", "multiagent-runner.ts");
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

async function readLedgerTask(databasePath: string, taskId = "task-smoke") {
	const runtime: ProbeRuntime = await openProbe({ databasePath, provider: "faux" });
	try {
		const root = await runtime.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		return runtime.harness.snapshot(TaskLedgerDoc, root.id, taskId, context);
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

		const killed = await runRunner(["--db", databasePath, "--request-id", "run-1a", "--input", "DELEGATE", "--kill-when", "child-conversation"]);
		expect(killed.code).not.toBe(0);

		// What survived: the committed intent, and one child conversation.
		expect(readRows(databasePath, "SELECT id FROM documents WHERE kind LIKE ?", ["%multiagent.task-ledger%"]).length).toBe(1);
		const children = readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL");
		expect(children.length).toBe(1);

		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-1b", "--input", "DELEGATE"]);
		expect(resumed.code).toBe(0);
		const summary = JSON.parse(resumed.stdout.trim().split("\n").at(-1) ?? "{}") as { status?: string; rounds?: number };
		expect(summary.status).toBe("awaiting_review");
		expect(summary.rounds).toBe(1);

		expect(readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL").length).toBe(1);
		const submissions = readRows(databasePath, "SELECT id, request_id, status FROM submissions WHERE request_id LIKE ?", [
			'%"multiagent-round:task-smoke:1"%',
		]);
		expect(submissions.length).toBe(1);
		expect(submissions[0]?.status).toBe("done");
	}, 90_000);

	it("resumes review on the same settled round after a kill before reviewing (boundary 2)", async () => {
		const databasePath = join(directory, "recover-2.sqlite");

		const killed = await runRunner(["--db", databasePath, "--request-id", "run-2a", "--input", "DELEGATE", "--kill-when", "awaiting_review"]);
		expect(killed.code).not.toBe(0);

		const before = await readLedgerTask(databasePath);
		expect(before?.status).toBe("awaiting_review");
		expect(before?.rounds).toHaveLength(1);
		expect(before?.reviews).toHaveLength(0);
		const childBefore = before?.childConversationId;
		expect(childBefore).toBeTypeOf("number");

		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-2b", "--input", "REVIEW"]);
		expect(resumed.code).toBe(0);

		const after = await readLedgerTask(databasePath);
		expect(after?.status).toBe("accepted");
		expect(after?.rounds).toHaveLength(1);
		expect(after?.childConversationId).toBe(childBefore);
		expect(after?.reviews).toHaveLength(1);
		expect(after?.reviews[0]?.round).toBe(1);
		expect(after?.rounds[0]?.evidence.length).toBeGreaterThan(0);
	}, 90_000);

	it("resumes the same revision round after a kill with the revision in flight (boundary 3)", async () => {
		const databasePath = join(directory, "recover-3.sqlite");

		// Round 1 completes; the task waits for review with only round 1 recorded.
		const first = await runRunner(["--db", databasePath, "--request-id", "run-3a", "--input", "DELEGATE"]);
		expect(first.code).toBe(0);
		const before = await readLedgerTask(databasePath);
		expect(before?.status).toBe("awaiting_review");
		expect(before?.rounds).toHaveLength(1);
		const childBefore = before?.childConversationId;

		// The revision starts and dies while its child submission is in flight.
		const killed = await runRunner(["--db", databasePath, "--request-id", "run-3b", "--input", "REVISE", "--kill-when", "revising-intent"]);
		expect(killed.code).not.toBe(0);
		const mid = await readLedgerTask(databasePath);
		expect(mid?.status).toBe("revising");
		// The revision's intent is committed: round 2 exists but is not settled.
		expect(mid?.rounds).toHaveLength(2);
		expect(mid?.rounds[1]?.submissionId).toBeUndefined();

		// Restart: the interrupted revision tool task replays and must resume
		// round 2 — not mint round 3.
		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-3c", "--input", "RESUME"]);
		expect(resumed.code).toBe(0);
		const after = await readLedgerTask(databasePath);
		expect(after?.status).toBe("awaiting_review");
		expect(after?.rounds).toHaveLength(2);
		expect(after?.childConversationId).toBe(childBefore);
		expect(after?.rounds[1]?.submissionId).toBeTypeOf("string");
		expect(after?.rounds[1]?.answerEntryId).toBeTypeOf("number");
		// Exactly one submission for round 2: the replay resumed it.
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-smoke:2"%']).length).toBe(1);
		// No round 3 was created, and no third-round submission exists.
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-smoke:3"%']).length).toBe(0);
	}, 90_000);

	it("replays an interrupted local tool exactly once after a kill inside it (boundary 4)", async () => {
		const databasePath = join(directory, "recover-4.sqlite");

		// The child asks the tool to pause and the process dies inside it.
		const killed = await runRunner(["--db", databasePath, "--request-id", "run-4a", "--input", "DELEGATE", "--kill-when", "tool-pause"]);
		expect(killed.code).not.toBe(0);

		// At the kill the tool task was running and no result was committed.
		const childRows = readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL");
		expect(childRows.length).toBe(1);
		const childId = Number(childRows[0]?.id);
		expect(
			readRows(databasePath, "SELECT id FROM entries WHERE conversation_id = ? AND record LIKE ?", [String(childId), '%"kind":"pi.tool-result"%'])
				.length,
		).toBe(0);
		// `kind` is stored JSON-encoded, hence the LIKE.
		const runningTools = readRows(databasePath, "SELECT id FROM tasks WHERE kind LIKE ? AND status = ?", ["%pi.tool%", "running"]);
		expect(runningTools.length).toBeGreaterThan(0);

		// Restart: the interrupted tool task replays (replay: "safe"), the round
		// settles, and exactly one tool result exists — the replay re-executed the
		// interrupted call rather than duplicating or skipping it.
		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-4b", "--input", "RESUME"]);
		expect(resumed.code).toBe(0);
		const after = await readLedgerTask(databasePath);
		expect(after?.status).toBe("awaiting_review");
		expect(after?.rounds).toHaveLength(1);
		expect(after?.rounds[0]?.submissionId).toBeTypeOf("string");
		expect(
			readRows(databasePath, "SELECT id FROM entries WHERE conversation_id = ? AND record LIKE ?", [String(childId), '%"kind":"pi.tool-result"%'])
				.length,
		).toBe(1);
		expect(readRows(databasePath, "SELECT id FROM tasks WHERE kind LIKE ? AND status = ?", ["%pi.tool%", "running"]).length).toBe(0);
	}, 120_000);
	it("makes exactly one submission after a kill at the pre-submit barrier (boundary 5)", async () => {
		const databasePath = join(directory, "recover-5.sqlite");

		const killed = await runRunner(["--db", databasePath, "--request-id", "run-5a", "--input", "DELEGATE", "--kill-when", "pre-submit"]);
		expect(killed.code).not.toBe(0);

		// The intent is committed and the submission does not exist yet.
		const mid = await readLedgerTask(databasePath);
		expect(mid?.rounds).toHaveLength(1);
		expect(mid?.rounds[0]?.settledAt).toBeUndefined();
		expect(mid?.status).toBe("running");
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-smoke:1"%'])).toHaveLength(0);

		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-5b", "--input", "RESUME"]);
		expect(resumed.code).toBe(0);
		const after = await readLedgerTask(databasePath);
		expect(after?.status).toBe("awaiting_review");
		expect(after?.rounds).toHaveLength(1);
		expect(after?.rounds[0]?.settledAt).toBeDefined();
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-smoke:1"%'])).toHaveLength(1);
	}, 90_000);

	it("returns the persisted receipt after a kill post-outcome, changing nothing (boundary 6)", async () => {
		const databasePath = join(directory, "recover-6.sqlite");

		const killed = await runRunner(["--db", databasePath, "--request-id", "run-6a", "--input", "DELEGATE", "--kill-when", "after-outcome"]);
		expect(killed.code).not.toBe(0);

		// The round is settled; the parent tool result never landed.
		const before = await readLedgerTask(databasePath);
		expect(before?.status).toBe("awaiting_review");
		expect(before?.rounds[0]?.settledAt).toBeDefined();
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-smoke:1"%'])).toHaveLength(1);
		const versionBefore = before?.version;
		const eventsBefore = JSON.stringify(before?.events);

		// The replay must return the receipt without re-submitting or re-transitioning.
		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-6b", "--input", "RESUME"]);
		expect(resumed.code).toBe(0);
		const after = await readLedgerTask(databasePath);
		expect(after?.status).toBe("awaiting_review");
		expect(after?.rounds).toHaveLength(1);
		expect(after?.version).toBe(versionBefore);
		expect(JSON.stringify(after?.events)).toBe(eventsBefore);
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", ['%"multiagent-round:task-smoke:1"%'])).toHaveLength(1);

		// The task is still usable: the review closes it.
		const reviewed = await runRunner(["--db", databasePath, "--request-id", "run-6c", "--input", "REVIEW"]);
		expect(reviewed.code).toBe(0);
		const accepted = await readLedgerTask(databasePath);
		expect(accepted?.status).toBe("accepted");
		expect(accepted?.rounds).toHaveLength(1);
	}, 90_000);

	it("keeps the derived business id stable when taskId was omitted (boundary 7)", async () => {
		const databasePath = join(directory, "recover-7.sqlite");

		const killed = await runRunner(["--db", databasePath, "--request-id", "run-7a", "--input", "DELEGATE", "--kill-when", "child-conversation", "--no-task-id"]);
		expect(killed.code).not.toBe(0);

		const docs = readRows(databasePath, "SELECT key_value FROM documents WHERE kind LIKE ?", ["%multiagent.task-ledger%"]);
		expect(docs).toHaveLength(1);
		const derivedId = JSON.parse(String(docs[0]?.key_value)) as string;
		expect(derivedId).toMatch(/^task-\d+$/);
		expect(readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toHaveLength(1);

		const resumed = await runRunner(["--db", databasePath, "--request-id", "run-7b", "--input", "RESUME", "--no-task-id"]);
		expect(resumed.code).toBe(0);
		// Same document, same child, exactly one submission for the derived id.
		expect(readRows(databasePath, "SELECT key_value FROM documents WHERE kind LIKE ?", ["%multiagent.task-ledger%"])).toHaveLength(1);
		expect(readRows(databasePath, "SELECT id FROM conversations WHERE owner_conversation_id IS NOT NULL")).toHaveLength(1);
		expect(readRows(databasePath, "SELECT id FROM submissions WHERE request_id LIKE ?", [`%"multiagent-round:${derivedId}:1"%`])).toHaveLength(1);
		const after = await readLedgerTask(databasePath, derivedId);
		expect(after?.status).toBe("awaiting_review");
		expect(after?.rounds).toHaveLength(1);
		expect(after?.taskId).toBe(derivedId);
	}, 90_000);
});
