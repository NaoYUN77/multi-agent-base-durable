// TASK-003 test/multiagent-compaction.test.ts
//
// AC-08: after compacting both conversations, the *effective context* has
// really changed (not a no-op), the old entries are still readable from the
// database, and the ledger — task status, review events, and evidence
// references — still resolves to the real records. No compression algorithm is
// implemented here: the built-in `conversation.compact()` is driven and its
// outcome verified.

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
import { entryText } from "../src/multiagent/evidence.ts";

const MAIN_SENTINEL = "MAIN-SENTINEL-3E9D";
const LONG_CHILD_ANSWER = `COMPACTION-ANSWER-START ${"Z".repeat(8000)} COMPACTION-ANSWER-END`;
const COMPACTION_SUMMARY = "COMPACTED-SUMMARY: the main agent delegated a text-counting task and the child answered with a long measurement text.";

const router: FauxResponseFactory = (request) => {
	const flat = request.messages
		.map((message) => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
				.join("\n");
		})
		.join("\n");
	// The built-in compaction task asks for a structured summary; answer it.
	const hasSummarizer = request.messages.some(
		(message) => message.role === "system" && typeof message.content === "string" && message.content.includes("context summarization assistant"),
	);
	const last = [...request.messages].reverse().find((message) => message.role !== "system");
	const textOf = (): string => {
		const content = (last as { content?: unknown } | undefined)?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
			.join("\n");
	};

	if (hasSummarizer) return fauxAssistantMessage([fauxText(COMPACTION_SUMMARY)]);

	if (!flat.includes(MAIN_SENTINEL)) {
		if (textOf().includes("count it")) {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: "a b c d", marker: "a" }, { id: "compact-call-1" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText(LONG_CHILD_ANSWER)]);
	}
	if (last?.role === "toolResult") {
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate") return fauxAssistantMessage([fauxText("MAIN-DONE-ROUND")]);
		return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	}
	return fauxAssistantMessage([fauxToolCall("task_delegate", { taskId: "task-compact", task: "count it", childTools: ["text_stats"] }, { id: "call-compact-delegate" })], { stopReason: "toolUse" });
};

/** Total model-facing text of a conversation's effective context. */
async function contextText(conversation: { context: (context: never, options?: never) => Promise<{ messages: readonly Message[] }> }): Promise<{ entries: number; chars: number }> {
	const view = await conversation.context(context as never);
	const chars = view.messages
		.map((message) => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : "")).join("\n");
		})
		.reduce((sum, text) => sum + text.length, 0);
	return { entries: view.messages.length, chars };
}

describe("TASK-003 compaction", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-compaction-"));
		databasePath = join(directory, "compaction.sqlite");
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	it("changes the effective context of both sides while keeping evidence readable (AC-08)", async () => {
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: router,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child agent." })],
			registryExtensions: [ChildTools],
			// The built-in policy keeps the recent 20000 tokens verbatim; this
			// deterministic transcript is far shorter, so the threshold is
			// narrowed to make a real compaction happen rather than a no-op.
			settings: { compaction: { keepRecentTokens: 48 } },
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();

		// Round 1: delegate; the child answers with a long text.
		const submission = await root.submit({ type: "input", content: `DELEGATE-COMPACT ${MAIN_SENTINEL}`, requestId: "main-compact" }, context);
		const settled = await submission.wait(context);
		expect(settled.status).toBe("done");
		await runtime.harness.waitForIdle(context);

		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-compact", context);
		expect(ledger?.status).toBe("awaiting_review");
		const childId = ledger!.childConversationId!;
		const child = (await runtime.harness.conversation(childId, context))!;
		const statsEvidence = ledger!.rounds[0]!.evidence.find((evidence) => evidence.toolName === "text_stats")!;

		// Before: both sides carry the long material in their effective context.
		const mainBefore = await contextText(root);
		const childBefore = await contextText(child);
		expect(childBefore.chars).toBeGreaterThan(8000);

		// Compact both conversations (manual, conversation-owned).
		const mainCompact = await root.compact(undefined, context);
		const childCompact = await child.compact(undefined, context);
		const mainResult = await runtime.harness.waitForTask(mainCompact, context);
		const childResult = await runtime.harness.waitForTask(childCompact, context);
		expect(mainResult.state.outcome.status).toBe("completed");
		expect(childResult.state.outcome.status).toBe("completed");

		// After: the effective context really changed — the compacted prefix is
		// gone from it and replaced by the summary, not a no-op.
		const mainAfter = await contextText(root);
		const childAfter = await contextText(child);
		expect(childAfter.entries).toBeLessThan(childBefore.entries);
		expect(mainAfter.entries).toBeLessThan(mainBefore.entries);
		const childContextText = JSON.stringify((await child.context(context as never)).messages);
		expect(childContextText).toContain("COMPACTED-SUMMARY");
		// The compacted-away raw content is no longer part of the context.
		expect(childContextText.includes("count it")).toBe(false);

		// Old entries are still readable from the database, and the ledger's
		// evidence reference still resolves to the same real record.
		const statsEntry = await child.commit((tx) => tx.entry(statsEvidence.entryId), context);
		expect(statsEntry).toBeDefined();
		expect(entryText(statsEntry)).toContain("lines=1");
		const ledgerAfter = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-compact", context);
		expect(ledgerAfter?.status).toBe("awaiting_review");
		expect(ledgerAfter?.rounds[0]?.evidence).toHaveLength(ledger!.rounds[0]!.evidence.length);
		expect(ledgerAfter?.reviews).toEqual(ledger!.reviews);
	}, 30000);
});
