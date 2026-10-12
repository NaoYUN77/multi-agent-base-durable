// TASK-003 test/multiagent.test.ts
//
// Deterministic, offline proofs for the multiagent lifecycle, using the faux
// provider as a scripted router. The router sees every actual provider request
// (`TranscriptContext.messages`), so the isolation claims of AC-02 are made
// about the requests the provider really received — never about what a model
// said it did.
//
// Request identity (AC-02) is established by *independent* evidence, not by the
// property under test: the child conversation carries the child instructions
// from `createMultiagentExtension`'s `childInstructions`, so a request whose
// system prompt contains that marker is a child request. The assertion "a child
// request contains no main sentinel" is then a real claim, not a tautology.
//
// Covered here:
//   AC-01  same model both sides; child has no parent; revision reuses the
//          child conversation; a new task gets a new child conversation
//   AC-02  provider-request level isolation, classified by instruction marker
//   AC-03  tool authorization: main tool set, child tool set, refusals
//   AC-04  evidence: every persisted tool result of a round, field by field, as
//          the main model actually receives it; round boundaries; truncation;
//          pagination beyond one scan page; empty-answer failure
//   AC-05  the revision loop, idempotent reviews, stale-review refusal, the
//          revision limit, duplicate-delegate refusal
//   AC-06  terminal tasks refuse further execution; history stays readable

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import { createMultiagentExtension, MANAGEMENT_TOOL_NAMES } from "../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

// ─── Request capture ────────────────────────────────────────────────────────

/** Every provider request, flattened to text, in arrival order. */
const requests: string[] = [];

function flattenMessages(messages: readonly Message[]): string {
	return messages
		.map((message) => {
			const typed = message as { content?: unknown; sections?: Record<string, string | null> };
			// Prompt text lives in `sections` (rendered by the provider), not in
			// `content`; both must be read for request-level assertions.
			const sectionText = Object.values(typed.sections ?? {})
				.filter((value): value is string => typeof value === "string")
				.join("\n");
			const content = typed.content;
			if (typeof content === "string") return `${content}\n${sectionText}`;
			if (!Array.isArray(content)) return sectionText;
			const parts = content
				.map((part) => {
					if (typeof part !== "object" || part === null) return "";
					const partTyped = part as { type?: string; text?: string };
					return partTyped.type === "text" ? (partTyped.text ?? "") : JSON.stringify(part);
				})
				.join("\n");
			return `${parts}\n${sectionText}`;
		})
		.join("\n");
}

const MAIN_SENTINEL = "MAIN-SENTINEL-9F3A";
const MATERIAL_ALPHA = "MATERIAL-ALPHA-7C2E";
const MATERIAL_BETA = "MATERIAL-BETA-5D81";
/** Identity marker of the child conversation, carried in its instructions. */
const CHILD_MARKER = "SUBAGENT-INSTRUCTION-MARKER-7C3F";
const CHILD_INSTRUCTIONS = `You are the child agent. ${CHILD_MARKER}`;

const capture: FauxResponseFactory = (request, options, state, model) => {
	requests.push(flattenMessages(request.messages));
	return router(request, options, state, model);
};

/**
 * The router answers from the request itself:
 *   - the main conversation delegates alpha, rejects, revises, accepts,
 *     refuses a post-terminal revision, then delegates beta;
 *   - the child conversation runs its tools for the round's task text, then
 *     answers with text derived from that task (no cross-task leakage).
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
		const material = textOf().includes(MATERIAL_BETA) ? MATERIAL_BETA : MATERIAL_ALPHA;
		if (last?.role !== "toolResult") {
			const calls = [fauxToolCall("text_stats", { text: material, marker: "MATERIAL" }, { id: "child-call-1" })];
			// Round 2 exercises the authorization boundary: one granted tool, one
			// registered-but-not-granted tool, and one unknown tool.
			if (textOf().includes("ROUND-TWO")) {
				calls.push(fauxToolCall("text_check", { text: material, marker: "MATERIAL" }, { id: "child-call-2" }));
				calls.push(fauxToolCall("not_a_tool", { anything: true }, { id: "child-call-3" }));
			}
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText(`CHILD-ANSWER for ${material}`)]);
	}

	// ── The main side: drive by what the last tool result said. ─────────────
	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate" && resultText.includes("task-alpha round 1 settled")) {
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"task_review",
						{ taskId: "task-alpha", decision: "reject", reason: "add the marker count", round: 1 },
						{ id: "call-reject-1" },
					),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (toolName === "task_review" && resultText.includes("rejected")) {
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"task_revise",
						{ taskId: "task-alpha", task: `ROUND-TWO count the marker in ${MATERIAL_ALPHA}`, feedback: "report the marker count too" },
						{ id: "call-revise-1" },
					),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (toolName === "task_revise" && resultText.includes("task-alpha round 2 settled")) {
			return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-alpha", decision: "accept", round: 2 }, { id: "call-accept-1" })], {
				stopReason: "toolUse",
			});
		}
		if (toolName === "task_review" && resultText.includes("task-alpha round 2 accepted")) {
			return fauxAssistantMessage([fauxText("MAIN-DONE-ALPHA")]);
		}
		// The post-terminal revision was refused program-side; delegate beta.
		if (toolName === "task_revise" && resultText.includes("accepts nothing further")) {
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"task_delegate",
						{ taskId: "task-beta", task: `count ${MATERIAL_BETA}`, childTools: ["text_stats"] },
						{ id: "call-delegate-beta" },
					),
				],
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
	if (textOf().includes("DELEGATE-AGAIN")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_delegate", { taskId: "task-alpha", task: "delegate it again", childTools: ["text_stats"] }, { id: "call-dup" })],
			{ stopReason: "toolUse" },
		);
	}
	if (textOf().includes("STALE-REVIEW")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_review", { taskId: "task-alpha", decision: "accept", round: 1 }, { id: "call-stale" })],
			{ stopReason: "toolUse" },
		);
	}
	if (textOf().includes("CANCEL-ALPHA")) {
		return fauxAssistantMessage([fauxToolCall("task_cancel", { taskId: "task-alpha", reason: "not needed" }, { id: "call-cancel" })], {
			stopReason: "toolUse",
		});
	}
	return fauxAssistantMessage(
		[
			fauxToolCall(
				"task_delegate",
				{ taskId: "task-alpha", task: `ROUND-ONE count the marker in ${MATERIAL_ALPHA}`, childTools: ["text_stats"] },
				{ id: "call-delegate-alpha" },
			),
		],
		{ stopReason: "toolUse" },
	);
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

function resetScript(): void {
	requests.length = 0;
}

async function openMultiagent(databasePath: string): Promise<ProbeRuntime> {
	return openProbe({
		databasePath,
		provider: "faux",
		fauxRouter: capture,
		extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: CHILD_INSTRUCTIONS })],
		registryExtensions: [ChildTools],
	});
}

async function readLedger(harness: ProbeRuntime["harness"], conversationId: number, taskId: string) {
	const doc = await harness.snapshot(TaskLedgerDoc, conversationId as never, taskId, context);
	if (doc === undefined) throw new Error(`ledger for task ${taskId} not found`);
	return doc;
}

async function allEntries(conversation: Conversation) {
	const page = await conversation.entries({ order: "ascending" }, 1000, undefined, context);
	return [...page.items];
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

	it("runs delegate → reject → revise → accept with one child conversation and per-round evidence (AC-01/04/05)", async () => {
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
		expect(ledger.createdAt).toBeGreaterThan(0);
		expect(ledger.version).toBeGreaterThan(0);

		// AC-05: review events are complete and ordered, each with its op key.
		expect(ledger.reviews.map((review) => [review.round, review.decision, review.after])).toEqual([
			[1, "reject", "revising"],
			[2, "accept", "accepted"],
		]);
		for (const review of ledger.reviews) expect(review.opKey).toMatch(/^review:\d+:/);

		// The transition log is explicit, not inferred from document revisions.
		expect(ledger.events.map((event) => `${event.from}->${event.to}`)).toEqual([
			"running->awaiting_review",
			"awaiting_review->revising",
			"revising->awaiting_review",
			"awaiting_review->accepted",
		]);
		// One binding per operation: delegate, review(reject), revise, review(accept).
		expect(ledger.operations.map((binding) => binding.kind)).toEqual(["delegate", "review", "revise", "review"]);
		for (const binding of ledger.operations) {
			expect(binding.toolTaskId).not.toBe("");
			expect(binding.callId).not.toBe("");
		}

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
		const statsMessage = statsEntry.model?.[0] as { toolCallId?: string; toolName?: string; isError?: boolean };
		expect(statsMessage.toolCallId).toBe(statsEvidence!.toolCallId);
		expect(statsMessage.toolName).toBe("text_stats");
		expect(statsEvidence!.isError).toBe(false);
		expect(statsEvidence!.byTaskId).toBeTypeOf("string");
		expect(statsEvidence!.excerpt).toContain("lines=1");
		// The argument summary is a defined summary: a JSON string value is shown
		// quoted (short values) or as a length placeholder (long ones).
		expect(statsEvidence!.argsSummary).toContain(MATERIAL_ALPHA);
		expect(statsEvidence!.argsSummary).toMatch(/^\{/);

		// The unknown tool of round 2 is recorded as an error with an excerpt.
		const unknownEvidence = round2!.evidence.find((evidence) => evidence.isError === true);
		expect(unknownEvidence).toBeDefined();
		expect(unknownEvidence!.excerpt.length).toBeGreaterThan(0);

		// AC-04: the *main model* actually received the full field set. The
		// captured main request that carries the delegation report must show the
		// tool call id, the by-task attribution, an explicit error=false, and the
		// entry id — a database field is not evidence that the model saw it.
		const reportRequest = requests.find((request) => request.includes("task-alpha round 1 settled") && request.includes(MAIN_SENTINEL));
		expect(reportRequest).toBeDefined();
		expect(reportRequest).toContain(`entry=${statsEvidence!.entryId}`);
		expect(reportRequest).toContain(`byTask=${statsEvidence!.byTaskId}`);
		expect(reportRequest).toContain(`call=${statsEvidence!.toolCallId}`);
		expect(reportRequest).toContain("error=false");
		expect(reportRequest).toContain("kind=pi.tool-result");

		// No harness contract violations were reported (structuredOutput schemas
		// match; nothing was stripped).
		expect(runtime.reports).toEqual([]);
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
		expect(flattenMessages(postEntries.flatMap((entry) => entry.model ?? []))).toContain("accepts nothing further");

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

		const first = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await first.wait(context);
		await runtime.harness.waitForIdle(context);
		const second = await root.submit({ type: "input", content: `POST-TERMINAL ${MAIN_SENTINEL}`, requestId: "main-post" }, context);
		await second.wait(context);
		await runtime.harness.waitForIdle(context);

		// Identity, not absence: a request is a child request because it carries
		// the child instructions; the claim is that such a request never contains
		// the main sentinel.
		const childRequests = requests.filter((request) => request.includes(CHILD_MARKER));
		expect(childRequests.length).toBeGreaterThan(0);
		for (const request of childRequests) expect(request.includes(MAIN_SENTINEL)).toBe(false);

		// Alpha's child requests carry alpha's material and nothing of beta.
		const alphaChildRequests = childRequests.filter((request) => request.includes(MATERIAL_ALPHA));
		expect(alphaChildRequests.length).toBeGreaterThan(0);
		for (const request of alphaChildRequests) expect(request.includes(MATERIAL_BETA)).toBe(false);

		// A new task's *child* gets a fresh context: beta's child requests carry
		// beta's material and none of alpha's child history. (The main
		// conversation legitimately keeps its own transcript, so this claim is
		// about the child side, where the isolation is required.)
		const betaChildRequests = childRequests.filter((request) => request.includes(MATERIAL_BETA));
		expect(betaChildRequests.length).toBeGreaterThan(0);
		for (const request of betaChildRequests) {
			expect(request.includes(MATERIAL_ALPHA)).toBe(false);
			expect(request.includes("CHILD-ANSWER for")).toBe(false);
		}
	}, 20000);

	it("enforces the tool authorization boundary on both sides (AC-03)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();

		// The main agent's offered tool set is exactly the management tools.
		const mainAgent = await (await runtime.harness.conversation(root.id, context))!.agent(context);
		expect(mainAgent.tools.map((tool) => tool.name).sort()).toEqual([...MANAGEMENT_TOOL_NAMES].sort());

		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		const ledger = await readLedger(runtime.harness, root.id, "task-alpha");
		const childAgent = await (await runtime.harness.conversation(ledger.childConversationId!, context))!.agent(context);
		const childTools = childAgent.tools.map((tool) => tool.name);
		// The child's set is the granted whitelist — no management tool at all.
		expect(childTools.sort()).toEqual(["text_stats"]);
		for (const forbidden of MANAGEMENT_TOOL_NAMES) expect(childTools.includes(forbidden)).toBe(false);

		// The unknown tool of round 2 was refused with an explainable result.
		const round2 = ledger.rounds[1]!;
		const unknown = round2.evidence.find((evidence) => evidence.isError === true);
		expect(unknown).toBeDefined();
		expect(unknown!.excerpt.length).toBeGreaterThan(0);
	}, 20000);

	it("refuses a second delegate for an existing task and keeps the original (AC-05)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		const before = await readLedger(runtime.harness, root.id, "task-alpha");
		const dup = await root.submit({ type: "input", content: `DELEGATE-AGAIN ${MAIN_SENTINEL}`, requestId: "main-dup" }, context);
		await dup.wait(context);
		await runtime.harness.waitForIdle(context);

		const after = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(after.rounds).toHaveLength(before.rounds.length);
		expect(after.reviews).toHaveLength(before.reviews.length);
		expect(after.operations).toHaveLength(before.operations.length);
		const entries = await allEntries(root);
		// The terminal check runs first: an accepted task refuses a new delegate
		// before the duplicate check is even reached. Both are program-side.
		expect(/already delegated|accepts nothing further/.test(flattenMessages(entries.flatMap((entry) => entry.model ?? [])))).toBe(true);
	}, 20000);

	it("refuses a stale review and keeps the ledger unchanged (AC-05)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		// The script already accepted round 2; a stale review aimed at round 1
		// must be refused program-side and add nothing.
		const stale = await root.submit({ type: "input", content: `STALE-REVIEW ${MAIN_SENTINEL}`, requestId: "main-stale" }, context);
		await stale.wait(context);
		await runtime.harness.waitForIdle(context);

		const ledger = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(ledger.reviews).toHaveLength(2);
		expect(ledger.operations.filter((binding) => binding.kind === "review")).toHaveLength(2);
		expect(ledger.status).toBe("accepted");
		const entries = await allEntries(root);
		expect(/stale review|accepts nothing further|not awaiting_review/.test(flattenMessages(entries.flatMap((entry) => entry.model ?? [])))).toBe(
			true,
		);
	}, 20000);

	it("collects every tool result of a round across scan pages (AC-04)", async () => {
		// 151 tool calls in one round crosses the 100-entry scan page.
		const calls = Array.from({ length: 150 }, (_, index) => `PAGE-${index}`);
		const pageRouter: FauxResponseFactory = (request) => {
			requests.push(flattenMessages(request.messages));
			const flat = flattenMessages(request.messages);
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (!flat.includes(MAIN_SENTINEL)) {
				if (last?.role !== "toolResult") {
					return fauxAssistantMessage(
						[
							fauxToolCall("text_stats", { text: "line 1", marker: "line" }, { id: "page-call" }),
							...calls.map((marker, index) => fauxToolCall("text_check", { text: marker, marker: "PAGE" }, { id: `page-check-${index}` })),
						],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage([fauxText("PAGE-ROUND-ANSWER")]);
			}
			if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("MAIN-DONE")]);
			return fauxAssistantMessage(
				[
					fauxToolCall(
						"task_delegate",
						{ taskId: "task-pages", task: "run many tools", childTools: ["text_stats", "text_check"] },
						{ id: "page-delegate" },
					),
				],
				{ stopReason: "toolUse" },
			);
		};

		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: pageRouter,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: CHILD_INSTRUCTIONS })],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-PAGES ${MAIN_SENTINEL}`, requestId: "main-pages" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		const ledger = await readLedger(runtime.harness, root.id, "task-pages");
		const round = ledger.rounds[0]!;
		// 151 tool calls (1 stats + 150 checks) → 151 results + 1 answer.
		expect(round.evidence).toHaveLength(152);
		const toolEvidence = round.evidence.filter((evidence) => evidence.kind === "pi.tool-result");
		expect(toolEvidence).toHaveLength(151);
		const child = (await runtime.harness.conversation(ledger.childConversationId!, context))!;
		const childEntries = await allEntries(child);
		const ids = new Set(childEntries.map((entry) => entry.id));
		for (const evidence of round.evidence) expect(ids.has(evidence.entryId)).toBe(true);
		// The main model's report lists all of them, not a truncated subset.
		const report = requests.find((request) => request.includes("task-pages round 1 settled"));
		expect(report).toBeDefined();
		expect(report).toContain("152 record(s)");
	}, 40000);

	it("fails a round whose settled answer is empty (AC-04)", async () => {
		const emptyRouter: FauxResponseFactory = (request) => {
			const flat = flattenMessages(request.messages);
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (!flat.includes(MAIN_SENTINEL)) {
				if (last?.role !== "toolResult") {
					return fauxAssistantMessage([fauxToolCall("text_stats", { text: "x", marker: "x" }, { id: "empty-call" })], { stopReason: "toolUse" });
				}
				// Settle with no text at all.
				return fauxAssistantMessage([]);
			}
			if (last?.role === "toolResult") return fauxAssistantMessage([fauxText("MAIN-DONE")]);
			return fauxAssistantMessage(
				[fauxToolCall("task_delegate", { taskId: "task-empty", task: "say nothing", childTools: ["text_stats"] }, { id: "empty-delegate" })],
				{ stopReason: "toolUse" },
			);
		};
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: emptyRouter,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: CHILD_INSTRUCTIONS })],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-EMPTY ${MAIN_SENTINEL}`, requestId: "main-empty" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		const ledger = await readLedger(runtime.harness, root.id, "task-empty");
		expect(ledger.status).toBe("failed");
		expect(ledger.failure?.reason).toBe("empty_answer");
	}, 20000);

	it("refuses to cancel a terminal task and keeps its history readable (AC-06)", async () => {
		runtime = await openMultiagent(databasePath);
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const submission = await root.submit({ type: "input", content: `DELEGATE-ALPHA ${MAIN_SENTINEL}`, requestId: "main-alpha" }, context);
		await submission.wait(context);
		await runtime.harness.waitForIdle(context);

		const before = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(before.status).toBe("accepted");
		const childId = before.childConversationId!;

		const refused = await root.submit({ type: "input", content: `CANCEL-ALPHA ${MAIN_SENTINEL}`, requestId: "main-cancel" }, context);
		await refused.wait(context);
		await runtime.harness.waitForIdle(context);
		const after = await readLedger(runtime.harness, root.id, "task-alpha");
		expect(after.status).toBe("accepted");

		const entries = await allEntries(root);
		expect(flattenMessages(entries.flatMap((entry) => entry.model ?? []))).toContain("cannot be cancelled");

		// The child's tasks are all terminal; history is readable.
		const tasks = await root.commit((tx) => tx.scanTasks({ conversationId: childId }, 100), context);
		for (const task of tasks.items) expect(task.state.status).toBe("terminal");
		const child = (await runtime.harness.conversation(childId, context))!;
		expect((await allEntries(child)).length).toBeGreaterThan(0);
	}, 20000);

	it("keeps the ledger transition helper honest (AC-05)", async () => {
		const { assertTransition, reviewOutcome, RevisionLimitError } = await import("../src/multiagent/ledger.ts");
		expect(reviewOutcome("t", "awaiting_review", "reject", 1)).toBe("revising");
		expect(() => reviewOutcome("t", "awaiting_review", "reject", 3)).toThrow(RevisionLimitError);
		expect(() => reviewOutcome("t", "accepted", "accept", 2)).toThrow();
		expect(() => reviewOutcome("t", "running", "reject", 1)).toThrow();
		expect(() => assertTransition("t", "accepted", "revising")).toThrow();
		expect(() => assertTransition("t", "running", "accepted")).toThrow();
		expect(() => assertTransition("t", "awaiting_review", "accepted")).not.toThrow();
	});
});
