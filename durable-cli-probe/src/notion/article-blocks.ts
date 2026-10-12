// Issue #3 src/notion/article-blocks.ts
//
// Renders an article into Notion block structure.
//
// The shape is fixed and comes from the issue's behaviour contract:
//
//   page title   <- input.title          (a property, not a block)
//   来源         <- input.source (+ link when sourceUrl is present)
//   原文         <- every original paragraph, in order, verbatim
//   逐段解读     <- per paragraph: summary + roleInArticle
//
// Two properties matter more than the layout:
//
// 1. **Explicit blocks, not Markdown-as-text.** A paragraph whose text begins
//    with `#` is still a paragraph here. Nothing is "formatted" by convention;
//    every heading is a real `heading_2`/`heading_3` block. Claiming Markdown
//    rendered itself would be the kind of unverifiable claim the workflow forbids.
//
// 2. **Reject before writing, never truncate.** Notion caps a request at 100
//    elements per array and 500KB overall. When an article exceeds what one
//    `pages.create` can carry, this throws. Silently dropping the tail would
//    produce a page that looks complete and is not.
//
// The original text never round-trips through the model: it is taken straight
// from `ArticleInput`, so the page cannot contain a paraphrase of the source.

import type { BlockObjectRequest, CreatePageParameters } from "@notionhq/client";
import { NOTION_MAX_RICH_TEXT_CHARS, type ArticleAnalysis, type ArticleInput } from "../article/contract.ts";

/** Per-array element cap. https://developers.notion.com/reference/request-limits */
export const NOTION_MAX_BLOCKS_PER_REQUEST = 100;
export const NOTION_MAX_RICH_TEXT_ITEMS = 100;
/** Overall payload cap, same page. */
export const NOTION_MAX_PAYLOAD_BYTES = 500 * 1024;

/** Raised when an article cannot be represented in a single supported request. */
export class ArticleRenderError extends Error {
	constructor(detail: string) {
		super(`article render: ${detail}`);
		this.name = "ArticleRenderError";
	}
}

/** What a rendered article contains, plus the numbers a report needs. */
export interface RenderedArticle {
	readonly title: string;
	readonly children: readonly BlockObjectRequest[];
	readonly blockCount: number;
	readonly richTextCount: number;
	readonly paragraphCount: number;
	/** Characters of original text placed on the page. Compared against the input. */
	readonly originalChars: number;
	/** Characters of summary + role text placed on the page. */
	readonly analysisChars: number;
	readonly payloadBytes: number;
}

/** A text rich-text item. Split by `splitRichText` before it is built. */
type RichTextItem = {
	type: "text";
	text: { content: string; link?: { url: string } | null };
};

/**
 * Split a string into `text.content` chunks that respect Notion's 2000-character
 * cap.
 *
 * Splitting is not truncation: the concatenation of the chunks is the original
 * string. Chunk boundaries are irrelevant to rendering because consecutive
 * rich-text items in one block are displayed as continuous text.
 */
export function splitRichText(content: string, max: number = NOTION_MAX_RICH_TEXT_CHARS): string[] {
	if (content === "") return [""];
	const chunks: string[] = [];
	for (let index = 0; index < content.length; index += max) {
		chunks.push(content.slice(index, index + max));
	}
	return chunks;
}

function textItems(content: string): RichTextItem[] {
	return splitRichText(content).map((chunk) => ({ type: "text" as const, text: { content: chunk } }));
}

function boldItem(content: string): RichTextItem & { annotations: { bold: true } } {
	return { type: "text", text: { content }, annotations: { bold: true } };
}

function paragraph(richText: RichTextItem[]): BlockObjectRequest {
	return { object: "block", type: "paragraph", paragraph: { rich_text: richText } };
}

function heading2(text: string): BlockObjectRequest {
	return { object: "block", type: "heading_2", heading_2: { rich_text: textItems(text) } };
}

function heading3(text: string): BlockObjectRequest {
	return { object: "block", type: "heading_3", heading_3: { rich_text: textItems(text) } };
}

/**
 * Render one article.
 *
 * `analysis` is assumed already validated against `input` by
 * `parseArticleAnalysis`; this function re-checks the count anyway, because a
 * caller that skipped validation would otherwise get a silently short page.
 */
export function renderArticleBlocks(input: ArticleInput, analysis: ArticleAnalysis): RenderedArticle {
	if (analysis.paragraphs.length !== input.paragraphs.length) {
		throw new ArticleRenderError(
			`analysis has ${analysis.paragraphs.length} entries but the article has ${input.paragraphs.length} paragraphs`,
		);
	}

	const children: BlockObjectRequest[] = [];

	// ── 来源 ────────────────────────────────────────────────────────────────
	children.push(heading2("来源"));
	children.push(
		paragraph(
			input.sourceUrl === undefined
				? textItems(input.source)
				: [
						...textItems(`${input.source} — `),
						{ type: "text", text: { content: input.sourceUrl, link: { url: input.sourceUrl } } },
					],
		),
	);

	// ── 原文 ────────────────────────────────────────────────────────────────
	children.push(heading2("原文"));
	let originalChars = 0;
	for (const text of input.paragraphs) {
		originalChars += text.length;
		// A blank paragraph is kept as an empty paragraph block. Dropping it would
		// change the article's visual structure.
		children.push(paragraph(textItems(text)));
	}

	// ── 逐段解读 ────────────────────────────────────────────────────────────
	children.push(heading2("逐段解读"));
	let analysisChars = 0;
	for (const entry of analysis.paragraphs) {
		children.push(heading3(`第 ${entry.paragraphId} 段`));
		analysisChars += entry.summary.length + entry.roleInArticle.length;
		children.push(
			paragraph([
				boldItem("摘要："),
				...textItems(entry.summary),
				{ type: "text", text: { content: "\n" } },
				boldItem("作用："),
				...textItems(entry.roleInArticle),
			]),
		);
	}

	// ── Limits, checked here so no caller can forget ─────────────────────────
	if (children.length > NOTION_MAX_BLOCKS_PER_REQUEST) {
		throw new ArticleRenderError(
			`${children.length} blocks exceeds the ${NOTION_MAX_BLOCKS_PER_REQUEST}-block request limit; ` +
				"this version writes an article in a single request and does not batch appends",
		);
	}

	let richTextCount = 0;
	for (const block of children) {
		for (const value of Object.values(block)) {
			if (typeof value !== "object" || value === null) continue;
			const richText = (value as { rich_text?: unknown }).rich_text;
			if (!Array.isArray(richText)) continue;
			richTextCount += richText.length;
			if (richText.length > NOTION_MAX_RICH_TEXT_ITEMS) {
				throw new ArticleRenderError(
					`a block carries ${richText.length} rich-text items, over the ${NOTION_MAX_RICH_TEXT_ITEMS}-item limit`,
				);
			}
		}
	}

	const payloadBytes = Buffer.byteLength(JSON.stringify(children), "utf8");
	if (payloadBytes > NOTION_MAX_PAYLOAD_BYTES) {
		throw new ArticleRenderError(
			`payload is ${payloadBytes} bytes, over the ${NOTION_MAX_PAYLOAD_BYTES}-byte limit`,
		);
	}

	return {
		title: input.title,
		children,
		blockCount: children.length,
		richTextCount,
		paragraphCount: input.paragraphs.length,
		originalChars,
		analysisChars,
		payloadBytes,
	};
}

/**
 * Build the `pages.create` parameters.
 *
 * `parentPageId` comes from configuration, never from the model or the article —
 * a model-chosen parent would let a bad reply write into an unrelated page.
 */
export function toCreatePageParameters(
	input: ArticleInput,
	rendered: RenderedArticle,
	parentPageId: string,
): CreatePageParameters {
	return {
		parent: { type: "page_id", page_id: parentPageId },
		properties: {
			title: { type: "title", title: [{ type: "text", text: { content: rendered.title } }] },
		},
		children: [...rendered.children],
	};
}
