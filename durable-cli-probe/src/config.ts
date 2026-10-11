// TASK-002 src/config.ts
//
// Read configuration for the Notion probe.
//
// The token is read from the environment and handed to the SDK as an in-memory
// string. It is never written to a file, a log line, the transcript, or SQLite.
// Nothing here prints it or includes it in an error message: `redactToken()`
// exists for the one place a caller might otherwise be tempted to interpolate a
// config object into a message.

/** The Notion API version this probe pins, as required by every request. */
export const NOTION_VERSION = "2026-03-11";

/** Notion's public REST origin. Overridable only for a test double, never in normal runs. */
export const NOTION_BASE_URL = "https://api.notion.com";

/** Environment variable names. Keys live in the environment, never in source. */
export const NOTION_TOKEN_ENV = "NOTION_TOKEN";
export const NOTION_PAGE_ID_ENV = "NOTION_PAGE_ID";

/** A resolved Notion configuration with no secret in a printable position. */
export interface NotionConfig {
	readonly token: string;
	readonly version: string;
	readonly baseUrl: string;
	/** Page id from `NOTION_PAGE_ID`, when set. Optional: only the page-scoped commands need it. */
	readonly pageId: string | undefined;
}

/** Thrown when a required environment variable is absent or empty. */
export class NotionConfigError extends Error {
	readonly variable: string;
	constructor(variable: string, hint: string) {
		super(`${variable} is not set. ${hint}`);
		this.name = "NotionConfigError";
		this.variable = variable;
	}
}

/**
 * Replace a token with a fixed placeholder. Use whenever a value that might
 * contain the token is about to be logged or thrown.
 */
export function redactToken(value: string): string {
	return value.length === 0 ? "<empty>" : "<redacted>";
}

/** Whether a token is present, without revealing it or throwing. */
export function hasNotionToken(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[NOTION_TOKEN_ENV];
	return value !== undefined && value.trim() !== "";
}

/** The page id from the environment, or `undefined`. Never throws. */
export function notionPageIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env[NOTION_PAGE_ID_ENV];
	return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/**
 * Build a `NotionConfig` from the environment.
 *
 * Throws `NotionConfigError` when `NOTION_TOKEN` is absent. The error names the
 * variable only; a token value never reaches it.
 */
export function loadNotionConfig(
	env: NodeJS.ProcessEnv = process.env,
	overrides: { readonly baseUrl?: string; readonly pageId?: string } = {},
): NotionConfig {
	const token = env[NOTION_TOKEN_ENV];
	if (token === undefined || token.trim() === "") {
		throw new NotionConfigError(
			NOTION_TOKEN_ENV,
			"Create an internal connection token in Notion and export it, e.g. read -rs NOTION_TOKEN && export NOTION_TOKEN.",
		);
	}
	return {
		token: token.trim(),
		version: NOTION_VERSION,
		baseUrl: overrides.baseUrl ?? NOTION_BASE_URL,
		pageId: overrides.pageId ?? notionPageIdFromEnv(env),
	};
}

/**
 * The page id a page-scoped command should use: the one passed on the command
 * line, else `NOTION_PAGE_ID`. Throws `NotionConfigError` when neither is set.
 */
export function requirePageId(config: NotionConfig, override?: string): string {
	const value = override ?? config.pageId;
	if (value === undefined || value.trim() === "") {
		throw new NotionConfigError(
			NOTION_PAGE_ID_ENV,
			"Pass a page id as the first argument, or export NOTION_PAGE_ID.",
		);
	}
	return value.trim();
}
