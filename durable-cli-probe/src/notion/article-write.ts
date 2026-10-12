// Issue #3 src/notion/article-write.ts
//
// Creating an article page, and reading it back to check that it says what it
// was supposed to say.
//
// Two things this module refuses to do, both on purpose:
//
// **It does not retry a create.** The SDK's own policy (`Client.js`, `canRetry`)
// is already the right one: `rate_limited` (429) and `service_overload` (529) are
// retried for every method because the server says the request was not processed;
// `internal_server_error` (500) and `service_unavailable` (503) are retried only
// for idempotent methods, so a POST is never repeated. Adding an unconditional
// retry here would turn a possibly-saved write into a duplicate page. When the
// outcome is genuinely unknown — a 500/503 on a POST, or a transport failure —
// this module raises `ArticleWriteIndeterminateError`, and the caller must report
// "may have been written" rather than "failed".
//
// **It does not trust the create response as proof of content.** A successful
// `pages.create` proves a page exists, not that it holds the right blocks. The
// read-back below re-fetches the page, extracts the text of every block, and
// compares it against what was sent. That comparison — not the HTTP status — is
// what the acceptance criterion calls "created successfully".

import type { Client } from "@notionhq/client";
import { APIErrorCode, isNotionClientError } from "@notionhq/client";
import { NotionRequestError, normalizeNotionError } from "./client.ts";
import { ArticleRenderError } from "./article-blocks.ts";

/** Counts describing what was written. Never contains the token. */
export interface ArticleWriteStats {
	readonly blockCount: number;
	readonly richTextCount: number;
	readonly paragraphCount: number;
	readonly originalChars: number;
	readonly analysisChars: number;
	readonly payloadBytes: number;
}

/** What a successful create returns. */
export interface ArticleWriteResult {
	readonly pageId: string;
	readonly pageUrl: string | undefined;
	readonly stats: ArticleWriteStats;
}

/**
 * What an operator should do when a create's outcome is unknown.
 *
 * Shared so the error raised here and the refusal the tool returns on a repeat
 * call say the same thing — the two paths are the same situation.
 */
export const INDETERMINATE_GUIDANCE =
	"页面可能已创建。请先核查父页面下是否已出现该文章，再决定是否重跑；不要直接换 requestId 重试。";

/**
 * Raised when the write's outcome cannot be determined.
 *
 * The distinction matters: a determinate failure means "nothing was written, a
 * retry is safe", while this means "a page may exist and must be checked". The
 * caller is expected to surface that difference, not collapse it into "failed".
 */
export class ArticleWriteIndeterminateError extends Error {
	readonly code: string;
	readonly status: number | undefined;
	readonly guidance: string;
	constructor(code: string, status: number | undefined, message: string) {
		super(`article write indeterminate (${code}${status === undefined ? "" : ` ${status}`}): ${message}`);
		this.name = "ArticleWriteIndeterminateError";
		this.code = code;
		this.status = status;
		this.guidance = INDETERMINATE_GUIDANCE;
	}
}

/**
 * Error codes that mean "the request definitely was not applied".
 *
 * Everything else — including `internal_server_error` (500), `service_unavailable`
 * (503), `gateway_timeout` (504) and any transport failure — is treated as
 * indeterminate, because the SDK does not retry those on a POST and the server
 * gives no evidence that the write did not happen. 503 in particular is
 * documented as "the change was saved, but the response could not be built".
 */
const DETERMINATE_FAILURES: ReadonlySet<string> = new Set<string>([
	APIErrorCode.Unauthorized,
	APIErrorCode.RestrictedResource,
	APIErrorCode.ObjectNotFound,
	APIErrorCode.ValidationError,
	APIErrorCode.InvalidJSON,
	APIErrorCode.InvalidRequest,
	APIErrorCode.InvalidRequestURL,
	APIErrorCode.InvalidBeta,
	APIErrorCode.ConflictError,
	// 429 and 529 are the server saying "not processed, try later". The SDK
	// already retried them; reaching here means the retries were exhausted, not
	// that the write half-happened.
	APIErrorCode.RateLimited,
	APIErrorCode.ServiceOverload,
]);

/**
 * Classify a failure from a write call.
 *
 * Returns the normalized info when the write definitely did not happen, and
 * throws `ArticleWriteIndeterminateError` when it might have. The default is
 * "indeterminate": an unrecognized failure on a POST is not evidence that
 * nothing was written.
 */
function classifyWriteFailure(endpoint: string, error: unknown): never {
	if (isNotionClientError(error)) {
		const info = normalizeNotionError(error);
		if (DETERMINATE_FAILURES.has(info.code)) {
			throw new NotionRequestError(endpoint as never, info);
		}
		throw new ArticleWriteIndeterminateError(info.code, info.status, info.message);
	}
	// A transport error (timeout, connection reset) after the request was sent
	// gives no information about whether the server processed it.
	const message = error instanceof Error ? error.message : String(error);
	throw new ArticleWriteIndeterminateError("transport_error", undefined, message);
}

/** Parameters accepted by `pages.create`, narrowed to what this feature sends. */
export type CreatePageArgs = Parameters<Client["pages"]["create"]>[0];

/** Create the article page. Throws on any failure; never retries. */
export async function createArticlePage(
	client: Client,
	args: CreatePageArgs,
	stats: ArticleWriteStats,
): Promise<ArticleWriteResult> {
	let response: Awaited<ReturnType<Client["pages"]["create"]>>;
	try {
		response = await client.pages.create(args);
	} catch (error) {
		classifyWriteFailure("pages.create", error);
	}

	const page = response as { id?: unknown; url?: unknown };
	if (typeof page.id !== "string" || page.id === "") {
		throw new ArticleRenderError("create returned no page id");
	}
	return {
		pageId: page.id,
		pageUrl: typeof page.url === "string" ? page.url : undefined,
		stats,
	};
}

/** One difference between what was sent and what the page now holds. */
export interface ReadBackMismatch {
	readonly index: number;
	readonly expected: string;
	readonly actual: string;
}

/** The result of re-reading a created page. */
export interface ReadBackReport {
	readonly pageId: string;
	readonly expectedTitle: string;
	readonly title: string;
	readonly titleMatches: boolean;
	readonly expectedBlocks: number;
	readonly actualBlocks: number;
	readonly mismatches: readonly ReadBackMismatch[];
	/** True only when the title *and* every block match. */
	readonly matches: boolean;
}

/** `heading_2` -> `"type=heading_2 | text=原文"`, used to compare sent vs stored. */
function blockSignature(block: unknown): string {
	if (typeof block !== "object" || block === null) return "type=? | text=";
	const record = block as Record<string, unknown>;
	const type = typeof record["type"] === "string" ? (record["type"] as string) : "?";

	// Response blocks expose `plain_text`; request blocks expose `text.content`.
	const richText = (record[type] as { rich_text?: unknown } | undefined)?.rich_text;
	if (!Array.isArray(richText)) return `type=${type} | text=`;

	const text = richText
		.map((item) => {
			if (typeof item !== "object" || item === null) return "";
			const itemRecord = item as Record<string, unknown>;
			if (typeof itemRecord["plain_text"] === "string") return itemRecord["plain_text"];
			const textField = itemRecord["text"];
			if (typeof textField === "object" && textField !== null) {
				const content = (textField as { content?: unknown }).content;
				if (typeof content === "string") return content;
			}
			return "";
		})
		.join("");

	return `type=${type} | text=${text}`;
}

/** Read every child block of a page, following pagination. */
async function listAllChildren(client: Client, blockId: string): Promise<unknown[]> {
	const results: unknown[] = [];
	let cursor: string | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		let response: { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
		try {
			response = (await client.blocks.children.list({
				block_id: blockId,
				page_size: 100,
				...(cursor === undefined ? {} : { start_cursor: cursor }),
			})) as unknown as { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
		} catch (error) {
			classifyReadFailure("blocks.children.list", error);
		}
		const batch = response.results ?? [];
		results.push(...batch);
		if (response.has_more !== true || typeof response.next_cursor !== "string") break;
		cursor = response.next_cursor;
	}
	return results;
}

/** Reads are idempotent, so a failure here is a plain error, not an indeterminate write. */
function classifyReadFailure(endpoint: string, error: unknown): never {
	throw new NotionRequestError(endpoint as never, normalizeNotionError(error));
}

/** The page's title, read from its title property. */
function titleOf(page: unknown): string {
	const properties = (page as { properties?: Record<string, unknown> } | null)?.properties;
	const title = properties?.["title"] as { title?: unknown } | undefined;
	if (!Array.isArray(title?.title)) return "";
	return title.title
		.map((item) => {
			const plain = (item as { plain_text?: unknown }).plain_text;
			return typeof plain === "string" ? plain : "";
		})
		.join("");
}

/**
 * Re-fetch a created page and compare it against what was sent.
 *
 * Compares the title property and then every block on `type` plus concatenated
 * text. A page that is missing a paragraph, has an extra one, whose heading
 * levels differ, or whose title was changed will not match. That is the point:
 * this is the check that turns "the API returned 200" into "the page says what it
 * was supposed to say".
 *
 * The title is compared explicitly because it lives in a property rather than in
 * the children, so a block-only comparison would pass for a page titled anything
 * at all.
 */
export async function readBackArticlePage(
	client: Client,
	pageId: string,
	expectedChildren: readonly unknown[],
	expectedTitle: string,
): Promise<ReadBackReport> {
	let page: unknown;
	try {
		page = await client.pages.retrieve({ page_id: pageId });
	} catch (error) {
		classifyReadFailure("pages.retrieve", error);
	}

	const actual = await listAllChildren(client, pageId);

	const mismatches: ReadBackMismatch[] = [];
	const length = Math.max(expectedChildren.length, actual.length);
	for (let index = 0; index < length; index++) {
		const expected = index < expectedChildren.length ? blockSignature(expectedChildren[index]) : "(missing)";
		const actualSignature = index < actual.length ? blockSignature(actual[index]) : "(missing)";
		if (expected !== actualSignature) mismatches.push({ index, expected, actual: actualSignature });
	}

	const title = titleOf(page);
	const titleMatches = title === expectedTitle;

	return {
		pageId,
		expectedTitle,
		title,
		titleMatches,
		expectedBlocks: expectedChildren.length,
		actualBlocks: actual.length,
		mismatches,
		matches: titleMatches && mismatches.length === 0,
	};
}
