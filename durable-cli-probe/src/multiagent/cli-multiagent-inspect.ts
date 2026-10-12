// TASK-003 src/multiagent/cli-multiagent-inspect.ts
//
// `npm run multiagent:inspect -- --db <absolute path> --task-id <business task id>`
//
// Read-only inspection of one task's ledger and its evidence references. It
// opens the Harness just far enough to read committed records: no task is
// started, no model is called, no submission is made, and a missing database
// or task is an error, never a fresh empty run.
//
// Exit codes:
//   0  the task exists and everything printed
//   1  the task or database is missing, or a reference does not resolve
//   2  configuration — --db or --task-id missing

import { createRequire } from "node:module";
import { context, openProbe } from "../runtime.ts";
import { ChildTools } from "./child-tools.ts";
import { createMultiagentExtension } from "./tools.ts";
import { TaskLedgerDoc } from "./ledger.ts";
import { entryText } from "./evidence.ts";

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
  - the task's status, round count, child conversation, and model/tool config
  - every round: stable request id, submission id, answer entry id, evidence
  - every review event with its before/after status
  - each evidence reference: entry id, tool name, error flag, truncation

This starts no task and calls no model. A missing database or task is reported
as such; the tool never creates an empty one.`;

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.databasePath.trim() === "") throw new InspectConfigError("--db <absolute sqlite path> is required");
	if (args.taskId === undefined || args.taskId.trim() === "") throw new InspectConfigError("--task-id <task id> is required");

	// The file must exist: inspecting a task never creates a database.
	const require = createRequire(import.meta.url);
	const { existsSync } = require("node:fs") as typeof import("node:fs");
	if (!existsSync(args.databasePath)) {
		console.error(`database not found: ${args.databasePath}`);
		return 1;
	}

	const runtime = await openProbe({
		databasePath: args.databasePath,
		provider: "faux",
		// No router: nothing in this path asks a model anything.
		extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "(inspect: not used)" })],
		registryExtensions: [ChildTools],
	});
	try {
		const root = await runtime.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, args.taskId, context);
		if (ledger === undefined) {
			console.error(`task ${args.taskId} not found in ${args.databasePath}`);
			return 1;
		}

		const lines: string[] = [];
		lines.push(`task: ${ledger.taskId}`);
		lines.push(`status: ${ledger.status}${ledger.failure ? ` (${ledger.failure.reason}${ledger.failure.detail ? `: ${ledger.failure.detail}` : ""})` : ""}`);
		lines.push(`main conversation: ${ledger.mainConversationId ?? "(unset)"}`);
		lines.push(`child conversation: ${ledger.childConversationId ?? "(none yet)"}`);
		lines.push(`model: ${JSON.stringify(ledger.model)}`);
		lines.push(`child tools: ${ledger.childTools.join(", ") || "(none)"}`);
		lines.push(`current round: ${ledger.currentRound}`);
		for (const round of ledger.rounds) {
			lines.push("");
			lines.push(`round ${round.round} (${round.kind}) requestId=${round.requestId}`);
			lines.push(`  task: ${round.task}`);
			if (round.feedback !== undefined) lines.push(`  feedback: ${round.feedback}`);
			lines.push(`  submissionId: ${round.submissionId ?? "(not settled)"}`);
			lines.push(`  answerEntryId: ${round.answerEntryId ?? "(not settled)"}`);
			for (const evidence of round.evidence) {
				lines.push(
					`  evidence entry=${evidence.entryId} kind=${evidence.kind} tool=${evidence.toolName ?? "-"} byTask=${evidence.byTaskId ?? "-"} error=${evidence.isError === true} truncated=${evidence.truncated}`,
				);
			}
		}
		for (const review of ledger.reviews) {
			lines.push("");
			lines.push(`review round ${review.round}: ${review.decision} -> ${review.after} (from ${review.before})${review.reason ? ` reason=${review.reason}` : ""}`);
		}
		console.log(lines.join("\n"));

		// Every evidence reference must still resolve to the real record.
		if (ledger.childConversationId !== undefined) {
			const child = await runtime.harness.conversation(ledger.childConversationId, context);
			if (child === undefined) {
				console.error(`child conversation ${ledger.childConversationId} is not readable`);
				return 1;
			}
			let unresolved = 0;
			for (const round of ledger.rounds) {
				for (const evidence of round.evidence) {
					const entry = await child.commit((tx) => tx.entry(evidence.entryId), context);
					if (entry === undefined || entryText(entry) === undefined) {
						unresolved++;
						console.error(`unresolved evidence: entry ${evidence.entryId} of task ${ledger.taskId} round ${round.round}`);
					}
				}
			}
			if (unresolved > 0) return 1;
		}
		return 0;
	} finally {
		await runtime.close();
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
