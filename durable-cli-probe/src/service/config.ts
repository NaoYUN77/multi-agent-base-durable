// TASK-005.5 src/service/config.ts
//
// The terminal entry's arguments and its configuration file, validated before
// the database is opened.
//
// Two rules shape this file.
//
//   * **Credentials are named, never carried.** A configuration may say which
//     environment variable holds a provider key (`apiKeyEnv`); a field that looks
//     like it *is* the credential (`apiKey`, `token`, `secret`, `password`, in
//     any casing) is refused by name, and its value is never echoed, logged or
//     stored. A refused config therefore cannot leak the secret it was refused
//     for. The key itself is read from the environment by the provider, and
//     nothing here copies it.
//   * **Unknown fields are errors.** A misspelled limit that was silently
//     ignored would leave the run configured by a default nobody chose. Every
//     limit is explicit, as the run-config contract requires.

import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateRunConfig, type RunConfig } from "../agent/contracts/run-config.ts";
import type { AgentConfig } from "./types.ts";

/** Exit codes of the entry. Documented in the README so a script can rely on them. */
export const EXIT = {
	ok: 0,
	openFailed: 1,
	notATerminal: 2,
	invalidConfig: 3,
} as const;

/** The result of parsing the entry's arguments or reading its configuration. */
export type ConfigResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

export type ParsedArgs = {
	readonly databasePath: string;
	readonly configPath: string;
	readonly animate: boolean;
};

const USAGE =
	"usage: npm run agent:tui -- --db <path> --config <path> [--no-animation]\n" +
	"  --db <path>          SQLite database the session opens; a real file, so a reopen restores the view\n" +
	"  --config <path>      JSON configuration (provider, model, limits); see README\n" +
	"  --no-animation       no spinner and no periodic re-render; the elapsed clock still runs";

export function usageText(): string {
	return USAGE;
}

/**
 * Parse `--db`, `--config` and `--no-animation`. Strict, in one pass: an
 * unknown argument, a missing value or a repeated option is an error, and
 * nothing is opened first.
 */
export function parseTuiArgs(argv: readonly string[]): ConfigResult<ParsedArgs> {
	const errors: string[] = [];
	let databasePath: string | undefined;
	let configPath: string | undefined;
	let animate = true;
	const seen = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		if (flag !== "--db" && flag !== "--config" && flag !== "--no-animation") {
			errors.push(`unknown argument ${JSON.stringify(arg)}`);
			continue;
		}
		if (seen.has(flag)) {
			errors.push(`${flag} given more than once`);
			continue;
		}
		seen.add(flag);
		if (flag === "--no-animation") {
			if (inline !== undefined) errors.push("--no-animation takes no value");
			else animate = false;
			continue;
		}
		const value = inline ?? argv[index + 1];
		if (inline === undefined) index += 1;
		if (value === undefined || value === "" || value.startsWith("--")) {
			errors.push(`${flag} needs a value`);
			if (value?.startsWith("--") === true) index -= 1;
			continue;
		}
		if (flag === "--db") databasePath = value;
		else configPath = value;
	}
	if (databasePath === undefined && !seen.has("--db")) errors.push("--db is required");
	if (configPath === undefined && !seen.has("--config")) errors.push("--config is required");
	if (databasePath === ":memory:") {
		errors.push("--db :memory: is refused: a memory database cannot be reopened, and restoring the view after a quit is part of the contract");
	}
	if (errors.length > 0) return { ok: false, errors };
	if (databasePath === undefined || configPath === undefined) return { ok: false, errors: ["--db and --config are required"] };
	return { ok: true, value: { databasePath, configPath, animate } };
}

/** Field names that hold a credential rather than name where one lives. Matched case- and separator-insensitively. */
const CREDENTIAL_FIELD = /^(.*)(apikey|apitoken|token|secret|password|passwd|credential)(.*)$/i;

/** Keys of the configuration document, before `runConfig` is unwrapped. */
const KNOWN_FIELDS: readonly string[] = [
	"provider",
	"modelId",
	"baseUrl",
	"apiKeyEnv",
	"databasePath",
	"maxConcurrentSubAgents",
	"maxSubAgentsPerRequest",
	"runConfig",
];

const PROVIDERS = new Set(["faux", "deepseek", "openai", "custom"]);

function normalizeField(name: string): string {
	return name.replace(/[_\-\s]/g, "").toLowerCase();
}

/**
 * Parse a configuration document.
 *
 * @param raw - the parsed JSON value.
 * @param where - how to name the source in an error ("config file", "test config").
 * @returns the validated config, or every error found (all of them, so one run reports one complete list).
 */
export function parseAgentConfig(raw: unknown, where = "config"): ConfigResult<AgentConfig> {
	const errors: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, errors: [`${where}: expected a JSON object`] };
	}
	const source = raw as Record<string, unknown>;
	for (const key of Object.keys(source)) {
		const normalized = normalizeField(key);
		if (KNOWN_FIELDS.some((known) => normalizeField(known) === normalized)) continue;
		if (CREDENTIAL_FIELD.test(normalized)) {
			// The value is deliberately not quoted: naming the field is enough to fix it, and the value may be a key.
			errors.push(`${where}: field \`${key}\` looks like it holds a credential. Remove it; a provider key is read from the environment, and \`apiKeyEnv\` names that variable.`);
			continue;
		}
		errors.push(`${where}: unknown field \`${key}\` (known: ${KNOWN_FIELDS.join(", ")})`);
	}

	const provider = source.provider;
	if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
		errors.push(`${where}: provider must be one of ${[...PROVIDERS].join(", ")}`);
	}
	const readString = (key: string): string | undefined => {
		const value = source[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value.trim() === "") {
			errors.push(`${where}: ${key} must be a non-empty string`);
			return undefined;
		}
		return value;
	};
	const modelId = readString("modelId");
	const baseUrl = readString("baseUrl");
	const apiKeyEnv = readString("apiKeyEnv");
	const databasePath = readString("databasePath");
	const readCount = (key: string): number | undefined => {
		const value = source[key];
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
			errors.push(`${where}: ${key} must be a positive integer`);
			return undefined;
		}
		return value;
	};
	const maxConcurrentSubAgents = readCount("maxConcurrentSubAgents");
	const maxSubAgentsPerRequest = readCount("maxSubAgentsPerRequest");

	if (apiKeyEnv !== undefined) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) errors.push(`${where}: apiKeyEnv must be an environment variable name`);
		else if (process.env[apiKeyEnv] === undefined) errors.push(`${where}: environment variable ${apiKeyEnv} is not set; nothing reads a key from the file itself`);
	}
	if (provider === "custom") {
		if (baseUrl === undefined) errors.push(`${where}: provider custom requires baseUrl`);
		else if (!/^https?:\/\//.test(baseUrl)) errors.push(`${where}: baseUrl must be an http(s) URL`);
		if (apiKeyEnv === undefined) errors.push(`${where}: provider custom requires apiKeyEnv (the name of the variable holding the key)`);
		if (modelId === undefined) errors.push(`${where}: provider custom requires modelId`);
	} else if (baseUrl !== undefined) {
		errors.push(`${where}: baseUrl is only used by provider custom`);
	}

	let runConfig: RunConfig | undefined;
	if (source.runConfig === undefined) {
		errors.push(`${where}: runConfig is required: every limit is explicit, and this file supplies none by default`);
	} else {
		const validation = validateRunConfig(source.runConfig);
		if (!validation.ok) {
			for (const violation of validation.violations) errors.push(`${where}: runConfig${violation.path}: ${violation.code}`);
		} else runConfig = validation.value;
	}
	if (runConfig !== undefined && runConfig.harnessRetry.maxRetries !== 0) {
		errors.push(`${where}: runConfig.harnessRetry.maxRetries must be 0; the batch runtime counts retries itself`);
	}

	if (errors.length > 0 || runConfig === undefined || typeof provider !== "string" || !PROVIDERS.has(provider)) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		value: {
			provider: provider as AgentConfig["provider"],
			...(modelId === undefined ? {} : { modelId }),
			...(baseUrl === undefined ? {} : { baseUrl }),
			...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
			...(databasePath === undefined ? {} : { databasePath }),
			maxConcurrentSubAgents: maxConcurrentSubAgents ?? runConfig.maxConcurrentSubAgents,
			maxSubAgentsPerRequest: maxSubAgentsPerRequest ?? runConfig.maxSubAgentsPerRequest,
			runConfig,
		},
	};
}

/**
 * Read and parse the configuration file.
 *
 * The path may be relative to the working directory. A JSON syntax error is
 * reported with its position but not the file's contents: a parse error may
 * quote a line, and a line may be a key someone typed into the file.
 */
export async function readAgentConfig(path: string): Promise<ConfigResult<AgentConfig>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return { ok: false, errors: [`config: cannot read ${path}: ${(error as Error).message}`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		const message = (error as Error).message;
		const position = /position (\d+)/.exec(message)?.[1];
		return { ok: false, errors: [`config: ${path} is not valid JSON${position === undefined ? "" : ` (error at character ${position})`}`] };
	}
	const parsed = parseAgentConfig(raw, "config");
	if (parsed.ok && parsed.value.databasePath !== undefined) {
		const configPath = parsed.value.databasePath;
		if (!isAbsolute(configPath)) return { ok: false, errors: ["config: databasePath must be an absolute path when set"] };
	}
	return parsed;
}
