import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** A server reached by spawning a process and speaking JSON-RPC over its stdio. */
export type McpStdioServerConfig = {
	readonly name: string;
	readonly transport: "stdio";
	readonly command: string;
	readonly args: readonly string[];
	/** Extra environment for the child, after expansion. */
	readonly env: Readonly<Record<string, string>>;
	readonly cwd?: string;
};

/** A server reached by HTTP, using the Streamable HTTP transport. */
export type McpHttpServerConfig = {
	readonly name: string;
	readonly transport: "http";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** All servers, in the order the file declares them. */
export type McpConfig = {
	readonly servers: readonly McpServerConfig[];
};

/** Either the configuration or every reason it was refused. Not a throw: a bad file is expected input. */
export type McpConfigResult = { readonly ok: true; readonly value: McpConfig } | { readonly ok: false; readonly errors: readonly string[] };

/** A server name that survives a tool name and a snapshot field unchanged. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KNOWN_FIELDS = ["command", "args", "env", "cwd", "url", "headers", "type"] as const;
/** Shown when the source is not a file (a test config, an inline document). */
const DEFAULT_WHERE = "mcp config";

/** The transport an entry names. `type` is a cross-check, never the source of truth. */
function declaredType(entry: Record<string, unknown>, where: string, errors: string[]): "stdio" | "http" | undefined {
	const hasCommand = entry.command !== undefined;
	const hasUrl = entry.url !== undefined;
	if (hasCommand && hasUrl) {
		errors.push(`${where}: give either \`command\` (stdio) or \`url\` (Streamable HTTP), not both`);
		return undefined;
	}
	if (!hasCommand && !hasUrl) {
		errors.push(`${where}: needs \`command\` (stdio) or \`url\` (Streamable HTTP)`);
		return undefined;
	}
	const transport = hasCommand ? "stdio" : "http";
	const type = entry.type;
	if (type !== undefined && type !== transport) {
		errors.push(`${where}: type must be \`${transport}\` for this entry`);
		return undefined;
	}
	return transport;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Expand `${VAR}` without including its value in errors. */
export function expandEnv(value: string, where: string, env: Readonly<Record<string, string | undefined>> = process.env): { ok: true; value: string } | { ok: false; error: string } {
	let failure: string | undefined;
	const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const found = env[name];
		if (found === undefined || found === "") {
			// The variable is named; its value is never part of the message.
			failure ??= `${where} refers to \${${name}}, which is not set`;
			return "";
		}
		return found;
	});
	return failure === undefined ? { ok: true, value: expanded } : { ok: false, error: failure };
}

/** Expand a whole string field, reporting the first failure. */
function expandedField(raw: unknown, where: string, errors: string[], env: Readonly<Record<string, string | undefined>>): string | undefined {
	const text = readString(raw);
	if (text === undefined) return undefined;
	const expanded = expandEnv(text, where, env);
	if (!expanded.ok) {
		errors.push(expanded.error);
		return undefined;
	}
	return expanded.value;
}

/** Expand a `name -> value` map (`env` or `headers`), refusing a nested value. */
function expandedMap(raw: unknown, where: string, errors: string[], env: Readonly<Record<string, string | undefined>>): Record<string, string> | undefined {
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${where}: expected an object of string values`);
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const text = readString(value);
		if (text === undefined) {
			errors.push(`${where}.${key}: expected a string`);
			continue;
		}
		const expanded = expandEnv(text, `${where}.${key}`, env);
		if (!expanded.ok) {
			errors.push(expanded.error);
			continue;
		}
		out[key] = expanded.value;
	}
	return out;
}

/** One entry, validated into a transport-specific configuration. */
function readServer(name: string, value: unknown, where: string, errors: string[], env: Readonly<Record<string, string | undefined>>): McpServerConfig | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		errors.push(`${where}: expected an object`);
		return undefined;
	}
	const entry = value as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (!(KNOWN_FIELDS as readonly string[]).includes(key)) errors.push(`${where}: unknown field \`${key}\` (known: ${KNOWN_FIELDS.join(", ")})`);
	}
	const transport = declaredType(entry, where, errors);
	if (transport === undefined) return undefined;

	if (transport === "http") {
		const url = expandedField(entry.url, `${where}.url`, errors, env);
		if (url === undefined) {
			errors.push(`${where}.url: expected a string`);
			return undefined;
		}
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				errors.push(`${where}.url: expected an http(s) URL`);
				return undefined;
			}
		} catch {
			errors.push(`${where}.url: not a valid URL`);
			return undefined;
		}
		if (entry.command !== undefined || entry.args !== undefined || entry.env !== undefined || entry.cwd !== undefined) {
			errors.push(`${where}: a url entry takes \`headers\`, not \`command\`, \`args\`, \`env\` or \`cwd\``);
			return undefined;
		}
		const headers = expandedMap(entry.headers, `${where}.headers`, errors, env);
		if (headers === undefined) return undefined;
		return { name, transport: "http", url, headers };
	}

	const command = expandedField(entry.command, `${where}.command`, errors, env);
	if (command === undefined || command.trim() === "") {
		errors.push(`${where}.command: expected a non-empty string`);
		return undefined;
	}
	if (entry.url !== undefined || entry.headers !== undefined) {
		errors.push(`${where}: a command entry takes \`args\`, \`env\` and \`cwd\`, not \`url\` or \`headers\``);
		return undefined;
	}
	const args: string[] = [];
	if (entry.args !== undefined) {
		if (!Array.isArray(entry.args)) {
			errors.push(`${where}.args: expected an array of strings`);
			return undefined;
		}
		for (const [index, raw] of entry.args.entries()) {
			const arg = expandedField(raw, `${where}.args[${index}]`, errors, env);
			if (arg === undefined) errors.push(`${where}.args[${index}]: expected a string`);
			else args.push(arg);
		}
	}
	const envMap = expandedMap(entry.env, `${where}.env`, errors, env);
	if (envMap === undefined) return undefined;
	if (entry.cwd !== undefined && typeof entry.cwd !== "string") {
		errors.push(`${where}.cwd: expected a string`);
		return undefined;
	}
	const cwd = entry.cwd === undefined ? undefined : expandedField(entry.cwd, `${where}.cwd`, errors, env);
	return { name, transport: "stdio", command, args, env: envMap, ...(cwd === undefined ? {} : { cwd }) };
}

/** Parse an `mcpServers` document and collect validation errors. */
export function parseMcpConfig(raw: unknown, where = DEFAULT_WHERE, env: Readonly<Record<string, string | undefined>> = process.env): McpConfigResult {
	const errors: string[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: [`${where}: expected a JSON object`] };
	const document = raw as Record<string, unknown>;
	for (const key of Object.keys(document)) {
		if (key !== "mcpServers") errors.push(`${where}: unknown field \`${key}\` (known: mcpServers)`);
	}
	const servers = document.mcpServers;
	if (servers === undefined) return { ok: false, errors: [...errors, `${where}: missing \`mcpServers\``] };
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
		return { ok: false, errors: [...errors, `${where}.mcpServers: expected an object keyed by server name`] };
	}
	const out: McpServerConfig[] = [];
	for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
		const entryWhere = `${where}.mcpServers.${name}`;
		if (!NAME_PATTERN.test(name)) {
			// The name becomes part of a tool name and of a task's configuration
			// snapshot; a name that has to be rewritten would be a second identity.
			errors.push(`${entryWhere}: a server name is lowercase letters, digits, \`-\` and \`_\` (max 64), starting with a letter or digit`);
			continue;
		}
		const server = readServer(name, value, entryWhere, errors, env);
		if (server !== undefined) out.push(server);
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: { servers: out } };
}

/** Read a config file, resolving child working directories relative to it. */
export async function readMcpConfig(path: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<McpConfigResult> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		return { ok: false, errors: [`cannot read ${path}: ${(error as Error).message}`] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, errors: [`${path} is not valid JSON`] };
	}
	const result = parseMcpConfig(raw, path, env);
	if (!result.ok) return result;
	return {
		ok: true,
		value: {
			servers: result.value.servers.map((server) => server.transport === "stdio"
				? { ...server, cwd: resolve(dirname(path), server.cwd ?? ".") }
				: server),
		},
	};
}
