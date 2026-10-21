// TASK-002 src/notion/tool.ts
//
// The read-only Notion tool, as a named Durable extension.
//
// How it enters Durable: `defineTool()` types a `ToolRegistration`; `defineExtension()`
// bundles it under a name; `registry.install(notionExtension)` puts it in the
// application-owned registry, and a conversation selects the extension by name
// through `agent.extensions`. The built-in `pi.tool` task is what actually runs
// it — the probe implements no agent loop and no task of its own.
//
// Why `replay: "safe"`: every call here is a read. A crash mid-call may rerun the
// tool; for a GET that is harmless and desirable, because the rerun reattaches to
// the same committed result instead of leaving a gap. A tool that wrote to Notion
// would have to be `unsafe`, which is one reason writes are out of scope.
//
// Why the output is bounded: `output` is what a model reads, and it is committed
// into the transcript. A whole page of blocks or a full search result would bloat
// the transcript and the model's context. The tool returns a flattened outline
// (read.ts renders it) under explicit line and byte limits.
//
// The token is never touched here. The tool reads it once at build time from the
// environment and closes over a client; the closure is process memory, never
// persisted.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Client } from "@notionhq/client";
import { NotionRequestError } from "./client.ts";
import {
	blockChildren,
	DEFAULT_MAX_BLOCKS,
	DEFAULT_MAX_BLOCK_PAGES,
	DEFAULT_MAX_PROPERTY_VALUE_CHARS,
	DEFAULT_MAX_PROPERTIES,
	DEFAULT_SEARCH_LIMIT,
	DEFAULT_SEARCH_MAX_PAGES,
	DEFAULT_SEARCH_PAGE_SIZE,
	pageSummary,
	renderBlockLines,
	renderSearchResult,
	search,
} from "./read.ts";

/** The name the model calls, and the extension name a conversation selects. */
export const NOTION_TOOL_NAME = "notion_read";
export const NOTION_EXTENSION_NAME = "notion-read";

/** Bounded output sizes; these are what keep one read from flooding the transcript. */
export const TOOL_OUTPUT_LIMITS = { maxBytes: 24_000, maxLines: 600 } as const;

const notionReadSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("search", { description: "Search pages and data sources shared with the connection." }),
			Type.Literal("read_page", { description: "Read a page's properties (its database columns, if any)." }),
			Type.Literal("read_blocks", { description: "Read a page's or block's body as a flattened outline." }),
		],
		{ description: "Which read to perform." },
	),
	query: Type.Optional(Type.String({ description: "For action=search: text to match in titles. Omit to list everything shared." })),
	object: Type.Optional(
		Type.Union([Type.Literal("page"), Type.Literal("data_source")], {
			description: "For action=search: restrict results to pages or to data sources.",
		}),
	),
	page_id: Type.Optional(Type.String({ description: "For read_page/read_blocks: the page id, with or without dashes." })),
	block_id: Type.Optional(Type.String({ description: "For read_blocks: a block id to read instead of a page id." })),
	limit: Type.Optional(Type.Number({ description: "Maximum items to collect (search hits or block lines)." })),
});

/** What the extension needs to build its tool. */
export interface NotionToolOptions {
	readonly client: Client;
	/** Whether to fall back to `NOTION_PAGE_ID` when the model omits the id. */
	readonly defaultPageId?: string;
	readonly searchLimit?: number;
	readonly blockLimit?: number;
}

/**
 * The tool's `details`: what a UI shows, and what the probe prints.
 *
 * Typed as a `Record<string, JsonValue>` alias rather than an `interface` on
 * purpose: the Durable `details` channel requires a `JsonValue`, and a bare
 * interface has no index signature, so it does not satisfy that constraint. An
 * index signature keeps the keys documented without weakening the JSON contract.
 */
type NotionToolDetails = {
	readonly [key: string]: string | number | boolean;
	readonly action: "search" | "read_page" | "read_blocks";
	/** Search: hits returned. Read_page: properties shown. Read_blocks: block objects seen. */
	readonly count: number;
	readonly truncated: boolean;
	/** Search only. */
	readonly hasMore: boolean;
	/** Read_blocks only. */
	readonly lineCount: number;
	readonly hasNestedChildren: boolean;
}

/**
 * Build the `notion_read` tool.
 *
 * The tool is read-only by construction: it exposes exactly three actions, all of
 * which map to a GET, and it has no branch that writes. Adding a write action
 * would mean changing this file and the constraint that allows it, which is the
 * point of keeping the surface this small.
 */
export function createNotionReadTool(options: NotionToolOptions) {
	const { client, defaultPageId } = options;
	const searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
	const blockLimit = options.blockLimit ?? DEFAULT_MAX_BLOCKS;

	return defineTool({
		name: NOTION_TOOL_NAME,
		description:
			"Read from Notion, read-only. action=search finds pages and data sources shared with the connection; " +
			"action=read_page returns a page's properties (the columns of a database row); action=read_blocks returns a " +
			"page or block's body as a flattened outline. Page properties and page body are different: read both when you " +
			"need the full picture. Results are bounded; do not assume they are complete.",
		parameters: notionReadSchema,
		// Every action is a GET: safe to rerun after a crash.
		replay: "safe",
		outputLimits: TOOL_OUTPUT_LIMITS,
		async execute(args, api): Promise<import("@earendil-works/pi-durable").ToolExecutionResult<NotionToolDetails>> {
			try {
				if (args.action === "search") {
					const result = await search(client, {
						...(args.query === undefined ? {} : { query: args.query }),
						...(args.object === undefined ? {} : { object: args.object }),
						limit: args.limit ?? searchLimit,
						pageSize: DEFAULT_SEARCH_PAGE_SIZE,
						maxPages: DEFAULT_SEARCH_MAX_PAGES,
					});
					const text = renderSearchResult(result);
					api.output(text);
					return {
						output: [{ type: "text" as const, text }],
						details: {
							action: "search",
							count: result.total,
							truncated: result.truncated,
							hasMore: result.hasMore,
							lineCount: 0,
							hasNestedChildren: false,
						},
					};
				}

				const id = args.page_id ?? args.block_id ?? defaultPageId;
				if (id === undefined || id.trim() === "") {
					return {
						output: [{ type: "text" as const, text: "No page id given and NOTION_PAGE_ID is not set." }],
						isError: true,
						details: { action: args.action, count: 0, truncated: false, hasMore: false, lineCount: 0, hasNestedChildren: false },
						diagnostics: [{ severity: "error" as const, code: "missing_id", message: "pass page_id or block_id" }],
					};
				}

				if (args.action === "read_page") {
					const page = await pageSummary(client, id, {
						maxProperties: DEFAULT_MAX_PROPERTIES,
						maxValueChars: DEFAULT_MAX_PROPERTY_VALUE_CHARS,
					});
					const propertyLines = Object.entries(page.properties).map(([name, value]) => `  ${name}: ${value}`);
					const text = [
						`page ${page.title}`,
						`id: ${page.id}`,
						...(page.url === undefined ? [] : [`url: ${page.url}`]),
						`properties (${propertyLines.length}${page.propertiesTruncated ? ", truncated" : ""}):`,
						...(propertyLines.length === 0 ? ["  (none)"] : propertyLines),
						"note: properties are not the page body; use action=read_blocks for its content",
					].join("\n");
					api.output(text);
					return {
						output: [{ type: "text" as const, text }],
						details: {
							action: "read_page",
							count: propertyLines.length,
							truncated: page.propertiesTruncated,
							hasMore: false,
							lineCount: propertyLines.length,
							hasNestedChildren: false,
						},
					};
				}

				const children = await blockChildren(client, id, {
					limit: args.limit ?? blockLimit,
					maxPages: DEFAULT_MAX_BLOCK_PAGES,
				});
				const text = renderBlockLines(children);
				api.output(text);
				return {
					output: [{ type: "text" as const, text }],
					details: {
						action: "read_blocks",
						count: children.blockCount,
						truncated: children.truncated,
						hasMore: false,
						lineCount: children.lines.length,
						hasNestedChildren: children.hasNestedChildren,
					},
				};
			} catch (error) {
				// A Notion failure becomes a tool error the model can read, not a crash.
				if (error instanceof NotionRequestError) {
					return {
						output: [{ type: "text" as const, text: `Notion error: ${error.info.code} — ${error.info.message}` }],
						isError: true,
						details: { action: args.action, count: 0, truncated: false, hasMore: false, lineCount: 0, hasNestedChildren: false },
						diagnostics: [
							{
								severity: "error" as const,
								code: error.info.code,
								message: error.message,
							},
						],
					};
				}
				throw error;
			}
		},
	});
}

/**
 * The `notion-read` extension: one tool, no sections, no hooks, no tasks.
 *
 * Kept minimal on purpose. A prompt section describing the tool would double the
 * tool's own description; hooks and tasks belong to a real integration, not to a
 * read-only probe.
 */
export function createNotionExtension(options: NotionToolOptions) {
	return defineExtension({
		name: NOTION_EXTENSION_NAME,
		tools: [createNotionReadTool(options)],
	});
}
