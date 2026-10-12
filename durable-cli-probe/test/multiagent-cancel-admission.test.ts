// TASK-003 test/multiagent-cancel-admission.test.ts
//
// The fourth review's P2 (handshake) and the fifth review's P1/P2:
//   * a round parked at `beforeSubmit` is *before* the cancellation gate: the
//     handshake proves it, the cancel stays pending while the right is held, and
//     releasing it makes the round refuse at the gate — no submission at all;
//   * a round parked at `atSubmit` is *after* the cancellation gate: releasing it
//     does submit, so the property asserted there is the one the fifth review
//     asked for — the cancel still stays pending while the right is held, and
//     once it reaches `cancelled` there is no new submission and no live work;
//   * a pending cancellation blocks *new* operations outright: a fresh
//     delegate/revise is refused before it claims a round, with rounds,
//     operations, currentRound and version unchanged.
//
// Why one process and one message: a conversation processes one run at a time —
// a second submission to the same conversation is queued in the inbox until the
// parked round finishes — so the only place a cancellation can run while a round
// is parked is a parallel tool call in the same turn. The handshake makes that
// deterministic instead of relying on who wins the race:
//
//   * the round parks at the `beforeSubmit` barrier, which now sits *inside* the
//     admission window, and signals `entered`;
//   * the cancellation in the same message runs to completion while the round is
//     parked, and must report `cancel pending` (the right is held);
//   * releasing the barrier lets the round reach its second admission check,
//     which sees the intent and refuses — no submission is ever made;
//   * a second turn retries the cancel and closes the task.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import type { Extension } from "@earendil-works/pi-durable";
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

/** Which round the barrier parks (undefined: park nothing). */
let parkRound: number | undefined;
/** Which window the barrier parks in. */
let parkWindow: "pre-gate" | "post-gate" = "pre-gate";

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
	if (input.includes("REVISE-AGAIN")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_revise", { taskId: "task-adm", round: 1, task: `ROUND-TWO ${MAT}`, feedback: "again" }, { id: "adm-revise-again" })],
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
	let entered: { promise: Promise<void>; resolve: () => void };
	/** Releases the cancellation tool's start (see `delayCancel`). */
	let cancelGate: { promise: Promise<void>; resolve: () => void };

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-admission-"));
		databasePath = join(directory, "admission.sqlite");
		parkRound = undefined;
		parkWindow = "pre-gate";
		gate = Promise.withResolvers<void>();
		entered = Promise.withResolvers<void>();
		cancelGate = Promise.withResolvers<void>();
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	/**
	 * Test-side wrapper: hold the cancel tool's execution until the test releases
	 * it. Production checks are untouched; only the *start* of the cancellation is
	 * sequenced, so a round can be parked in the post-gate window before the
	 * cancellation begins (tool calls in one message otherwise start together).
	 */
	function delayCancel(extension: Extension): Extension {
		return {
			...extension,
			tools: (extension.tools ?? []).map((tool) =>
				tool.name === "task_cancel"
					? {
							...tool,
							execute: async (args: never, api: never, ctx: never) => {
								await cancelGate.promise;
								return tool.execute(args, api, ctx);
							},
						}
					: tool,
			),
		} as Extension;
	}

	async function open(): Promise<{ harness: ProbeRuntime["harness"]; root: Awaited<ReturnType<typeof openRoot>> }> {
		// Park the round under test at the requested window and announce that it is
		// there: `beforeSubmit` is the pre-gate window, `atSubmit` the post-gate one.
		const park = async (info: { round: number }): Promise<void> => {
			if (info.round !== parkRound) return;
			entered.resolve();
			await gate.promise;
		};
		const extension = createMultiagentExtension({
			model: { provider: "faux", modelId: "faux-1" },
			childInstructions: "You are the child.",
			...(parkWindow === "pre-gate" ? { beforeSubmit: park } : { atSubmit: park }),
		});
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: router,
			extensions: [delayCancel(extension)],
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

	/** Poll an async predicate until it holds (or fail). */
	async function poll(check: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await check()) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`timed out waiting for ${label}`);
	}

	async function transcript(harness: ProbeRuntime["harness"], rootId: number): Promise<string> {
		const conversation = await harness.conversation(rootId as never, context);
		const page = await conversation!.entries({ order: "ascending" }, 500, undefined, context);
		return flatten(page.items.flatMap((entry) => entry.model ?? []));
	}

	it("keeps the cancel pending while the initial round is inside the admission window (AC-06)", async () => {
		parkRound = 1;
		cancelGate.resolve();
		const { harness, root } = await open();

		// One message, two parallel calls. The round parks inside the window and
		// the cancel runs to completion while it is parked.
		const turn = root.submit({ type: "input", content: `DELEGATE-AND-CANCEL ${MAIN_SENTINEL}` }, context);
		await entered.promise; // the handshake: the round really is in the window
		// The parked round cannot finish yet, so observe the cancellation's own
		// outcome instead of waiting for the whole turn.
		await poll(async () => (await ledgerOf(harness, root.id)).cancelRequested !== undefined, "the cancellation intent");
		await poll(async () => (await transcript(harness, root.id)).includes("cancel pending"), "the cancel to report pending");

		// Observed while parked: the right is held, the intent is recorded, the
		// cancel reported pending, and nothing has been submitted.
		const parked = await ledgerOf(harness, root.id);
		expect(parked.cancelRequested).toBeDefined();
		expect(parked.activeOpKey).toMatch(/^delegate:/);
		expect(parked.status).toBe("running");
		expect(roundSubmissions(1)).toBe(0);

		// Release: the round reaches its second admission check, sees the intent,
		// and refuses to submit.
		gate.resolve();
		await (await turn).wait(context);
		await harness.waitForIdle(context);
		expect(roundSubmissions(1)).toBe(0);

		// The retried cancel closes the task; still nothing was submitted.
		await (await root.submit({ type: "input", content: `CLOSE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id);
		expect(after.status).toBe("cancelled");
		expect(roundSubmissions(1)).toBe(0);
		expect(after.rounds).toHaveLength(1);
		expect(after.rounds[0]!.settledAt).toBeUndefined();
		const childId = after.childConversationId;
		if (childId !== undefined) {
			const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 200), context);
			expect(tasks.items.filter((task) => task.state.status !== "terminal")).toEqual([]);
		}
	}, 60000);

	it("keeps the cancel pending while a revision is inside the admission window (AC-06)", async () => {
		parkRound = 2;
		cancelGate.resolve();
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
		const round1Reviews = beforeRevision.reviews;

		// The revision parks inside the window; the cancel runs while it is parked.
		const turn = root.submit({ type: "input", content: `REVISE-AND-CANCEL ${MAIN_SENTINEL}` }, context);
		await entered.promise;
		await poll(async () => (await ledgerOf(harness, root.id)).cancelRequested !== undefined, "the cancellation intent");
		await poll(async () => (await transcript(harness, root.id)).includes("cancel pending"), "the cancel to report pending");

		const parked = await ledgerOf(harness, root.id);
		expect(parked.cancelRequested).toBeDefined();
		expect(parked.activeOpKey).toMatch(/^revise:/);
		expect(parked.activeRound).toBe(2);
		expect(parked.status).toBe("revising");
		expect(parked.rounds).toHaveLength(2);
		expect(parked.rounds[1]!.feedback).toBe("again");
		expect(roundSubmissions(2)).toBe(0);

		// Release: the revision refuses to submit.
		gate.resolve();
		await (await turn).wait(context);
		await harness.waitForIdle(context);
		expect(roundSubmissions(2)).toBe(0);

		// Close the task; round 1's records stay exactly as they were.
		await (await root.submit({ type: "input", content: `CLOSE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id);
		expect(after.status).toBe("cancelled");
		expect(roundSubmissions(2)).toBe(0);
		expect(roundSubmissions(1)).toBe(round1Submissions);
		expect(after.rounds[0]!.evidence.length).toBe(round1Evidence);
		expect(after.reviews).toEqual(round1Reviews);
		expect(after.rounds[1]!.settledAt).toBeUndefined();
	}, 60000);
	it("keeps the cancel pending in the post-gate window and starts nothing after it closes (AC-06)", async () => {
		parkWindow = "post-gate";
		parkRound = 1;
		const { harness, root } = await open();

		// The round parks *after* the cancellation gate, and the cancellation has
		// not started yet: the window is covered without racing the gate.
		const turn = root.submit({ type: "input", content: `DELEGATE-AND-CANCEL ${MAIN_SENTINEL}` }, context);
		await entered.promise;
		const parked = await ledgerOf(harness, root.id);
		expect(parked.activeOpKey).toMatch(/^delegate:/);
		expect(parked.status).toBe("running");
		expect(roundSubmissions(1)).toBe(0);
		expect(parked.cancelRequested).toBeUndefined();

		// Now start the cancellation: while the round holds the right and is past
		// the gate, the cancel must stay pending and must not close the task.
		cancelGate.resolve();
		await poll(async () => (await ledgerOf(harness, root.id)).cancelRequested !== undefined, "the cancellation intent");
		await poll(async () => (await transcript(harness, root.id)).includes("cancel pending"), "the cancel to report pending");
		const whilePending = await ledgerOf(harness, root.id);
		expect(whilePending.status).not.toBe("cancelled");
		expect(roundSubmissions(1)).toBe(0);

		// Release: the round is already admitted, so it proceeds to submit; the
		// cancel's abort stops it. The cancel itself must not have closed the task
		// while the right was held.
		gate.resolve();
		await (await turn).wait(context);
		await harness.waitForIdle(context);
		const beforeClose = roundSubmissions(1);
		expect(beforeClose).toBeLessThanOrEqual(1);

		// Retry the cancel: it closes only now, and nothing new starts after that.
		await (await root.submit({ type: "input", content: `CLOSE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id);
		expect(after.status).toBe("cancelled");
		expect(roundSubmissions(1)).toBe(beforeClose);
		const childId = after.childConversationId;
		if (childId !== undefined) {
			const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 200), context);
			expect(tasks.items.filter((task) => task.state.status !== "terminal")).toEqual([]);
		}
	}, 60000);

	it("refuses new work while a cancellation is pending, changing nothing (AC-05/06)", async () => {
		parkRound = 1;
		const { harness, root } = await open();

		// Park the round (pre-gate), start the cancellation while it is parked, then
		// release it: it refuses at the gate, so the task stays non-terminal with the
		// intent recorded and no cancellation running any more.
		const turn = root.submit({ type: "input", content: `DELEGATE-AND-CANCEL ${MAIN_SENTINEL}` }, context);
		await entered.promise;
		cancelGate.resolve();
		await poll(async () => (await ledgerOf(harness, root.id)).cancelRequested !== undefined, "the cancellation intent");
		await poll(async () => (await transcript(harness, root.id)).includes("cancel pending"), "the cancel to report pending");
		gate.resolve();
		await (await turn).wait(context);
		await harness.waitForIdle(context);
		const before = await ledgerOf(harness, root.id);
		expect(before.status).not.toBe("cancelled");
		expect(before.cancelRequested).toBeDefined();

		// A new revision must be refused before it claims anything.
		await (await root.submit({ type: "input", content: `REVISE-AGAIN ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		const after = await ledgerOf(harness, root.id);
		expect(after.rounds).toHaveLength(before.rounds.length);
		expect(after.operations).toHaveLength(before.operations.length);
		expect(after.currentRound).toBe(before.currentRound);
		expect(after.version).toBe(before.version);
		expect(after.activeOpKey).toBeUndefined();
		expect(await transcript(harness, root.id)).toContain("accepts no new work");

		// Clean up: the retried cancel closes the task.
		await (await root.submit({ type: "input", content: `CLOSE ${MAIN_SENTINEL}` }, context)).wait(context);
		await harness.waitForIdle(context);
		expect((await ledgerOf(harness, root.id)).status).toBe("cancelled");
	}, 60000);
});
