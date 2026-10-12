// Issue #3 src/article/cli-article.ts
//
// `npm run article:probe -- --provider <faux|deepseek> --input <path> --db <path> --request-id <id>`
//
// The acceptance entry point. It drives the *existing* Durable machinery —
// submission, the built-in generation task, the built-in `pi.tool` task — and
// implements no model loop of its own. The only thing it adds is the article
// tool and the spec that tells the model how to use it.
//
// Two modes, and the difference matters for what may be claimed:
//
//   faux      the model's reply is scripted from a fixture, so the run is
//             deterministic and needs no credentials. The Notion traffic is
//             still real unless the caller injects a client. A faux run proves
//             the wiring, never that a real model can do the task.
//   deepseek  a real model reads the spec and the article and issues the tool
//             call itself. This is the only mode that can support a claim about
//             model behaviour.
//
// Exit codes, matching the rest of the probe:
//   2  configuration — a required file, variable, or id is missing
//   1  the run failed, or produced a result that did not verify
//   0  the page was created and read back identical
//
// The token is read from the environment and handed to the SDK. It is never
// printed, never placed in the prompt, and never written to the transcript.

import { readFileSync } from "node:fs";
import { ToolResultEntry, type Conversation, type EntryRecord, type JsonObject } from "@earendil-works/pi-durable";
import {
	NotionConfigError,
	hasNotionToken,
	loadNotionConfig,
	requireArticleParentPageId,
	NOTION_TOKEN_ENV,
} from "../config.ts";
import { createNotionClient, pinnedFetch } from "../notion/client.ts";
import { createNotionWriteExtension, NOTION_WRITE_TOOL_NAME } from "../notion/article-tool.ts";
import { ArticleInputError, parseArticleInput, type ArticleInput } from "./contract.ts";
import { ARTICLE_SPEC_RELATIVE_PATH, ArticleSpecError, buildAnalysisPrompt, loadArticleSpec } from "./spec.ts";
import { context, openProbe, openRoot, type ProbeRuntime, type ProviderKind } from "../runtime.ts";
import { notionPinIpFromEnv } from "../notion/runtime.ts";

/** Raised for a configuration problem; the CLI maps it to exit code 2. */
class ArticleCliConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArticleCliConfigError";
	}
}

interface Args {
	readonly provider: ProviderKind;
	readonly inputPath: string;
	readonly databasePath: string;
	readonly requestId: string | undefined;
	readonly modelId: string | undefined;
	readonly fauxAnalysisPath: string;
	readonly parentPageId: string | undefined;
}

const DEFAULT_INPUT = "test/fixtures/article-sample.json";
const DEFAULT_DB = "./data/article-probe.sqlite";
const DEFAULT_FAUX_ANALYSIS = "test/fixtures/article-analysis.faux.json";

function parseArgs(argv: readonly string[]): Args {
	let provider: ProviderKind = "faux";
	let inputPath = DEFAULT_INPUT;
	let databasePath = DEFAULT_DB;
	let requestId: string | undefined;
	let modelId: string | undefined;
	let fauxAnalysisPath = DEFAULT_FAUX_ANALYSIS;
	let parentPageId: string | undefined;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		const next = (): string => {
			const value = argv[++index];
			if (value === undefined) throw new ArticleCliConfigError(`${arg} requires a value`);
			return value;
		};
		if (arg === "--provider") {
			const value = next();
			if (value !== "faux" && value !== "deepseek") {
				throw new ArticleCliConfigError(`--provider must be faux or deepseek, got ${value}`);
			}
			provider = value;
		} else if (arg === "--input") inputPath = next();
		else if (arg === "--db") databasePath = next();
		else if (arg === "--request-id") requestId = next();
		else if (arg === "--model") modelId = next();
		else if (arg === "--faux-analysis") fauxAnalysisPath = next();
		else if (arg === "--parent-page-id") parentPageId = next();
		else if (arg.startsWith("--")) throw new ArticleCliConfigError(`unknown argument: ${arg}`);
		else throw new ArticleCliConfigError(`unexpected positional argument: ${arg}`);
	}

	return { provider, inputPath, databasePath, requestId, modelId, fauxAnalysisPath, parentPageId };
}

function readJsonFile(path: string, what: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ArticleCliConfigError(`${what} ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ArticleCliConfigError(`${what} ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** All entries of a conversation, oldest first. */
async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

/** Flatten a tool-result entry's text content. */
function toolResultText(entry: { model?: readonly { role?: string; content?: unknown }[] } | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "toolResult") return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			typeof part === "object" && part !== null && "text" in part ? [String((part as { text?: unknown }).text ?? "")] : [],
		)
		.join("");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	// ── Configuration, all checked before anything is sent ────────────────────
	if (!hasNotionToken()) {
		throw new ArticleCliConfigError(
			`${NOTION_TOKEN_ENV} is not set. Export it first, e.g. read -rs NOTION_TOKEN && export NOTION_TOKEN`,
		);
	}
	const parentPageId = requireArticleParentPageId(args.parentPageId);
	const rawInput = readJsonFile(args.inputPath, "article input");
	let article: ArticleInput;
	try {
		article = parseArticleInput(rawInput);
	} catch (error) {
		if (error instanceof ArticleInputError) throw new ArticleCliConfigError(error.message);
		throw error;
	}
	if (args.requestId !== undefined && args.requestId !== article.requestId) {
		// The flag wins, but say so — a silent override would break replay reasoning.
		console.log(`[article] requestId overridden by --request-id: ${args.requestId} (input had ${article.requestId})`);
	}
	const requestId = args.requestId ?? article.requestId;

	let spec: string;
	try {
		spec = loadArticleSpec();
	} catch (error) {
		if (error instanceof ArticleSpecError) throw new ArticleCliConfigError(error.message);
		throw error;
	}

	const prompt = buildAnalysisPrompt(spec, article);

	console.log(`[article] provider=${args.provider} input=${args.inputPath}`);
	console.log(`[article] title=${JSON.stringify(article.title)} source=${JSON.stringify(article.source)}`);
	console.log(`[article] paragraphs=${article.paragraphs.length} request_id=${requestId}`);
	console.log(`[article] spec=${ARTICLE_SPEC_RELATIVE_PATH} chars=${spec.length}`);
	console.log(`[article] parent_page_id=${parentPageId}`);

	// ── Build the client and the tool ─────────────────────────────────────────
	const config = loadNotionConfig();
	const pinIp = notionPinIpFromEnv();
	const client = createNotionClient(config, pinIp === undefined ? {} : { fetch: pinnedFetch(pinIp) });

	const writeExtension = createNotionWriteExtension({ client, parentPageId, article });

	// ── Faux scripting ────────────────────────────────────────────────────────
	// In faux mode the model's reply is fixed, so the tool call is written out
	// here. The analysis still goes through the same validation the real path
	// uses — the fixture is not trusted either.
	let fauxToolTurns: { name: string; arguments: JsonObject }[][] | undefined;
	if (args.provider === "faux") {
		const fixture = readJsonFile(args.fauxAnalysisPath, "faux analysis");
		const analysis = (fixture as { analysis?: unknown }).analysis ?? fixture;
		fauxToolTurns = [
			[{ name: NOTION_WRITE_TOOL_NAME, arguments: analysis as JsonObject }],
		];
	}

	const runtime: ProbeRuntime = await openProbe({
		databasePath: args.databasePath,
		provider: args.provider,
		...(args.modelId === undefined ? {} : { modelId: args.modelId }),
		...(fauxToolTurns === undefined ? {} : { fauxToolTurns, fauxResponses: ["Article processed."] }),
		extensions: [writeExtension],
	});

	let failed = false;
	try {
		const root = await openRoot(runtime);
		runtime.harness.resume();

		console.log(`[article] db=${args.databasePath} provider=${runtime.modelRef.provider} model=${runtime.modelRef.modelId}`);
		console.log(`[article] root conversation id=${root.id}`);
		console.log(`[article] installed extensions: ${runtime.installedExtensions.join(", ") || "(none)"}`);

		const submission = await root.submit({ type: "input", content: prompt, requestId }, context);
		const settled = await submission.wait(context);
		console.log(`[article] submission=${requestId} status=${settled.status}`);

		const entries = await allEntries(root);
		const kinds = entries.map((entry) => entry.kind);
		const toolResultIds = entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => entry.id);
		console.log(`[article] transcript kinds: ${kinds.join(", ")}`);
		console.log(`[article] tool-result entries: ${toolResultIds.join(", ") || "(none)"}`);

		if (toolResultIds.length === 0) {
			// No tool call means no page. Say so plainly rather than reporting success.
			console.log(`[article] FAIL: the model did not call ${NOTION_WRITE_TOOL_NAME}; no page was created.`);
			failed = true;
		} else {
			// Report every tool result, and treat any error result as a failure.
			for (const id of toolResultIds) {
				const entry = await root.commit((tx) => tx.entry(ToolResultEntry, id as never), context);
				const text = toolResultText(entry as { model?: readonly { role?: string; content?: unknown }[] });
				const isError = (entry as { model?: readonly { isError?: unknown }[] })?.model?.[0]?.isError === true;
				console.log(`[article] --- tool-result ${id}${isError ? " (isError)" : ""} ---`);
				for (const line of text.split("\n")) console.log(`[article]   ${line}`);
				if (isError) failed = true;
			}
		}

		if (runtime.reports.length > 0) {
			console.log(`[article] harness reports: ${runtime.reports.length}`);
			for (const report of runtime.reports) {
				console.log(`[article]   ${report instanceof Error ? report.message : String(report)}`);
			}
			failed = true;
		}
	} finally {
		await runtime.close();
	}

	process.exitCode = failed ? 1 : 0;
}

/** The spec's path, for the banner. Kept separate so the banner cannot throw. */
await main().catch((error: unknown) => {
	if (error instanceof ArticleCliConfigError || error instanceof NotionConfigError) {
		console.error(`[article] ${error.message}`);
		process.exit(2);
	}
	console.error(`[article] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
