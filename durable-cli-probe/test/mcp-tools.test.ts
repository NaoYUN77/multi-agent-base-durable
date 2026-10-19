import { describe, expect, it } from "vitest";
import { createMcpManager } from "../src/mcp/manager.ts";
import { createMcpTools, mcpToolName } from "../src/mcp/tools.ts";
import { authorizeTask } from "../src/agent/builder/authorization.ts";
import { loadSkillRegistry } from "../src/agent/builder/skill-registry.ts";
import { taskSpecOf, REPOSITORY_SKILLS } from "./helpers/batch-system.ts";

const server = { name: "local", transport: "stdio" as const, command: "mcp-fixture", args: [], env: {} };

describe("durable MCP capability identity", () => {
	it("keeps offline registrations stable, marks arbitrary calls unsafe, and binds destination changes", async () => {
		const manager = createMcpManager({ servers: [server] });
		const [first] = createMcpTools(manager);
		const [again] = createMcpTools(createMcpManager({ servers: [server] }));
		const [changed] = createMcpTools(createMcpManager({ servers: [{ ...server, args: ["another-destination"] }] }));
		expect(first?.name).toBe("mcp__local");
		expect(first?.version).toBe(again?.version);
		expect(first?.version).not.toBe(changed?.version);
		expect(first?.registration.replay).toBe("unsafe");
		expect(first?.effects).toEqual({ reads: [], writes: ["*"] });
		expect(manager.status()[0]?.state).toBe("idle");
		await manager.close();
	});

	it("grants only the server capabilities the child explicitly requests", async () => {
		const tools = createMcpTools(createMcpManager({ servers: [server] }));
		const policy = { skills: await loadSkillRegistry({ root: REPOSITORY_SKILLS }), allowedSkills: ["material-summary"],
			allowedTools: tools.map((tool) => tool.name), tools };
		const spec = taskSpecOf({ id: "t-mcp-grant", skillId: "material-summary", requestedTools: [],
			budget: { maxToolInvocations: 2, maxAttempts: 1, maxTechnicalRestarts: 0, timeoutMs: 5_000 } });
		const none = authorizeTask(spec, policy);
		expect(none.ok && none.value.tools).toEqual([]);
		const granted = authorizeTask({ ...spec, requestedTools: ["mcp__local"] }, policy);
		expect(granted.ok && granted.value.tools.map((tool) => tool.name)).toEqual(["mcp__local"]);
		expect(authorizeTask({ ...spec, requestedTools: ["mcp__other"] }, policy).ok).toBe(false);
	});

	it("keeps long names distinct and within provider limits", () => {
		const long = "x".repeat(64);
		expect(mcpToolName(long).length).toBeLessThanOrEqual(64);
		expect(mcpToolName(long)).not.toBe(mcpToolName(`${"x".repeat(63)}y`));
		expect(mcpToolName(long)).toMatch(/^[a-zA-Z0-9_-]+$/);
	});
});
