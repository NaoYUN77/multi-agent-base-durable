import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpManager, type McpManager } from "../src/mcp/manager.ts";
import type { McpServerConfig } from "../src/mcp/config.ts";
import { startMcpHttpServer } from "./helpers/mcp-http-server.mjs";

const STDIO_FIXTURE = fileURLToPath(new URL("./helpers/mcp-stdio-server.mjs", import.meta.url));

/** The stdio fixture, as a configuration entry names it. */
function stdioServer(name = "local"): McpServerConfig {
	return { name, transport: "stdio", command: process.execPath, args: [STDIO_FIXTURE], env: {} };
}

function httpServer(url: string, name = "remote"): McpServerConfig {
	return { name, transport: "http", url, headers: {} };
}

describe("MCP connections over the two standard transports", { timeout: 30_000 }, () => {
	let manager: McpManager | undefined;

	afterEach(async () => {
		await manager?.close();
		manager = undefined;
	});

	it("spawns a stdio server, reads its catalog, and calls one of its tools", async () => {
		manager = createMcpManager({ servers: [stdioServer()] });
		expect(manager.status()[0]?.state).toBe("idle");

		const connected = await manager.connect("local");
		// The server's own identity and the version it agreed to, not ours.
		expect(connected.state).toBe("connected");
		expect(connected.serverInfo).toEqual({ name: "mcp-stdio-fixture", version: "1.2.3" });
		expect(connected.protocolVersion).toBe("2025-11-25");
		// A real child process is behind the connection, which is the whole point
		// of this transport; the pid is how the panel and this test can say so.
		expect(connected.pid).toBeGreaterThan(0);
		expect(connected.tools).toEqual(["echo", "fail"]);
		expect(connected.error).toBeUndefined();

		// The answer can only come from the spawned process: it prefixes the text
		// with `echo: `, a string that appears nowhere in this repository.
		const result = await manager.callTool("local", "echo", { text: "across the boundary" });
		expect(result.isError).toBeFalsy();
		expect((result.content?.[0] as { text?: string }).text).toBe("echo: across the boundary");

		// A tool that reports its own failure is a result, not a transport error.
		const refused = await manager.callTool("local", "fail", { reason: "because" });
		expect(refused.isError).toBe(true);
		expect((refused.content?.[0] as { text?: string }).text).toBe("refused: because");
		expect(manager.status()[0]?.state).toBe("connected");

		await manager.disconnect("local");
		expect(manager.status()[0]?.state).toBe("idle");
	});

	it("connects to a Streamable HTTP server over a real socket and remembers its session", async () => {
		const fixture = await startMcpHttpServer();
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)] });
			const connected = await manager.connect("remote");
			expect(connected.state).toBe("connected");
			expect(connected.serverInfo).toEqual({ name: "mcp-http-fixture", version: "9.9.9" });
			expect(connected.tools).toEqual(["echo"]);
			expect(connected.transport).toBe("http");
			expect(connected.target).toBe(fixture.url);

			// The POSTs arrived here: `initialize`, the initialized notification and
			// `tools/list`.
			const methods = fixture.requests.filter((entry) => entry.method === "POST").map((entry) => (JSON.parse(entry.body).method as string) ?? "");
			expect(methods).toContain("initialize");
			expect(methods).toContain("tools/list");
			// The session id the server handed out is sent back on every later
			// request, which is what keeps the connection to one session.
			expect(fixture.requests.at(-1)?.session).toBe("fixture-session-1");

			const result = await manager.callTool("remote", "echo", { text: "over http" });
			expect((result.content?.[0] as { text?: string }).text).toBe("http-echo: over http");

			await manager.disconnect("remote");
			expect(manager.status()[0]?.state).toBe("idle");
			// Closing the session best-effort notifies the server.
			expect(fixture.requests.some((entry) => entry.method === "DELETE")).toBe(true);
		} finally {
			await manager?.close();
			await fixture.close();
		}
	});

	it("reports a failed connection without affecting the servers that work", async () => {
		const fixture = await startMcpHttpServer();
		try {
			manager = createMcpManager({
				servers: [
					{ name: "broken", transport: "stdio", command: join(STDIO_FIXTURE, "does-not-exist"), args: [], env: {} },
					stdioServer("local"),
					httpServer(fixture.url, "remote"),
				],
			});

			const broken = await manager.connect("broken");
			expect(broken.state).toBe("failed");
			expect(broken.error === undefined ? "" : broken.error).toMatch(/ENOENT|not found|failed/i);

			// The failure is one server's, not the session's.
			await expect(manager.connect("local")).resolves.toMatchObject({ state: "connected" });
			await expect(manager.connect("remote")).resolves.toMatchObject({ state: "connected" });

			// A tool call against the server that never connected fails as an answer
			// about that server, not as a rejection the caller has to catch twice.
			const refused = await manager.callTool("broken", "echo", { text: "x" });
			expect(refused.isError).toBe(true);
			expect((refused.content?.[0] as { text?: string }).text).toContain("broken");
		} finally {
			await manager?.close();
			await fixture.close();
		}
	});

	it("connects on demand when a tool is called before anyone connected", async () => {
		manager = createMcpManager({ servers: [stdioServer()] });
		expect(manager.status()[0]?.state).toBe("idle");
		const result = await manager.callTool("local", "echo", { text: "cold" });
		expect((result.content?.[0] as { text?: string }).text).toBe("echo: cold");
		expect(manager.status()[0]?.state).toBe("connected");
	});

	it("reads HTTP POST responses delivered as server-sent events", async () => {
		const fixture = await startMcpHttpServer({ responseMode: "sse" });
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)] });
			await expect(manager.connect("remote")).resolves.toMatchObject({ state: "connected", tools: ["echo"] });
			expect(await manager.callTool("remote", "echo", { text: "event stream" })).toMatchObject({ content: [{ type: "text", text: "http-echo: event stream" }] });
		} finally {
			await manager?.close();
			await fixture.close();
		}
	});

	it("connects a server without a tools capability", async () => {
		const fixture = await startMcpHttpServer({ reply: (message) => {
			if (message.method === "initialize") return { jsonrpc: "2.0", id: message.id, result: {
				protocolVersion: "2025-11-25", capabilities: { resources: {} }, serverInfo: { name: "resources-only", version: "1" },
			} };
			if (message.method === "tools/list") return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } };
			return undefined;
		} });
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)] });
			await expect(manager.connect("remote")).resolves.toMatchObject({ state: "connected", tools: [] });
			expect(await manager.listTools("remote")).toEqual([]);
			expect(fixture.requests.some((entry) => entry.body.includes('"tools/list"'))).toBe(false);
		} finally {
			await manager?.close();
			await fixture.close();
		}
	});

	it("shares an in-flight connection and exposes full tool schemas", async () => {
		const fixture = await startMcpHttpServer();
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)] });
			const states = await Promise.all([manager.connect("remote"), manager.connect("remote"), manager.listTools("remote")]);
			expect(states[0]).toMatchObject({ state: "connected" });
			expect(states[2]).toEqual([expect.objectContaining({ name: "echo", inputSchema: expect.objectContaining({ type: "object" }) })]);
			expect(fixture.requests.filter((entry) => entry.body.includes('"initialize"'))).toHaveLength(1);
		} finally {
			await manager?.close();
			await fixture.close();
		}
	});

	for (const action of ["disconnect", "close"] as const) {
		it(`${action} during initialization cannot resurrect the connection`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const fixture = await startMcpHttpServer({ beforeReply: async (message) => {
				if (message.method === "initialize") { entered.resolve(); await release.promise; }
			} });
			try {
				manager = createMcpManager({ servers: [httpServer(fixture.url)], requestTimeoutMs: 1_000 });
				const connecting = manager.connect("remote");
				await entered.promise;
				if (action === "close") await manager.close();
				else await manager.disconnect("remote");
				release.resolve();
				await connecting.catch(() => {});
				expect(manager.status()[0]?.state).toBe("idle");
				if (action === "close") {
					await expect(manager.connect("remote")).rejects.toThrow(/closed/i);
					expect(await manager.callTool("remote", "echo", {})).toMatchObject({ isError: true });
				} else await expect(manager.connect("remote")).resolves.toMatchObject({ state: "connected" });
			} finally {
				release.resolve();
				await manager?.close();
				await fixture.close();
			}
		});
	}

	it("returns a safe call error without replaying an ambiguous write", async () => {
		const fixture = await startMcpHttpServer({ reply: (message) => message.method === "tools/call"
			? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "private-server-error" } }
			: undefined });
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)] });
			const result = await manager.callTool("remote", "echo", { text: "write" });
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).not.toContain("private-server-error");
			expect(fixture.requests.filter((entry) => entry.body.includes('"tools/call"'))).toHaveLength(1);
			expect(JSON.stringify(manager.status())).not.toContain("private-server-error");
		} finally {
			await manager?.close();
			await fixture.close();
		}
	});

	it("cancels a pending call without closing a shared connection", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixture = await startMcpHttpServer({ beforeReply: async (message) => {
			if (message.method === "tools/call" && message.params?.arguments?.text === "blocked") { entered.resolve(); await release.promise; }
		} });
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)] });
			const controller = new AbortController();
			const pending = manager.callTool("remote", "echo", { text: "blocked" }, { signal: controller.signal });
			await entered.promise;
			controller.abort();
			expect(await pending).toMatchObject({ isError: true });
			expect(manager.status()[0]?.state).toBe("connected");
			expect(await manager.callTool("remote", "echo", { text: "next" })).toMatchObject({ content: [{ type: "text", text: "http-echo: next" }] });
		} finally {
			release.resolve();
			await manager?.close();
			await fixture.close();
		}
	});

	it("cancels a caller waiting for initialization while another caller connects", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixture = await startMcpHttpServer({ beforeReply: async (message) => {
			if (message.method === "initialize") { entered.resolve(); await release.promise; }
		} });
		try {
			manager = createMcpManager({ servers: [httpServer(fixture.url)], requestTimeoutMs: 1_000 });
			const controller = new AbortController();
			const pending = manager.callTool("remote", "echo", { text: "cancelled" }, { signal: controller.signal });
			await entered.promise;
			const connected = manager.connect("remote");
			controller.abort();
			expect(await pending).toMatchObject({ isError: true });
			release.resolve();
			await expect(connected).resolves.toMatchObject({ state: "connected" });
			expect(fixture.requests.filter((entry) => entry.body.includes('"tools/call"'))).toHaveLength(0);
		} finally {
			release.resolve();
			await manager?.close();
			await fixture.close();
		}
	});

	it("does not connect or send a call for an already cancelled request", async () => {
		manager = createMcpManager({ servers: [stdioServer()] });
		const controller = new AbortController();
		controller.abort();
		expect(await manager.callTool("local", "echo", {}, { signal: controller.signal })).toMatchObject({ isError: true });
		expect(manager.status()[0]?.state).toBe("idle");
	});

	it("reports an unexpected process exit as failed and permits explicit reconnect", async () => {
		manager = createMcpManager({ servers: [stdioServer()] });
		const status = await manager.connect("local");
		if (status.pid === undefined) throw new Error("stdio fixture did not start");
		process.kill(status.pid);
		await expect.poll(() => manager?.status()[0]?.state).toBe("failed");
		expect(manager.status()[0]?.error).toMatch(/closed|failed/i);
		await expect(manager.connect("local")).resolves.toMatchObject({ state: "connected" });
	});

	it("shows only safe transport targets", () => {
		manager = createMcpManager({ servers: [
			{ name: "local", transport: "stdio", command: "C:\\private-dir\\node.exe", args: ["private-argument"], env: {} },
			httpServer("https://private-user:private-password@example.com/mcp?token=private-query#private-fragment"),
		] });
		expect(manager.status().map((status) => status.target)).toEqual(["node.exe", "https://example.com/mcp"]);
	});

	it("refuses a name that is not configured", async () => {
		manager = createMcpManager({ servers: [stdioServer()] });
		await expect(manager.connect("nope")).rejects.toThrow(/nope/);
		expect((await manager.callTool("nope", "echo", {})).isError).toBe(true);
	});
});
