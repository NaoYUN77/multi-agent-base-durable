// TASK-003 src/multiagent/cli-multiagent.ts
//
// `npm run multiagent:probe -- --provider deepseek --db <absolute path> --request-id <id>`
//
// The acceptance entry point for one real main/sub-agent run. It drives only the
// existing machinery — the management tools, the built-in generation and tool
// tasks, the delegation round — and implements no model loop of its own.
//
// The two runtime prompts are the files the agent actually receives:
// `prompts/multiagent/main.md` becomes the main conversation's instructions and
// `prompts/multiagent/sub.md` the child conversation's. They are loaded here, so
// the repository holds exactly one copy of each.
//
// The sub-agent's task is local and side-effect-free: counting and checking
// text. No Notion write, no network beyond the model API.
//
// Exit codes, matching the rest of the probe:
//   2  configuration — a required variable, id, or file is missing
//   1  the run did not reach a *verified* acceptance (including a run that
//      stopped at awaiting_review because the main model never reviewed, or one
//      whose evidence does not support the task's own acceptance rule)
//   0  the run completed, the task is accepted, and the program's acceptance
//      check on the persisted evidence passed
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
//   revising-intent     a revision round's intent is committed but its
//                       submission has not settled
//   tool-running        a `pi.tool` task of the child conversation is running
//                       (the local tool is mid-execution)

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { context, openProbe, openRoot, type ProviderKind } from "../runtime.ts";
import { ChildTools } from "./child-tools.ts";
import { createMultiagentExtension } from "./tools.ts";
import { TaskLedgerDoc } from "./ledger.ts";

/** The material the smoke task operates on. Kept here so the task text and the
 * program-side acceptance check read the same constant. */
const MATERIAL = "MATERIAL-SMOKE- alpha beta MATERIAL gamma";
/** Substring occurrences of `MATERIAL` in MATERIAL — the acceptance value. */
const EXPECTED_COUNT = 2;

const TASK_REQUEST = [
	`素材（原样，不要改动）：${MATERIAL}`,
	'请统计子串 "MATERIAL" 在素材中出现的次数，并说明是否 found。',
].join("\n");

const MAIN_USER_INPUT = [
	"请完成下面这件事，并走完委派→验收闭环：",
	'委派时请使用任务 ID "task-smoke"（便于事后用 multiagent:inspect 取证）。',
	TASK_REQUEST,
	"验收要求：工具证据里 text_stats 的 text 参数必须是完整素材本身，marker 为 \"MATERIAL\"，",
	`且计数必须等于素材中子串 MATERIAL 的实际出现次数（${EXPECTED_COUNT}）。`,
	'审阅时 task_review 必须带 round（用委派报告里的轮次号）；证据满足就 accept，不满足就 reject 并说明差在哪里。',
	"最后用中文给出结论。",
].join("\n");

const PROMPTS_DIR = new URL("../../prompts/multiagent/", import.meta.url);

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
  one local task (count a marker in a given material). The main agent delegates
  through the program-side tools, receives the final answer plus the per-tool
  evidence, and reviews. The runtime prompts are the files the agents actually
  receive: prompts/multiagent/main.md and prompts/multiagent/sub.md.

  Exit 0 requires a *verified* acceptance: the task must be accepted, the final
  answer must be non-empty, and the persisted tool evidence must satisfy the
  task's own acceptance rule. Stopping at awaiting_review is a non-success exit.

Scripted verification entry points:
  npm run multiagent:test            deterministic AC-01..08 checks, no network
  npm run multiagent:inspect -- --db <same path> --task-id <task id>
                                     read-only ledger and evidence inspection

Exit codes:
  0  accepted, with the evidence check passing
  1  not accepted / not verified (including unreviewed or failed runs)
  2  configuration missing (provider credentials, --db, prompt files)

Limits:
  - The provider must supply credentials via its usual environment variable
    (DEEPSEEK_API_KEY / OPENAI_API_KEY); the key never enters a prompt, a log,
    or the database.
  - The sub-agent task is local and read-only; no Notion write, no other
    external side effect.
  - One run is one task. A terminal task accepts nothing further; start a new
    task (a new conversation) for new work.`;

/** Poll the database for a recovery condition, then die uncleanly. */
function watchAndKill(databasePath: string, condition: string, intervalMs = 5): void {
	const require = createRequire(import.meta.url);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const deadline = Date.now() + 120_000;
	const poll = (): void => {
		try {
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
				if (condition === "revising-intent") {
					// A ledger is `revising` while its newest round still has no submission.
					const docs = db.prepare("SELECT id FROM documents WHERE kind LIKE ?").all("%multiagent.task-ledger%") as { id: number }[];
					for (const doc of docs) {
						const rev = db
							.prepare("SELECT content FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1")
							.get(doc.id) as { content?: string } | undefined;
						const text = rev?.content ?? "";
						if (text.includes("revising") && text.includes("multiagent-round:") && !text.includes("submissionId")) return kill();
					}
				}
				if (condition === "tool-running") {
					const row = db.prepare("SELECT count(*) AS n FROM tasks WHERE kind = ? AND status = ?").get("pi.tool", "running") as
						| { n: number }
						| undefined;
					if ((row?.n ?? 0) > 0) return kill();
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

/** The instructions section of a conversation's `pi.system` entry, if any. */
async function instructionsOf(runtime: Awaited<ReturnType<typeof openProbe>>, conversationId: number): Promise<string | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	if (conversation === undefined) return undefined;
	const entries = await conversation.entries({ order: "ascending" }, 200, undefined, context);
	for (const entry of entries.items) {
		if (entry.kind !== "pi.system") continue;
		for (const message of entry.model ?? []) {
			const sections = (message as { sections?: Record<string, string | null> }).sections;
			if (sections?.instructions !== undefined && sections.instructions !== null) return sections.instructions;
		}
	}
	return undefined;
}

function loadPrompt(name: string): string {
	const path = fileURLToPath(new URL(name, PROMPTS_DIR));
	try {
		return readFileSync(path, "utf8");
	} catch {
		throw new CliConfigError(`prompt file not found or unreadable: ${path}`);
	}
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.databasePath.trim() === "") throw new CliConfigError("--db <absolute sqlite path> is required");
	const requestId = args.requestId ?? `multiagent-smoke-${Date.now().toString(36)}`;

	const mainPrompt = loadPrompt("main.md");
	const childPrompt = loadPrompt("sub.md");

	const runtime = await openProbe({
		databasePath: args.databasePath,
		provider: args.provider,
		extensions: [
			createMultiagentExtension({
				model: { provider: args.provider, modelId: defaultModelId(args.provider) },
				childInstructions: childPrompt,
			}),
		],
		registryExtensions: [ChildTools],
	});

	// The recovery watcher polls the committed records; it must start before the
	// submission so no condition can be missed.
	if (args.killWhen !== undefined) watchAndKill(args.databasePath, args.killWhen);

	const root = await openRoot(runtime);
	runtime.harness.resume();
	try {
		// The main conversation's instructions are the prompt file, not prose
		// embedded in the user turn.
		await root.configure({ instructions: mainPrompt }, context);
		const submission = await root.submit({ type: "input", content: MAIN_USER_INPUT, requestId }, context);
		const settled = await submission.wait(context);
		if (settled.status !== "done" || settled.type !== "input") {
			console.error(`run failed: ${settled.status}${settled.status === "unanswered" ? ` (${settled.reason})` : ""}`);
			return 1;
		}
		await runtime.harness.waitForIdle(context);

		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-smoke", context);
		if (ledger === undefined) {
			console.error("no task-smoke ledger was written");
			return 1;
		}
		const answerEntry = await root.commit((tx) => tx.entry(settled.answer), context);
		const answerText = (answerEntry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();

		console.log("── task-smoke ledger ──");
		console.log(
			JSON.stringify(
				{
					taskId: ledger.taskId,
					status: ledger.status,
					version: ledger.version,
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
							argsSummary: evidence.argsSummary ?? null,
							truncated: evidence.truncated,
						})),
					})),
					reviews: ledger.reviews,
				},
				null,
				1,
			),
		);
		console.log("── main agent's final answer ──");
		console.log(answerText === undefined || answerText === "" ? "(no text)" : answerText);

		// ── The prompt files must be what the agents actually received ────────
		const mainInstalled = await instructionsOf(runtime, root.id);
		if (mainInstalled === undefined || !mainInstalled.includes("主 Agent 运行时指令")) {
			console.error("prompt check failed: the main conversation does not carry prompts/multiagent/main.md as its instructions.");
			return 1;
		}
		if (ledger.childConversationId === undefined) {
			console.error("prompt check failed: no child conversation to inspect.");
			return 1;
		}
		const childInstalled = await instructionsOf(runtime, ledger.childConversationId);
		if (childInstalled === undefined || !childInstalled.includes("子 Agent 运行时指令")) {
			console.error("prompt check failed: the child conversation does not carry prompts/multiagent/sub.md as its instructions.");
			return 1;
		}
		console.log("── prompts verified: main.md and sub.md are the installed instructions ──");

		// ── Program-side acceptance verification ─────────────────────────────
		// Success requires an actual acceptance, a non-empty answer, and persisted
		// evidence that supports the task's own rule: a successful text_stats run
		// over the *whole material* with marker MATERIAL counting EXPECTED_COUNT.
		if (ledger.status !== "accepted") {
			console.error(`not accepted: task-smoke is ${ledger.status}; the main model did not close the loop.`);
			return 1;
		}
		if (answerText === undefined || answerText === "") {
			console.error("not accepted: the final answer is empty.");
			return 1;
		}
		const stats = ledger.rounds
			.flatMap((round) => round.evidence)
			.filter((evidence) => evidence.toolName === "text_stats" && evidence.isError !== true);
		// The ledger stores a *redacted* argument summary (a 41-character string
		// becomes `<string:41>`), so the check reads the shape and the length, and
		// ties them to the tool's own reported counts — it does not require the
		// payload to be echoed.
		const verified = stats.find(
			(evidence) =>
				/marker:"MATERIAL"/.test(evidence.argsSummary ?? "") &&
				new RegExp(`text:<string:${MATERIAL.length}>|${MATERIAL}`).test(evidence.argsSummary ?? "") &&
				new RegExp(`count=${EXPECTED_COUNT}\\b`).test(evidence.excerpt) &&
				new RegExp(`chars=${MATERIAL.length}\\b`).test(evidence.excerpt),
		);
		if (verified === undefined) {
			console.error(`not accepted: no text_stats evidence shows the full material counted with marker MATERIAL at count=${EXPECTED_COUNT}.`);
			for (const evidence of stats) {
				console.error(`  saw entry=${evidence.entryId} args=${evidence.argsSummary ?? "-"} excerpt=${evidence.excerpt.slice(0, 120)}`);
			}
			return 1;
		}
		console.log(`── verified: entry ${verified.entryId} counted MATERIAL in the material (count=${EXPECTED_COUNT}) ──`);
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
