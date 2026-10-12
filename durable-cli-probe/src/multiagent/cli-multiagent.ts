// TASK-003 src/multiagent/cli-multiagent.ts
//
// `npm run multiagent:probe -- --provider deepseek --db <absolute path> --request-id <id>`
//
// The acceptance entry point for one real main/sub-agent run. It drives only the
// existing machinery — the management tools, the built-in generation and tool
// tasks, the delegation round — and implements no model loop of its own.
//
// The sub-agent's task is local and side-effect-free: counting and checking
// text. No Notion write, no network beyond the model API.
//
// Exit codes, matching the rest of the probe:
//   2  configuration — a required variable, id, or file is missing
//   1  the run failed, or produced a result that did not verify
//   0  the run completed and the ledger verifies
//
// The API key is read from the environment inside the provider itself: it is
// never printed, never placed in a prompt, and never written to the database.
//
// `--kill-when <condition>` exists for the cross-process recovery check: the
// process SIGKILLs itself once the condition is observed in the database, which
// is exactly an unclean stop, not a graceful shutdown. Conditions:
//   child-conversation  the child conversation exists (intent committed, the
//                       submission is in flight or done)
//   awaiting_review     a task has reached `awaiting_review` (the round settled,
//                       the main model has not reviewed yet)

import { createRequire } from "node:module";
import { context, openProbe, openRoot, type ProviderKind } from "../runtime.ts";
import { ChildTools } from "./child-tools.ts";
import { createMultiagentExtension } from "./tools.ts";
import { TaskLedgerDoc } from "./ledger.ts";

const MAIN_PROMPT = [
	"你是一次多 Agent 协作验收运行的主 Agent。",
	"把任务委派给子 Agent：使用 task_delegate，taskId 用 'task-smoke'，",
	"任务文本：'统计文本 MATERIAL 中 MATERIAL 的出现次数，并说明是否 found。'，",
	"childTools 用 ['text_stats']。",
	"收到结果后用 task_review 验收：证据显示工具成功执行且答案与任务一致时 accept，否则 reject 并给出理由。",
	"最后用中文给出最终结论。",
].join("\n");
const MATERIAL = "MATERIAL-SMOKE- alpha beta MATERIAL gamma";

class CliConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliConfigError";
	}
}

interface Args {
	provider: ProviderKind;
	databasePath: string;
	requestId: string | undefined;
	killWhen: string | undefined;
	help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { provider: "faux", databasePath: "", requestId: undefined, killWhen: undefined, help: false };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const next = (): string => {
			const value = argv[++index];
			if (value === undefined) throw new CliConfigError(`${arg} requires a value`);
			return value;
		};
		switch (arg) {
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--provider":
				args.provider = next() as ProviderKind;
				break;
			case "--db":
				args.databasePath = next();
				break;
			case "--request-id":
				args.requestId = next();
				break;
			case "--kill-when":
				args.killWhen = next();
				break;
			default:
				throw new CliConfigError(`unknown argument: ${arg}`);
		}
	}
	return args;
}

const USAGE = `multiagent:probe — one real main/sub-agent delegation run

Usage:
  npm run multiagent:probe -- --provider <faux|deepseek|openai|custom> --db <absolute sqlite path> --request-id <id>

What it runs:
  A main agent and a sub-agent, both on the selected provider and model, over
  one local task (count a marker in a text). The main agent delegates through
  the program-side tools, receives the final answer plus the per-tool evidence,
  and reviews. The run's ledger (status, rounds, reviews, evidence references)
  is printed at the end and can be re-read with multiagent:inspect.

Scripted verification entry points:
  npm run multiagent:test            deterministic AC-01..08 checks, no network
  npm run multiagent:inspect -- --db <same path> --task-id <task id>
                                     read-only ledger and evidence inspection

Exit codes:
  0  the run completed and the ledger verifies
  1  the run failed, or the ledger did not verify
  2  configuration missing (provider credentials, --db)

Limits:
  - The provider must supply credentials via its usual environment variable
    (DEEPSEEK_API_KEY / OPENAI_API_KEY); the key never enters a prompt, a log,
    or the database.
  - The sub-agent task is local and read-only; no Notion write, no other
    external side effect.
  - One run is one task. A terminal task accepts nothing further; start a new
    task (a new conversation) for new work.`;

/** Poll the database for a recovery condition, then die uncleanly. */
function watchAndKill(databasePath: string, condition: string, intervalMs = 10): void {
	const deadline = Date.now() + 120_000;
	const poll = (): void => {
		try {
			// A raw read of the committed records; no Harness, no model.
			const require = createRequire(import.meta.url);
			const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
			const db = new DatabaseSync(databasePath, { readOnly: true });
			try {
				if (condition === "child-conversation") {
					const row = db.prepare("SELECT count(*) AS n FROM conversations WHERE owner_conversation_id IS NOT NULL").get() as
						| { n: number }
						| undefined;
					if ((row?.n ?? 0) > 0) return kill();
				}
				if (condition === "awaiting_review") {
					const doc = db
						.prepare("SELECT record FROM documents WHERE kind LIKE ? ORDER BY id DESC LIMIT 1")
						.get("%multiagent.task-ledger%") as { record?: string } | undefined;
					if ((doc?.record ?? "").includes('"awaiting_review"')) return kill();
				}
			} finally {
				db.close();
			}
		} catch {
			// Database not created yet, or a transient lock: keep polling.
		}
		if (Date.now() > deadline) return;
		setTimeout(poll, intervalMs);
	};
	poll();
}

function kill(): never {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.databasePath.trim() === "") throw new CliConfigError("--db <absolute sqlite path> is required");
	const requestId = args.requestId ?? `multiagent-smoke-${Date.now().toString(36)}`;

	const childInstructions = [
		"你是子 Agent，在一次独立会话中执行主 Agent 分发的任务。",
		"只使用任务授权的本地工具（text_stats / text_check 的子集），它们是本地、无副作用的。",
		"先用工具计算，再给最终答案；不要编造数字。",
	].join("\n");

	const runtime = await openProbe({
		databasePath: args.databasePath,
		provider: args.provider,
		extensions: [createMultiagentExtension({ model: { provider: args.provider, modelId: defaultModelId(args.provider) }, childInstructions })],
		registryExtensions: [ChildTools],
	});

	// The recovery watcher polls the committed ledger; it must start before the
	// submission so no condition can be missed.
	if (args.killWhen !== undefined) watchAndKill(args.databasePath, args.killWhen);

	const root = await openRoot(runtime);
	runtime.harness.resume();
	try {
		const submission = await root.submit({ type: "input", content: `${MAIN_PROMPT}\n\n文本：${MATERIAL}`, requestId }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			console.error(`run failed: ${settled.status}${settled.status === "unanswered" ? ` (${settled.reason})` : ""}`);
			return 1;
		}
		await runtime.harness.waitForIdle(context);

		// Verify the ledger the same way multiagent:inspect does, so a successful
		// exit means the durable records agree with what happened.
		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-smoke", context);
		if (ledger === undefined) {
			console.error("no task-smoke ledger was written");
			return 1;
		}
		if (ledger.status !== "accepted" && ledger.status !== "awaiting_review") {
			console.error(`ledger status is ${ledger.status}, not a settled task`);
			return 1;
		}
		for (const round of ledger.rounds) {
			if (round.submissionId === undefined || round.answerEntryId === undefined || round.evidence.length === 0) {
				console.error(`round ${round.round} is missing ids or evidence`);
				return 1;
			}
		}
		const answer = await root.commit((tx) => tx.entry(settled.answer), context);
		const text = (answer?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		console.log("── task-smoke ledger ──");
		console.log(
			JSON.stringify(
				{
					taskId: ledger.taskId,
					status: ledger.status,
					currentRound: ledger.currentRound,
					childConversationId: ledger.childConversationId ?? null,
					rounds: ledger.rounds.map((round) => ({
						round: round.round,
						requestId: round.requestId,
						submissionId: round.submissionId ?? null,
						answerEntryId: round.answerEntryId ?? null,
						evidence: round.evidence.map((evidence) => ({
							entryId: evidence.entryId,
							toolName: evidence.toolName ?? null,
							isError: evidence.isError ?? false,
						})),
					})),
					reviews: ledger.reviews,
				},
				null,
				1,
			),
		);
		console.log("── main agent's final answer ──");
		console.log(text ?? "(no text)");
		return 0;
	} finally {
		await runtime.close();
	}
}

function defaultModelId(provider: ProviderKind): string {
	if (provider === "deepseek") return "deepseek-flash";
	if (provider === "openai") return "gpt-4o-mini";
	return "faux-1";
}

main()
	.then((code) => process.exit(code))
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const config = error instanceof CliConfigError || /DEEPSEEK_API_KEY|OPENAI_API_KEY|api_key|baseUrl/.test(message);
		console.error(config ? `configuration: ${message}` : `run failed: ${message}`);
		process.exit(config ? 2 : 1);
	});
