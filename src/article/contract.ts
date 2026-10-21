// Issue #3 src/article/contract.ts
//
// The two data contracts this feature is built on, and their validation.
//
// There are two boundaries where untrusted data enters:
//
//   1. The article input — read from a JSON file on disk. Everything downstream
//      (rendering, the write call) trusts it, so it is validated once, here.
//   2. The model's analysis — arbitrary text from a language model. It claims to
//      describe the same paragraphs, but nothing forces it to. A missing, extra,
//      duplicated, or renumbered paragraph must be rejected *before* any write,
//      because a partial article is worse than a failed run: it looks finished.
//
// Both validators throw rather than returning a partial result. A caller cannot
// accidentally proceed with half-valid data.
//
// What is deliberately NOT here: the article's prose. The original text is held
// by the application and assembled into the page by `notion/article-blocks.ts`.
// The model never round-trips it, so the text on the page cannot drift from the
// text that was read. That is the reason the model's output carries summaries
// only, never the paragraphs themselves.

/** Notion's own limits, from https://developers.notion.com/reference/request-limits */
export const NOTION_MAX_RICH_TEXT_CHARS = 2000;
export const NOTION_MAX_URL_CHARS = 2000;

/** A sentence used verbatim when the article is a hand-written acceptance sample. */
export const HANDWRITTEN_SAMPLE_SOURCE = "人工编写验收样例";

/** The article to process. Produced by a human or a test fixture, never by a model. */
export interface ArticleInput {
	/** Idempotency key for the Durable submission. Reusing it must not create a second page. */
	readonly requestId: string;
	readonly title: string;
	/** Where the article came from, as stated by the input. Never inferred by the model. */
	readonly source: string;
	/** Optional. When present it is shown as a link; it is never invented. */
	readonly sourceUrl?: string;
	/** The article body, in original order. Paragraph 1 is index 0. */
	readonly paragraphs: readonly string[];
}

/** One paragraph's interpretation. `paragraphId` is 1-based, matching the input order. */
export interface ParagraphAnalysis {
	readonly paragraphId: number;
	/** What this paragraph says, in the model's words. */
	readonly summary: string;
	/** What this paragraph does for the article as a whole. */
	readonly roleInArticle: string;
}

/** The model's complete response. Always the same length as the input's paragraphs. */
export interface ArticleAnalysis {
	readonly paragraphs: readonly ParagraphAnalysis[];
}

/** A malformed article input. `field` names the offending key for a useful message. */
export class ArticleInputError extends Error {
	readonly field: string;
	constructor(field: string, detail: string) {
		super(`article input: ${field} ${detail}`);
		this.name = "ArticleInputError";
		this.field = field;
	}
}

/** A malformed or misaligned model response. */
export class ArticleAnalysisError extends Error {
	constructor(detail: string) {
		super(`article analysis: ${detail}`);
		this.name = "ArticleAnalysisError";
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, or a thrown `ArticleInputError` naming the field. */
function requireNonEmptyString(container: Record<string, unknown>, field: string): string {
	const value = container[field];
	if (typeof value !== "string") throw new ArticleInputError(field, "must be a string");
	if (value.trim() === "") throw new ArticleInputError(field, "must not be empty");
	return value;
}

/**
 * Validate one article input.
 *
 * Rejects empty paragraphs only in the sense of "must be a string" — a paragraph
 * that is present but blank is legal input, because a blank line between sections
 * is part of the article. The model is told to describe such a paragraph rather
 * than skip it, which keeps the alignment check meaningful.
 */
export function parseArticleInput(raw: unknown): ArticleInput {
	if (!isPlainObject(raw)) throw new ArticleInputError("(root)", "must be a JSON object");

	const requestId = requireNonEmptyString(raw, "requestId");
	const title = requireNonEmptyString(raw, "title");
	const source = requireNonEmptyString(raw, "source");

	const paragraphsRaw = raw["paragraphs"];
	if (!Array.isArray(paragraphsRaw)) throw new ArticleInputError("paragraphs", "must be an array");
	if (paragraphsRaw.length === 0) throw new ArticleInputError("paragraphs", "must not be empty");
	const paragraphs = paragraphsRaw.map((value, index) => {
		if (typeof value !== "string") {
			throw new ArticleInputError(`paragraphs[${index}]`, "must be a string");
		}
		return value;
	});

	let sourceUrl: string | undefined;
	const sourceUrlRaw = raw["sourceUrl"];
	if (sourceUrlRaw !== undefined && sourceUrlRaw !== null && sourceUrlRaw !== "") {
		if (typeof sourceUrlRaw !== "string") throw new ArticleInputError("sourceUrl", "must be a string");
		if (sourceUrlRaw.length > NOTION_MAX_URL_CHARS) {
			throw new ArticleInputError("sourceUrl", `exceeds ${NOTION_MAX_URL_CHARS} characters`);
		}
		let parsed: URL;
		try {
			parsed = new URL(sourceUrlRaw);
		} catch {
			throw new ArticleInputError("sourceUrl", "must be an absolute URL");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new ArticleInputError("sourceUrl", "must be http or https");
		}
		sourceUrl = sourceUrlRaw;
	}

	return {
		requestId,
		title,
		source,
		...(sourceUrl === undefined ? {} : { sourceUrl }),
		paragraphs,
	};
}

/**
 * Validate the model's analysis against the paragraph count it was given.
 *
 * The count check is the important one. A model that silently drops a paragraph
 * produces a page that reads as complete but is missing a section, and nothing
 * downstream would notice. Requiring exact coverage turns that into a hard error.
 */
export function parseArticleAnalysis(raw: unknown, expectedParagraphCount: number): ArticleAnalysis {
	if (!isPlainObject(raw)) throw new ArticleAnalysisError("root must be a JSON object");

	const paragraphsRaw = raw["paragraphs"];
	if (!Array.isArray(paragraphsRaw)) throw new ArticleAnalysisError("`paragraphs` must be an array");

	if (paragraphsRaw.length !== expectedParagraphCount) {
		throw new ArticleAnalysisError(
			`expected ${expectedParagraphCount} paragraph entries, got ${paragraphsRaw.length}`,
		);
	}

	const seen = new Set<number>();
	const paragraphs: ParagraphAnalysis[] = paragraphsRaw.map((entry, index) => {
		if (!isPlainObject(entry)) throw new ArticleAnalysisError(`entry ${index} must be an object`);

		const paragraphId = entry["paragraphId"];
		if (typeof paragraphId !== "number" || !Number.isInteger(paragraphId)) {
			throw new ArticleAnalysisError(`entry ${index}: paragraphId must be an integer`);
		}
		if (paragraphId < 1 || paragraphId > expectedParagraphCount) {
			throw new ArticleAnalysisError(
				`entry ${index}: paragraphId ${paragraphId} is outside 1..${expectedParagraphCount}`,
			);
		}
		if (seen.has(paragraphId)) {
			throw new ArticleAnalysisError(`paragraphId ${paragraphId} appears more than once`);
		}
		seen.add(paragraphId);

		const summary = entry["summary"];
		if (typeof summary !== "string" || summary.trim() === "") {
			throw new ArticleAnalysisError(`paragraphId ${paragraphId}: summary must be a non-empty string`);
		}
		const roleInArticle = entry["roleInArticle"];
		if (typeof roleInArticle !== "string" || roleInArticle.trim() === "") {
			throw new ArticleAnalysisError(`paragraphId ${paragraphId}: roleInArticle must be a non-empty string`);
		}

		return { paragraphId, summary, roleInArticle };
	});

	// No separate "is any id missing?" check is needed, and adding one would be
	// dead code: the count equals `expectedParagraphCount`, every id is unique,
	// and every id lies in 1..N — so by pigeonhole the set is exactly {1..N}.
	// A dropped paragraph therefore surfaces as a count mismatch above, and a
	// renumbered one as a duplicate.

	// Return in paragraph order so a shuffled model response cannot reorder the page.
	return { paragraphs: [...paragraphs].sort((a, b) => a.paragraphId - b.paragraphId) };
}

/**
 * Pull a JSON object out of a model's reply.
 *
 * Models wrap JSON in prose or a code fence often enough that requiring a bare
 * object would fail for no good reason. This takes the outermost balanced
 * `{...}` span; it does not attempt to repair malformed JSON, because a reply
 * that needs repairing is a reply whose alignment should be checked, not patched.
 */
export function extractJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	if (start === -1) throw new ArticleAnalysisError("no JSON object found in the reply");

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) {
				const slice = text.slice(start, index + 1);
				try {
					return JSON.parse(slice);
				} catch (error) {
					throw new ArticleAnalysisError(
						`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	}
	throw new ArticleAnalysisError("unbalanced JSON object in the reply");
}
