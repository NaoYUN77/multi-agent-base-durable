// Issue #3 src/notion/article-tool.ts
//
// The `notion_write_article` tool: the only place this probe writes to Notion.
//
// It is a *separate* tool from `notion_read`, not a new action on it. The read
// tool's whole guarantee is "three actions, all GETs, safe to replay"; adding a
// write action would quietly remove that guarantee for every existing caller.
// A second tool keeps the two contracts independent, and lets a conversation be
// granted one without the other.
//
// **What the model may and may not control.** The tool's parameters carry only
// the model's *interpretation* — the per-paragraph summaries and roles. The
// article's original text and the destination parent page come from the closure,
// which was built from app-controlled input and configuration. A model cannot
// choose where to write, and cannot alter the text that gets written. That is the
// structural reason a bad reply cannot corrupt or relocate content.
//
// **Why `replay: "unsafe"`.** The Durable tool contract only reruns a recovered
// call when the stored policy and the current policy are both `"safe"` (see
// `packages/durable/src/harness/tool.ts`). A create is not idempotent: rerunning
// it would produce a second page. Declaring `unsafe` makes an interrupted call
// end as an interruption that must be checked, instead of silently repeating.
// The SDK's own retry policy is left untouched — it already refuses to repeat a
// POST on 500/503.

import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Client } from "@notionhq/client";
import { ArticleAnalysisError, parseArticleAnalysis, type ArticleAnalysis, type ArticleInput } from "../article/contract.ts";
import { ArticleRenderError, renderArticleBlocks, toCreatePageParameters, type RenderedArticle } from "./article-blocks.ts";
import {
	ArticleWriteIndeterminateError,
	INDETERMINATE_GUIDANCE,
	createArticlePage,
	readBackArticlePage,
	type ArticleWriteResult,
	type ArticleWriteStats,
	type ReadBackReport,
} from "./article-write.ts";
import { NotionRequestError } from "./client.ts";

/** The name the model calls, and the extension a conversation selects. */
export const NOTION_WRITE_TOOL_NAME = "notion_write_article";
export const NOTION_WRITE_EXTENSION_NAME = "notion-write";

/** Bounded output; a create report is short, but the cap is explicit anyway. */
export const WRITE_TOOL_OUTPUT_LIMITS = { maxBytes: 8_000, maxLines: 120 } as const;

/**
 * The tool's `details`. A type alias with an index signature, not an interface:
 * Durable requires a `JsonValue`, and every branch below must fill every key.
 */
type NotionWriteDetails = {
	readonly [key: string]: string | number | boolean;
	readonly action: "write_article";
	readonly pageId: string;
	readonly pageUrl: string;
	readonly blockCount: number;
	readonly paragraphCount: number;
	readonly readBackMatches: boolean;
	readonly readBackMismatches: number;
};

const articleWriteSchema = Type.Object({
	paragraphs: Type.Array(
		Type.Object({
			paragraphId: Type.Number({
				description: "1-based position of the paragraph in the original article.",
			}),
			summary: Type.String({ description: "What that paragraph says, in your own words." }),
			roleInArticle: Type.String({
				description: "What that paragraph does for the article as a whole.",
			}),
		}),
		{
			description:
				"Exactly one entry per original paragraph, with paragraphId covering 1..N. " +
				"Missing, extra, or duplicated entries are rejected and nothing is written.",
		},
	),
});

/** Everything the tool needs; all of it app-controlled except the model's reply. */
export interface NotionWriteToolOptions {
	readonly client: Client;
	/** Destination page. From configuration — never from the model. */
	readonly parentPageId: string;
	/** The article whose text will be written. Held by the app, not the model. */
	readonly article: ArticleInput;
	/**
	 * When true, render and validate but do not call Notion. Used by offline
	 * tests that need the tool path without network. The result says so.
	 */
	readonly dryRun?: boolean;
}

const emptyDetails = (): NotionWriteDetails => ({
	action: "write_article",
	pageId: "",
	pageUrl: "",
	blockCount: 0,
	paragraphCount: 0,
	readBackMatches: false,
	readBackMismatches: 0,
});

/**
 * How far one article's processing has got.
 *
 * `replay: "unsafe"` only governs what Durable does when *recovering* a call. It
 * does nothing about a model that issues the same call twice in one turn, or that
 * calls again after an uncertain result — both of which would create a second
 * page. This state is what stops that: a processing creates at most one page, and
 * once a page exists every later call reuses it instead of creating another.
 *
 * `idle` is the only state a create may start from, so a determinate failure
 * (nothing was written) legitimately allows a retry, while an uncertain or
 * already-created outcome does not.
 */
type AttemptState =
	| { readonly kind: "idle" }
	/** A create is in flight. Blocks a concurrent second call. */
	| { readonly kind: "running" }
	/** A page exists — created by this processing. Later calls reuse it. */
	| {
			readonly kind: "created";
			readonly pageId: string;
			readonly pageUrl: string | undefined;
			/** False when the read-back could not run or did not match. */
			readonly verified: boolean;
			readonly text: string;
	  }
	/** The create's outcome is unknown. Creating again could duplicate a page. */
	| { readonly kind: "indeterminate"; readonly message: string };

/**
 * Build the tool.
 *
 * Failure handling is deliberate: a validation or render failure means nothing
 * was sent, so it returns `isError` with the reason. An indeterminate write is
 * reported as an error that says the page may exist — never as a success, and
 * never retried.
 */
export function createNotionWriteArticleTool(options: NotionWriteToolOptions) {
	const { client, parentPageId, article } = options;

	// One processing, one page. Shared by every call this tool instance serves.
	let state: AttemptState = { kind: "idle" };

	/** Report an existing page rather than creating another one. */
	const reuse = (current: Extract<AttemptState, { kind: "created" }>): ToolExecutionResult<NotionWriteDetails> => {
		const text = [
			`复用本次处理已创建的页面（未重复创建）：${current.pageId}`,
			current.text,
		].join("\n");
		return {
			output: [{ type: "text" as const, text }],
			isError: !current.verified,
			details: {
				action: "write_article",
				pageId: current.pageId,
				pageUrl: current.pageUrl ?? "",
				blockCount: 0,
				paragraphCount: article.paragraphs.length,
				readBackMatches: current.verified,
				readBackMismatches: 0,
			},
		};
	};

	return defineTool({
		name: NOTION_WRITE_TOOL_NAME,
		description:
			"Create a Notion page for the article currently being processed. " +
			"Supply one entry per original paragraph: a summary of that paragraph and its role in the whole article. " +
			"The article's text and the destination page are fixed by the application; you cannot change them. " +
			"Call this only after reading the entire article. If it reports an error, do not claim the page was created.",
		parameters: articleWriteSchema,
		// A create is not idempotent: an interrupted call must be surfaced, not rerun.
		replay: "unsafe",
		outputLimits: WRITE_TOOL_OUTPUT_LIMITS,
		async execute(args): Promise<ToolExecutionResult<NotionWriteDetails>> {
			// ── 0. Guard: one processing creates at most one page ───────────────
			// Checked before anything else, so a second call in the same turn (or a
			// call after an uncertain result) cannot reach `pages.create`.
			if (state.kind === "created") return reuse(state);
			if (state.kind === "indeterminate") {
				return {
					output: [
						{
							type: "text" as const,
							text: `拒绝重复创建：${state.message}\n${INDETERMINATE_GUIDANCE}`,
						},
					],
					isError: true,
					details: { ...emptyDetails(), paragraphCount: article.paragraphs.length },
					diagnostics: [
						{ severity: "error" as const, code: "create_refused_indeterminate", message: state.message },
					],
				};
			}
			if (state.kind === "running") {
				return {
					output: [{ type: "text" as const, text: "该文章的写入正在进行中，拒绝并发调用。" }],
					isError: true,
					details: { ...emptyDetails(), paragraphCount: article.paragraphs.length },
					diagnostics: [
						{ severity: "error" as const, code: "create_in_flight", message: "a create is already running" },
					],
				};
			}

			// ── 1. Validate the model's reply against the article ───────────────
			let analysis: ArticleAnalysis;
			try {
				analysis = parseArticleAnalysis({ paragraphs: args.paragraphs }, article.paragraphs.length);
			} catch (error) {
				const message = error instanceof ArticleAnalysisError ? error.message : String(error);
				return {
					output: [{ type: "text" as const, text: `Rejected: ${message}. Nothing was written.` }],
					isError: true,
					details: { ...emptyDetails(), paragraphCount: article.paragraphs.length },
					diagnostics: [{ severity: "error" as const, code: "invalid_analysis", message }],
				};
			}

			// ── 2. Render, rejecting anything a single request cannot carry ─────
			let rendered: RenderedArticle;
			try {
				rendered = renderArticleBlocks(article, analysis);
			} catch (error) {
				const message = error instanceof ArticleRenderError ? error.message : String(error);
				return {
					output: [{ type: "text" as const, text: `Rejected: ${message}. Nothing was written.` }],
					isError: true,
					details: { ...emptyDetails(), paragraphCount: article.paragraphs.length },
					diagnostics: [{ severity: "error" as const, code: "render_failed", message }],
				};
			}

			const stats: ArticleWriteStats = {
				blockCount: rendered.blockCount,
				richTextCount: rendered.richTextCount,
				paragraphCount: rendered.paragraphCount,
				originalChars: rendered.originalChars,
				analysisChars: rendered.analysisChars,
				payloadBytes: rendered.payloadBytes,
			};

			if (options.dryRun === true) {
				const text = [
					`dry-run: rendered ${rendered.blockCount} blocks for ${rendered.paragraphCount} paragraphs.`,
					"No Notion request was made.",
				].join("\n");
				return {
					output: [{ type: "text" as const, text }],
					details: {
						...emptyDetails(),
						blockCount: rendered.blockCount,
						paragraphCount: rendered.paragraphCount,
					},
				};
			}

			// ── 3. Create ──────────────────────────────────────────────────────
			// Marked before the await so a second call arriving while this one is in
			// flight sees `running` rather than starting a create of its own.
			state = { kind: "running" };
			let created: ArticleWriteResult;
			try {
				created = await createArticlePage(
					client,
					toCreatePageParameters(article, rendered, parentPageId),
					stats,
				);
			} catch (error) {
				if (error instanceof ArticleWriteIndeterminateError) {
					// A page may exist. Remember that, so no later call creates another.
					state = { kind: "indeterminate", message: error.message };
					return {
						output: [
							{
								type: "text" as const,
								text: `Write outcome unknown: ${error.message}\n${error.guidance}`,
							},
						],
						isError: true,
						details: { ...emptyDetails(), paragraphCount: rendered.paragraphCount },
						diagnostics: [
							{ severity: "error" as const, code: error.code, message: error.message },
						],
					};
				}
				// Determinate: nothing was written, so a later attempt is legitimate.
				state = { kind: "idle" };
				const message = error instanceof NotionRequestError ? `${error.info.code}: ${error.info.message}` : String(error);
				return {
					output: [{ type: "text" as const, text: `Write failed: ${message}. Nothing was written.` }],
					isError: true,
					details: { ...emptyDetails(), paragraphCount: rendered.paragraphCount },
					diagnostics: [{ severity: "error" as const, code: "write_failed", message }],
				};
			}

			// ── 4. Read back and compare ───────────────────────────────────────
			// A 200 from create proves a page exists, not that it says the right
			// thing. The read-back is the actual acceptance check, and it covers the
			// title as well as the blocks.
			let readBack: ReadBackReport;
			try {
				readBack = await readBackArticlePage(client, created.pageId, rendered.children, rendered.title);
			} catch (error) {
				const message = error instanceof NotionRequestError ? error.info.message : String(error);
				const text = `Page created (${created.pageId}) but read-back failed: ${message}. Verify manually; not creating another.`;
				// A page exists, so this processing must not create a second one.
				state = {
					kind: "created",
					pageId: created.pageId,
					pageUrl: created.pageUrl,
					verified: false,
					text,
				};
				return {
					output: [{ type: "text" as const, text }],
					isError: true,
					details: {
						action: "write_article",
						pageId: created.pageId,
						pageUrl: created.pageUrl ?? "",
						blockCount: rendered.blockCount,
						paragraphCount: rendered.paragraphCount,
						readBackMatches: false,
						readBackMismatches: 0,
					},
					diagnostics: [{ severity: "error" as const, code: "readback_failed", message }],
				};
			}

			const summaryLines = [
				`created page ${created.pageId}`,
				`url: ${created.pageUrl ?? "(not reported)"}`,
				`title: ${readBack.titleMatches ? "matches" : `MISMATCH (expected ${JSON.stringify(readBack.expectedTitle)}, got ${JSON.stringify(readBack.title)})`}`,
				`blocks: ${rendered.blockCount}  paragraphs: ${rendered.paragraphCount}`,
				`original chars: ${rendered.originalChars}  analysis chars: ${rendered.analysisChars}`,
				`read-back: ${readBack.matches ? "matches" : `MISMATCH (${readBack.mismatches.length} blocks)`}`,
			];
			if (!readBack.matches) {
				for (const mismatch of readBack.mismatches.slice(0, 5)) {
					summaryLines.push(`  [${mismatch.index}] expected ${mismatch.expected}`);
					summaryLines.push(`  [${mismatch.index}] actual   ${mismatch.actual}`);
				}
			}
			const text = summaryLines.join("\n");

			// The page exists from here on. A later call reuses this result instead
			// of creating another, whether or not the read-back matched.
			state = {
				kind: "created",
				pageId: created.pageId,
				pageUrl: created.pageUrl,
				verified: readBack.matches,
				text,
			};

			return {
				output: [{ type: "text" as const, text }],
				// A content or title mismatch is a failure even though the page exists.
				isError: !readBack.matches,
				details: {
					action: "write_article",
					pageId: created.pageId,
					pageUrl: created.pageUrl ?? "",
					blockCount: rendered.blockCount,
					paragraphCount: rendered.paragraphCount,
					readBackMatches: readBack.matches,
					readBackMismatches: readBack.mismatches.length + (readBack.titleMatches ? 0 : 1),
				},
				...(readBack.matches
					? {}
					: {
							diagnostics: [
								{
									severity: "error" as const,
									code: readBack.titleMatches ? "readback_mismatch" : "readback_title_mismatch",
									message: readBack.titleMatches
										? `page content differs from what was sent (${readBack.mismatches.length} blocks)`
										: `page title differs: expected ${JSON.stringify(readBack.expectedTitle)}, got ${JSON.stringify(readBack.title)}`,
								},
							],
						}),
			};
		},
	});
}

/** The `notion-write` extension: one tool. */
export function createNotionWriteExtension(options: NotionWriteToolOptions) {
	return defineExtension({
		name: NOTION_WRITE_EXTENSION_NAME,
		tools: [createNotionWriteArticleTool(options)],
	});
}
