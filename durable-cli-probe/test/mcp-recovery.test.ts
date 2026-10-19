// MCP recovery binding: a call that was queued durably must not run against a
// different server because the configuration was edited between two opens.
//
// The reproduction is the real one: a real loopback HTTP server holds the first
// `tools/call`, the session is closed while it is in flight, `mcp.json` is
// pointed at a second server, and the same database is reopened. Nothing here
// asserts how the opening refuses — only that a call the previous run had
// already committed to is never sent to the new destination.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentSession } from "../src/service/session.ts";
import type { AgentSession } from "../src/service/types.ts";
import { mainRouter, runConfigOf } from "./helpers/batch-system.ts";
import { startMcpHttpServer } from "./helpers/mcp-http-server.mjs";

const RUN_CONFIG = runConfigOf({
	schemaVersion: 1,
	maxConcurrentSubAgents: 2,
	maxSubAgentsPerRequest: 4,
	maxToolInvocationsPerRound: 4,
	maxFailedToolCallsPerRound: 2,
	maxAttemptsPerOperation: 2,
	maxTechnicalRestarts: 1,
	roundTimeoutMs: 10_000,
	providerRetry: { maxRetries: 0, backoffMs: 0 },
	harnessRetry: { maxRetries: 0, backoffMs: 0 },
});

/** Two sequential calls, so a resumed run has a second call to send. */
const twoCalls = mainRouter(
	() => [
		[{ name: "mcp__local", arguments: { action: "call", tool: "echo", arguments: { text: "one" } } }],
		[{ name: "mcp__local", arguments: { action: "call", tool: "echo", arguments: { text: "two" } } }],
	],
	() => fauxAssistantMessage([fauxText("unused in this suite")]),
);

const calls = (requests: readonly { readonly body: string }[]) => requests.filter((entry) => entry.body.includes('"tools/call"'));

const directories: string[] = [];
const opened: AgentSession[] = [];

afterEach(async () => {
	for (const session of opened.splice(0)) await session.close().catch(() => {});
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ readonly directory: string; readonly databasePath: string; readonly configPath: string }> {
	const directory = await mkdtemp(join(tmpdir(), "mcp-recovery-"));
	directories.push(directory);
	return { directory, databasePath: join(directory, "agent.sqlite"), configPath: join(directory, "mcp.json") };
}

async function pointAt(configPath: string, url: string): Promise<void> {
	await writeFile(configPath, JSON.stringify({ mcpServers: { local: { url } } }));
}

function open(options: { readonly databasePath: string; readonly configPath: string }): Promise<AgentSession> {
	return openAgentSession({
		provider: "faux",
		databasePath: options.databasePath,
		mcpConfigPath: options.configPath,
		fauxRouter: twoCalls,
		runConfig: RUN_CONFIG,
		maxConcurrentSubAgents: RUN_CONFIG.maxConcurrentSubAgents,
		maxSubAgentsPerRequest: RUN_CONFIG.maxSubAgentsPerRequest,
	});
}

/** A server whose first `tools/call` never answers until it is released. */
async function holdingServer() {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let held = false;
	const server = await startMcpHttpServer({
		beforeReply: async (message: unknown) => {
			const first = (Array.isArray(message) ? message[0] : message) as { readonly method?: string } | undefined;
			if (first?.method === "tools/call" && !held) {
				held = true;
				await gate;
			}
		},
	});
	return { server, release: () => release() };
}

async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function waitForAsync<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("MCP destination is bound across a reopen", { timeout: 60_000 }, () => {
	it("refuses to reopen a database whose configuration changed while a call was in flight", async () => {
		const { databasePath, configPath } = await workspace();
		const { server: before, release } = await holdingServer();
		const after = await startMcpHttpServer();
		try {
			await pointAt(configPath, before.url);
			const first = await open({ databasePath, configPath });
			const sent = await first.main.submitUserInput({ text: "call the server twice", requestId: "req-mcp-1" });
			expect(sent.kind).toBe("request");
			// The first call is committed and in flight when the process goes away.
			await waitFor(() => before.requests, (requests) => calls(requests).length === 1);
			await first.close();

			// A different destination now answers to the same dispatcher name.
			await pointAt(configPath, after.url);
			await expect(open({ databasePath, configPath })).rejects.toThrow(/MCP/i);
			// The call the previous run had committed to was not sent here.
			expect(calls(after.requests)).toEqual([]);
		} finally {
			release();
			await before.close();
			await after.close();
		}
	});

	it("reopens an unchanged database without replaying the interrupted call", async () => {
		const { databasePath, configPath } = await workspace();
		const { server: before, release } = await holdingServer();
		try {
			await pointAt(configPath, before.url);
			const first = await open({ databasePath, configPath });
			const sent = await first.main.submitUserInput({ text: "call the server twice", requestId: "req-mcp-2" });
			expect(sent.kind).toBe("request");
			await waitFor(() => before.requests, (requests) => calls(requests).length === 1);
			await first.close();
			release();

			// Same configuration: the identity matches, so the reopen is not refused,
			// and the guard connects to nothing while it decides.
			const second = await open({ databasePath, configPath });
			opened.push(second);
			expect(second.mcpStatus().map((status) => status.state)).toEqual(["idle"]);

			// The run is recovered to its end, and the call that was interrupted is
			// reported as interrupted rather than sent a second time: an MCP call may
			// already have taken effect.
			await waitForAsync(() => second.snapshot(Date.now()), (snapshot) => !snapshot.mainBusy);
			expect(calls(before.requests).filter((entry) => entry.body.includes('"one"'))).toHaveLength(1);
		} finally {
			release();
			await before.close();
		}
	});

	it("accepts a changed configuration when no work is outstanding", async () => {
		const { databasePath, configPath } = await workspace();
		const first = await startMcpHttpServer();
		const second = await startMcpHttpServer();
		try {
			await pointAt(configPath, first.url);
			const idle = await open({ databasePath, configPath });
			await idle.close();

			await pointAt(configPath, second.url);
			const reopened = await open({ databasePath, configPath });
			opened.push(reopened);
			// The idle reopen took the new destination.
			expect(reopened.mcpStatus()[0]?.target).toBe(`${new URL(second.url).origin}${new URL(second.url).pathname}`);
		} finally {
			await first.close();
			await second.close();
		}
	});
});
