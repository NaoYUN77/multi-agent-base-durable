// TASK-003 test/multiagent-cancel-admission.test.ts
//
// The third review's P1: cancellation and submission admission must be
// coordinated, not merely checked twice. The race is driven deterministically
// inside one process (the only configuration the base Harness supports — a
// second process opening the same database *takes over* a surviving running
// task, which is a resume, not a coordination primitive):
//
//   1. a round is parked at its verification barrier, holding the execution
//      right, with no submission yet;
//   2. a cancellation runs to completion while the round is parked;
//   3. the barrier is released, so the round would submit if nothing stopped it.
//
// The safety property asserted at every step: **no submission for the parked
// round ever appears**. Covered for the initial round and for a revision round.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

const MAIN_SENTINEL = "MAIN-SENTINEL-ADM";
const MAT = "MAT-ADM-3C";

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

/** Which round the barrier should park (undefined: park nothing). */
let parkRound: number | undefined;

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
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: MAT, marker: "MAT" }, { id: "adm-child-1" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(`ADM-CHILD-ANSWER ${MAT}`)]);
	}

	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate" && resultText.includes("round 1 settled") && parkRound === 2) {
			// Reject round 1 so a revision is legal next.
			return fauxAssistantMessage(
				[fauxToolCall("task_review", { taskId: "task-adm", decision: "reject", reason: "redo", round: 1 }, { id: "adm-reject" })],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage([fauxText("ADM-MAIN-DONE")]);
	}

	const input = textOf();
	if (input.includes("REVISE-AND-CANCEL")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("task_revise", { taskId: "task-adm", round: 1, task: `ROUND-TWO ${MAT}`, feedback: "again" }, { id: "adm-revise" }),
				fauxToolCall("task_cancel", { taskId: "task-adm", reason: "driver" }, { id: "adm-cancel" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (input.includes("DELEGATE-AND-CANCEL")) {
		return fauxAssistantMessage(
			[
				fauxToolCall("task_delegate", { taskId: "task-adm", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "adm-delegate" }),
				fauxToolCall("task_cancel", { taskId: "task-adm", reason: "driver" }, { id: "adm-cancel" }),
			],
			{ stopReason: "toolUse" },
		);
	}
	if (input.includes("CLOSE")) {
		return fauxAssistantMessage([fauxToolCall("task_cancel", { taskId: "task-adm", reason: "driver close" }, { id: "adm-close" })], {
			stopReason: "toolUse",
		});
	}
	return fauxAssistantMessage(
		[fauxToolCall("task_delegate", { taskId: "task-adm", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "adm-delegate" })],
		{ stopReason: "toolUse" },
	);
};

describe("TASK-003 cancellation admission control", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;
	let gate: { promise: Promise<void>; resolve: () => void };

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-admission-"));
		databasePath = join(directory, "admission.sqlite");
		parkRound = undefined;
		const { promise, resolve } = Promise.withResolvers<void>();
		gate = { promise, resolve };
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
			extensions: [
				createMultiagentExtension({
					model: { provider: "faux", modelId: "faux-1" },
					childInstructions: "You are the child.",
					// Park exactly the round under test at the pre-submit barrier.
					beforeSubmit: (info) => (info.round === parkRound ? gate.promise : undefined),
				}),
			],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();
		return { harness: runtime.harness, root };
	}

	async function ledgerOf(harness: ProbeRuntime["harness"], rootId: number) {
		const doc = await harness.snapshot(TaskLedgerDoc, rootId as never, "task-adm", context);
		if (doc === undefined) throw new Error("no ledger for task-adm");
		return doc;
	}

	/** Submissions of one round's stable request id, read straight from SQLite. */
	function roundSubmissions(round: number): number {
		const require = createRequire(import.meta.url);
		const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
		const db = new DatabaseSync(databasePath, { readOnly: true });
		try {
			return (db.prepare("SELECT id FROM submissions WHERE request_id LIKE ?").all(`%"multiagent-round:task-adm:${round}"%`) as unknown[])
				.length;
		} finally {
			db.close();
		}
	}

	it("never lets a parked initial round submit once the cancel has run (AC-06)", async () => {
		parkRound = 1;
		const { harness, root } = await open();

		// One message, two parallel calls: the delegation parks at the barrier and
		// the cancellation runs while it is parked.
		const turn = await root.submit({ type: "input", content: `DELEGATE-AND-CANCEL ${MAIN_SENTINEL}` }, context);
		const settled = await turn.wait(context);
		expect(settled.status).toBe("done");
		await harness.waitForIdle(context);

		const parked = await ledgerOf(harness, root.id);
		// The cancellation recorded its intent; the round has no submission yet.
		expect(parked.cancelRequested).toBeDefined();
		expect(roundSubmissions(1)).toBe(0);

		// Release the parked round: it must see the intent and refuse to submit.
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(roundSubmissions(1)).toBe(0);

		// The operator's cancel then closes the task, and still no submission exists.
		await (await root.submit({ type: "input", content: `CLOSE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id);
		expect(after.status).toBe("cancelled");
		expect(roundSubmissions(1)).toBe(0);
		expect(after.rounds).toHaveLength(1);
		expect(after.rounds[0]!.settledAt).toBeUndefined();
		// No hidden child work.
		const childId = after.childConversationId;
		if (childId !== undefined) {
			const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 200), context);
			expect(tasks.items.filter((task) => task.state.status !== "terminal")).toEqual([]);
		}
	}, 40000);

	it("never lets a parked revision submit once the cancel has run (AC-06)", async () => {
		parkRound = 2;
		const { harness, root } = await open();

		// Round 1 completes and is rejected, so the task waits at `revising`.
		await (await root.submit({ type: "input", content: `DELEGATE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const beforeRevision = await ledgerOf(harness, root.id);
		expect(beforeRevision.status).toBe("revising");
		expect(beforeRevision.rounds).toHaveLength(1);
		const round1Evidence = beforeRevision.rounds[0]!.evidence.length;
		const round1Submissions = roundSubmissions(1);
		expect(round1Submissions).toBe(1);

		// The revision parks at its barrier; the cancel runs while it is parked.
		const turn = await root.submit({ type: "input", content: `REVISE-AND-CANCEL ${MAIN_SENTINEL}` }, context);
		expect((await turn.wait(context)).status).toBe("done");
		await harness.waitForIdle(context);

		const parked = await ledgerOf(harness, root.id);
		expect(parked.cancelRequested).toBeDefined();
		expect(parked.rounds).toHaveLength(2);
		expect(roundSubmissions(2)).toBe(0);

		// Release: the revision must refuse to submit.
		gate.resolve();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(roundSubmissions(2)).toBe(0);

		// Close the task; round 1's records stay exactly as they were.
		await (await root.submit({ type: "input", content: `CLOSE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id);
		expect(after.status).toBe("cancelled");
		expect(roundSubmissions(2)).toBe(0);
		expect(roundSubmissions(1)).toBe(round1Submissions);
		expect(after.rounds[0]!.evidence.length).toBe(round1Evidence);
		expect(after.rounds[1]!.settledAt).toBeUndefined();
	}, 40000);
});
