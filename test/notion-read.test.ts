// TASK-002 test/notion-read.test.ts
//
// Offline tests for the Notion read layer and the Durable tool.
//
// The task forbids treating a real Notion call as the only test (constraint 7),
// so everything here runs with no network and no token. A fake `fetch` stands in
// for Notion: it records the requests the SDK makes and replies with canned JSON.
// That is enough to assert the things a live call cannot pin down reliably —
// pagination wiring, the `Notion-Version` header, the projections that keep a raw
// response out of the model's context, and how an error is normalized.
//
// The Durable half of the coverage (tool → registry → transcript → restart) lives
// in cli-tool.ts, which needs a token because its tool calls are real reads. What
// is testable offline is covered here.

import { describe, expect, it } from "vitest";
import { Client } from "@notionhq/client";
import { loadNotionConfig, NotionConfigError, redactToken } from "../src/config.ts";
import {
	callNotion,
	createNotionClient,
	normalizeNotionError,
	NotionRequestError,
	describeNotionError,
} from "../src/notion/client.ts";
import {
	blockChildren,
	pageSummary,
	plainTextOf,
	renderBlockLines,
	renderPropertyValue,
	renderSearchResult,
	search,
	usersMe,
	NOTION_MAX_PAGE_SIZE,
} from "../src/notion/read.ts";

/** One recorded request from the fake fetch. */
interface Recorded {
	readonly method: string;
	readonly url: string;
	readonly version: string | undefined;
	readonly auth: string | undefined;
	readonly body: unknown;
}

/** A fake `fetch` that answers a queue of (status, json) responses and records every request. */
function fakeFetch(responses: readonly { status?: number; json?: unknown; headers?: Record<string, string> }[]) {
	const recorded: Recorded[] = [];
	let index = 0;
	const fetchImpl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
		recorded.push({
			method: init.method ?? "GET",
			url: String(url),
			version: init.headers?.["Notion-Version"],
			// The SDK sends this header lowercased; read it case-insensitively so the
			// test asserts the value, not the SDK's spelling.
			auth: init.headers?.authorization ?? init.headers?.["Authorization"],
			body: init.body === undefined ? undefined : JSON.parse(init.body),
		});
		const next = responses[Math.min(index, responses.length - 1)]!;
		index++;
		const status = next.status ?? 200;
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
			text: async () => JSON.stringify(next.json ?? {}),
		};
	};
	return { recorded, fetchImpl };
}

/** Build a client over the fake fetch, with the version the probe pins. */
function clientWith(responses: readonly { status?: number; json?: unknown; headers?: Record<string, string> }[]) {
	const { recorded, fetchImpl } = fakeFetch(responses);
	const client = createNotionClient(
		{ token: "ntn_test_token", version: "2026-03-11", baseUrl: "https://api.notion.com", pageId: undefined },
		{ fetch: fetchImpl as unknown as typeof globalThis.fetch, maxRetries: 0 },
	);
	return { client, recorded };
}

// ─────────────────────────────────────────────────────────────── config

describe("config", () => {
	it("redacts a token rather than echoing it", () => {
		expect(redactToken("ntn_supersecret")).toBe("<redacted>");
		expect(redactToken("")).toBe("<empty>");
	});

	it("throws a named config error when NOTION_TOKEN is absent, naming only the variable", () => {
		expect(() => loadNotionConfig({} as NodeJS.ProcessEnv)).toThrowError(NotionConfigError);
		try {
			loadNotionConfig({} as NodeJS.ProcessEnv);
		} catch (error) {
			expect((error as NotionConfigError).variable).toBe("NOTION_TOKEN");
			expect((error as Error).message).not.toContain("secret");
		}
	});

	it("pins Notion-Version and reads the page id from the environment", () => {
		const config = loadNotionConfig({ NOTION_TOKEN: "ntn_x", NOTION_PAGE_ID: "  page-1  " } as NodeJS.ProcessEnv);
		expect(config.version).toBe("2026-03-11");
		expect(config.pageId).toBe("page-1");
		expect(config.baseUrl).toBe("https://api.notion.com");
	});
});

// ─────────────────────────────────────────────────────── request wiring

describe("client request wiring", () => {
	it("sends Notion-Version 2026-03-11 and the bearer token on every call", async () => {
		const { client, recorded } = clientWith([
			{ json: { object: "user", id: "u1", name: "Bot", type: "bot", bot: { owner: { type: "workspace" } } } },
		]);
		await usersMe(client);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]!.version).toBe("2026-03-11");
		expect(recorded[0]!.auth).toBe("Bearer ntn_test_token");
		expect(recorded[0]!.method).toBe("GET");
		expect(recorded[0]!.url).toContain("/v1/users/me");
	});

	it("caps page_size at Notion's maximum", async () => {
		const { client, recorded } = clientWith([{ json: { object: "list", results: [], has_more: false, next_cursor: null } }]);
		await search(client, { pageSize: 999 });
		expect(recorded[0]!.body).toMatchObject({ page_size: NOTION_MAX_PAGE_SIZE });
	});

	it("wraps a failure in NotionRequestError with the endpoint label", async () => {
		const { client } = clientWith([{ status: 401, json: { code: "unauthorized", message: "API token is invalid." } }]);
		await expect(usersMe(client)).rejects.toBeInstanceOf(NotionRequestError);
		await expect(usersMe(client)).rejects.toMatchObject({ endpoint: "users.me", info: { code: "unauthorized", status: 401 } });
	});

	it("normalizes a rate limit and surfaces Retry-After", async () => {
		// A real 429 from the fake fetch becomes an APIResponseError, which is what
		// normalizeNotionError recognizes. Asserting on the error the SDK actually
		// builds is stronger than asserting on a hand-shaped object.
		const { client } = clientWith([{ status: 429, json: { code: "rate_limited", message: "slow down" }, headers: { "retry-after": "7" } }]);
		try {
			await usersMe(client);
			throw new Error("expected usersMe to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(NotionRequestError);
			const info = (error as NotionRequestError).info;
			expect(info.code).toBe("rate_limited");
			expect(info.status).toBe(429);
			expect(info.retryAfterSeconds).toBe(7);
			expect(describeNotionError(info)).toContain("retry_after=7s");
		}
	});

	it("labels a transport failure distinctly from an API failure", () => {
		const info = normalizeNotionError(new TypeError("fetch failed"));
		expect(info.code).toBe("transport_error");
		expect(info.status).toBeUndefined();
	});

	it("never lets a token-shaped string survive normalization", () => {
		const info = normalizeNotionError(new Error("bad header Bearer secret_abc123 rejected"));
		expect(info.message).not.toContain("secret_abc123");
		expect(info.message).toContain("<redacted>");
	});

	it("rethrows a non-Notion error unchanged in kind, still normalized", async () => {
		const { client } = clientWith([{ status: 500, json: {} }]);
		const promise = callNotion("users.me", () => client.users.me({ auth: "ntn_test_token" }));
		await expect(promise).rejects.toBeInstanceOf(NotionRequestError);
	});
});

// ─────────────────────────────────────────────────────────── pagination

describe("pagination", () => {
	it("walks search pages, following next_cursor until has_more is false", async () => {
		const page = (id: string) => ({ object: "page", id, url: `https://notion.so/${id}`, properties: {} });
		const { client, recorded } = clientWith([
			{ json: { object: "list", results: [page("p1"), page("p2")], has_more: true, next_cursor: "cursor-2" } },
			{ json: { object: "list", results: [page("p3")], has_more: false, next_cursor: null } },
		]);
		const result = await search(client, { limit: 10, pageSize: 2 });
		expect(result.hits.map((hit) => hit.id)).toEqual(["p1", "p2", "p3"]);
		expect(result.hasMore).toBe(false);
		expect(result.truncated).toBe(false);
		// The second request carried the cursor the first returned.
		expect(recorded).toHaveLength(2);
		expect(recorded[1]!.body).toMatchObject({ start_cursor: "cursor-2" });
	});

	it("reports truncated when it stops at its own limit while Notion still has more", async () => {
		const page = (id: string) => ({ object: "page", id, properties: {} });
		const { client } = clientWith([
			{ json: { object: "list", results: [page("p1"), page("p2")], has_more: true, next_cursor: "c2" } },
		]);
		const result = await search(client, { limit: 2, pageSize: 2 });
		expect(result.hits).toHaveLength(2);
		expect(result.hasMore).toBe(true);
		expect(result.truncated).toBe(true);
	});

	it("stops paginating at maxPages even when Notion keeps saying has_more", async () => {
		const page = (id: string) => ({ object: "page", id, properties: {} });
		const { client, recorded } = clientWith([
			{ json: { object: "list", results: [page("p1")], has_more: true, next_cursor: "c2" } },
		]);
		const result = await search(client, { limit: 100, pageSize: 1, maxPages: 2 });
		expect(recorded).toHaveLength(2);
		expect(result.hits).toHaveLength(2);
		expect(result.hasMore).toBe(true);
	});

	it("walks block children across pages and marks nested children", async () => {
		const { client, recorded } = clientWith([
			{
				json: {
					object: "list",
					results: [
						{ object: "block", id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "first" }] } },
						{ object: "block", id: "b2", type: "toggle", has_children: true, toggle: { rich_text: [{ plain_text: "more" }] } },
					],
					has_more: true,
					next_cursor: "bc2",
				},
			},
			{
				json: {
					object: "list",
					results: [
						{ object: "block", id: "b3", type: "heading_1", has_children: false, heading_1: { rich_text: [{ plain_text: "Title" }] } },
					],
					has_more: false,
					next_cursor: null,
				},
			},
		]);
		const children = await blockChildren(client, "page-1", { limit: 50, pageSize: 2 });
		expect(children.blockCount).toBe(3);
		expect(children.lines.map((line) => line.text)).toEqual(["first", "more", "Title"]);
		expect(children.hasNestedChildren).toBe(true);
		expect(children.truncated).toBe(false);
		expect(recorded).toHaveLength(2);
		expect(recorded[0]!.url).toContain("/v1/blocks/page-1/children");
		expect(recorded[0]!.method).toBe("GET");
	});
});

// ─────────────────────────────────────────────────────────── projections

describe("projections (raw response never reaches the model)", () => {
	it("flattens rich text and drops annotations", () => {
		expect(plainTextOf([{ plain_text: "hello ", annotations: { bold: true } }, { plain_text: "world" }])).toBe("hello world");
		expect(plainTextOf(undefined)).toBe("");
	});

	it("renders each property type to a short string", () => {
		expect(renderPropertyValue({ type: "title", title: [{ plain_text: "Doc" }] })).toBe("Doc");
		expect(renderPropertyValue({ type: "number", number: 42 })).toBe("42");
		expect(renderPropertyValue({ type: "checkbox", checkbox: true })).toBe("true");
		expect(renderPropertyValue({ type: "select", select: { name: "Done" } })).toBe("Done");
		expect(renderPropertyValue({ type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] })).toBe("a, b");
		expect(renderPropertyValue({ type: "date", date: { start: "2026-01-01" } })).toBe("2026-01-01");
		expect(renderPropertyValue({ type: "relation", relation: [{ id: "1" }, { id: "2" }] })).toBe("2 related");
		expect(renderPropertyValue(undefined)).toBe("");
	});

	it("clamps a long property value instead of passing it through", () => {
		const long = "x".repeat(1000);
		const rendered = renderPropertyValue({ type: "rich_text", rich_text: [{ plain_text: long }] }, 10);
		expect(rendered.length).toBeLessThanOrEqual(11);
		expect(rendered.endsWith("…")).toBe(true);
	});

	it("projects a page to a small summary, not the whole object", async () => {
		const { client } = clientWith([
			{
				json: {
					object: "page",
					id: "page-1",
					url: "https://notion.so/page-1",
					in_trash: false,
					parent: { type: "data_source_id", data_source_id: "ds-1" },
					created_by: { id: "u1" },
					cover: { type: "external", external: { url: "https://example.com/c.png" } },
					icon: { type: "emoji", emoji: "📄" },
					properties: { Name: { type: "title", title: [{ plain_text: "My Page" }] }, Done: { type: "checkbox", checkbox: false } },
				},
			},
		]);
		const summary = await pageSummary(client, "page-1");
		expect(summary.title).toBe("My Page");
		expect(summary.properties).toEqual({ Name: "My Page", Done: "false" });
		expect(summary.parentType).toBe("data_source_id");
		// The projection has no `cover`, `icon`, or `created_by` — nothing raw survives.
		expect(Object.keys(summary).sort()).toEqual(["id", "lastEditedTime", "parentType", "properties", "propertiesTruncated", "title", "url"]);
	});

	it("caps properties and flags the truncation", async () => {
		const properties: Record<string, unknown> = {};
		for (let index = 0; index < 10; index++) properties[`P${index}`] = { type: "number", number: index };
		const { client } = clientWith([{ json: { object: "page", id: "p", properties } }]);
		const summary = await pageSummary(client, "p", { maxProperties: 3 });
		expect(Object.keys(summary.properties)).toHaveLength(3);
		expect(summary.propertiesTruncated).toBe(true);
	});

	it("reads a data_source hit's title from its own field", async () => {
		const { client } = clientWith([
			{
				json: {
					object: "list",
					results: [{ object: "data_source", id: "ds-1", title: "Tasks", url: "https://notion.so/ds-1" }],
					has_more: false,
					next_cursor: null,
				},
			},
		]);
		const result = await search(client, { query: "task", object: "data_source" });
		expect(result.hits[0]).toMatchObject({ object: "data_source", title: "Tasks" });
	});

	it("skips results that are neither a page nor a data source", async () => {
		const { client } = clientWith([
			{ json: { object: "list", results: [{ object: "something_else", id: "x" }], has_more: false, next_cursor: null } },
		]);
		const result = await search(client);
		expect(result.hits).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────── rendering

describe("rendering", () => {
	it("renders a block outline with types and a nested-children notice", () => {
		const text = renderBlockLines({
			rootId: "p",
			lines: [
				{ type: "heading_1", depth: 0, text: "Title", hasChildren: false },
				{ type: "paragraph", depth: 0, text: "Body", hasChildren: true },
			],
			blockCount: 2,
			truncated: false,
			hasNestedChildren: true,
		});
		expect(text).toContain("[heading_1] Title");
		expect(text).toContain("[paragraph] Body ⟶");
		expect(text).toContain("nested children");
	});

	it("renders a search result with ids, and says when it stopped early", () => {
		const text = renderSearchResult({
			query: "x",
			hits: [{ object: "page", id: "p1", title: "One", url: undefined, lastEditedTime: "2026-01-01", parentType: "workspace" }],
			total: 1,
			hasMore: true,
			truncated: true,
		});
		expect(text).toContain("[page] One");
		expect(text).toContain("id: p1");
		expect(text).toContain("has more pages");
		expect(text).toContain("result bound");
	});

	it("says so when there are no results", () => {
		expect(renderSearchResult({ query: "x", hits: [], total: 0, hasMore: false, truncated: false })).toContain("(no results)");
	});
});

// ─────────────────────────────────────────────────────── identity

describe("users.me", () => {
	it("projects the bot identity, including workspace and owner", async () => {
		const { client } = clientWith([
			{
				json: {
					object: "user",
					id: "bot-1",
					name: "Probe",
					type: "bot",
					bot: { owner: { type: "workspace", workspace: true }, workspace_name: "Acme" },
				},
			},
		]);
		expect(await usersMe(client)).toEqual({
			id: "bot-1",
			name: "Probe",
			type: "bot",
			workspaceName: "Acme",
			ownerType: "workspace",
		});
	});
});

// ─────────────────────────────────────────────────────── SDK default check

describe("@notionhq/client export surface", () => {
	it("exposes the Client the probe builds on", () => {
		expect(typeof Client).toBe("function");
		expect(new Client({ auth: "x" })).toBeInstanceOf(Client);
	});
});
