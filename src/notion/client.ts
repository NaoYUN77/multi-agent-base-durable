// TASK-002 src/notion/client.ts
//
// The Notion SDK client and its error normalization.
//
// Two things this file owns and nothing else does:
//
//  1. Pinning the API. Every request goes out with `Notion-Version: 2026-03-11`
//     (see config.ts). 2026-03-11 renamed `archived` to `in_trash` and `after` to
//     `position`; a probe written against a different version would read the wrong
//     field. The version is set once, on the client, so a call site cannot forget.
//
//  2. Turning SDK errors into `NotionErrorInfo`. The SDK throws typed subclasses
//     of `NotionClientError` carrying `code`, `status`, and `additional_data`.
//     A caller that only sees an HTTP status cannot tell "bad token" from "token
//     is fine but this page is not shared with the connection", which is the
//     single most common Notion mistake — so `normalizeNotionError` preserves the
//     API `code`.
//
// The token is passed to `new Client({ auth })` and lives in the client only.
// Nothing here logs it or puts it in an error message; `redactToken()` is applied
// to any message that could conceivably echo the auth header back.

import { Client, APIErrorCode, LogLevel, isNotionClientError } from "@notionhq/client";
import { redactToken, type NotionConfig } from "../config.ts";
import type { NotionErrorInfo } from "./types.ts";

/** The endpoints this probe is allowed to reach. Read-only by construction. */
export type NotionEndpoint = "users.me" | "search" | "pages.retrieve" | "blocks.children.list";

/** How many automatic retries the SDK performs on 429/5xx. Notion asks callers to back off. */
export const DEFAULT_MAX_RETRIES = 3;

/** Notion error codes the probe recognizes by name; unknown codes pass through as their string. */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<string>(Object.values(APIErrorCode));

/**
 * A Notion failure carrying the normalized info, so a caller can both branch on
 * `info.code` and let the error propagate with a useful message.
 */
export class NotionRequestError extends Error {
	readonly info: NotionErrorInfo;
	readonly endpoint: NotionEndpoint;
	constructor(endpoint: NotionEndpoint, info: NotionErrorInfo) {
		super(`${endpoint} failed (${info.code}${info.status === undefined ? "" : ` ${info.status}`}): ${info.message}`);
		this.name = "NotionRequestError";
		this.info = info;
		this.endpoint = endpoint;
	}
}

/** Options for building the client; a test double passes `fetch` and `baseUrl`. */
export interface NotionClientOptions {
	readonly baseUrl?: string;
	readonly maxRetries?: number;
	/**
	 * Injected by tests only. Typed loosely on purpose: the SDK's own fetch type
	 * is not exported from the package root, and a test double only needs to be
	 * assignable to `fetch`. Production calls leave this unset and use global fetch.
	 */
	readonly fetch?: typeof globalThis.fetch;
	/** Fixed clock injected by tests only, for deterministic log lines. */
	readonly now?: () => number;
}

/**
 * Build the SDK client for a config. `notionVersion` and `baseUrl` come from the
 * config, so no call site can drift to another API version.
 */
export function createNotionClient(config: NotionConfig, options: NotionClientOptions = {}): Client {
	return new Client({
		auth: config.token,
		notionVersion: config.version,
		baseUrl: options.baseUrl ?? config.baseUrl,
		// The SDK retries 429 and 529 with the server's Retry-After, and 5xx with
		// backoff. Notion's docs require respecting Retry-After; leaving this on is
		// how the probe respects it instead of hammering a rate limit.
		retry: { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
		...(options.fetch === undefined ? {} : { fetch: options.fetch as never }),
		// `LogLevel.WARN` keeps the SDK from writing request bodies to stdout.
		// Bodies can contain page content; the probe never wants that on a console.
		logLevel: LogLevel.WARN,
	});
}

/** Alias kept short at call sites. */
export type NotionClient = Client;

/**
 * A `fetch` that connects `api.notion.com` to one fixed IP, keeping the TLS SNI
 * and the `Host` header correct.
 *
 * Why this exists: in a restricted network (CI sandbox, or an egress policy that
 * filters a specific hostname), `api.notion.com` can resolve to several addresses
 * where only some accept a connection — the others reset the TLS handshake. The
 * failure is a bare `ECONNRESET` that looks like "Notion is down", when in fact
 * the API is reachable and only one edge address is blocked.
 *
 * This is an operator escape hatch for that case, never a default: the caller
 * passes an IP explicitly (via `NOTION_PIN_IP`), and with it unset the SDK uses
 * global fetch and normal DNS. It only affects the transport; the request itself
 * — version header, auth header, path — is unchanged, so a pinned run is still a
 * real call to the real API.
 */
export function pinnedFetch(ip: string): typeof globalThis.fetch {
	// `node:https` is imported lazily so this module keeps working in a runtime
	// that only has web fetch (a test double never reaches this branch).
	return (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
		const { request } = await import("node:https");
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const headers: Record<string, string> = {};
		if (init?.headers !== undefined) {
			const source = init.headers as Record<string, string>;
			for (const [key, value] of Object.entries(source)) headers[key] = value;
		}
		return await new Promise<Response>((resolve, reject) => {
			const req = request(
				{
					host: url.hostname,
					port: url.port === "" ? 443 : Number(url.port),
					path: `${url.pathname}${url.search}`,
					method: init?.method ?? "GET",
					// SNI stays the real hostname, so the certificate still validates
					// against `api.notion.com`; only the address is forced.
					servername: url.hostname,
					lookup: (_hostname, options, callback) => {
						const cb = callback as (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;
						if (typeof options === "object" && options !== null && (options as { all?: boolean }).all === true) {
							cb(null, [{ address: ip, family: 4 }]);
							return;
						}
						cb(null, ip, 4);
					},
					headers,
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => {
						const body = Buffer.concat(chunks);
						resolve(
							new Response(body, {
								status: response.statusCode ?? 0,
								statusText: response.statusMessage ?? "",
								headers: response.headers as Record<string, string>,
							}),
						);
					});
				},
			);
			req.on("error", reject);
			const body = init?.body;
			if (typeof body === "string") req.write(body);
			else if (body instanceof Uint8Array) req.write(body);
			req.end();
		});
	}) as typeof globalThis.fetch;
}

/**
 * Pull `Retry-After` out of a thrown SDK error's headers as whole seconds.
 *
 * The SDK stores raw headers on its HTTP error subclass; the value may be a
 * number of seconds (Notion's form). Returns `undefined` when absent or unparsable
 * so the caller falls back to the SDK's own backoff.
 */
function retryAfterSecondsOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const headers = (error as { headers?: unknown }).headers;
	if (headers === undefined || headers === null) return undefined;
	const read = (name: string): string | undefined => {
		if (typeof (headers as { get?: unknown }).get === "function") {
			const value = (headers as { get(name: string): string | null }).get(name);
			return value ?? undefined;
		}
		const record = headers as Record<string, unknown>;
		for (const key of Object.keys(record)) {
			if (key.toLowerCase() === name) {
				const value = record[key];
				return typeof value === "string" ? value : undefined;
			}
		}
		return undefined;
	};
	const raw = read("retry-after");
	if (raw === undefined) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * Normalize anything thrown by an SDK call into `NotionErrorInfo`.
 *
 * Branching is by Notion's API `code`, not by HTTP status: `unauthorized` means
 * the token itself is bad, while `object_not_found` on a page almost always means
 * the token is fine but the page was never shared with the connection. A probe
 * that collapsed both to "404/401" would send the operator to the wrong fix.
 */
export function normalizeNotionError(error: unknown): NotionErrorInfo {
	if (isNotionClientError(error)) {
		const code = typeof error.code === "string" ? error.code : "unknown";
		const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : undefined;
		const requestId =
			typeof (error as { request_id?: unknown }).request_id === "string"
				? (error as { request_id: string }).request_id
				: undefined;
		const additional = (error as { additional_data?: unknown }).additional_data;
		let message = typeof error.message === "string" ? error.message : String(error);
		// A message can echo request context; make sure no token-shaped string survives.
		message = message.replace(/secret_[A-Za-z0-9]+/g, "<redacted>").replace(/ntn_[A-Za-z0-9]+/g, "<redacted>");
		if (additional !== undefined) {
			// `additional_data` sometimes carries a clearer remediation hint than `message`.
			const hint = typeof additional === "object" && additional !== null
				? Object.entries(additional as Record<string, unknown>)
						.filter(([, value]) => typeof value === "string")
						.map(([key, value]) => `${key}=${value as string}`)
						.join(", ")
				: "";
			if (hint !== "") message = `${message} (${hint})`;
		}
		return {
			code,
			status,
			message,
			retryAfterSeconds: code === APIErrorCode.RateLimited || status === 429 || status === 529 ? retryAfterSecondsOf(error) : undefined,
			requestId,
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		code: "transport_error",
		status: undefined,
		message: message.replace(/secret_[A-Za-z0-9]+/g, "<redacted>").replace(/ntn_[A-Za-z0-9]+/g, "<redacted>"),
		retryAfterSeconds: undefined,
		requestId: undefined,
	};
}

/**
 * Run one SDK call under an endpoint label, normalizing any failure.
 *
 * Retries are the SDK's job (see `createNotionClient`); this wrapper only labels
 * and normalizes, so every endpoint reports the same `NotionErrorInfo` shape.
 */
export async function callNotion<T>(endpoint: NotionEndpoint, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw new NotionRequestError(endpoint, normalizeNotionError(error));
	}
}

/** A one-line, token-free summary of an error, for a CLI. */
export function describeNotionError(info: NotionErrorInfo): string {
	const parts = [`code=${info.code}`];
	if (info.status !== undefined) parts.push(`status=${info.status}`);
	if (info.retryAfterSeconds !== undefined) parts.push(`retry_after=${info.retryAfterSeconds}s`);
	if (info.requestId !== undefined) parts.push(`request_id=${info.requestId}`);
	return parts.join(" ");
}

/** Point out the token never appears in an error, for the one place a caller might forget. */
export function safeAuthLabel(token: string): string {
	return `auth=${redactToken(token)}`;
}
