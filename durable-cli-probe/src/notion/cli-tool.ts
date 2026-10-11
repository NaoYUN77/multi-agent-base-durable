// TASK-002 src/notion/cli-tool.ts
//
// `npm run notion:tool` — the Durable integration, end to end.
//
// The acceptance command in the task is:
//
//   node --conditions=source --experimental-strip-types src/cli.ts \
//     --provider faux --request-id notion-tool-test-1 "读取 Notion 页面并总结"
//
// That drives the *existing* src/cli.ts, which does not install the notion
// extension. This file is the same idea with the extension installed, so the
// durable path can actually be exercised:
//
//   1. build a read-only notion client from NOTION_TOKEN
//   2. build the `notion-read` extension from it
//   3. install it in the registry and select it for the root conversation
//   4. run one faux-driven turn whose tool calls hit the real Notion API
//   5. print the transcript entry kinds, proving `pi.tool-result` was committed
//   6. reopen the same SQLite file and re-read that entry, proving it survives
//
// Step 6 is the point: a tool result that only exists in memory would pass steps
// 1-5 and fail the task's requirement that the result be readable after restart.
//
// The faux provider is used for the model call so the run is deterministic and
// costs no model tokens; the tool's own HTTP traffic is real, read-only Notion.

import { createNotionClient } from "./client.ts";
import { createNotionExtension, NOTION_TOOL_NAME } from "./tool.ts";
import { loadNotionConfig, NOTION_TOKEN_ENV, hasNotionToken, notionPageIdFromEnv } from "../config.ts";
import { pinnedFetch } from "./client.ts";
import { notionPinIpFromEnv } from "./runtime.ts";
import { AssistantEntry, ToolResultEntry, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../runtime.ts";

const DATABASE_PATH = "./data/notion-tool.sqlite";
const REQUEST_ID = "notion-tool-test-1";

/** Entries of a conversation, oldest first. */
async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

function requireToken(): string {
	if (!hasNotionToken()) {
		console.error(`[notion] ${NOTION_TOKEN_ENV} is not set; export it to run the durable tool.`);
		process.exit(2);
	}
	return loadNotionConfig().token;
}

async function main(): Promise<void> {
	const token = requireToken();
	const pageId = notionPageIdFromEnv();
	const config = loadNotionConfig();
	const pinIp = notionPinIpFromEnv();
	const client = createNotionClient(config, pinIp === undefined ? {} : { fetch: pinnedFetch(pinIp) });
	const notionExtension = createNotionExtension({
		client,
		...(pageId === undefined ? {} : { defaultPageId: pageId }),
	});

	console.log(`[notion] tool=${NOTION_TOOL_NAME} extension=${notionExtension.name} page_id=${pageId ?? "(unset)"}${pinIp === undefined ? "" : ` pinned_ip=${pinIp}`}`);

	// ── First open: install, select, run one turn ──────────────────────────
	// The faux model is scripted to call `notion_read` twice: once to read the
	// page's properties and once to read its body. That makes the real `pi.tool`
	// task run, the real Notion API get hit, and a real `pi.tool-result` entry be
	// committed — which is the whole point of this command. A final text turn lets
	// the conversation settle so the submission reports `done`.
	const scriptedId = pageId ?? "00000000-0000-0000-0000-000000000000";
	const first: ProbeRuntime = await openProbe({
		databasePath: DATABASE_PATH,
		provider: "faux",
		fauxToolTurns: [
			[{ name: NOTION_TOOL_NAME, arguments: { action: "read_page", page_id: scriptedId } }],
			[{ name: NOTION_TOOL_NAME, arguments: { action: "read_blocks", page_id: scriptedId, limit: 25 } }],
		],
		fauxResponses: ["Notion reads complete."],
		extensions: [notionExtension],
	});
	let firstRootId: number;
	let firstKinds: string[];
	let toolResultEntryId: number | undefined;
	try {
		const root = await openRoot(first);
		firstRootId = root.id;
		first.harness.resume();

		console.log(`[notion] root conversation id=${root.id}`);
		const agent = await root.agent(context);
		console.log(`[notion] selected extensions: ${agent.extensions.map((extension) => extension.name).join(", ") || "(none)"}`);
		console.log(`[notion] offered tools: ${agent.tools.map((tool) => tool.name).join(", ") || "(none)"}`);

		// One durable turn. The model reply is faux, but the submission, the
		// generation task, and the committed assistant entry are all real.
		const submission = await root.submit(
			{ type: "input", content: "读取 Notion 页面并总结", requestId: REQUEST_ID },
			context,
		);
		const settled = await submission.wait(context);
		console.log(`[notion] submission=${REQUEST_ID} status=${settled.status}`);

		const entries = await allEntries(root);
		firstKinds = entries.map((entry) => entry.kind);
		toolResultEntryId = entries.find((entry) => entry.kind === "pi.tool-result")?.id;
		console.log(`[notion] transcript kinds: ${firstKinds.join(", ")}`);
		console.log(`[notion] tool-result entry: ${toolResultEntryId ?? "(none: model made no tool call)"}`);
	} finally {
		await first.close();
	}

	// ── Second open: the transcript must still be there, including any tool result ──
	const second = await openProbe({
		databasePath: DATABASE_PATH,
		provider: "faux",
		extensions: [notionExtension],
	});
	try {
		const root = await openRoot(second);
		console.log(`[notion] reopened root conversation id=${root.id} (first open: ${firstRootId})`);

		const reopened = await allEntries(root);
		const kinds = reopened.map((entry) => entry.kind);
		console.log(`[notion] reopened transcript kinds: ${kinds.join(", ")}`);
		console.log(`[notion] transcript survived restart: ${kinds.join(",") === firstKinds.join(",")}`);

		if (toolResultEntryId !== undefined) {
			// Re-read the exact tool-result entry through a commit, proving it was
			// persisted and is addressable, not merely present in a page listing.
			const entry = await root.commit((tx) => tx.entry(ToolResultEntry, toolResultEntryId as never), context);
			const message = entry?.model?.[0];
			const content = message?.role === "toolResult" ? message.content : undefined;
			const text = Array.isArray(content)
				? content.flatMap((part) => (typeof part === "object" && part !== null && "text" in part ? [String((part as { text?: unknown }).text ?? "")] : [])).join("")
				: "";
			console.log(`[notion] tool-result recovered: id=${entry?.id} chars=${text.length}`);
			console.log(`[notion] tool-result preview: ${text.slice(0, 160).replace(/\n/g, " ⏎ ")}`);
		} else {
			console.log("[notion] no tool-result entry to recover (the faux model made no tool call)");
		}

		// Idempotency: resubmitting the same requestId must not append anything.
		const replay = await root.submit(
			{ type: "input", content: "读取 Notion 页面并总结", requestId: REQUEST_ID },
			context,
		);
		const replayed = await replay.wait(context);
		const after = await allEntries(root);
		console.log(`[notion] replay status=${replayed.status} entries=${after.length} (was ${reopened.length})`);
		console.log(`[notion] requestId idempotent: ${after.length === reopened.length}`);
	} finally {
		await second.close();
	}

	// A direct read through the same client, so the run proves the API works even
	// when the faux model never calls the tool.
	try {
		const { usersMe } = await import("./read.ts");
		const me = await usersMe(client);
		console.log(`[notion] token ok: bot=${me.name} id=${me.id}`);
	} catch (error) {
		console.error(`[notion] token check failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

await main();
