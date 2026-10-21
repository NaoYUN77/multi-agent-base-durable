import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readMcpConfig } from "../src/mcp/config.ts";

describe("MCP stdio destination", () => {
	it("pins an omitted child cwd to the config directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "mcp-cwd-"));
		try {
			const path = join(directory, "mcp.json");
			await writeFile(path, JSON.stringify({ mcpServers: { local: { command: "node", args: ["./server.mjs"] } } }));
			const config = await readMcpConfig(path);
			expect(config.ok).toBe(true);
			if (!config.ok) return;
			expect(config.value.servers[0]).toMatchObject({ cwd: resolve(dirname(path)) });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
