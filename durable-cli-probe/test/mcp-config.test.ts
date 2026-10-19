import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpConfig, readMcpConfig } from "../src/mcp/config.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function configFile(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-config-"));
	directories.push(directory);
	const path = join(directory, "mcp.json");
	await writeFile(path, text);
	return path;
}

describe("MCP configuration", () => {
	it("rejects a cwd that is not a string", () => {
		const result = parseMcpConfig({ mcpServers: { local: { command: "node", cwd: 42 } } });
		expect(result).toEqual({ ok: false, errors: ["mcp config.mcpServers.local.cwd: expected a string"] });
	});

	it("reports invalid JSON without quoting file content", async () => {
		const path = await configFile('{"password":"private-config-value", broken}');
		const result = await readMcpConfig(path);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.join("\n")).toContain("not valid JSON");
			expect(result.errors.join("\n")).not.toContain("private-config-value");
			expect(result.errors).toEqual([`${path} is not valid JSON`]);
		}
	});

	it("does not echo arbitrary type values in validation errors", () => {
		const result = parseMcpConfig({ mcpServers: { local: { command: "node", type: { password: "private-type-value" } } } });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.join("\n")).toContain("type");
			expect(result.errors.join("\n")).not.toContain("private-type-value");
		}
	});

	it("resolves an expanded relative cwd from the configuration directory", async () => {
		const path = await configFile(JSON.stringify({ mcpServers: { local: { command: "node", cwd: `\${WORK_DIR}` } } }));
		const result = await readMcpConfig(path, { WORK_DIR: "./service" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.servers[0]).toMatchObject({ cwd: resolve(path, "..", "service") });
	});

	it("expands transport fields and rejects missing environment values", () => {
		expect(parseMcpConfig({ mcpServers: { remote: { url: `\${ENDPOINT}`, headers: { Authorization: `Bearer \${TOKEN}` } } } }, "config", { ENDPOINT: "https://example.com/mcp", TOKEN: "value" }))
			.toEqual({ ok: true, value: { servers: [{ name: "remote", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer value" } }] } });
		const missing = parseMcpConfig({ mcpServers: { remote: { url: `https://example.com/\${MISSING}` } } }, "config", {});
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors.join("\n")).toContain("MISSING");
	});
});
