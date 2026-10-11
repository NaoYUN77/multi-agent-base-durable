// TASK-002 src/notion/read.ts
//
// The four read operations, each returning a narrow projection (types.ts).
//
// Design rules this file follows, all from the task:
//
//  * Read-only. Only `users.me`, `search`, `pages.retrieve`, and
//    `blocks.children.list` are called. There is no write path here at all.
//  * Never hand a raw response to the model. Every call projects down to the
//    small types in types.ts before returning; a page object's `properties` is
//    flattened to `name → value` strings, not passed through as JSON.
//  * Paginate explicitly. Notion caps `page_size` and returns `has_more` +
//    `next_cursor`; the probe walks pages up to a bound and says when it stopped,
//    rather than silently returning a truncated list.
//  * Bounded work. `maxBlocks` and `maxPages` bound a read so one large page
//    cannot consume the probe's budget or the model's context.
//
// The functions take a client plus narrow options, so a test can drive them with
// a fake fetch and assert the projections without touching the network.

import type { Client } from "@notionhq/client";
import { callNotion } from "./client.ts";
import type {
	BlockChildren,
	BotIdentity,
	NotionId,
	PageSummary,
	SearchHit,
	SearchResult,
	TextLine,
} from "./types.ts";

/** Notion's own maximum for `page_size` on these endpoints. */
export const NOTION_MAX_PAGE_SIZE = 100;

/** Defaults that keep one read small enough to reason about. */
export const DEFAULT_SEARCH_PAGE_SIZE = 25;
export const DEFAULT_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_MAX_PAGES = 4;
export const DEFAULT_BLOCK_PAGE_SIZE = 100;
export const DEFAULT_MAX_BLOCKS = 300;
export const DEFAULT_MAX_BLOCK_PAGES = 4;
export const DEFAULT_MAX_PROPERTY_VALUE_CHARS = 400;
export const DEFAULT_MAX_PROPERTIES = 50;

/** How far the probe will walk a paginated endpoint before stopping. */
export interface PaginationBounds {
	/** Items per Notion request, capped at 100. */
	readonly pageSize?: number;
	/** Maximum total items to collect. */
	readonly limit?: number;
	/** Maximum Notion requests to make. */
	readonly maxPages?: number;
}

/** ---------------------------------------------------------------- users.me */

/**
 * The bot user behind the token. This is the probe's token-validity check: it
 * needs no page to be shared, so a `401 unauthorized` here is unambiguously a bad
 * token, while a `403`/`404` on a later read is unambiguously a sharing problem.
 */
export async function usersMe(client: Client): Promise<BotIdentity> {
	const response = await callNotion("users.me", () => client.users.me());
	const owner = "bot" in response ? response.bot.owner : undefined;
	const workspace = "bot" in response ? response.bot.workspace_name : undefined;
	return {
		id: response.id,
		name: response.name ?? "(unnamed)",
		type: response.type,
		workspaceName: typeof workspace === "string" ? workspace : undefined,
		ownerType: owner === undefined ? undefined : owner.type,
	};
}

/** ------------------------------------------------------------------ search */

/** Read a title out of a search hit, wherever the object keeps it. */
function titleOfSearchHit(hit: Record<string, unknown>): string {
	// A data_source keeps a plain `title`; a page keeps it in `properties` under
	// whichever key has type "title". Both are checked, and a blank either way
	// still yields a usable label from the id.
	if (typeof hit.title === "string" && hit.title !== "") return hit.title;
	const properties = hit.properties;
	if (typeof properties === "object" && properties !== null) {
		for (const value of Object.values(properties as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const property = value as Record<string, unknown>;
			if (property.type !== "title" || !Array.isArray(property.title)) continue;
			return plainTextOf(property.title);
		}
	}
	return "(untitled)";
}

/** Flatten a Notion rich-text array to plain text, dropping annotations and links. */
export function plainTextOf(richText: unknown): string {
	if (!Array.isArray(richText)) return "";
	let text = "";
	for (const part of richText) {
		if (typeof part !== "object" || part === null) continue;
		const value = part as Record<string, unknown>;
		if (typeof value.plain_text === "string") text += value.plain_text;
		else if (typeof value.text === "object" && value.text !== null) {
			const inner = (value.text as Record<string, unknown>).content;
			if (typeof inner === "string") text += inner;
		}
	}
	return text;
}

function parentTypeOf(record: Record<string, unknown>): string | undefined {
	const parent = record.parent;
	if (typeof parent !== "object" || parent === null) return undefined;
	const type = (parent as Record<string, unknown>).type;
	return typeof type === "string" ? type : undefined;
}

function asSearchHit(result: unknown): SearchHit | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const record = result as Record<string, unknown>;
	const object = record.object;
	if (object !== "page" && object !== "data_source") return undefined;
	if (typeof record.id !== "string") return undefined;
	return {
		object,
		id: record.id,
		title: titleOfSearchHit(record),
		url: typeof record.url === "string" ? record.url : undefined,
		lastEditedTime: typeof record.last_edited_time === "string" ? record.last_edited_time : undefined,
		parentType: parentTypeOf(record),
	};
}

/**
 * Search everything shared with the connection, walking pages up to the bound.
 *
 * `filter` narrows to pages or to data sources; `query` is optional and, when
 * omitted, Notion returns everything shared. The result reports `hasMore` (more
 * pages exist) and `truncated` (the probe hit its own bound) separately, so the
 * caller can tell "Notion has more" from "I stopped early".
 */
export async function search(
	client: Client,
	options: {
		readonly query?: string;
		readonly object?: "page" | "data_source";
		readonly sort?: { readonly timestamp: "last_edited_time"; readonly direction: "ascending" | "descending" };
	} & PaginationBounds = {},
): Promise<SearchResult> {
	const pageSize = Math.min(options.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE, NOTION_MAX_PAGE_SIZE);
	const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
	const maxPages = options.maxPages ?? DEFAULT_SEARCH_MAX_PAGES;

	const hits: SearchHit[] = [];
	let cursor: string | null | undefined;
	let hasMore = false;
	let truncated = false;
	let pages = 0;

	while (pages < maxPages) {
		const response = await callNotion("search", () =>
			client.search({
				...(options.query === undefined ? {} : { query: options.query }),
				page_size: pageSize,
				...(options.sort === undefined ? {} : { sort: options.sort }),
				...(options.object === undefined ? {} : { filter: { property: "object", value: options.object } }),
				...(cursor === undefined || cursor === null ? {} : { start_cursor: cursor }),
			}),
		);
		pages++;
		for (const result of response.results) {
			const hit = asSearchHit(result);
			if (hit !== undefined) hits.push(hit);
			if (hits.length >= limit) break;
		}
		hasMore = response.has_more;
		cursor = response.next_cursor;
		if (!hasMore || hits.length >= limit || cursor === null || cursor === undefined) break;
	}
	// Stopped by our own bound while Notion still had more.
	if (hits.length >= limit && hasMore) truncated = true;
	return {
		query: options.query,
		hits,
		total: hits.length,
		hasMore,
		truncated,
	};
}

/** ------------------------------------------------------------ pages.retrieve */

/** Render one page-property value as a short string. Handles the common types; others fall back to their type name. */
export function renderPropertyValue(property: unknown, maxChars = DEFAULT_MAX_PROPERTY_VALUE_CHARS): string {
	if (typeof property !== "object" || property === null) return "";
	const record = property as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === undefined) return "";
	const value = record[type];
	switch (type) {
		case "title":
		case "rich_text":
			return clamp(plainTextOf(value), maxChars);
		case "number":
			return typeof value === "number" ? String(value) : "";
		case "checkbox":
			return value === true ? "true" : "false";
		case "url":
		case "email":
		case "phone_number":
			return typeof value === "string" ? clamp(value, maxChars) : "";
		case "select":
			return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).name === "string"
				? ((value as Record<string, unknown>).name as string)
				: "";
		case "status":
			return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).name === "string"
				? ((value as Record<string, unknown>).name as string)
				: "";
		case "multi_select":
			return Array.isArray(value)
				? clamp(
						value
							.map((entry) =>
								typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string"
									? ((entry as Record<string, unknown>).name as string)
									: "",
							)
							.filter((name) => name !== "")
							.join(", "),
						maxChars,
					)
				: "";
		case "date":
			return typeof value === "object" && value !== null
				? String((value as Record<string, unknown>).start ?? "")
				: "";
		case "people":
			return Array.isArray(value)
				? clamp(
						value
							.map((entry) =>
								typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string"
									? ((entry as Record<string, unknown>).name as string)
									: "?",
							)
							.join(", "),
						maxChars,
					)
				: "";
		case "files":
			return Array.isArray(value) ? clamp(value.map((entry) => ("name" in (entry as object) ? String((entry as { name?: unknown }).name ?? "") : "")).filter((name) => name !== "").join(", "), maxChars) : "";
		case "relation":
			return Array.isArray(value) ? `${value.length} related` : "";
		case "formula":
		case "rollup":
			// Formula and rollup values nest their own `type`; their raw text is still useful.
			return clamp(JSON.stringify(value), maxChars);
		default:
			return `(${type})`;
	}
}

function clamp(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/**
 * A page's identity and properties. This is the *properties* read: for a page
 * whose parent is a data source, these are the columns of that row. It does not
 * include the page's body — that is `blockChildren`, a separate endpoint. A probe
 * that conflated the two would report an empty page for one that has plenty of
 * content but no database columns, and vice versa.
 */
export async function pageSummary(
	client: Client,
	pageId: NotionId,
	options: { readonly maxProperties?: number; readonly maxValueChars?: number } = {},
): Promise<PageSummary> {
	const maxProperties = options.maxProperties ?? DEFAULT_MAX_PROPERTIES;
	const maxValueChars = options.maxValueChars ?? DEFAULT_MAX_PROPERTY_VALUE_CHARS;
	const response = await callNotion("pages.retrieve", () => client.pages.retrieve({ page_id: pageId }));
	const record = response as unknown as Record<string, unknown>;

	const properties: Record<string, string> = {};
	let count = 0;
	let propertiesTruncated = false;
	const source = record.properties;
	if (typeof source === "object" && source !== null) {
		for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
			if (count >= maxProperties) {
				propertiesTruncated = true;
				break;
			}
			properties[name] = renderPropertyValue(value, maxValueChars);
			count++;
		}
	}

	return {
		id: typeof record.id === "string" ? record.id : pageId,
		title: titleOfSearchHit(record),
		url: typeof record.url === "string" ? record.url : undefined,
		parentType: parentTypeOf(record),
		properties,
		lastEditedTime: typeof record.last_edited_time === "string" ? record.last_edited_time : undefined,
		propertiesTruncated,
	};
}

/** ------------------------------------------------- blocks.children.list */

/** The block types whose text is worth showing; everything else renders as its type name. */
const TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set([
	"paragraph",
	"heading_1",
	"heading_2",
	"heading_3",
	"heading_4",
	"bulleted_list_item",
	"numbered_list_item",
	"quote",
	"callout",
	"toggle",
	"to_do",
	"code",
	"equation",
	"template",
	"meeting_notes",
	"transcription", // pre-2026-03-11 spelling, kept so an old page still reads
]);

/** Whether a block object reports child blocks of its own. */
function blockHasChildren(block: Record<string, unknown>): boolean {
	if (block.has_children === true) return true;
	const type = typeof block.type === "string" ? block.type : undefined;
	if (type === undefined) return false;
	const value = block[type];
	if (typeof value !== "object" || value === null) return false;
	return Array.isArray((value as Record<string, unknown>).children);
}

/** Text of one block, flattened; empty for non-text blocks. */
function blockText(block: Record<string, unknown>): string {
	const type = typeof block.type === "string" ? block.type : "";
	const value = block[type];
	if (typeof value !== "object" || value === null) return "";
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.rich_text)) return plainTextOf(record.rich_text);
	if (Array.isArray(record.caption) && Array.isArray(record.file)) return plainTextOf(record.caption);
	if (type === "code" && typeof record.code === "object") return plainTextOf(record.rich_text);
	return "";
}

/**
 * A block's direct children, walking pages up to the bound.
 *
 * Notion returns one level at a time; a block with `has_children` needs another
 * call to read its own children. The probe does not recurse by default — it marks
 * `hasNestedChildren` and leaves the depth to the caller — because unbounded
 * recursion over a large page is exactly the kind of work the task says to bound.
 */
export async function blockChildren(
	client: Client,
	blockId: NotionId,
	options: PaginationBounds = {},
): Promise<BlockChildren> {
	const pageSize = Math.min(options.pageSize ?? DEFAULT_BLOCK_PAGE_SIZE, NOTION_MAX_PAGE_SIZE);
	const limit = options.limit ?? DEFAULT_MAX_BLOCKS;
	const maxPages = options.maxPages ?? DEFAULT_MAX_BLOCK_PAGES;

	const lines: TextLine[] = [];
	let blockCount = 0;
	let cursor: string | null | undefined;
	let hasMore = false;
	let truncated = false;
	let hasNestedChildren = false;
	let pages = 0;

	while (pages < maxPages) {
		const response = await callNotion("blocks.children.list", () =>
			client.blocks.children.list({
				block_id: blockId,
				page_size: pageSize,
				...(cursor === undefined || cursor === null ? {} : { start_cursor: cursor }),
			}),
		);
		pages++;
		for (const raw of response.results) {
			blockCount++;
			if (typeof raw !== "object" || raw === null) continue;
			const block = raw as Record<string, unknown>;
			const type = typeof block.type === "string" ? block.type : "unknown";
			const nested = blockHasChildren(block);
			if (nested) hasNestedChildren = true;
			if (!TEXT_BLOCK_TYPES.has(type)) continue;
			lines.push({
				type,
				depth: 0,
				text: blockText(block),
				hasChildren: nested,
			});
			if (lines.length >= limit) break;
		}
		hasMore = response.has_more;
		cursor = response.next_cursor;
		if (!hasMore || lines.length >= limit || cursor === null || cursor === undefined) break;
	}
	if (lines.length >= limit && hasMore) truncated = true;
	return { rootId: blockId, lines, blockCount, truncated, hasNestedChildren };
}

/** ---------------------------------------------------------------- rendering */

/**
 * Render a page's body as bounded, model-readable lines.
 *
 * This is what the durable tool returns as its `output`. It is deliberately
 * plain text: a model reads a flattened outline far better than a JSON tree of
 * annotations, and the text form has no `resources` to leak.
 */
export function renderBlockLines(children: BlockChildren, options: { readonly maxChars?: number } = {}): string {
	const maxChars = options.maxChars ?? 12_000;
	const lines: string[] = [];
	for (const line of children.lines) {
		const indent = "  ".repeat(line.depth);
		const suffix = line.hasChildren ? " ⟶" : "";
		const text = line.text.trim();
		lines.push(`${indent}[${line.type}] ${text}${suffix}`);
	}
	if (children.hasNestedChildren) lines.push("(some blocks have nested children; the outline stops at this level)");
	if (children.truncated) lines.push("(output truncated at the probe's block bound)");
	const joined = lines.join("\n");
	return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n(rendered text truncated)`;
}

/** Render a search result as bounded, model-readable lines. */
export function renderSearchResult(result: SearchResult, options: { readonly maxChars?: number } = {}): string {
	const maxChars = options.maxChars ?? 4_000;
	const lines = result.hits.map(
		(hit, index) =>
			`${index + 1}. [${hit.object}] ${hit.title}\n   id: ${hit.id}${hit.parentType === undefined ? "" : `\n   parent: ${hit.parentType}`}${hit.lastEditedTime === undefined ? "" : `\n   edited: ${hit.lastEditedTime}`}`,
	);
	if (result.hits.length === 0) lines.push("(no results)");
	if (result.hasMore) lines.push(`(${result.total} shown; Notion has more pages of results)`);
	if (result.truncated) lines.push("(stopped at the probe's result bound)");
	const joined = lines.join("\n");
	return joined.length <= maxChars ? joined : `${joined.slice(0, maxChars)}\n(rendered text truncated)`;
}
