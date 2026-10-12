// TASK-003 test/multiagent-inspect.test.ts
//
// AC-07 / inspection contract: reading a task's ledger must not change the
// database. These checks are byte- and row-level:
//   - inspecting a database that was left *interrupted* (a running task) leaves
//     every logical record and the file bytes identical;
//   - inspecting a copy leaves the copy's records identical (the read path
//     starts no Harness, so nothing reconciles running tasks);
//   - a non-Durable SQLite file is refused and not initialized;
//   - a missing database and a missing task are refused without creating
//     anything.

import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSPECT = join(import.meta.dirname, "..", "src", "multiagent", "cli-multiagent-inspect.ts");
const RUNNER = join(import.meta.dirname, "helpers", "multiagent-runner.ts");
const NODE = process.execPath;
const NODE_FLAGS = ["--conditions=source", "--experimental-strip-types"];

function run(args: readonly string[], timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(NODE, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`timed out: ${stderr.slice(-300)}`));
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});
}

const runInspect = (databasePath: string, taskId: string) => run([...NODE_FLAGS, INSPECT, "--db", databasePath, "--task-id", taskId]);

/** Every logical record of the Durable tables, as comparable JSON. */
function logicalRecords(databasePath: string): string {
	const require = createRequire(import.meta.url);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(databasePath, { readOnly: true });
	try {
		const tables = ["conversations", "entries", "tasks", "submissions", "documents", "document_revisions", "record_ids"];
		const snapshot: Record<string, unknown[]> = {};
		for (const table of tables) {
			const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
				| { name?: string }
				| undefined;
			if (exists === undefined) continue;
			snapshot[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
		}
		return JSON.stringify(snapshot);
	} finally {
		db.close();
	}
}

async function hashOf(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("TASK-003 read-only inspection", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-inspect-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("leaves an interrupted database byte- and row-identical (AC-07)", async () => {
		const databasePath = join(directory, "interrupted.sqlite");
		// A real unclean stop mid-submission: a running tool task is left behind.
		const killed = await run([...NODE_FLAGS, RUNNER, "--db", databasePath, "--request-id", "ins-1", "--input", "DELEGATE", "--kill-when", "child-conversation"]);
		expect(killed.code).not.toBe(0);

		const beforeHash = await hashOf(databasePath);
		const beforeRows = logicalRecords(databasePath);

		const inspected = await runInspect(databasePath, "task-smoke");
		expect(inspected.code).toBe(0);
		expect(inspected.stdout).toContain("task: task-smoke");

		expect(await hashOf(databasePath)).toBe(beforeHash);
		expect(logicalRecords(databasePath)).toBe(beforeRows);
	}, 90_000);

	it("leaves a copy's records identical when inspecting the copy", async () => {
		const sourcePath = join(directory, "source.sqlite");
		const killed = await run([...NODE_FLAGS, RUNNER, "--db", sourcePath, "--request-id", "ins-2", "--input", "DELEGATE", "--kill-when", "child-conversation"]);
		expect(killed.code).not.toBe(0);

		const copyPath = join(directory, "copy.sqlite");
		// Copy the sidecars too: the runner died uncleanly, so part of the data
		// still lives in the write-ahead log.
		await copyFile(sourcePath, copyPath);
		for (const suffix of ["-wal", "-shm"]) {
			try {
				await copyFile(`${sourcePath}${suffix}`, `${copyPath}${suffix}`);
			} catch {
				// The sidecar may not exist; the copy is still consistent without it.
			}
		}
		const before = logicalRecords(copyPath);
		const inspected = await runInspect(copyPath, "task-smoke");
		expect(inspected.code).toBe(0);
		expect(logicalRecords(copyPath)).toBe(before);
	}, 90_000);

	it("refuses a non-Durable database without initializing it", async () => {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const alienPath = join(directory, "alien.sqlite");
		const db = new DatabaseSync(alienPath);
		db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY, note TEXT)");
		db.exec("INSERT INTO unrelated (note) VALUES ('keep me')");
		db.close();
		const beforeHash = await hashOf(alienPath);

		const inspected = await runInspect(alienPath, "task-smoke");
		expect(inspected.code).toBe(1);
		expect(inspected.stderr).toContain("not a Durable database");
		expect(await hashOf(alienPath)).toBe(beforeHash);

		// Nothing was created: no Durable tables appeared.
		const check = new DatabaseSync(alienPath, { readOnly: true });
		try {
			const durable = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'").get();
			expect(durable).toBeUndefined();
		} finally {
			check.close();
		}
	}, 60_000);

	it("refuses a missing database and a missing task without creating anything", async () => {
		const missingPath = join(directory, "nope.sqlite");
		const missing = await runInspect(missingPath, "task-smoke");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("database not found");
		await expect(readFile(missingPath)).rejects.toThrow();

		// A Durable database without that task id.
		const otherPath = join(directory, "other.sqlite");
		await run([...NODE_FLAGS, RUNNER, "--db", otherPath, "--request-id", "ins-3", "--input", "DELEGATE"]);
		const noTask = await runInspect(otherPath, "task-absent");
		expect(noTask.code).toBe(1);
		expect(noTask.stderr).toContain("not found");

		// Configuration errors exit 2 and touch nothing.
		const config = await run([...NODE_FLAGS, INSPECT, "--db", otherPath]);
		expect(config.code).toBe(2);
		expect(config.stderr).toContain("--task-id");
	}, 90_000);

	it("prints the ledger the new schema records, including operations and events", async () => {
		const databasePath = join(directory, "complete.sqlite");
		await run([...NODE_FLAGS, RUNNER, "--db", databasePath, "--request-id", "ins-4", "--input", "DELEGATE"]);
		const inspected = await runInspect(databasePath, "task-smoke");
		expect(inspected.code).toBe(0);
		expect(inspected.stdout).toContain("status: awaiting_review");
		expect(inspected.stdout).toMatch(/operation delegate:\d+:\S+ kind=delegate/);
		expect(inspected.stdout).toMatch(/event running -> awaiting_review/);
		expect(inspected.stdout).toMatch(/evidence entry=\d+ kind=pi\.tool-result tool=text_stats/);
		expect(inspected.stdout).toMatch(/call=call|call=/);
	}, 90_000);

	it("refuses a database whose ledger document uses an unsupported delta op", async () => {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const databasePath = join(directory, "weird.sqlite");
		await run([...NODE_FLAGS, RUNNER, "--db", databasePath, "--request-id", "ins-5", "--input", "DELEGATE"]);
		const db = new DatabaseSync(databasePath);
		try {
			const doc = db.prepare("SELECT id FROM documents WHERE kind LIKE ?").get("%multiagent.task-ledger%") as { id: number };
			const last = db.prepare("SELECT seq FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1").get(doc.id) as {
				seq: number;
			};
			db.prepare("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, ?, ?, ?)").run(
				doc.id,
				last.seq + 1,
				"delta",
				1,
				JSON.stringify([["x", ["status"], "accepted"]]),
			);
		} finally {
			db.close();
		}
		const inspected = await runInspect(databasePath, "task-smoke");
		expect(inspected.code).toBe(1);
		expect(inspected.stderr).toContain("unsupported delta op");
	}, 90_000);
});
