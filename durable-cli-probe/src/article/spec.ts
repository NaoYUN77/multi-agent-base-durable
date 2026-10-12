// Issue #3 src/article/spec.ts
//
// Loads `prompts/article-analysis.md` and turns it into the instruction the model
// actually receives.
//
// Why this is a separate module rather than a string constant: the spec is meant
// to be edited by a human without touching TypeScript, and a spec that is only
// *present* in the repository while the code uses a hard-coded copy is worse than
// no spec at all — it silently drifts. `loadArticleSpec()` therefore throws when
// the file is missing or blank, so a run cannot succeed while ignoring it.
//
// The path is resolved from this module's own location, not from `process.cwd()`,
// so `npm run article:probe` works from any directory.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArticleInput } from "./contract.ts";

/** Thrown when the spec file is absent or unusable. Never swallowed. */
export class ArticleSpecError extends Error {
	readonly path: string;
	constructor(path: string, detail: string) {
		super(`article spec: ${detail} (looked at ${path})`);
		this.name = "ArticleSpecError";
		this.path = path;
	}
}

/** `src/article/spec.ts` -> the probe root. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The spec's location relative to the probe root. */
export const ARTICLE_SPEC_RELATIVE_PATH = "prompts/article-analysis.md";

/** Absolute path of the spec file for a given probe root. */
export function articleSpecPath(root: string = resolve(HERE, "..", "..")): string {
	return resolve(root, ARTICLE_SPEC_RELATIVE_PATH);
}

/**
 * Read the spec.
 *
 * Returns the file's text verbatim. An empty spec is treated as missing: a blank
 * instruction would let a run "pass" while the model had no guidance at all.
 */
export function loadArticleSpec(root?: string): string {
	const path = articleSpecPath(root);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ArticleSpecError(path, `cannot be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (text.trim() === "") throw new ArticleSpecError(path, "is empty");
	return text;
}

/**
 * Compose the instruction for one article.
 *
 * The spec comes first and is unmodified, so what a reviewer reads in the file is
 * what the model was told. The article follows as JSON: paragraphs are sent as an
 * array, and the model is told the array index + 1 is the `paragraphId` it must
 * echo back. Sending them as data (not prose) keeps the numbering unambiguous.
 *
 * `toolName` is a parameter rather than an import so this module stays free of
 * any dependency on the Notion side — the caller knows which tool it installed.
 */
export function buildAnalysisPrompt(spec: string, input: ArticleInput, toolName: string): string {
	const payload = {
		title: input.title,
		source: input.source,
		...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
		paragraphCount: input.paragraphs.length,
		paragraphs: input.paragraphs.map((text, index) => ({ paragraphId: index + 1, text })),
	};

	return [
		spec.trim(),
		"",
		"---",
		"",
		"## 本次输入",
		"",
		`段落数：${input.paragraphs.length}。输出必须包含 ${input.paragraphs.length} 条记录，\`paragraphId\` 取 1 至 ${input.paragraphs.length}。`,
		"",
		"```json",
		JSON.stringify(payload, null, 2),
		"```",
		"",
		`现在按规范调用 \`${toolName}\` 工具，把 ${input.paragraphs.length} 段解读一次性提交。不要把 JSON 作为文本输出。`,
	].join("\n");
}
