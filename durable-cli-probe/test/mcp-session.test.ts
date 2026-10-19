import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentSession } from "../src/service/session.ts";
import type { AgentSession } from "../src/service/types.ts";
import { context } from "../src/runtime.ts";
import { childAnswer, mainRouter, runConfigOf, taskSpecOf } from "./helpers/batch-system.ts";
import { startMcpHttpServer } from "./helpers/mcp-http-server.mjs";

const runConfig = runConfigOf({
	schemaVersion: 1, maxConcurrentSubAgents: 2, maxSubAgentsPerRequest: 4,
	maxToolInvocationsPerRound: 4, maxFailedToolCallsPerRound: 2,
	maxAttemptsPerOperation: 2, maxTechnicalRestarts: 1, roundTimeoutMs: 10_000,
	providerRetry: { maxRetries: 0, backoffMs: 0 }, harnessRetry: { maxRetries: 0, backoffMs: 0 },
});
const stdioFixture = fileURLToPath(new URL("./helpers/mcp-stdio-server.mjs", import.meta.url));

async function waitForChild(session: AgentSession, taskId: string) {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const detail = await session.inspectTask(taskId, Date.now());
		if (detail?.row.status === "awaiting-review") return detail;
		if (Date.now() > deadline) throw new Error(`child did not finish: ${detail?.row.status}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("MCP tools in the production session", { timeout: 30_000 }, () => {
	let directory: string | undefined;
	let session: AgentSession | undefined;
	let http: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
	afterEach(async () => {
		await session?.close();
		await http?.close();
		if (directory) await rm(directory, { recursive: true, force: true });
		session = undefined;
		http = undefined;
	});

	it.each(["stdio", "http"] as const)("lets Main and an explicitly granted child call a real %s server", async (transport) => {
		directory = await mkdtemp(join(tmpdir(), "mcp-session-"));
		if (transport === "http") http = await startMcpHttpServer();
		const mcpConfigPath = join(directory, "mcp.json");
		await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { local: transport === "stdio"
			? { command: process.execPath, args: [stdioFixture] }
			: { url: http?.url } } }));
		const tool = "mcp__local";
		const spec = taskSpecOf({ id: "t-mcp", skillId: "mcp-work", requestedTools: [tool],
			budget: { maxToolInvocations: 3, maxAttempts: 1, maxTechnicalRestarts: 0, timeoutMs: 10_000 } });
		let childAnswerText = "";
		const router = mainRouter(() => [
			[{ name: tool, arguments: { action: "list" } }],
			[{ name: tool, arguments: { action: "call", tool: "echo", arguments: { text: "MAIN-MCP" } } }],
			[{ name: "save_plan", arguments: { planId: "mcp-plan", goals: ["MCP"], taskIds: [spec.id] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "mcp-plan", version: 1, tasks: [spec as never] } }],
		], (request) => {
			const last = request.messages.at(-1);
			if (last?.role !== "toolResult") return fauxAssistantMessage([
				fauxToolCall(tool, { action: "call", tool: "echo", arguments: { text: "CHILD-MCP" } }),
			], { stopReason: "toolUse" });
			childAnswerText = JSON.stringify(last.content);
			return fauxAssistantMessage(childAnswer(childAnswerText));
		});
		session = await openAgentSession({ provider: "faux", databasePath: join(directory, "agent.sqlite"),
			mcpConfigPath, fauxRouter: router, runConfig,
			maxConcurrentSubAgents: 2, maxSubAgentsPerRequest: 4 });
		const sent = await session.main.submitUserInput({ text: "use MCP and delegate", requestId: "mcp-request" });
		expect(sent.kind).toBe("request");
		if (sent.kind !== "request") return;
		await sent.submission.wait(context);
		const transcript = await session.transcript(50);
		expect(transcript.some((line) => line.kind === "tool" && line.text.includes("echo: MAIN-MCP"))).toBe(true);
		expect(transcript.some((line) => line.kind === "tool" && line.text.includes("inputSchema"))).toBe(true);
		const child = await waitForChild(session, spec.id);
		expect(childAnswerText).toContain("echo: CHILD-MCP");
		expect(child.rounds[0]?.resultSummary).toContain("echo: CHILD-MCP");
	});
});
