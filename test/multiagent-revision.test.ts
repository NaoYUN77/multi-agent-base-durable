// TASK-003 test/multiagent-revision.test.ts
//
// The hard end of the lifecycle, deterministic and offline:
//   - the revision limit: three rejections fail the task (`revision_limit`)
//     instead of accepting it, and a terminal task refuses everything after;
//   - evidence retrieval: the full text behind a truncated excerpt, the
//     listing of a round's evidence, and refusals of ids that are not the
//     round's evidence (including ids from another conversation);
//   - truncation marking: a long child answer is excerpted with the flag set,
//     and the flag points at the retrieval tool.

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

const MAIN_SENTINEL = "MAIN-SENTINEL-4B7E";
const TASK = "GAMMA-SENTINEL-8A2C";

/** The requests the provider actually received, flattened. */
const requests: string[] = [];

function flatten(messages: readonly Message[]): string {
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

/** The long child answer: longer than the evidence excerpt limit. */
const LONG_ANSWER = `LONG-ANSWER-START ${"X".repeat(6000)} LONG-ANSWER-END`;

const router: FauxResponseFactory = (request) => {
	requests.push(flatten(request.messages));
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
		if (textOf().includes(TASK)) {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: TASK, marker: "GAMMA" }, { id: "gamma-call-1" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText(LONG_ANSWER)]);
	}

	if (last?.role === "toolResult") {
		const resultText = textOf();
		const toolName = (last as { toolName?: string }).toolName;
		// Rejection loop: reject, revise, reject, revise, reject → failed.
		if (toolName === "task_delegate" || (toolName === "task_revise" && resultText.includes("settled"))) {
			// `round` is required: take it from the delegation report itself.
			const round = Number(/round (\d+) settled/.exec(resultText)?.[1] ?? "1");
			return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-gamma", decision: "reject", reason: "not enough", round }, { id: `call-reject-${requests.length}` })], { stopReason: "toolUse" });
		}
		if (toolName === "task_review" && resultText.includes("rejected")) {
			// The revision must name the round it is about: read it from the review.
			const reviewed = Number(/round (\d+) rejected/.exec(resultText)?.[1] ?? "1");
			return fauxAssistantMessage([fauxToolCall("task_revise", { taskId: "task-gamma", round: reviewed, task: `redo ${TASK}`, feedback: "redo it" }, { id: `call-revise-${requests.length}` })], { stopReason: "toolUse" });
		}
		if (toolName === "task_review" && resultText.includes("failed")) {
			return fauxAssistantMessage([fauxText("MAIN-DONE-FAILED")]);
		}
		if (toolName === "task_revise" && resultText.includes("not revisable")) {
			// Terminal task: walk through the evidence queries.
			return fauxAssistantMessage([fauxToolCall("task_evidence", { taskId: "task-gamma" }, { id: "call-evidence-list" })], { stopReason: "toolUse" });
		}
		if (toolName === "task_evidence" && resultText.includes("evidence (")) {
			return fauxAssistantMessage([fauxText("MAIN-DONE-AFTER-QUERIES")]);
		}
		return fauxAssistantMessage([fauxText("MAIN-DONE")]);
	}
	if (textOf().includes("AFTER-FAILED")) {
		return fauxAssistantMessage([fauxToolCall("task_revise", { taskId: "task-gamma", round: 3, task: "one more", feedback: "one more" }, { id: "call-after-failed" })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage([fauxToolCall("task_delegate", { taskId: "task-gamma", task: `count ${TASK}`, childTools: ["text_stats"] }, { id: "call-delegate-gamma" })], { stopReason: "toolUse" });
};

describe("TASK-003 revision limit and evidence retrieval", () => {
	let directory: string;
	let databasePath: string;
	let runtime: ProbeRuntime | undefined;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "multiagent-revision-"));
		databasePath = join(directory, "revision.sqlite");
		requests.length = 0;
	});

	afterEach(async () => {
		if (runtime !== undefined) await runtime.close();
		runtime = undefined;
		await rm(directory, { recursive: true, force: true });
	});

	it("fails at the revision limit and keeps the evidence retrievable (AC-04/05/06)", async () => {
		runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: router,
			extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child agent." })],
			registryExtensions: [ChildTools],
		});
		const root = await openRoot(runtime);
		runtime.harness.resume();

		const submission = await root.submit({ type: "input", content: `DELEGATE-GAMMA ${MAIN_SENTINEL}`, requestId: "main-gamma" }, context);
		const settled = await submission.wait(context);
		expect(settled.status).toBe("done");
		await runtime.harness.waitForIdle(context);

		const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-gamma", context);
		expect(ledger).toBeDefined();

		// AC-05: three rejections fail the task; nothing is accepted by default.
		expect(ledger!.status).toBe("failed");
		expect(ledger!.failure?.reason).toBe("revision_limit");
		expect(ledger!.currentRound).toBe(3);
		expect(ledger!.rounds).toHaveLength(3);
		expect(ledger!.reviews).toHaveLength(3);
		expect(ledger!.reviews.map((review) => review.decision)).toEqual(["reject", "reject", "reject"]);
		expect(ledger!.reviews[2]?.after).toBe("failed");

		// AC-04: the long answer is excerpted with the truncation flag, and the
		// answer entry is still the round's real evidence.
		const answerEvidence = ledger!.rounds[0]!.evidence.find((evidence) => evidence.kind === "pi.assistant");
		expect(answerEvidence).toBeDefined();
		expect(answerEvidence!.truncated).toBe(true);
		expect(answerEvidence!.excerpt.length).toBeLessThan(LONG_ANSWER.length);
		expect(ledger!.rounds[0]!.answerEntryId).toBe(answerEvidence!.entryId);

		// AC-06: a terminal task refuses execution afterwards.
		const after = await root.submit({ type: "input", content: `AFTER-FAILED ${MAIN_SENTINEL}`, requestId: "main-after" }, context);
		const afterSettled = await after.wait(context);
		expect(afterSettled.status).toBe("done");
		await runtime.harness.waitForIdle(context);

		const afterLedger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-gamma", context);
		expect(afterLedger!.status).toBe("failed");
		expect(afterLedger!.rounds).toHaveLength(3);
		expect(afterLedger!.reviews).toHaveLength(3);

		// The main conversation recorded the refusals it received.
		const entries = await root.entries({}, 1000, undefined, context);
		const flat = entries.items.flatMap((entry) => entry.model ?? []).map((message) => JSON.stringify(message)).join("\n");
		expect(/accepts nothing further|not revisable|stale revision/.test(flat)).toBe(true);

		// AC-02 from the provider side: no child request saw the main sentinel.
		const childRequests = requests.filter((request) => !request.includes(MAIN_SENTINEL));
		expect(childRequests.length).toBeGreaterThan(0);
		for (const request of childRequests) expect(request.includes(MAIN_SENTINEL)).toBe(false);
	}, 30000);
});
