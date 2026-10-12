// TASK-003 src/multiagent/cli-multiagent-inspect.ts
//
// `npm run multiagent:inspect -- --db <absolute path> --task-id <business task id>`
//
// Read-only inspection of one task's ledger and its evidence references. This
// path deliberately does **not** open a Harness: opening one runs migrations,
// reconciles surviving `running` tasks to `pending`, and enters writable
// commits — all of which would change the very state an operator is inspecting.
// Instead it reads the SQLite file directly with a read-only connection and
// reconstructs the ledger document from its stored revisions.
//
// The document value is stored as a base revision plus ordered deltas
// (`["s", path, value]`, `["d", path]`, `["r", value]`). The applier below
// understands exactly that set and *fails loudly* on anything else, rather than
// printing a partial or wrong ledger.
//
// Exit codes:
//   0  the task exists and everything printed
//   1  the task or database is missing, the file is not a Durable database, or
//      a reference does not resolve (nothing is ever created or modified)
//   2  configuration — --db or --task-id missing

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

class InspectConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InspectConfigError";
	}
}

interface Args {
	databasePath: string;
	taskId: string | undefined;
	help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { databasePath: "", taskId: undefined, help: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const next = (): string => {
			const value = argv[++index];
			if (value === undefined) throw new InspectConfigError(`${arg} requires a value`);
			return value;
		};
		switch (arg) {
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--db":
				args.databasePath = next();
				break;
			case "--task-id":
				args.taskId = next();
				break;
			default:
				throw new InspectConfigError(`unknown argument: ${arg}`);
		}
	}
	return args;
}

const USAGE = `multiagent:inspect — read-only ledger and evidence inspection

Usage:
  npm run multiagent:inspect -- --db <absolute sqlite path> --task-id <task id>

Prints, from the committed records of one run's database:
  - the task's status, version, round count, child conversation, model/tool config
  - every round: stable request id, submission id, answer entry id, evidence
  - every review event and every recorded state transition
  - every operation binding (tool task / call id → round)
  - each evidence reference: entry id, tool name, error flag, truncation

This opens the file with a read-only SQLite connection only. It starts no task,
runs no migration, calls no model, and never creates or modifies anything; a
missing database, a non-Durable file, or an unknown task is reported as such.`;

/** A minimal applier for the document revision delta format the store writes. */
function applyDelta(value: unknown, ops: unknown, context: string): unknown {
	if (!Array.isArray(ops)) throw new Error(`${context}: delta is not an array`);
	let root = value;
	for (const op of ops) {
		if (!Array.isArray(op) || typeof op[0] !== "string") throw new Error(`${context}: unsupported delta op ${JSON.stringify(op).slice(0, 80)}`);
		const [kind, path, payload] = op as [string, unknown, unknown];
		if (kind === "r") {
			root = payload;
			continue;
		}
		if (!Array.isArray(path)) throw new Error(`${context}: ${kind} without a path`);
		if (kind === "s") root = setAt(root, path, payload);
		else if (kind === "d") root = deleteAt(root, path);
		else throw new Error(`${context}: unsupported delta op kind ${JSON.stringify(kind)}`);
	}
	return root;
}

function containerFor(parent: unknown, key: string | number): unknown {
	if (Array.isArray(parent)) return parent[Number(key)];
	if (typeof parent === "object" && parent !== null) return (parent as Record<string, unknown>)[String(key)];
	return undefined;
}

function setAt(root: unknown, path: readonly unknown[], value: unknown): unknown {
	if (path.length === 0) return value;
	let cursor: unknown = root;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index] as string | number;
		let next = containerFor(cursor, key);
		if (next === undefined || next === null) {
			// Create the missing container the next key needs.
			next = typeof path[index + 1] === "number" ? [] : {};
			if (Array.isArray(cursor)) cursor[Number(key)] = next;
			else if (typeof cursor === "object" && cursor !== null) (cursor as Record<string, unknown>)[String(key)] = next;
			else throw new Error(`cannot set into a non-container at ${JSON.stringify(path)}`);
		}
		cursor = next;
	}
	const last = path[path.length - 1] as string | number;
	if (Array.isArray(cursor)) cursor[Number(last)] = value;
	else if (typeof cursor === "object" && cursor !== null) (cursor as Record<string, unknown>)[String(last)] = value;
	else throw new Error(`cannot set into a non-container at ${JSON.stringify(path)}`);
	return root;
}

function deleteAt(root: unknown, path: readonly unknown[]): unknown {
	if (path.length === 0) return root;
	let cursor: unknown = root;
	for (let index = 0; index < path.length - 1; index++) {
		cursor = containerFor(cursor, path[index] as string | number);
		if (cursor === undefined || cursor === null) return root;
	}
	const last = path[path.length - 1] as string | number;
	if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
	else if (typeof cursor === "object" && cursor !== null) delete (cursor as Record<string, unknown>)[String(last)];
	return root;
}

/** Reconstruct one document's current value from its stored revisions. */
function reconstructValue(db: SqliteLike, documentId: number): unknown {
	const revisions = db.prepare("SELECT seq, kind, content FROM document_revisions WHERE document_id = ? ORDER BY seq").all(documentId) as {
		seq: number;
		kind: string;
		content: string;
	}[];
	let value: unknown;
	for (const revision of revisions) {
		const content = JSON.parse(revision.content) as unknown;
		if (revision.kind === "base") value = content;
		else if (revision.kind === "delta") value = applyDelta(value, content, `document ${documentId} revision ${revision.seq}`);
		else throw new Error(`document ${documentId}: unsupported revision kind ${revision.kind}`);
	}
	return value;
}

interface SqliteLike {
	prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
	close(): void;
}

/** Model-facing text of one entry record, for evidence excerpts. */
function entryTextOf(record: string): string {
	const parsed = JSON.parse(record) as { model?: { role?: string; content?: unknown }[] };
	const parts: string[] = [];
	for (const message of parsed.model ?? []) {
		const content = message.content;
		if (typeof content === "string") parts.push(content);
		else if (Array.isArray(content)) {
			for (const part of content) {
				if (typeof part === "object" && part !== null) {
					const typed = part as { type?: string; text?: string };
					if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
				}
			}
		}
	}
	return parts.join("\n");
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.databasePath.trim() === "") throw new InspectConfigError("--db <absolute sqlite path> is required");
	if (args.taskId === undefined || args.taskId.trim() === "") throw new InspectConfigError("--task-id <task id> is required");

	const require = createRequire(import.meta.url);
	if (!existsSync(args.databasePath)) {
		console.error(`database not found: ${args.databasePath}`);
		return 1;
	}
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	// Read-only: this connection cannot create a schema, migrate, or write.
	const db = new DatabaseSync(args.databasePath, { readOnly: true }) as unknown as SqliteLike;
	try {
		const schema = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'").get() as
			| { name?: string }
			| undefined;
		if (schema === undefined) {
			console.error(`not a Durable database (no durable_schema table): ${args.databasePath}`);
			return 1;
		}
		const doc = db
			.prepare("SELECT id FROM documents WHERE kind LIKE ? AND key_value = ?")
			.get("%multiagent.task-ledger%", JSON.stringify(args.taskId)) as { id?: number } | undefined;
		if (doc?.id === undefined) {
			console.error(`task ${args.taskId} not found in ${args.databasePath}`);
			return 1;
		}
		const value = reconstructValue(db, doc.id) as {
			taskId: string;
			status: string;
			version: number;
			mainConversationId?: number;
			childConversationId?: number;
			model: unknown;
			childTools: string[];
			currentRound: number;
			createdAt: number;
			terminalAt?: number;
			failure?: { reason: string; detail?: string };
			rounds: {
				round: number;
				kind: string;
				requestId: string;
				task: string;
				feedback?: string;
				submissionId?: string;
				answerEntryId?: number;
				evidence: {
					entryId: number;
					kind: string;
					byTaskId?: string;
					toolCallId?: string;
					toolName?: string;
					isError?: boolean;
					argsSummary?: string;
					excerpt: string;
					truncated: boolean;
					diagnostics?: string[];
				}[];
			}[];
			reviews: { round: number; decision: string; reason?: string; before: string; after: string; opKey: string }[];
			events: { at: number; from: string; to: string; opKey?: string; round?: number; reason?: string }[];
			operations: { opKey: string; kind: string; toolTaskId: string; callId: string; round: number; decision?: string }[];
		};

		// A document written by an older revision of this ledger may lack the
		// newer fields; inspection reads what is there instead of failing.
		const rounds = value.rounds ?? [];
		const reviews = value.reviews ?? [];
		const events = value.events ?? [];
		const operations = value.operations ?? [];

		const lines: string[] = [];
		lines.push(`task: ${value.taskId}`);
		lines.push(`status: ${value.status}${value.failure ? ` (${value.failure.reason}${value.failure.detail ? `: ${value.failure.detail}` : ""})` : ""}`);
		lines.push(`version: ${value.version ?? 0}`);
		lines.push(`main conversation: ${value.mainConversationId ?? "(unset)"}`);
		lines.push(`child conversation: ${value.childConversationId ?? "(none yet)"}`);
		lines.push(`model: ${JSON.stringify(value.model)}`);
		lines.push(`child tools: ${(value.childTools ?? []).join(", ") || "(none)"}`);
		lines.push(`current round: ${value.currentRound}`);
		for (const round of rounds) {
			lines.push("");
			lines.push(`round ${round.round} (${round.kind}) requestId=${round.requestId}`);
			lines.push(`  task: ${round.task}`);
			if (round.feedback !== undefined) lines.push(`  feedback: ${round.feedback}`);
			lines.push(`  submissionId: ${round.submissionId ?? "(not settled)"}`);
			lines.push(`  answerEntryId: ${round.answerEntryId ?? "(not settled)"}`);
			for (const evidence of round.evidence) {
				lines.push(
					`  evidence entry=${evidence.entryId} kind=${evidence.kind} tool=${evidence.toolName ?? "-"} byTask=${evidence.byTaskId ?? "-"} call=${evidence.toolCallId ?? "-"} error=${evidence.isError === true} truncated=${evidence.truncated}`,
				);
				if (evidence.argsSummary !== undefined) lines.push(`    args=${evidence.argsSummary}`);
				if (evidence.diagnostics !== undefined) lines.push(`    diagnostics=${JSON.stringify(evidence.diagnostics)}`);
			}
		}
		for (const review of reviews) {
			lines.push("");
			lines.push(
				`review round ${review.round}: ${review.decision} -> ${review.after} (from ${review.before})${review.reason ? ` reason=${review.reason}` : ""} op=${review.opKey}`,
			);
		}
		for (const event of events) {
			lines.push(
				`event ${event.from} -> ${event.to}${event.round === undefined ? "" : ` round=${event.round}`}${event.reason === undefined ? "" : ` reason=${event.reason}`}${event.opKey === undefined ? "" : ` op=${event.opKey}`}`,
			);
		}
		for (const binding of operations) {
			lines.push(
				`operation ${binding.opKey} kind=${binding.kind} task=${binding.toolTaskId} call=${binding.callId} round=${binding.round}${binding.decision === undefined ? "" : ` decision=${binding.decision}`}`,
			);
		}
		console.log(lines.join("\n"));

		// Every evidence reference must resolve to the real record, in the child
		// conversation the ledger names.
		const childConversationId = value.childConversationId;
		if (childConversationId !== undefined) {
			let unresolved = 0;
			for (const round of rounds) {
				for (const evidence of round.evidence) {
					const row = db.prepare("SELECT conversation_id, record FROM entries WHERE id = ?").get(evidence.entryId) as
						| { conversation_id?: number; record?: string }
						| undefined;
					if (row?.record === undefined) {
						unresolved++;
						console.error(`unresolved evidence: entry ${evidence.entryId} of task ${value.taskId} round ${round.round}`);
						continue;
					}
					if (Number(row.conversation_id) !== Number(childConversationId)) {
						unresolved++;
						console.error(`foreign evidence: entry ${evidence.entryId} belongs to conversation ${row.conversation_id}, not ${childConversationId}`);
						continue;
					}
					const text = entryTextOf(row.record);
					if (text === "") {
						unresolved++;
						console.error(`empty evidence: entry ${evidence.entryId} has no readable text`);
					}
				}
			}
			if (unresolved > 0) return 1;
		}
		return 0;
	} finally {
		db.close();
	}
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const config = error instanceof InspectConfigError;
		console.error(config ? `configuration: ${message}` : `inspect failed: ${message}`);
		process.exit(config ? 2 : 1);
	});
