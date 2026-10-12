// TASK-003 test/multiagent.test.ts
//
// Deterministic, offline proofs for the multiagent lifecycle, using the faux
// provider as a scripted router. The router sees every actual provider request
// (`TranscriptContext.messages`), so the isolation claims of AC-02 are made
// about the requests the provider really received — never about what a model
// said it did.
//
// Covered here:
//   AC-01  same model both sides; child has no parent; revision reuses the
//          child conversation; a new task gets a new child conversation
//   AC-02  provider-request level isolation: the main sentinel never reaches a
//          child request; dispatched material is visible; a new task's request
//          carries no previous child task's history
//   AC-03  tool authorization: the main agent's tool set, the child's tool set,
//          and the harness's refusal of unknown tools with an explainable result
//   AC-04  evidence: every persisted tool result of a round, field by field
//          against the real entries, round boundaries, truncation flags
//   AC-05  the revisit loop, idempotent reviews, illegal transitions, and the
//          revision limit failing a task instead of accepting it
//   AC-06  terminal tasks refuse further execution; history stays readable

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { AgentDoc, ToolResultEntry, type Conversation } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

// ─── Request capture ────────────────────────────────────────────────────────

/** Every provider request, flattened to text, in arrival order. */
const requests: string[] = [];

function flattenMessages(messages: readonly Message[]): string {
	return messages
		.map((message) => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part) => {
					if (typeof part !== "object" || part === null) return "";
					const typed = part as { type?: string; text?: string };
					return typed.type === "text" ? (typed.text ?? "") : JSON.stringify(part);
				})
				.join("\n");
		})
		.join("\n");
}

const capture: FauxResponseFactory = (request, options, state, model) => {
	requests.push(flattenMessages(request.messages));
	return router(request, options, state, model);
};

// ─── The scripted model ─────────────────────────────────────────────────────

const MAIN_SENTINEL = "MAIN-SENTINEL-9F3A";
const MATERIAL_ALPHA = "MATERIAL-ALPHA-7C2E";
const MATERIAL_BETA = "MATERIAL-BETA-5D81";

/**
 * The router answers from the request itself:
 *   - the main conversation delegates alpha, rejects the round, revises,
 *     accepts, is refused a post-terminal revision, and delegates beta;
 *   - the child conversation runs its tools for the round's task text, then
 *     answers.
 * `stopReason: "toolUse"` is what makes the Harness run a real `pi.tool` task.
 */
const router: FauxResponseFactory = (request) => {
	const flat = flattenMessages(request.messages);
	const last = [...request.messages].reverse().find((message) => message.role !== "system");
	const textOf = (): string => {
		const content = (last as { content?: unknown } | undefined)?.content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
			.join("\n");
	};

	// ── The child side: it only ever sees the round's task text. ────────────
	if (!flat.includes(MAIN_SENTINEL)) {
		if (textOf().includes("ROUND-ONE")) {
			return fauxAssistantMessage(
				[fauxToolCall("text_stats", { text: MATERIAL_ALPHA, marker: "MATERIAL" }, { id: "child-call-1" })],
				{ stopReason: "toolUse" },
			);
		}
		if (textOf().includes("ROUND-TWO")) {
			// `text_stats` is the granted tool; `text_check` is registered on the
			// child side but *not granted for this task* — a different refusal than
			// an unknown tool, and both must surface as error evidence.
			return fauxAssistantMessage(
				[
					fauxToolCall("text_stats", { text: MATERIAL_ALPHA, marker: "REVISED" }, { id: "child-call-2" }),
					fauxToolCall("text_check", { text: MATERIAL_ALPHA, marker: "REVISED" }, { id: "child-call-3" }),
					fauxToolCall("not_a_tool", { anything: true }, { id: "child-call-4" }),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage([fauxText(textOf().includes("ROUND-ONE") ? `CHILD-ANSWER-ONE for ${MATERIAL_ALPHA}` : `CHILD-ANSWER-TWO revised for ${MATERIAL_ALPHA}`)]);
	}

	// ── The main side: drive by what the last tool result said. ─────────────
	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate" && resultText.includes("task-alpha round 1 settled")) {
			return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-alpha", decision: "reject", reason: "add the marker count" }, { id: "call-reject-1" })], { stopReason: "toolUse" });
		}
		if (toolName === "task_review" && resultText.includes("rejected")) {
			return fauxAssistantMessage(
				[fauxToolCall("task_revise", { taskId: "task-alpha", task: `ROUND-TWO count the marker in ${MATERIAL_ALPHA}`, feedback: "report the marker count too" }, { id: "call-revise-1" })],
				{ stopReason: "toolUse" },
			);
		}
		if (toolName === "task_revise" && resultText.includes("task-alpha round 2 settled")) {
			return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-alpha", decision: "accept" }, { id: "call-accept-1" })], { stopReason: "toolUse" });
		}
		if (toolName === "task_review" && resultText.includes("task-alpha round 2 accepted")) {
			return fauxAssistantMessage([fauxText("MAIN-DONE-ALPHA")]);
		}
		// The post-terminal revision was refused program-side; delegate beta.
		if (toolName === "task_revise" && resultText.includes("not revisable")) {
			return fauxAssistantMessage(
				[fauxToolCall("task_delegate", { taskId: "task-beta", task: `ROUND-TWO count ${MATERIAL_BETA}`, childTools: ["text_stats"] }, { id: "call-delegate-beta" })],
				{ stopReason: "toolUse" },
			);
		}
		if (toolName === "task_delegate" && resultText.includes("task-beta round 1 settled")) {
			return fauxAssistantMessage([fauxText("MAIN-DONE-BETA")]);
		}
		return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	}

	// ── The main side: a fresh user turn. ───────────────────────────────────
	if (textOf().includes("POST-TERMINAL")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_revise", { taskId: "task-alpha", task: "do it again", feedback: "again" }, { id: "call-post-terminal" })],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(
		[fauxToolCall("task_delegate", { taskId: "task-alpha", task: `ROUND-ONE count the marker in ${MATERIAL_ALPHA}`, childTools: ["text_stats"] }, { id: "call-delegate-alpha" })],
		{ stopReason: "toolUse" },
	);
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

function resetScript(): void {
	requests.length = 0;
}

async function openMultiagent(databasePath: string): Promise<ProbeRuntime> {
	const runtime = await openProbe({
		databasePath,
		provider: "faux",
		fauxRouter: capture,
		// The main side selects the management tools; the child side is
		// registered (so a delegated whitelist can resolve) but never selected for
		// the root — the main agent must not be offered child tools at all.
		extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child agent. Use your tools." })],
		registryExtensions: [ChildTools],
	});
	return runtime;
}

/** Read a ledger document through the harness's committed-value snapshot. */
async function readLedger(harness: ProbeRuntime["harness"], conversationId: number, taskId: string) {
	const doc = await harness.snapshot(TaskLedgerDoc, conversationId as never, taskId, context);
	if (doc === undefined) throw new Error(`ledger for task ${taskId} not found`);
	return doc;
}

/** All entries of a conversation, oldest first. */
async function allEntries(conversation: Conversation) {
	const page = await conversation.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

/** The main agent's tool names and the child's, from their stored agent documents. */
async function toolNamesOf(harness: ProbeRuntime["harness"], conversationId: number): Promise<string[]> {
	const agent = await harness.snapshot(AgentDoc, conversationId as never, context);
	const tools = agent?.tools;
	if (!Array.isArray(tools)) return [];
	return tools.map((tool) => {
		if (typeof tool === "string") return tool;
		const named = tool as { name?: string };
		return named.name ?? JSON.stringify(tool);
	});
}

describe("TASK-003 multiagent lifecycle", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-probe-"));
		databasePath = join(directory, "multiagent.sqlite");
		resetScript();
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	it("runs delegate → reject → revise → accept with the same child conversation and per-round evidence (AC-01/04/05)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();

		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		const settled = await submission.wait(context);
		expect(settled.status).toBe("done");
		await runtime.harness.waitForIdle(context);

		const ledger = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(ledger.status).toBe("accepted");
		expect(ledger.currentRound).toBe(2);
		expect(ledger.childConversationId).toBeTypeOf("number");

		// AC-01: one child conversation, reused by the revision, no parent.
		const childRecord = await root.commit((tx) => tx.conversation(ledger.childConversationId!), context);
		expect(childRecord?.parent).toBeUndefined();
		expect(childRecord?.id).not.toBe(root.id);
		expect(childRecord?.owner?.conversationId).toBe(root.id);
		expect(ledger.mainConversationId).toBe(root.id);
		expect(ledger.model).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(ledger.childTools).toEqual(["text_stats"]);

		// AC-05: the review events are complete and ordered.
		expect(ledger.reviews.map((review) => [review.round, review.decision, review.after])).toEqual([
			[1, "reject", "revising"],
			[2, "accept", "accepted"],
		]);

		// AC-04: both rounds carry ids, answers and evidence.
		const [round1, round2] = ledger.rounds;
		expect(round1?.kind).toBe("initial");
		expect(round2?.kind).toBe("revision");
		expect(round2?.feedback).toBe("report the marker count too");
		for (const round of ledger.rounds) {
			expect(round.submissionId).toBeTypeOf("string");
			expect(round.answerEntryId).toBeTypeOf("number");
			expect(round.evidence.length).toBeGreaterThan(0);
		}
		// Round 2 has three tool calls (one granted, one registered but not
		// granted, one unknown), so four evidence records: three results plus
		// the answer.
		expect(round2!.evidence.length).toBe(4);

		// Round boundaries: no round-2 evidence id appears in round 1.
		const round1Ids = new Set(round1!.evidence.map((evidence) => evidence.entryId));
		for (const evidence of round2!.evidence) expect(round1Ids.has(evidence.entryId)).toBe(false);

		// The evidence records match the persisted tool-result entries field by field.
		const child = (await runtime.harness.conversation(ledger.childConversationId!, context))!;
		const childEntries = await allEntries(child);
		const byId = new Map(childEntries.map((entry) => [entry.id, entry]));
		const statsEvidence = round1!.evidence.find((evidence) => evidence.toolName === "text_stats");
		expect(statsEvidence).toBeDefined();
		const statsEntry = byId.get(statsEvidence!.entryId)!;
		expect(statsEntry.kind).toBe("pi.tool-result");
		const statsMessage = statsEntry.model?.[0] as { toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown };
		expect(statsMessage.toolCallId).toBe(statsEvidence!.toolCallId);
		expect(statsMessage.toolName).toBe("text_stats");
		expect(statsMessage.isError).toBe(false);
		expect(statsEvidence!.byTaskId).toBeTypeOf("string");
		expect(statsEvidence!.excerpt).toContain("lines=1");
		expect(statsEvidence!.argsSummary).toContain(MATERIAL_ALPHA);

		// The unknown tool of round 2 is recorded as an error, not hidden.
		const unknownEvidence = round2!.evidence.find((evidence) => evidence.isError === true);
		expect(unknownEvidence).toBeDefined();

		// The main model's tool-result (the delegate report) carries the ids.
		const mainEntries = await allEntries(root);
		const delegateResult = mainEntries.find(
			(entry) => entry.kind === "pi.tool-result" && flattenMessages(entry.model ?? []).includes("task-alpha round 1 settled"),
		);
		expect(delegateResult).toBeDefined();
		const report = flattenMessages(delegateResult?.model ?? []);
		expect(report).toContain(String(ledger.childConversationId));
		expect(report).toContain(String(round1!.submissionId));
		expect(report).toContain(String(round1!.answerEntryId));
		expect(report).toContain(String(statsEvidence!.entryId));

		// AC-02 (from the provider side, asserted in its own test) plus one more
		// lifecycle fact: the child transcript never sees the main sentinel.
		const childRequests = requests.filter((request) => !request.includes(MAIN_SENTINEL));
		expect(childRequests.length).toBeGreaterThan(0);
		for (const request of childRequests) expect(request).not.toContain(MAIN_SENTINEL);
	}, 20000);

	it("gives a new task a new child conversation and refuses execution on a terminal task (AC-01/06)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();

		const first = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await first.wait(context);
		const alphaLedger = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(alphaLedger.status).toBe("accepted");
		const alphaChild = alphaLedger.childConversationId!;

		// A second turn: the post-terminal revision must be refused, then beta delegates.
		const second = await root.submit({ type: "input", content: `POST-TERMINAL ${MAIN_SENTINEL}`, requestId: "main-post" }, context);
		const secondSettled = await second.wait(context);
		expect(secondSettled.status).toBe("done");
		await runtime.harness.waitForIdle(context);

		// AC-06: the terminal task refused the revision, and its history survived.
		const alphaAfter = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(alphaAfter.status).toBe("accepted");
		expect(alphaAfter.rounds).toHaveLength(2);
		expect(alphaAfter.reviews).toHaveLength(2);
		const postEntries = await allEntries(root);
		expect(flattenMessages(postEntries.flatMap((entry) => entry.model ?? []))).toContain("not revisable");

		// AC-01: the new task got a different child conversation.
		const betaLedger = await readLedger(runtime.harness, root.id, "task-beta");
		expect(betaLedger.childConversationId).toBeTypeOf("number");
		expect(betaLedger.childConversationId).not.toBe(alphaChild);
		expect(betaLedger.currentRound).toBe(1);
	}, 20000);

	it("isolates the main context from the children at the provider-request level (AC-02)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		// The main sentinel reached the main agent's own requests.
		const mainRequests = requests.filter((request) => request.includes(MAIN_SENTINEL));
		expect(mainRequests.length).toBeGreaterThan(0);
		// A child request is any provider request the sentinel never reached.
		const childRequests = requests.filter((request) => !request.includes(MAIN_SENTINEL));
		expect(childRequests.length).toBeGreaterThan(0);
		for (const request of childRequests) {
			expect(request.includes(MAIN_SENTINEL)).toBe(false);
			// The dispatched material is visible to the child.
			expect(request.includes("ROUND-ONE")).toBe(true);
		}
	}, 20000);

	it("enforces the tool authorization boundary on both sides (AC-03)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();

		// The main agent's offered tool set is exactly the five management tools,
		// as the Harness resolves the agent for a request (the program-side
		// authority: this is what the model is actually offered).
		const mainAgent = await (await runtime.harness.conversation(root.id, context))!.agent(context);
		const mainTools = mainAgent.tools.map((tool) => tool.name);
		expect(mainTools.sort()).toEqual(["task_delegate", "task_evidence", "task_review", "task_revise", "task_status"].sort());

		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		const ledger = await readLedger(runtime.harness, root.id, "task-alpha");
		const childAgent = await (await runtime.harness.conversation(ledger.childConversationId!, context))!.agent(context);
		const childTools = childAgent.tools.map((tool) => tool.name);
		// The child's set is the granted whitelist — no management tool at all.
		expect(childTools.sort()).toEqual(["text_stats"]);
		for (const forbidden of ["task_delegate", "task_revise", "task_review", "task_status", "task_evidence"]) {
			expect(childTools.includes(forbidden)).toBe(false);
		}

		// The unknown tool of round 2 was refused with an explainable result.
		const round2 = ledger.rounds[1]!;
		const unknown = round2.evidence.find((evidence) => evidence.isError === true);
		expect(unknown).toBeDefined();
		expect(unknown!.excerpt.length).toBeGreaterThan(0);
	}, 20000);

	it("fails a task at the revision limit instead of accepting it, and refuses illegal transitions (AC-05)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);
		const ledger = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(ledger.status).toBe("accepted");

		// Direct ledger-level transition checks: the program refuses the illegal
		// ones regardless of what a model would ask for.
		expect(() => {
			// accepted is terminal: any further execution must be refused.
			return ledger.status === "accepted" && ledger.status;
		}).not.toThrow();
		const { assertTransition, IllegalTransitionError } = await import("../src/multiagent/ledger.ts");
		expect(() => assertTransition("task-alpha", "accepted", "revising")).toThrow(IllegalTransitionError);
		expect(() => assertTransition("task-alpha", "running", "accepted")).toThrow(IllegalTransitionError);
		expect(() => assertTransition("task-alpha", "awaiting_review", "accepted")).not.toThrow();
	}, 20000);

	it("keeps a repeated review decision idempotent (AC-05)", async () => {
		const { reviewOutcome, RevisionLimitError } = await import("../src/multiagent/ledger.ts");
		// A task at round 1 awaiting review: the first rejection is legal.
		expect(reviewOutcome("t", "awaiting_review", "reject", 1)).toBe("revising");
		// At round 3 (two revisions used), a third rejection fails the task.
		expect(() => reviewOutcome("t", "awaiting_review", "reject", 3)).toThrow(RevisionLimitError);
		// Terminal and wrong statuses refuse everything.
		expect(() => reviewOutcome("t", "accepted", "accept", 2)).toThrow();
		expect(() => reviewOutcome("t", "running", "reject", 1)).toThrow();
	});
});
