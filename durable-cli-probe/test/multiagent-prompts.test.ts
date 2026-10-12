// TASK-003 test/multiagent-prompts.test.ts
//
// The runtime prompts must be the files the agents actually receive — not a
// second, drifting copy. This proves the loading path end to end: the file
// content is read, installed as the conversation's instructions, and shows up
// in the `pi.system` entry's `sections` (which is what a provider renders into
// the request).

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

const PROMPTS = new URL("../prompts/multiagent/", import.meta.url);
const MAIN_PROMPT = readFileSync(new URL("main.md", PROMPTS), "utf8");
const SUB_PROMPT = readFileSync(new URL("sub.md", PROMPTS), "utf8");

const MAIN_SENTINEL = "MAIN-SENTINEL-PR0M";

function flatten(messages: readonly Message[]): string {
	return messages
		.map((message) => {
			const typed = message as { content?: unknown; sections?: Record<string, string | null> };
			const sections = Object.values(typed.sections ?? {})
				.filter((value): value is string => typeof value === "string")
				.join("\n");
			const content = typed.content;
			if (typeof content === "string") return `${content}\n${sections}`;
			if (!Array.isArray(content)) return sections;
			return `${content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
				.join("\n")}\n${sections}`;
		})
		.join("\n");
}

const requests: string[] = [];

const router: FauxResponseFactory = (request) => {
	requests.push(flatten(request.messages));
	const flat = flatten(request.messages);
	const last = [...request.messages].reverse().find((message) => message.role !== "system");
	if (!flat.includes(MAIN_SENTINEL)) {
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: "a b", marker: "b" }, { id: "prompt-call" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText("PROMPT-CHILD-ANSWER")]);
	}
	if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	return fauxAssistantMessage(
		[fauxToolCall("task_delegate", { taskId: "task-prompt", task: "count b", childTools: ["text_stats"] }, { id: "prompt-delegate" })],
		{ stopReason: "toolUse" },
	);
};

/** The instructions section of a conversation's `pi.system` entry. */
async function instructionsOf(runtime: ProbeRuntime, conversationId: number): Promise<string | undefined> {
	const conversation = await runtime.harness.conversation(conversationId as never, context);
	if (conversation === undefined) return undefined;
	const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
	for (const entry of entries.items) {
		if (entry.kind !== "pi.system") continue;
		for (const message of entry.model ?? []) {
			const sections = (message as { sections?: Record<string, string | null> }).sections;
			if (sections?.instructions !== undefined && sections.instructions !== null) return sections.instructions;
		}
	}
	return undefined;
}

describe("TASK-003 runtime prompts", () => {
	let directory: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-prompts-"));
		requests.length = 0;
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	it("loads the two prompt files and installs them as the agents' instructions", async () => {
		// The files exist, are non-empty, and are the documents they claim to be.
		expect(MAIN_PROMPT.trim().length).toBeGreaterThan(0);
		expect(SUB_PROMPT.trim().length).toBeGreaterThan(0);
		expect(MAIN_PROMPT).toContain("主 Agent 运行时指令");
		expect(SUB_PROMPT).toContain("子 Agent 运行时指令");

		runtime = await openProbe({
			databasePath: join(directory, "prompts.sqlite"),
			provider: "faux",
			fauxRouter: router,
			// Exactly the CLI's wiring: the file content is the child's instructions.
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: SUB_PROMPT })],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();
		// Exactly the CLI's wiring for the main side.
		await root.configure({ instructions: MAIN_PROMPT }, context);

		const submission = await root.submit({ type: "input", content: `DELEGATE-PROMPT ${MAIN_SENTINEL}` }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		// The main conversation's instructions are the main prompt file.
		const mainInstructions = await instructionsOf(runtime, root.id);
		expect(mainInstructions).toBeDefined();
		expect(mainInstructions).toContain("主 Agent 运行时指令");
		expect(mainInstructions).toContain("task_evidence");

		// The child conversation's instructions are the child prompt file.
		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-prompt", context);
		const childInstructions = await instructionsOf(runtime, ledger!.childConversationId!);
		expect(childInstructions).toBeDefined();
		expect(childInstructions).toContain("子 Agent 运行时指令");
		expect(childInstructions).toContain("text_stats");

		// And the prompts really reached the provider requests: the main prompt
		// marker is in a main request, the child marker only in child requests.
		const mainRequests = requests.filter((request) => request.includes(MAIN_SENTINEL));
		expect(mainRequests.some((request) => request.includes("主 Agent 运行时指令"))).toBe(true);
		const childRequests = requests.filter((request) => request.includes("子 Agent 运行时指令"));
		expect(childRequests.length).toBeGreaterThan(0);
		for (const request of childRequests) {
			expect(request.includes("主 Agent 运行时指令")).toBe(false);
			expect(request.includes(MAIN_SENTINEL)).toBe(false);
		}
	}, 20000);
});
