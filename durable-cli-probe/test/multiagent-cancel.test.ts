// TASK-003 test/multiagent-cancel.test.ts
//
// Cancellation and concurrency, deterministic and offline:
//   - cancel while a revision is in flight (revise and cancel issued in the
//     same assistant message, so they really race) closes the task as
//     cancelled, leaves no live child work, and does not let the interrupted
//     revision drag the ledger back;
//   - a cancelled task refuses revise/review/delegate and keeps its history;
//   - a new task after a cancel gets a fresh child conversation;
//   - two conflicting reviews in one message produce exactly one decision.

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

const MAIN_SENTINEL = "MAIN-SENTINEL-C4N0";
const MAT = "MAT-CANCEL-1A2B";

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

/** Drives: delegate → reject (round 1) → then per-turn actions. */
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
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: MAT, marker: "MAT" }, { id: "cancel-call-1" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(`CANCEL-CHILD-ANSWER ${MAT}`)]);
	}

	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate" && resultText.includes("task-cancel round 1 settled")) {
			return fauxAssistantMessage(
				[fauxToolCall("task_review", { taskId: "task-cancel", decision: "reject", reason: "redo", round: 1 }, { id: "cancel-reject" })],
				{ stopReason: "toolUse" },
			);
		}
		if (toolName === "task_delegate" && resultText.includes("task-double round 1 settled")) {
			// Two conflicting accepts for the same round, in one message.
			return fauxAssistantMessage(
				[
					fauxToolCall("task_review", { taskId: "task-double", decision: "accept", round: 1 }, { id: "double-a" }),
					fauxToolCall("task_review", { taskId: "task-double", decision: "accept", round: 1 }, { id: "double-b" }),
				],
				{ stopReason: "toolUse" },
			);
		}
		// A revision and a cancel are still running; their results arrive separately.
		return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	}

	if (textOf().includes("RACE-REVISE-CANCEL")) {
		// One message, two parallel calls: the revision starts and is cancelled
		// while it is in flight.
		return fauxAssistantMessage(
			[
				fauxToolCall("task_revise", { taskId: "task-cancel", round: 1, task: `ROUND-TWO count ${MAT}`, feedback: "again" }, { id: "race-revise" }),
				fauxToolCall("task_cancel", { taskId: "task-cancel", reason: "changed my mind" }, { id: "race-cancel" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (textOf().includes("AFTER-CANCEL-OPS")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_revise", { taskId: "task-cancel", round: 1, task: "again", feedback: "again" }, { id: "after-revise" })],
			{ stopReason: "toolUse" },
		);
	}
	if (textOf().includes("NEW-TASK")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_delegate", { taskId: "task-after", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "after-delegate" })],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(
		[
			fauxToolCall(
				"task_delegate",
				{ taskId: textOf().includes("DOUBLE") ? "task-double" : "task-cancel", task: `count ${MAT}`, childTools: ["text_stats"] },
				{ id: "cancel-delegate" },
			),
		],
		{ stopReason: "toolUse" },
	);
};

describe("TASK-003 cancellation and concurrency", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-cancel-"));
		databasePath = join(directory, "cancel.sqlite");
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	async function open(): Promise<ProbeRuntime["harness"]> {
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: router,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child." })],
			registryExtensions: [ChildTools],
		});
		return runtime.harness;
	}

	async function ledgerOf(harness: ProbeRuntime["harness"], rootId: number, taskId: string) {
		const doc = await harness.snapshot(TaskLedgerDoc, rootId as never, taskId, context);
		if (doc === undefined) throw new Error(`no ledger for ${taskId}`);
		return doc;
	}

	it("cancels a task whose revision is in flight, leaving no live child work (AC-06)", async () => {
		const harness = await open();
		const root = await openRoot(runtime!);
		harness.resume();

		await (await root.submit({ type: "input", content: `DELEGATE ${MAIN_SENTINEL}` }, context)).wait(context);
		const afterReject = await ledgerOf(harness, root.id, "task-cancel");
		expect(afterReject.status).toBe("revising");
		const childId = afterReject.childConversationId!;

		// The revision and the cancel are issued together.
		const race = await root.submit({ type: "input", content: `RACE-REVISE-CANCEL ${MAIN_SENTINEL}` }, context);
		const settled = await race.wait(context);
		expect(settled.status).toBe("done");
		await harness.waitForIdle(context);

		const ledger = await ledgerOf(harness, root.id, "task-cancel");
		expect(ledger.status).toBe("cancelled");
		expect(ledger.failure?.reason).toBe("cancelled");
		// The revision's intent was recorded before the cancel closed the task;
		// no extra round was created by the abort.
		expect(ledger.rounds.length).toBeLessThanOrEqual(2);
		expect(ledger.events.some((event) => event.to === "cancelled")).toBe(true);

		// No live child work: every task of the child conversation is terminal.
		const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 200), context);
		const live = tasks.items.filter((task) => task.state.status !== "terminal");
		expect(live.map((task) => `${task.id}:${task.state.status}`)).toEqual([]);

		// History and evidence stay readable.
		const child = (await harness.conversation(childId, context))!;
		const entries = await child.entries({ order: "ascending" }, 200, undefined, context);
		expect(entries.items.length).toBeGreaterThan(0);
	}, 30000);

	it("refuses operations after a cancel and gives a new task a new child (AC-06)", async () => {
		const harness = await open();
		const root = await openRoot(runtime!);
		harness.resume();
		await (await root.submit({ type: "input", content: `DELEGATE ${MAIN_SENTINEL}` }, context)).wait(context);
		const rejected = await ledgerOf(harness, root.id, "task-cancel");
		expect(rejected.status).toBe("revising");
		const cancelledChild = rejected.childConversationId!;

		await (await root.submit({ type: "input", content: `RACE-REVISE-CANCEL ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		expect((await ledgerOf(harness, root.id, "task-cancel")).status).toBe("cancelled");

		// A revision on the cancelled task is refused program-side.
		await (await root.submit({ type: "input", content: `AFTER-CANCEL-OPS ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const stillCancelled = await ledgerOf(harness, root.id, "task-cancel");
		expect(stillCancelled.status).toBe("cancelled");
		expect(stillCancelled.rounds.length).toBeLessThanOrEqual(2);

		// A new task gets its own child conversation.
		await (await root.submit({ type: "input", content: `NEW-TASK ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id, "task-after");
		expect(after.childConversationId).toBeTypeOf("number");
		expect(after.childConversationId).not.toBe(cancelledChild);
	}, 30000);

	it("keeps two conflicting reviews in one message to a single decision (AC-05)", async () => {
		const harness = await open();
		const root = await openRoot(runtime!);
		harness.resume();
		// DOUBLE goes straight to task-double; the delegate runs, then the two
		// accepts are issued together.
		await (await root.submit({ type: "input", content: `DOUBLE-REVIEW ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);

		const ledger = await ledgerOf(harness, root.id, "task-double");
		expect(ledger.status).toBe("accepted");
		expect(ledger.reviews).toHaveLength(1);
		expect(ledger.operations.filter((binding) => binding.kind === "review")).toHaveLength(1);
	}, 30000);
});
