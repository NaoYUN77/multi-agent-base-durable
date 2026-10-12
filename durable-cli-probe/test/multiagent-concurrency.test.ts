// TASK-003 test/multiagent-concurrency.test.ts
//
// The races the second review asked for, all deterministic and offline:
//   - two delegations issued together: one wins, the other is refused, and the
//     task ends with one child conversation and one round;
//   - two revisions issued together: one wins round 2, the other is refused,
//     and round 2 has exactly one submission;
//   - a delegation and a cancellation issued together on a fresh task: the
//     cancel intent wins (or the round it interrupted stays unsettled), the
//     task closes as cancelled, and no child work is left running;
//   - a global stop (the main conversation's abort) while a round is in flight:
//     the child's work stops, the task is *not* turned into `failed`, and a
//     cancel then closes it.

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

const MAIN_SENTINEL = "MAIN-SENTINEL-RACE";
const MAT = "MAT-RACE-9F";

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

/** How many tool calls of each kind this router has already issued. */
let doubleDelegate = false;
let doubleRevise = false;
let delegateThenCancel = false;
/** Slow the child's tool so an abort lands while the round is in flight. */
let slowTool = false;

const router: FauxResponseFactory = (request) => {
	const flat = flatten(request.messages);
	const last = [...request.messages].reverse().find((message) => message.role !== "system");
	const textOf = (): string => {
		const content = (last as { content?: unknown } | undefined)?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
			.join("\n");
	};

	if (!flat.includes(MAIN_SENTINEL)) {
		if (last?.role !== "toolResult") {
			const args: Record<string, string | number> = { text: MAT, marker: "MAT" };
			if (slowTool) args.pauseMs = 5_000;
			return fauxAssistantMessage([fauxToolCall("text_stats", args, { id: "race-child-1" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText(`RACE-CHILD-ANSWER ${MAT}`)]);
	}

	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		if (doubleRevise && toolName === "task_review" && resultText.includes("rejected")) {
			// Two revisions for the same round, in one message.
			return fauxAssistantMessage(
				[
					fauxToolCall("task_revise", { taskId: "task-race", round: 1, task: `ROUND-TWO A ${MAT}`, feedback: "A" }, { id: "race-revise-a" }),
					fauxToolCall("task_revise", { taskId: "task-race", round: 1, task: `ROUND-TWO B ${MAT}`, feedback: "B" }, { id: "race-revise-b" }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (toolName === "task_delegate" && resultText.includes("round 1 settled")) {
			return fauxAssistantMessage(
				[fauxToolCall("task_review", { taskId: "task-race", decision: "reject", reason: "redo", round: 1 }, { id: "race-reject" })],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage([fauxText("RACE-MAIN-DONE")]);
	}

	const input = textOf();
	if (input.includes("DOUBLE-DELEGATE")) {
		doubleDelegate = true;
		return fauxAssistantMessage(
			[
				fauxToolCall("task_delegate", { taskId: "task-race", task: `count A ${MAT}`, childTools: ["text_stats"] }, { id: "race-delegate-a" }),
				fauxToolCall("task_delegate", { taskId: "task-race", task: `count B ${MAT}`, childTools: ["text_stats"] }, { id: "race-delegate-b" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (input.includes("DOUBLE-REVISE")) {
		doubleRevise = true;
		return fauxAssistantMessage(
			[fauxToolCall("task_delegate", { taskId: "task-race", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "race-delegate" })],
			{ stopReason: "toolUse" },
		);
	}
	if (input.includes("DELEGATE-AND-CANCEL")) {
		delegateThenCancel = true;
		return fauxAssistantMessage(
			[
				fauxToolCall("task_delegate", { taskId: "task-fresh", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "race-fresh-delegate" }),
				fauxToolCall("task_cancel", { taskId: "task-fresh", reason: "changed my mind" }, { id: "race-fresh-cancel" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (input.includes("SLOW-DELEGATE")) {
		slowTool = true;
		return fauxAssistantMessage(
			[fauxToolCall("task_delegate", { taskId: "task-slow", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "race-slow-delegate" })],
			{ stopReason: "toolUse" },
		);
	}
	if (input.includes("CLOSE-SLOW")) {
		return fauxAssistantMessage([fauxToolCall("task_cancel", { taskId: "task-slow", reason: "global stop" }, { id: "race-slow-cancel" })], {
			stopReason: "toolUse",
		});
	}
	return fauxAssistantMessage(
		[fauxToolCall("task_delegate", { taskId: "task-race", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "race-delegate" })],
		{ stopReason: "toolUse" },
	);
};

describe("TASK-003 concurrency and global stop", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-race-"));
		databasePath = join(directory, "race.sqlite");
		doubleDelegate = false;
		doubleRevise = false;
		delegateThenCancel = false;
		slowTool = false;
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	async function open(): Promise<{ harness: ProbeRuntime["harness"]; root: Awaited<ReturnType<typeof openRoot>> }> {
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: router,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child." })],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();
		return { harness: runtime.harness, root };
	}

	async function ledgerOf(harness: ProbeRuntime["harness"], rootId: number, taskId: string) {
		const doc = await harness.snapshot(TaskLedgerDoc, rootId as never, taskId, context);
		if (doc === undefined) throw new Error(`no ledger for ${taskId}`);
		return doc;
	}

	it("keeps one winner out of two delegations issued together (AC-05)", async () => {
		const { harness, root } = await open();
		await (await root.submit({ type: "input", content: `DOUBLE-DELEGATE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);

		const ledger = await ledgerOf(harness, root.id, "task-race");
		expect(ledger.rounds).toHaveLength(1);
		expect(ledger.operations.filter((binding) => binding.kind === "delegate")).toHaveLength(1);
		// One child conversation, not two: the losing delegation never created one.
		const conversations = await root.commit((tx) => tx.scanConversations({ ownerConversationId: root.id }, 100), context);
		expect(conversations.items).toHaveLength(1);
		// The loser was refused program-side, in the transcript.
		const entries = await root.entries({ order: "ascending" }, 200, undefined, context);
		const text = flatten(entries.items.flatMap((entry) => entry.model ?? []));
		expect(/already executing under another operation|already delegated/.test(text)).toBe(true);
	}, 30000);

	it("keeps one winner out of two revisions issued together (AC-05)", async () => {
		const { harness, root } = await open();
		await (await root.submit({ type: "input", content: `DOUBLE-REVISE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);

		const ledger = await ledgerOf(harness, root.id, "task-race");
		// Exactly one revision round, with exactly one submission.
		expect(ledger.rounds).toHaveLength(2);
		expect(ledger.operations.filter((binding) => binding.kind === "revise")).toHaveLength(1);
		const round2 = ledger.rounds[1]!;
		expect(round2.settledAt).toBeDefined();
		expect(round2.feedback === "A" || round2.feedback === "B").toBe(true);
		const entries = await root.entries({ order: "ascending" }, 200, undefined, context);
		const text = flatten(entries.items.flatMap((entry) => entry.model ?? []));
		// The loser is refused program-side: either because the round is already
		// executing, or because its target round is now stale.
		expect(/already executing under another operation|stale revision/.test(text)).toBe(true);
	}, 30000);

	it("closes a fresh task as cancelled when a delegation races a cancellation (AC-06)", async () => {
		const { harness, root } = await open();
		await (await root.submit({ type: "input", content: `DELEGATE-AND-CANCEL ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);

		const ledger = await ledgerOf(harness, root.id, "task-fresh");
		// Either the cancel intent landed first (the delegation was refused and no
		// round exists) or the delegation reserved round 1 and the cancel closed it
		// with that round unsettled. Never a completed round, never a live child.
		expect(ledger.status).toBe("cancelled");
		expect(ledger.rounds.length).toBeLessThanOrEqual(1);
		if (ledger.rounds.length === 1) expect(ledger.rounds[0]!.settledAt).toBeUndefined();
		const childId = ledger.childConversationId;
		if (childId !== undefined) {
			const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 200), context);
			expect(tasks.items.filter((task) => task.state.status !== "terminal")).toEqual([]);
		}
	}, 30000);

	it("does not turn a global stop into a failure, and a cancel then closes it (AC-06)", async () => {
		const { harness, root } = await open();
		// The child's tool is slow, so the round is in flight when the abort lands.
		const submission = root.submit({ type: "input", content: `SLOW-DELEGATE ${MAIN_SENTINEL}` }, context);
		const started = await submission;
		// Wait until the child conversation and its round exist, then stop everything.
		for (let tries = 0; tries < 2000; tries++) {
			const doc = await harness.snapshot(TaskLedgerDoc, root.id, "task-slow", context);
			if (doc?.childConversationId !== undefined && doc.rounds.length === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await root.abort(context);
		await started.wait(context).catch(() => undefined);
		await harness.waitForIdle(context);

		const afterAbort = await ledgerOf(harness, root.id, "task-slow");
		// The global stop is not a failure: the task stays non-terminal with its
		// round unsettled, so a resume or a cancel can still decide.
		expect(["running", "revising"]).toContain(afterAbort.status);
		expect(afterAbort.rounds[0]!.settledAt).toBeUndefined();
		expect(afterAbort.failure).toBeUndefined();
		// No hidden child work.
		const childId = afterAbort.childConversationId!;
		const liveTasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 200), context);
		expect(liveTasks.items.filter((task) => task.state.status !== "terminal")).toEqual([]);

		// The operator closes it explicitly.
		await (await root.submit({ type: "input", content: `CLOSE-SLOW ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const closed = await ledgerOf(harness, root.id, "task-slow");
		expect(closed.status).toBe("cancelled");
	}, 40000);
});
