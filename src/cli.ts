// TASK-001 src/cli.ts
//
// Minimal CLI: one prompt in, one durable answer out.
//
// Usage:
//   node --conditions=source --experimental-strip-types src/cli.ts [prompt...]
//
// Flags (all optional):
//   --db <path>        SQLite file (default ./data/probe.sqlite)
//   --provider <kind>  faux | deepseek | openai | custom (default faux)
//   --model <id>       model id (default per provider; required for custom)
//   --request-id <id>  submission requestId (default job-1); reuse it to prove idempotency
//   --base-url <url>   base URL for --provider custom (deepseek/openai have it built in)
//   --api-key-env <N>  env var holding the key for --provider custom (default PROBE_API_KEY)
//
// For --provider deepseek the key is read from DEEPSEEK_API_KEY, base_url is
// https://api.deepseek.com, and the model ids are the checkout's catalog:
// deepseek-flash (default) and deepseek-v4-pro.
//
// The API key is read from an environment variable, never from argv, so it does
// not appear in the shell history or in a process listing. This program never
// prints it, logs it, or writes it to SQLite.

import { AssistantEntry } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProviderKind } from "./runtime.ts";

interface Args {
	readonly prompt: string;
	readonly databasePath: string;
	readonly provider: ProviderKind;
	readonly modelId: string | undefined;
	readonly requestId: string;
	readonly baseUrl: string | undefined;
	readonly apiKeyEnv: string;
}

function parseArgs(argv: readonly string[]): Args {
	let databasePath = "./data/probe.sqlite";
	let provider: ProviderKind = "faux";
	let modelId: string | undefined;
	let requestId = "job-1";
	let baseUrl: string | undefined;
	let apiKeyEnv = "PROBE_API_KEY";
	const words: string[] = [];

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--db") databasePath = argv[++index] ?? databasePath;
		else if (arg === "--provider") {
			const value = argv[++index];
			if (value !== "faux" && value !== "deepseek" && value !== "openai" && value !== "custom") {
				throw new Error(`Unknown provider: ${value}`);
			}
			provider = value;
		} else if (arg === "--model") modelId = argv[++index];
		else if (arg === "--request-id") requestId = argv[++index] ?? requestId;
		else if (arg === "--base-url") baseUrl = argv[++index];
		else if (arg === "--api-key-env") apiKeyEnv = argv[++index] ?? apiKeyEnv;
		else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
		else words.push(arg);
	}

	const prompt = words.join(" ").trim() || "Say hello in one short sentence.";
	return { prompt, databasePath, provider, modelId, requestId, baseUrl, apiKeyEnv };
}

/** Flatten an assistant message's text blocks into one string. */
function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text";
		})
		.map((part) => part.text)
		.join("");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	// The key is read from the environment only when the custom provider is used,
	// and is handed to the provider as an in-memory string.
	const apiKey = args.provider === "custom" ? process.env[args.apiKeyEnv] : undefined;
	if (args.provider === "custom" && (apiKey === undefined || apiKey === "")) {
		throw new Error(`--provider custom requires the key in env var ${args.apiKeyEnv}`);
	}

	const runtime = await openProbe({
		databasePath: args.databasePath,
		provider: args.provider,
		...(args.modelId === undefined ? {} : { modelId: args.modelId }),
		...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
		...(apiKey === undefined ? {} : { apiKey }),
		...(args.provider === "faux" ? { fauxResponses: ["Hello from durable."] } : {}),
	});

	try {
		const root = await openRoot(runtime);
		// resume() enables scheduling; submit() also does it, but being explicit
		// makes the recovered-work path visible when reopening a database.
		runtime.harness.resume();

		console.log(`[probe] db=${args.databasePath} provider=${runtime.modelRef.provider} model=${runtime.modelRef.modelId}`);
		console.log(`[probe] root conversation id=${root.id}`);

		const submission = await root.submit(
			{ type: "input", content: args.prompt, requestId: args.requestId },
			context,
		);
		const settled = await submission.wait(context);

		if (settled.status === "done" && settled.type === "input") {
			// The answer entry is read back through a commit, so the text printed is
			// the committed transcript, not an in-memory echo.
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
			const message = entry?.model?.[0];
			const text = message?.role === "assistant" ? assistantText(message.content) : "";
			console.log(`[probe] submission=${args.requestId} status=done`);
			console.log(`[probe] answer: ${text}`);
		} else {
			console.log(`[probe] submission=${args.requestId} status=${settled.status}`);
			if (settled.status === "unanswered") {
				console.log(`[probe] reason=${settled.reason}`);
			}
		}

		// A readable transcript proves the entries were persisted, not just echoed.
		const page = await root.entries({}, 20, undefined, context);
		const kinds = [...page.items].reverse().map((entry) => entry.kind);
		console.log(`[probe] transcript kinds: ${kinds.join(", ")}`);

		if (runtime.reports.length > 0) {
			console.log(`[probe] harness reports: ${runtime.reports.length}`);
			for (const report of runtime.reports) {
				console.log(`[probe]   ${report instanceof Error ? report.message : String(report)}`);
			}
		}
	} finally {
		await runtime.close();
	}
}

await main();
