// TASK-005.5 test/tui-config.test.ts
//
// The entry's order and its refusals, from arguments to exit code.
//
// `prepare` is the part of `npm run agent:tui` that runs before any screen: a
// bad argument, a non-terminal stdout or a bad configuration must stop the
// process with the documented code and leave the database untouched. Each test
// proves one stop, and the credential tests prove that a refused configuration
// never echoes the value it refused.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT, parseAgentConfig, parseTuiArgs } from "../src/service/config.ts";
import { prepare } from "../src/tui/main.ts";
import { runConfigOf } from "./helpers/batch-system.ts";

const RUN_CONFIG = {
	schemaVersion: 1,
	maxConcurrentSubAgents: 2,
	maxSubAgentsPerRequest: 4,
	maxToolInvocationsPerRound: 4,
	maxFailedToolCallsPerRound: 2,
	maxAttemptsPerOperation: 2,
	maxTechnicalRestarts: 1,
	roundTimeoutMs: 10_000,
	providerRetry: { maxRetries: 1, backoffMs: 5 },
	harnessRetry: { maxRetries: 0, backoffMs: 0 },
};

const FAUX_CONFIG = { provider: "faux", runConfig: RUN_CONFIG };

describe("TASK-005.5 entry arguments", () => {
	it("accepts the documented form and keeps the TTY order", () => {
		expect(parseTuiArgs(["--db", "a.sqlite", "--config", "c.json"])).toEqual({ ok: true, value: { databasePath: "a.sqlite", configPath: "c.json", animate: true } });
		expect(parseTuiArgs(["--db=a.sqlite", "--config=c.json", "--no-animation"])).toEqual({ ok: true, value: { databasePath: "a.sqlite", configPath: "c.json", animate: false } });
	});

	it("accepts an optional standalone MCP config path and refuses malformed options", () => {
		const base = ["--db", "a.sqlite", "--config", "c.json"];
		for (const option of [["--mcp-config", "servers.json"], ["--mcp-config=servers.json"]]) {
			expect(parseTuiArgs([...base, ...option])).toEqual({
				ok: true,
				value: { databasePath: "a.sqlite", configPath: "c.json", animate: true, mcpConfigPath: "servers.json" },
			});
		}
		expect(parseTuiArgs([...base, "--mcp-config"])).toMatchObject({ ok: false });
		expect(parseTuiArgs([...base, "--mcp-config="])).toMatchObject({ ok: false });
		expect(parseTuiArgs([...base, "--mcp-config", "a.json", "--mcp-config", "b.json"])).toMatchObject({ ok: false });
	});

	it("refuses unknown, repeated, missing and memory arguments", () => {
		const unknown = parseTuiArgs(["--db", "a", "--config", "b", "--verbose"]);
		expect(unknown).toMatchObject({ ok: false });
		if (!unknown.ok) expect(unknown.errors[0]).toContain("unknown argument");
		expect(parseTuiArgs(["--db", "a", "--db", "b", "--config", "c"])).toMatchObject({ ok: false });
		expect(parseTuiArgs(["--config", "c"])).toMatchObject({ ok: false });
		expect(parseTuiArgs(["--db", "--config", "c"])).toMatchObject({ ok: false });
		const memory = parseTuiArgs(["--db", ":memory:", "--config", "c"]);
		expect(memory).toMatchObject({ ok: false });
		if (!memory.ok) expect(memory.errors.join("\n")).toContain("cannot be reopened");
	});

	it("exits 3 for a bad argument before reading any file", async () => {
		const io = collector();
		const prepared = await prepare(["--nope"], io);
		expect(prepared).toEqual({ exit: EXIT.invalidConfig });
		expect(io.stderrText()).toContain("unknown argument");
		expect(io.stderrText()).toContain("usage: npm run agent:tui");
	});
});

describe("TASK-005.5 entry configuration", () => {
	it("accepts a provider configured only by name of the key variable", () => {
		vi.stubEnv("TUI_TEST_KEY", "value-never-read-here");
		const parsed = parseAgentConfig({ provider: "custom", baseUrl: "https://example.invalid/v1", apiKeyEnv: "TUI_TEST_KEY", modelId: "m", runConfig: RUN_CONFIG });
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value).not.toHaveProperty("apiKey");
			expect(parsed.value.apiKeyEnv).toBe("TUI_TEST_KEY");
		}
		vi.unstubAllEnvs();
	});

	it("refuses a credential field by name and never echoes its value", () => {
		const secret = "sk-this-must-never-appear-1234";
		for (const field of ["apiKey", "api_key", "API-KEY", "token", "secret", "password", "openaiApiKey"]) {
			const parsed = parseAgentConfig({ ...FAUX_CONFIG, [field]: secret });
			expect(parsed.ok).toBe(false);
			if (parsed.ok) continue;
			const text = parsed.errors.join("\n");
			expect(text).toContain(field);
			expect(text).toContain("looks like it holds a credential");
			expect(text).not.toContain(secret);
		}
	});

	it("refuses unknown fields, a missing environment variable and provider gaps", () => {
		const unknown = parseAgentConfig({ ...FAUX_CONFIG, maxConcurrent: 3 });
		expect(unknown).toMatchObject({ ok: false });
		if (!unknown.ok) expect(unknown.errors[0]).toContain("maxConcurrent");

		const unset = parseAgentConfig({ ...FAUX_CONFIG, apiKeyEnv: "TUI_KEY_SURELY_UNSET_0420" });
		expect(unset).toMatchObject({ ok: false });
		if (!unset.ok) expect(unset.errors.join("\n")).toContain("TUI_KEY_SURELY_UNSET_0420");

		const custom = parseAgentConfig({ provider: "custom", runConfig: RUN_CONFIG });
		expect(custom).toMatchObject({ ok: false });
		if (!custom.ok) {
			const text = custom.errors.join("\n");
			expect(text).toContain("custom requires baseUrl");
			expect(text).toContain("custom requires apiKeyEnv");
		}

		const badUrl = parseAgentConfig({ provider: "custom", baseUrl: "file:///etc/passwd", apiKeyEnv: "HOME", modelId: "m", runConfig: RUN_CONFIG });
		expect(badUrl).toMatchObject({ ok: false });
		if (!badUrl.ok) expect(badUrl.errors.join("\n")).toContain("http(s) URL");
	});

	it("refuses a run configuration the runtime would not honour", () => {
		const missing = parseAgentConfig({ provider: "faux" });
		expect(missing).toMatchObject({ ok: false });
		if (!missing.ok) expect(missing.errors.join("\n")).toContain("runConfig is required");

		const retrying = parseAgentConfig({ provider: "faux", runConfig: { ...RUN_CONFIG, harnessRetry: { maxRetries: 2, backoffMs: 1 } } });
		expect(retrying).toMatchObject({ ok: false });
		if (!retrying.ok) expect(retrying.errors.join("\n")).toContain("must be 0");
	});

	it("hands the validated configuration through unchanged", () => {
		const parsed = parseAgentConfig({ ...FAUX_CONFIG, maxConcurrentSubAgents: 3 });
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value.runConfig).toEqual(runConfigOf(RUN_CONFIG));
	});

	it("accepts a faux catalog, so /model has more than one name to offer", () => {
		const parsed = parseAgentConfig({
			...FAUX_CONFIG,
			models: [
				{ id: "faux-1", name: "Faux One", contextWindow: 128_000 },
				{ id: "faux-2", name: "Faux Two", contextWindow: 64_000, maxTokens: 8_192 },
			],
		});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.models?.map((model) => model.id)).toEqual(["faux-1", "faux-2"]);
		// The first entry is the model a fresh database's root is configured with,
		// so the file need not repeat it as `modelId`.
		expect(parsed.value.modelId).toBe("faux-1");
	});

	it("refuses a catalog the provider could not honour", () => {
		const errors = (raw: Record<string, unknown>): string => {
			const parsed = parseAgentConfig({ ...FAUX_CONFIG, ...raw });
			expect(parsed.ok).toBe(false);
			return parsed.ok ? "" : parsed.errors.join("\n");
		};
		expect(errors({ models: [] })).toContain("non-empty array");
		expect(errors({ models: [{ id: "a" }, { id: "a" }] })).toContain("appears more than once");
		expect(errors({ models: [{ name: "no id" }] })).toContain("id must be a non-empty string");
		expect(errors({ models: [{ id: "a", contextWindow: 0 }] })).toContain("contextWindow must be a positive integer");
		expect(errors({ models: [{ id: "a", contxtWindow: 1 }] })).toContain("unknown field `contxtWindow`");
		// A model named as the one to open with must be one the catalog offers.
		expect(errors({ models: [{ id: "a" }], modelId: "b" })).toContain("is not in models");
		// Another provider's catalog is its own; the file cannot replace it.
		const custom = parseAgentConfig({ provider: "custom", baseUrl: "https://example.invalid/v1", apiKeyEnv: "HOME", modelId: "m", runConfig: RUN_CONFIG, models: [{ id: "a" }] });
		expect(custom.ok).toBe(false);
		if (!custom.ok) expect(custom.errors.join("\n")).toContain("models is only used by provider faux");
	});
});

describe("TASK-005.5 entry order", { timeout: 60_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "tui-config-"));
		databasePath = join(directory, "entry.sqlite");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	});

	it("exits 2 on a piped stdout without touching the database", async () => {
		const configPath = join(directory, "config.json");
		await writeFile(configPath, JSON.stringify(FAUX_CONFIG), "utf8");
		const isTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		try {
			const io = collector();
			const prepared = await prepare(["--db", databasePath, "--config", configPath], io);
			expect(prepared).toEqual({ exit: EXIT.notATerminal });
			expect(io.stderrText()).toContain("interactive terminal");
		} finally {
			if (isTTY === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
			else Object.defineProperty(process.stdout, "isTTY", isTTY);
		}
		await expect(readFile(databasePath)).rejects.toThrow();
	});

	it("exits 3 for a configuration file that is missing, invalid or carries a key", async () => {
		const stubTTY = fakeTTY();
		try {
			const missing = collector();
			expect(await prepare(["--db", databasePath, "--config", join(directory, "absent.json")], missing)).toEqual({ exit: EXIT.invalidConfig });
			expect(missing.stderrText()).toContain("cannot read");

			const brokenPath = join(directory, "broken.json");
			await writeFile(brokenPath, "{\"provider\": \"faux\",\n\"apiKey\": \"sk-broken-line-77\"", "utf8");
			const broken = collector();
			expect(await prepare(["--db", databasePath, "--config", brokenPath], broken)).toEqual({ exit: EXIT.invalidConfig });
			expect(broken.stderrText()).toContain("not valid JSON");
			expect(broken.stderrText()).not.toContain("sk-broken-line-77");

			const keyPath = join(directory, "key.json");
			await writeFile(keyPath, JSON.stringify({ ...FAUX_CONFIG, token: "sk-typed-into-the-file" }), "utf8");
			const keyed = collector();
			expect(await prepare(["--db", databasePath, "--config", keyPath], keyed)).toEqual({ exit: EXIT.invalidConfig });
			expect(keyed.stderrText()).toContain("looks like it holds a credential");
			expect(keyed.stderrText()).not.toContain("sk-typed-into-the-file");
		} finally {
			stubTTY.restore();
		}
		await expect(readFile(databasePath)).rejects.toThrow();
	});

	it("loads the standalone MCP file selected by the CLI", async () => {
		const stubTTY = fakeTTY();
		try {
			const configPath = join(directory, "agent.json");
			const mcpConfigPath = join(directory, "servers.json");
			await writeFile(configPath, JSON.stringify(FAUX_CONFIG), "utf8");
			await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { local: { command: "node", args: ["--version"] } } }), "utf8");
			const io = collector();
			const prepared = await prepare(["--db", databasePath, "--config", configPath, "--mcp-config", mcpConfigPath], io);
			expect(io.stderrText()).toBe("");
			expect("session" in prepared).toBe(true);
			if (!("session" in prepared)) return;
			try {
				expect(prepared.session.mcpStatus()).toMatchObject([{ name: "local", transport: "stdio", state: "idle" }]);
			} finally {
				await prepared.session.close();
			}
		} finally {
			stubTTY.restore();
		}
	});

	it("opens the session for a valid configuration and leaves a database behind", async () => {
		const stubTTY = fakeTTY();
		try {
			const configPath = join(directory, "good.json");
			await writeFile(configPath, JSON.stringify(FAUX_CONFIG), "utf8");
			const io = collector();
			const prepared = await prepare(["--db", databasePath, "--config", configPath, "--no-animation"], io);
			expect(io.stderrText()).toBe("");
			expect("session" in prepared).toBe(true);
			if (!("session" in prepared)) return;
			expect(prepared.animate).toBe(false);
			const snap = await prepared.session.snapshot(Date.now());
			expect(snap.tasks).toEqual([]);
			await prepared.session.close();
			expect((await readFile(databasePath)).length).toBeGreaterThan(0);
		} finally {
			stubTTY.restore();
		}
	});
});

function collector() {
	let stderr = "";
	let stdout = "";
	return {
		stdout: (text: string) => {
			stdout += text;
		},
		stderr: (text: string) => {
			stderr += text;
		},
		stderrText: () => stderr,
		stdoutText: () => stdout,
	};
}

/** stdout and stdin report a terminal for the duration of one test. */
function fakeTTY(): { restore: () => void } {
	const saved = (["stdin", "stdout"] as const).map((name) => [name, Object.getOwnPropertyDescriptor(process[name], "isTTY")] as const);
	for (const name of ["stdin", "stdout"] as const) Object.defineProperty(process[name], "isTTY", { value: true, configurable: true });
	return {
		restore: () => {
			for (const [name, descriptor] of saved) {
				if (descriptor === undefined) Reflect.deleteProperty(process[name], "isTTY");
				else Object.defineProperty(process[name], "isTTY", descriptor);
			}
		},
	};
}
