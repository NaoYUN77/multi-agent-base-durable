// TASK-002 src/notion/runtime.ts
//
// Shared plumbing for the notion:* CLIs: build a client from the environment,
// print a banner that never contains the token, and normalize a failure into a
// non-zero exit with a token-free message.
//
// Every notion:* command is a thin wrapper over this plus one read from read.ts,
// so the token handling and the exit-code contract exist in exactly one place.

import { loadNotionConfig, hasNotionToken, NOTION_TOKEN_ENV, NOTION_VERSION, redactToken, NotionConfigError } from "../config.ts";
import { createNotionClient, describeNotionError, NotionRequestError, pinnedFetch } from "./client.ts";
import type { Client } from "@notionhq/client";

/**
 * Optional operator override: an IPv4 address to connect `api.notion.com` to.
 *
 * Set only when the environment's egress path resets the handshake for some of
 * the addresses that hostname resolves to. Unset means normal DNS. See
 * `pinnedFetch` in client.ts for why this is not the default.
 */
export const NOTION_PIN_IP_ENV = "NOTION_PIN_IP";

/** The pinned IP from the environment, or `undefined`. Never throws. */
export function notionPinIpFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[NOTION_PIN_IP_ENV];
	return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** What every notion:* CLI needs to run one read. */
export interface NotionCliContext {
	readonly client: Client;
	readonly version: string;
	readonly baseUrl: string;
	/** The IPv4 the transport was pinned to, when `NOTION_PIN_IP` was set. */
	readonly pinnedIp: string | undefined;
}

/** Print a banner naming the version and base URL, never the token. */
export function printBanner(target: string, context: { readonly version: string; readonly baseUrl: string; readonly pinnedIp?: string }): void {
	const pin = context.pinnedIp === undefined ? "" : ` pinned_ip=${context.pinnedIp}`;
	console.log(`[notion] target=${target} version=${context.version} base_url=${context.baseUrl}${pin}`);
}

/**
 * Build a client from `NOTION_TOKEN`, or exit with a clear message.
 *
 * The token is read here and handed to the SDK; it is also reduced to
 * `<redacted>` for the one diagnostic line, so nothing downstream can print it.
 */
export function openNotionCli(): NotionCliContext {
	if (!hasNotionToken()) {
		console.error(`[notion] ${NOTION_TOKEN_ENV} is not set.`);
		console.error("[notion] export it first, e.g.: read -rs NOTION_TOKEN && export NOTION_TOKEN");
		process.exit(2);
	}
	const config = loadNotionConfig();
	const pinIp = notionPinIpFromEnv();
	const client = createNotionClient(config, pinIp === undefined ? {} : { fetch: pinnedFetch(pinIp) });
	return { client, version: config.version, baseUrl: config.baseUrl, pinnedIp: pinIp };
}

/**
 * Run one CLI body, mapping a failure to an exit code with a token-free message.
 *
 * Exit codes let a script tell the failures apart:
 *   2 — configuration: a required variable is missing or empty.
 *   1 — the Notion API rejected the request (print its normalized code).
 *   1 — anything else (transport, a local bug).
 * A `NotionRequestError` prints its normalized code, so 401 (bad token) and 404
 * (not shared) are distinguishable on the console.
 */
export async function runNotionCli(body: () => Promise<void>): Promise<void> {
	try {
		await body();
	} catch (error) {
		if (error instanceof NotionConfigError) {
			console.error(`[notion] ${error.message}`);
			process.exit(2);
		}
		if (error instanceof NotionRequestError) {
			console.error(`[notion] error ${describeNotionError(error.info)}`);
			console.error(`[notion] ${error.info.message}`);
			process.exit(1);
		}
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[notion] ${message}`);
		process.exit(1);
	}
}

/** A token-free description of what the CLI will do, for the header line. */
export function describeAuth(): string {
	const token = process.env[NOTION_TOKEN_ENV];
	return `auth=${redactToken(token ?? "")} version=${NOTION_VERSION}`;
}
