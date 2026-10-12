// TASK-003 test/multiagent-evidence.test.ts
//
// AC-04's retrieval half: a truncated excerpt must point at a way back to the
// full persisted text, and that way back must refuse ids that are not the
// round's evidence — including ids that exist, but in another conversation.

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

const MAIN_SENTINEL = "MAIN-SENTINEL-6C1F";
const LONG_ANSWER = `EVIDENCE-ANSWER-START ${"Y".repeat(6000)} EVIDENCE-ANSWER-END`;

/** Set by the test between turns: the entry id the main model should retrieve. */
let targetEntryId = 0;
/** An entry id from the main conversation: exists, but belongs elsewhere. */
let foreignEntryId = 0;
/** An entry of the child conversation that is not this round's evidence. */
let childNonEvidenceEntryId = 0;
/** Which bad-id probe of the QUERY-BAD turn runs next. */
let badPhase: "foreign" | "inside-not-evidence" | "missing" | "done" = "foreign";
/** Whether the current turn is the bad-id walk (only then do probes chain). */
let badTurnActive = false;
/** What the last evidence tool result said, for the routing below. */
let lastEvidenceText = "";
/** Every evidence tool result text, in order. */
const evidenceResults: string[] = [];

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
		if (textOf().includes("count it")) return fauxAssistantMessage([fauxToolCall("text_stats", { text: "a b c", marker: "b" }, { id: "e-call-1" })], { stopReason: "toolUse" });
		return fauxAssistantMessage([fauxText(LONG_ANSWER)]);
	}
	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		// The delegation round ends here; the queries are later user turns, once
		// the test has read the real answer entry id from the ledger.
		if (toolName === "task_delegate") return fauxAssistantMessage([fauxText("MAIN-DONE-ROUND1")]);
		if (toolName === "task_evidence") {
			lastEvidenceText = resultText;
			evidenceResults.push(resultText);
			// The QUERY-BAD turn walks its probes one per call, then finishes.
			const next = nextBadProbeCall();
			if (next !== undefined) return next;
			return fauxAssistantMessage([fauxText(resultText.includes("EVIDENCE-ANSWER-END") ? "MAIN-GOT-FULL" : "MAIN-GOT-REFUSALS")]);
		}
		return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	}
	const input = textOf();
	if (input.includes("QUERY-FULL")) {
		return fauxAssistantMessage([fauxToolCall("task_evidence", { taskId: "task-ev", entryId: targetEntryId }, { id: "call-e-full" })], { stopReason: "toolUse" });
	}
	if (input.includes("QUERY-BAD")) {
		badTurnActive = true;
		const next = nextBadProbeCall();
		if (next !== undefined) return next;
		return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	}
	badTurnActive = false;
	if (input.includes("QUERY-LIST")) {
		return fauxAssistantMessage([fauxToolCall("task_evidence", { taskId: "task-ev" }, { id: "call-e-list" })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage([fauxToolCall("task_delegate", { taskId: "task-ev", task: "count it", childTools: ["text_stats"] }, { id: "call-e-delegate" })], { stopReason: "toolUse" });
};


/** The next bad-id probe call of the QUERY-BAD turn, or undefined when done. */
function nextBadProbeCall(): ReturnType<typeof fauxAssistantMessage> | undefined {
	if (!badTurnActive || badPhase === "done") return undefined;
	if (badPhase === "foreign") {
		badPhase = "inside-not-evidence";
		return fauxAssistantMessage([fauxToolCall("task_evidence", { taskId: "task-ev", entryId: foreignEntryId }, { id: "call-e-foreign" })], { stopReason: "toolUse" });
	}
	if (badPhase === "inside-not-evidence") {
		badPhase = "missing";
		return fauxAssistantMessage([fauxToolCall("task_evidence", { taskId: "task-ev", entryId: childNonEvidenceEntryId }, { id: "call-e-inside" })], { stopReason: "toolUse" });
	}
	if (badPhase === "missing") {
		badPhase = "done";
		return fauxAssistantMessage([fauxToolCall("task_evidence", { taskId: "task-ev", entryId: 999424 }, { id: "call-e-bad" })], { stopReason: "toolUse" });
	}
	return undefined;
}

describe("TASK-003 evidence retrieval", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-evidence-"));
		databasePath = join(directory, "evidence.sqlite");
		lastEvidenceText = "";
		badPhase = "foreign";
		badTurnActive = false;
		evidenceResults.length = 0;
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	it("retrieves the full text behind a truncated excerpt and refuses foreign ids (AC-04)", async () => {
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: router,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child agent." })],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();

		// Round 1: delegate, and the child answers with the long text.
		const first = await root.submit({ type: "input", content: `DELEGATE-EV ${MAIN_SENTINEL}`, requestId: "main-ev-1" }, context);
		const firstSettled = await first.wait(context);
		expect(firstSettled.status).toBe("done");
		await runtime.harness.waitForIdle(context);

		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-ev", context);
		const answerEntryId = ledger!.rounds[0]!.answerEntryId!;
		targetEntryId = answerEntryId as number;

		const mainEntries = await root.entries({}, 1000, undefined, context);
		foreignEntryId = mainEntries.items[0]!.id;
		// The child's first (user) entry: inside the right conversation, but not
		// this round's evidence.
		const child = (await runtime.harness.conversation(ledger!.childConversationId!, context))!;
		// The child's oldest entry (its user input): inside the right
		// conversation, but not this round's evidence.
		const childEntries = await child.entries({ order: "ascending" }, 1000, undefined, context);
		childNonEvidenceEntryId = childEntries.items[0]!.id;
		expect(childEntries.items[0]!.kind).toBe("pi.user");
		expect(childNonEvidenceEntryId).not.toBe(answerEntryId);

		// Turn 2: the main model asks for the full text of the truncated answer.
		const second = await root.submit({ type: "input", content: `QUERY-FULL ${MAIN_SENTINEL}`, requestId: "main-ev-2" }, context);
		const secondSettled = await second.wait(context);
		expect(secondSettled.status).toBe("done");
		await runtime.harness.waitForIdle(context);
		// The retrieval carried the complete persisted text, not the excerpt.
		expect(lastEvidenceText).toContain("EVIDENCE-ANSWER-END");
		expect(lastEvidenceText.length).toBeGreaterThan(2000);

		// Turn 3: a nonexistent id is refused, then a foreign id is refused.
		const third = await root.submit({ type: "input", content: `QUERY-BAD ${MAIN_SENTINEL}`, requestId: "main-ev-3" }, context);
		const thirdSettled = await third.wait(context);
		expect(thirdSettled.status).toBe("done");
		await runtime.harness.waitForIdle(context);
		// Three distinct refusals in the turn, each naming why.
		const refusals = evidenceResults.filter((text) => /belongs to conversation|not evidence of task|not found/.test(text));
		expect(refusals).toHaveLength(3);
		expect(refusals[0]).toContain(`belongs to conversation ${root.id}`);
		expect(refusals[1]).toContain("not evidence of task task-ev round 1");
		expect(refusals[2]).toContain("not found");

		// Turn 4: without an entry id, the round's evidence is listed.
		const fourth = await root.submit({ type: "input", content: `QUERY-LIST ${MAIN_SENTINEL}`, requestId: "main-ev-4" }, context);
		const fourthSettled = await fourth.wait(context);
		expect(fourthSettled.status).toBe("done");
		await runtime.harness.waitForIdle(context);
		expect(lastEvidenceText).toContain("task-ev round 1 evidence");
		expect(lastEvidenceText).toContain("text_stats");
	}, 30000);
});
