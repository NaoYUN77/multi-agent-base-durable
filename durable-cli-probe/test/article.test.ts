// Issue #3 test/article.test.ts
//
// Offline tests for the article pipeline. No network, no credentials, no real
// model: every Notion call goes through a fake fetch, so the assertions are about
// *this* code's behaviour rather than about a live service.
//
// What these tests can and cannot show:
//
//   they CAN show  that validation rejects bad input before any write, that the
//                  rendered blocks carry the original text unchanged, that a
//                  failure is classified as determinate vs indeterminate, that a
//                  create is attempted exactly once, and that a content mismatch
//                  is reported as a failure.
//   they CANNOT show that a real Notion workspace accepts the request, or that a
//                  real model produces a well-formed reply. Those are the live
//                  checks, and they are reported separately.

import { describe, expect, it } from "vitest";
import type { Client } from "@notionhq/client";
import {
	ArticleAnalysisError,
	ArticleInputError,
	extractJsonObject,
	parseArticleAnalysis,
	parseArticleInput,
	type ArticleInput,
} from "../src/article/contract.ts";
import { articleSpecPath, buildAnalysisPrompt, loadArticleSpec, ArticleSpecError } from "../src/article/spec.ts";
import { describeScopeProblem, toolResultsOfSubmission } from "../src/article/submission-results.ts";
import {
	ArticleRenderError,
	NOTION_MAX_BLOCKS_PER_REQUEST,
	renderArticleBlocks,
	splitRichText,
	toCreatePageParameters,
} from "../src/notion/article-blocks.ts";
import {
	ArticleWriteIndeterminateError,
	createArticlePage,
	readBackArticlePage,
} from "../src/notion/article-write.ts";
import { NotionRequestError } from "../src/notion/client.ts";
import { createNotionWriteArticleTool, NOTION_WRITE_TOOL_NAME } from "../src/notion/article-tool.ts";
import { createNotionClient } from "../src/notion/client.ts";

// ─────────────────────────────────────────────────────────────── fake Notion

interface RecordedRequest {
	readonly method: string;
	readonly url: string;
	readonly body: unknown;
}

interface FakeOptions {
	readonly create?: { status?: number; json?: unknown; headers?: Record<string, string> };
	readonly pageTitle?: string;
	readonly children?: readonly unknown[];
	/** Fail the transport instead of answering, to exercise the unknown-outcome path. */
	readonly transportFailure?: string;
}

function jsonResponse(status: number, json: unknown, headers: Record<string, string> = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
		text: async () => JSON.stringify(json),
	};
}

/** A fake Notion REST surface that records every request. */
function fakeNotion(options: FakeOptions = {}) {
	const requests: RecordedRequest[] = [];
	const fetchImpl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
		const method = (init.method ?? "GET").toUpperCase();
		const target = String(url);
		requests.push({ method, url: target, body: init.body === undefined ? undefined : JSON.parse(init.body) });

		if (options.transportFailure !== undefined) throw new Error(options.transportFailure);

		if (method === "POST" && target.includes("/v1/pages")) {
			const answer = options.create ?? {
				status: 200,
				json: { object: "page", id: "page-created-1", url: "https://www.notion.so/page-created-1" },
			};
			return jsonResponse(answer.status ?? 200, answer.json ?? {}, answer.headers);
		}
		if (method === "GET" && /\/v1\/pages\/[^/]+$/.test(target)) {
			return jsonResponse(200, {
				object: "page",
				id: "page-created-1",
				properties: { title: { title: [{ plain_text: options.pageTitle ?? "T" }] } },
			});
		}
		if (method === "GET" && /\/v1\/blocks\/[^/]+\/children/.test(target)) {
			return jsonResponse(200, {
				object: "list",
				results: options.children ?? [],
				has_more: false,
				next_cursor: null,
			});
		}
		return jsonResponse(404, { object: "error", status: 404, code: "object_not_found", message: "no fake route" });
	};
	return { requests, fetchImpl };
}

function clientOver(options: FakeOptions = {}) {
	const { requests, fetchImpl } = fakeNotion(options);
	const client = createNotionClient(
		{ token: "ntn_test_token", version: "2026-03-11", baseUrl: "https://api.notion.com", pageId: undefined },
		{ fetch: fetchImpl as unknown as typeof globalThis.fetch, maxRetries: 0 },
	);
	return { client, requests };
}

// ─────────────────────────────────────────────────────────────── fixtures

const SAMPLE: ArticleInput = {
	requestId: "req-1",
	title: "样例标题",
	source: "人工编写验收样例",
	paragraphs: ["第一段。", "第二段。", "第三段。"],
};

function analysisFor(count: number) {
	return {
		paragraphs: Array.from({ length: count }, (_, index) => ({
			paragraphId: index + 1,
			summary: `摘要 ${index + 1}`,
			roleInArticle: `作用 ${index + 1}`,
		})),
	};
}

/** The response blocks a real create+read would produce, derived from the request. */
function echoChildren(children: readonly unknown[]): unknown[] {
	return children.map((block) => {
		const record = block as Record<string, unknown>;
		const type = record["type"] as string;
		const richText = (record[type] as { rich_text: { text: { content: string } }[] }).rich_text;
		return {
			object: "block",
			type,
			[type]: { rich_text: richText.map((item) => ({ plain_text: item.text.content })) },
		};
	});
}

// ─────────────────────────────────────────────────────────────── contract

describe("article input contract", () => {
	it("accepts a well-formed input", () => {
		const parsed = parseArticleInput({
			requestId: "r",
			title: "t",
			source: "s",
			paragraphs: ["a", ""],
		});
		expect(parsed.paragraphs).toEqual(["a", ""]);
		expect(parsed.sourceUrl).toBeUndefined();
	});

	it("keeps a blank paragraph instead of dropping it", () => {
		const parsed = parseArticleInput({ requestId: "r", title: "t", source: "s", paragraphs: ["a", "   "] });
		expect(parsed.paragraphs).toHaveLength(2);
	});

	it("rejects a missing or blank required field, naming the field", () => {
		expect(() => parseArticleInput({ title: "t", source: "s", paragraphs: ["a"] })).toThrowError(ArticleInputError);
		expect(() => parseArticleInput({ requestId: " ", title: "t", source: "s", paragraphs: ["a"] })).toThrowError(
			/requestId must not be empty/,
		);
		expect(() => parseArticleInput({ requestId: "r", title: "", source: "s", paragraphs: ["a"] })).toThrowError(
			/title must not be empty/,
		);
	});

	it("rejects an empty or non-array paragraph list", () => {
		expect(() => parseArticleInput({ requestId: "r", title: "t", source: "s", paragraphs: [] })).toThrowError(
			/must not be empty/,
		);
		expect(() => parseArticleInput({ requestId: "r", title: "t", source: "s", paragraphs: "a" })).toThrowError(
			/must be an array/,
		);
	});

	it("rejects a non-string paragraph and names its index", () => {
		expect(() => parseArticleInput({ requestId: "r", title: "t", source: "s", paragraphs: ["a", 7] })).toThrowError(
			/paragraphs\[1\]/,
		);
	});

	it("rejects a relative or non-http sourceUrl", () => {
		expect(() =>
			parseArticleInput({ requestId: "r", title: "t", source: "s", sourceUrl: "/x", paragraphs: ["a"] }),
		).toThrowError(/absolute URL/);
		expect(() =>
			parseArticleInput({ requestId: "r", title: "t", source: "s", sourceUrl: "ftp://x/y", paragraphs: ["a"] }),
		).toThrowError(/http or https/);
	});

	it("rejects a sourceUrl over Notion's 2000-character limit", () => {
		const long = `https://example.com/${"a".repeat(2000)}`;
		expect(() =>
			parseArticleInput({ requestId: "r", title: "t", source: "s", sourceUrl: long, paragraphs: ["a"] }),
		).toThrowError(/exceeds 2000/);
	});
});

describe("article analysis contract", () => {
	it("accepts one entry per paragraph", () => {
		const parsed = parseArticleAnalysis(analysisFor(3), 3);
		expect(parsed.paragraphs.map((p) => p.paragraphId)).toEqual([1, 2, 3]);
	});

	it("rejects a wrong entry count", () => {
		expect(() => parseArticleAnalysis(analysisFor(2), 3)).toThrowError(/expected 3 paragraph entries, got 2/);
	});

	it("rejects a duplicate paragraphId", () => {
		const bad = { paragraphs: [{ paragraphId: 1, summary: "a", roleInArticle: "b" }, { paragraphId: 1, summary: "c", roleInArticle: "d" }] };
		expect(() => parseArticleAnalysis(bad, 2)).toThrowError(/appears more than once/);
	});

	it("rejects a dropped paragraph as a count mismatch, and a renumbered one as a duplicate", () => {
		// A model that drops paragraph 2 returns N-1 entries.
		const dropped = {
			paragraphs: [
				{ paragraphId: 1, summary: "a", roleInArticle: "a" },
				{ paragraphId: 3, summary: "c", roleInArticle: "c" },
				{ paragraphId: 4, summary: "d", roleInArticle: "d" },
			],
		};
		expect(() => parseArticleAnalysis(dropped, 4)).toThrowError(/expected 4 paragraph entries, got 3/);

		// A model that renumbers returns N entries but repeats one id.
		const renumbered = {
			paragraphs: [
				{ paragraphId: 1, summary: "a", roleInArticle: "a" },
				{ paragraphId: 2, summary: "b", roleInArticle: "b" },
				{ paragraphId: 3, summary: "c", roleInArticle: "c" },
				{ paragraphId: 3, summary: "d", roleInArticle: "d" },
			],
		};
		expect(() => parseArticleAnalysis(renumbered, 4)).toThrowError(/appears more than once/);

		// An id outside 1..N is rejected outright.
		const outOfRange = {
			paragraphs: [
				{ paragraphId: 1, summary: "a", roleInArticle: "a" },
				{ paragraphId: 3, summary: "c", roleInArticle: "c" },
			],
		};
		expect(() => parseArticleAnalysis(outOfRange, 2)).toThrowError(/outside 1\.\.2/);
	});

	it("rejects an empty summary or role", () => {
		expect(() =>
			parseArticleAnalysis({ paragraphs: [{ paragraphId: 1, summary: " ", roleInArticle: "b" }] }, 1),
		).toThrowError(/summary must be a non-empty string/);
		expect(() =>
			parseArticleAnalysis({ paragraphs: [{ paragraphId: 1, summary: "a", roleInArticle: "" }] }, 1),
		).toThrowError(/roleInArticle must be a non-empty string/);
	});

	it("returns entries in paragraph order even when the reply is shuffled", () => {
		const shuffled = {
			paragraphs: [
				{ paragraphId: 3, summary: "c", roleInArticle: "c" },
				{ paragraphId: 1, summary: "a", roleInArticle: "a" },
				{ paragraphId: 2, summary: "b", roleInArticle: "b" },
			],
		};
		expect(parseArticleAnalysis(shuffled, 3).paragraphs.map((p) => p.paragraphId)).toEqual([1, 2, 3]);
	});

	it("rejects a non-object reply", () => {
		expect(() => parseArticleAnalysis("nope", 1)).toThrowError(ArticleAnalysisError);
	});
});

describe("extractJsonObject", () => {
	it("reads a bare object", () => {
		expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
	});

	it("reads through a markdown code fence", () => {
		expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it("reads through surrounding prose", () => {
		expect(extractJsonObject('好的，结果如下：\n{"a":1}\n以上。')).toEqual({ a: 1 });
	});

	it("is not confused by braces inside a string", () => {
		expect(extractJsonObject('{"a":"}{"}')).toEqual({ a: "}{" });
	});

	it("throws on an unbalanced object", () => {
		expect(() => extractJsonObject('{"a":1')).toThrowError(/unbalanced/);
	});
});

// ─────────────────────────────────────────────────────────────── spec

describe("article spec loading", () => {
	it("loads the real spec file and it is non-empty", () => {
		const spec = loadArticleSpec();
		expect(spec.length).toBeGreaterThan(500);
		expect(spec).toContain("roleInArticle");
	});

	it("states the language rule symmetrically, in both directions", () => {
		const spec = loadArticleSpec();
		// The previous wording only exemplified Chinese, which is the behaviour
		// Issue #6 is about. Both directions must be spelled out.
		expect(spec).toMatch(/英文[\s\S]{0,40}英文/);
		expect(spec).toMatch(/中文[\s\S]{0,40}中文/);
	});

	it("names the things that must NOT decide the output language", () => {
		const spec = loadArticleSpec();
		// The spec's own language is the most likely decoy: it is written in Chinese.
		expect(spec).toContain("本规范自身的语言");
		// Metadata that happens to be Chinese must not drive the output language.
		expect(spec).toContain("source");
		expect(spec).toContain("title");
		// And the rule must be anchored to the body, not to the instructions.
		expect(spec).toMatch(/正文/);
	});

	it("throws rather than silently continuing when the file is absent", () => {
		expect(() => loadArticleSpec("C:/definitely/not/a/root")).toThrowError(ArticleSpecError);
	});

	it("points at prompts/article-analysis.md", () => {
		expect(articleSpecPath().replace(/\\/g, "/")).toMatch(/\/prompts\/article-analysis\.md$/);
	});

	it("puts the spec, the numbered paragraphs, and the tool name into the prompt", () => {
		const prompt = buildAnalysisPrompt("SPEC-BODY", SAMPLE, "notion_write_article");
		expect(prompt).toContain("SPEC-BODY");
		expect(prompt).toContain('"paragraphId": 1');
		expect(prompt).toContain("第一段。");
		expect(prompt).toContain("段落数：3");
		// The reply must arrive as a tool call; saying so in the prompt is what
		// makes a real model do it rather than printing JSON as text.
		expect(prompt).toContain("notion_write_article");
		expect(prompt).toContain("不要把 JSON 作为文本输出");
	});
});

// ─────────────────────────────────────────────────────────────── rendering

describe("article rendering", () => {
	it("emits 来源 / 原文 / 逐段解读 in that order", () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const headings = rendered.children
			.filter((block) => (block as { type?: string }).type === "heading_2")
			.map((block) => (block as { heading_2: { rich_text: { text: { content: string } }[] } }).heading_2.rich_text[0]!.text.content);
		expect(headings).toEqual(["来源", "原文", "逐段解读"]);
	});

	it("keeps the original paragraph text verbatim, in order", () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const paragraphs = rendered.children
			.filter((block) => (block as { type?: string }).type === "paragraph")
			.map((block) =>
				(block as { paragraph: { rich_text: { text: { content: string } }[] } }).paragraph.rich_text
					.map((item) => item.text.content)
					.join(""),
			);
		// 来源 line, then the three original paragraphs, then three analysis blocks.
		expect(paragraphs.slice(1, 4)).toEqual(SAMPLE.paragraphs);
	});

	it("counts the characters it placed on the page", () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		expect(rendered.originalChars).toBe(SAMPLE.paragraphs.join("").length);
		expect(rendered.paragraphCount).toBe(3);
	});

	it("splits a long paragraph into 2000-character rich-text items without losing text", () => {
		const long = "字".repeat(5000);
		expect(splitRichText(long).map((chunk) => chunk.length)).toEqual([2000, 2000, 1000]);
		expect(splitRichText(long).join("")).toBe(long);
	});

	it("rejects an article that exceeds one request's block limit instead of truncating", () => {
		const many: ArticleInput = { ...SAMPLE, paragraphs: Array.from({ length: 60 }, (_, i) => `段 ${i}`) };
		expect(() => renderArticleBlocks(many, parseArticleAnalysis(analysisFor(60), 60))).toThrowError(ArticleRenderError);
		expect(() => renderArticleBlocks(many, parseArticleAnalysis(analysisFor(60), 60))).toThrowError(
			new RegExp(String(NOTION_MAX_BLOCKS_PER_REQUEST)),
		);
	});

	it("rejects an analysis whose length disagrees with the article", () => {
		expect(() => renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(2), 2))).toThrowError(
			/analysis has 2 entries but the article has 3/,
		);
	});

	it("takes the parent page from the caller, not from the article", () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const params = toCreatePageParameters(SAMPLE, rendered, "parent-from-config");
		expect(params.parent).toEqual({ type: "page_id", page_id: "parent-from-config" });
		expect(params.properties).toMatchObject({ title: { title: [{ text: { content: SAMPLE.title } }] } });
	});

	it("links the source URL when one is present", () => {
		const withUrl: ArticleInput = { ...SAMPLE, sourceUrl: "https://example.com/a" };
		const rendered = renderArticleBlocks(withUrl, parseArticleAnalysis(analysisFor(3), 3));
		const sourceBlock = rendered.children[1] as { paragraph: { rich_text: { text: { link?: { url: string } } }[] } };
		expect(sourceBlock.paragraph.rich_text.some((item) => item.text.link?.url === "https://example.com/a")).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────── write

describe("article write", () => {
	it("posts exactly one create, to the configured parent", async () => {
		const { client, requests } = clientOver();
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const result = await createArticlePage(client, toCreatePageParameters(SAMPLE, rendered, "parent-1"), {
			blockCount: rendered.blockCount,
			richTextCount: rendered.richTextCount,
			paragraphCount: rendered.paragraphCount,
			originalChars: rendered.originalChars,
			analysisChars: rendered.analysisChars,
			payloadBytes: rendered.payloadBytes,
		});

		expect(result.pageId).toBe("page-created-1");
		expect(result.pageUrl).toBe("https://www.notion.so/page-created-1");

		const posts = requests.filter((r) => r.method === "POST");
		expect(posts).toHaveLength(1);
		expect((posts[0]!.body as { parent: unknown }).parent).toEqual({ type: "page_id", page_id: "parent-1" });
	});

	it("classifies validation_error as a determinate failure", async () => {
		const { client } = clientOver({
			create: { status: 400, json: { object: "error", status: 400, code: "validation_error", message: "bad body" } },
		});
		await expect(
			createArticlePage(
				client,
				{ parent: { page_id: "p" }, properties: {} } as never,
				{ blockCount: 0, richTextCount: 0, paragraphCount: 0, originalChars: 0, analysisChars: 0, payloadBytes: 0 },
			),
		).rejects.toBeInstanceOf(NotionRequestError);
	});

	it("classifies 503 as an indeterminate write, because the page may already exist", async () => {
		const { client } = clientOver({
			create: { status: 503, json: { object: "error", status: 503, code: "service_unavailable", message: "saved but no response" } },
		});
		const attempt = createArticlePage(
			client,
			{ parent: { page_id: "p" }, properties: {} } as never,
			{ blockCount: 0, richTextCount: 0, paragraphCount: 0, originalChars: 0, analysisChars: 0, payloadBytes: 0 },
		);
		await expect(attempt).rejects.toBeInstanceOf(ArticleWriteIndeterminateError);
		// The guidance is what the operator reads; it must say "check first", not "retry".
		await expect(attempt).rejects.toThrowError(/service_unavailable/);
		try {
			await attempt;
		} catch (error) {
			expect((error as ArticleWriteIndeterminateError).guidance).toContain("可能已创建");
			expect((error as ArticleWriteIndeterminateError).guidance).toContain("不要直接换 requestId 重试");
		}
	});

	it("classifies a transport failure as indeterminate and does not retry", async () => {
		const { client, requests } = clientOver({ transportFailure: "socket hang up" });
		await expect(
			createArticlePage(
				client,
				{ parent: { page_id: "p" }, properties: {} } as never,
				{ blockCount: 0, richTextCount: 0, paragraphCount: 0, originalChars: 0, analysisChars: 0, payloadBytes: 0 },
			),
		).rejects.toBeInstanceOf(ArticleWriteIndeterminateError);
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
	});
});

// ─────────────────────────────────────────────────────────────── read-back

describe("read-back verification", () => {
	it("matches when the stored title and blocks equal what was sent", async () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const { client } = clientOver({ children: echoChildren(rendered.children), pageTitle: SAMPLE.title });
		const report = await readBackArticlePage(client, "page-created-1", rendered.children, rendered.title);
		expect(report.matches).toBe(true);
		expect(report.titleMatches).toBe(true);
		expect(report.title).toBe(SAMPLE.title);
		expect(report.actualBlocks).toBe(rendered.children.length);
	});

	it("fails when the page title differs, even though every block matches", async () => {
		// The title lives in a property, not in the children, so a block-only
		// comparison would call this page correct.
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const { client } = clientOver({ children: echoChildren(rendered.children), pageTitle: "WRONG TITLE" });
		const report = await readBackArticlePage(client, "page-created-1", rendered.children, rendered.title);
		expect(report.titleMatches).toBe(false);
		expect(report.matches).toBe(false);
		expect(report.expectedTitle).toBe(SAMPLE.title);
		expect(report.title).toBe("WRONG TITLE");
	});

	it("detects a block that is missing from the page", async () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const short = echoChildren(rendered.children).slice(0, -1);
		const { client } = clientOver({ children: short, pageTitle: SAMPLE.title });
		const report = await readBackArticlePage(client, "page-created-1", rendered.children, rendered.title);
		expect(report.matches).toBe(false);
		expect(report.mismatches.length).toBeGreaterThan(0);
	});

	it("detects changed text", async () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const tampered = echoChildren(rendered.children);
		const last = tampered[tampered.length - 1] as { paragraph: { rich_text: { plain_text: string }[] } };
		last.paragraph.rich_text = last.paragraph.rich_text.map((item) => ({ plain_text: `${item.plain_text} 改动` }));
		const { client } = clientOver({ children: tampered, pageTitle: SAMPLE.title });
		const report = await readBackArticlePage(client, "page-created-1", rendered.children, rendered.title);
		expect(report.matches).toBe(false);
	});
});

describe("one processing creates at most one page", () => {
	/** A client whose children echo whatever the tool sent, so read-back matches. */
	function happyClient() {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		return { rendered, ...clientOver({ children: echoChildren(rendered.children), pageTitle: SAMPLE.title }) };
	}

	it("reuses the created page when the tool is called twice in one processing", async () => {
		const { client, requests } = happyClient();
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });

		const first = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		const second = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);

		expect(first.isError).toBeFalsy();
		expect(second.isError).toBeFalsy();
		// The second call must not reach the API at all.
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
		expect(second.details).toMatchObject({ pageId: first.details?.pageId });
		expect(JSON.stringify(second.output)).toContain("未重复创建");
	});

	it("refuses a concurrent second call while the first create is in flight", async () => {
		// Delay the create so the second call arrives while `running` is set.
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { requests, fetchImpl } = fakeNotion({
			children: echoChildren(rendered.children),
			pageTitle: SAMPLE.title,
		});
		const slowFetch = (async (url: string, init: never) => {
			if ((init as { method?: string }).method === "POST") await gate;
			return fetchImpl(url, init);
		}) as unknown as typeof globalThis.fetch;
		const client = createNotionClient(
			{ token: "ntn_test_token", version: "2026-03-11", baseUrl: "https://api.notion.com", pageId: undefined },
			{ fetch: slowFetch, maxRetries: 0 },
		);

		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		const inFlight = tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		// The first call has reached its `await`; the guard must already be set.
		await Promise.resolve();
		const concurrent = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(concurrent.isError).toBe(true);
		expect(JSON.stringify(concurrent.output)).toContain("正在进行中");

		release?.();
		await inFlight;
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
	});

	it("refuses to create again after an uncertain outcome, and says to check first", async () => {
		const { client, requests } = clientOver({
			create: { status: 503, json: { object: "error", status: 503, code: "service_unavailable", message: "saved but no response" } },
		});
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });

		const first = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(first.isError).toBe(true);
		expect(JSON.stringify(first.output)).toContain("可能已创建");

		const second = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(second.isError).toBe(true);
		expect(JSON.stringify(second.output)).toContain("拒绝重复创建");
		expect(JSON.stringify(second.output)).toContain("核查");
		// Only the first call ever reached the API.
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
	});

	it("does not create again after a read-back failure, and reports the known page", async () => {
		// Create succeeds; the children list is empty, so the read-back mismatches.
		const { client, requests } = clientOver({ children: [], pageTitle: SAMPLE.title });
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });

		const first = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(first.isError).toBe(true);

		const second = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(second.isError).toBe(true);
		expect(second.details).toMatchObject({ pageId: "page-created-1" });
		expect(JSON.stringify(second.output)).toContain("未重复创建");
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
	});

	it("allows a retry after a determinate failure, because nothing was written", async () => {
		const { client, requests } = clientOver({
			create: { status: 400, json: { object: "error", status: 400, code: "validation_error", message: "bad body" } },
		});
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		const first = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(first.isError).toBe(true);
		// A second attempt is legitimate here: the first provably wrote nothing.
		await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(2);
	});

	it("reports the title mismatch through the tool as an error", async () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const { client } = clientOver({ children: echoChildren(rendered.children), pageTitle: "WRONG TITLE" });
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		const result = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ readBackMatches: false });
		expect(JSON.stringify(result.output)).toContain("title: MISMATCH");
	});
});

describe("scoping tool results to one submission", () => {
	const entries = [
		{ id: 1, kind: "pi.user" },
		{ id: 2, kind: "pi.system" },
		{ id: 3, kind: "pi.assistant" },
		{ id: 4, kind: "pi.tool-result" }, // belongs to submission A
		{ id: 5, kind: "pi.assistant" },
		{ id: 6, kind: "pi.user" }, // submission B starts here
		{ id: 7, kind: "pi.assistant" },
	];

	it("returns only the results committed between this submission's input and its answer", () => {
		const scoped = toolResultsOfSubmission(entries, { status: "done", entry: 6, answer: 7 });
		expect("results" in scoped && scoped.results.map((entry) => entry.id)).toEqual([]);

		const earlier = toolResultsOfSubmission(entries, { status: "done", entry: 1, answer: 5 });
		expect("results" in earlier && earlier.results.map((entry) => entry.id)).toEqual([4]);
	});

	it("does not let a later run borrow an earlier run's success", () => {
		// Run B settled `done` but called no tool. A must not be consulted.
		const scoped = toolResultsOfSubmission(entries, { status: "done", entry: 6, answer: 7 });
		expect("results" in scoped).toBe(true);
		expect("results" in scoped && scoped.results).toHaveLength(0);
	});

	it("does not let an earlier failure poison a later success", () => {
		const withFailure = [{ id: 1, kind: "pi.user" }, { id: 2, kind: "pi.tool-result" }, { id: 3, kind: "pi.user" }, { id: 4, kind: "pi.tool-result" }, { id: 5, kind: "pi.assistant" }];
		const later = toolResultsOfSubmission(withFailure, { status: "done", entry: 3, answer: 5 });
		expect("results" in later && later.results.map((entry) => entry.id)).toEqual([4]);
	});

	it("reports a problem instead of guessing when the submission did not settle done", () => {
		const scoped = toolResultsOfSubmission(entries, { status: "unanswered", entry: 6, answer: 7 });
		expect("problem" in scoped && scoped.problem.reason).toBe("not_done");
	});

	it("reports a problem when the boundaries are missing from the transcript", () => {
		expect("problem" in toolResultsOfSubmission(entries, { status: "done", entry: 99, answer: 7 })).toBe(true);
		expect("problem" in toolResultsOfSubmission(entries, { status: "done", entry: 6 })).toBe(true);
	});

	it("locates the original results when a completed requestId is replayed", () => {
		// A replay returns the same submission record, so the same range applies.
		const scoped = toolResultsOfSubmission(entries, { status: "done", entry: 1, answer: 5 });
		expect("results" in scoped && scoped.results.map((entry) => entry.id)).toEqual([4]);
	});
});

// ─────────────────────────────────────────────────────────────── tool

describe("notion_write_article tool", () => {
	it("is named as the issue requires and is declared unsafe", () => {
		const { client } = clientOver();
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		expect(tool.name).toBe(NOTION_WRITE_TOOL_NAME);
		expect(tool.name).toBe("notion_write_article");
		expect(tool.replay).toBe("unsafe");
	});

	it("refuses a misaligned analysis and writes nothing", async () => {
		const { client, requests } = clientOver();
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		const result = await tool.execute({ paragraphs: analysisFor(2).paragraphs } as never, {} as never, {} as never);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.output)).toContain("Nothing was written");
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
	});

	it("rejects an over-limit article before any request", async () => {
		const many: ArticleInput = { ...SAMPLE, paragraphs: Array.from({ length: 60 }, (_, i) => `段 ${i}`) };
		const { client, requests } = clientOver();
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: many });
		const result = await tool.execute({ paragraphs: analysisFor(60).paragraphs } as never, {} as never, {} as never);
		expect(result.isError).toBe(true);
		expect(requests).toHaveLength(0);
	});

	it("creates, reads back, and reports a match on the happy path", async () => {
		const rendered = renderArticleBlocks(SAMPLE, parseArticleAnalysis(analysisFor(3), 3));
		const { client } = clientOver({ children: echoChildren(rendered.children), pageTitle: SAMPLE.title });
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		const result = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(result.isError).toBeFalsy();
		expect(result.details).toMatchObject({ pageId: "page-created-1", readBackMatches: true, readBackMismatches: 0 });
	});

	it("reports a content mismatch as an error even though the page exists", async () => {
		const { client } = clientOver({ children: [] });
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE });
		const result = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ readBackMatches: false });
		expect((result.details as { readBackMismatches: number }).readBackMismatches).toBeGreaterThan(0);
	});

	it("dry-run renders and validates without contacting Notion", async () => {
		const { client, requests } = clientOver();
		const tool = createNotionWriteArticleTool({ client, parentPageId: "p", article: SAMPLE, dryRun: true });
		const result = await tool.execute({ paragraphs: analysisFor(3).paragraphs } as never, {} as never, {} as never);
		expect(result.isError).toBeFalsy();
		expect(requests).toHaveLength(0);
	});
});
