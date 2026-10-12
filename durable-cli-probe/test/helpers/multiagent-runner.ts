// TASK-003 test/helpers/multiagent-runner.ts
//
// A deterministic, scripted runner for the cross-process recovery checks. It is
// spawned by test/multiagent-recovery.test.ts as a real child process, so a
// SIGKILL is a real unclean stop, not a simulated one.
//
// Usage:
//   node --conditions=source --experimental-strip-types test/helpers/multiagent-runner.ts \
//     --db <absolute path> --request-id <id> --input <DELEGATE|REVIEW> [--kill-when <condition>]
//
// The script:
//   DELEGATE  the main agent delegates `task-smoke`; the child runs text_stats
//             and answers; the main agent finishes with text (no review).
//   REVIEW    the main agent accepts `task-smoke`'s current round.

import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, openProbe, openRoot } from "../../src/runtime.ts";
import { ChildTools } from "../../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../../src/multiagent/ledger.ts";

const SENTINEL = "RUNNER-SENTINEL-2D7B";
const MAT = "MAT-RECOVER-5A1C";

function flatten(messages: readonly Message[]): string {
	return messages
		.map((message) => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
				.join("\n");
		})
		.join("\n");
}

const router: FauxResponseFactory = (request) => {
	// Recovery kill points live on the request path itself: the process dies at
	// a moment a model turn is actually in flight, which a wall-clock poll can
	// miss when the deterministic script runs to completion between timers.
	if (killWhen === "child-conversation" && !flatten(request.messages).includes(SENTINEL)) killNow();
	if (killWhen === "awaiting_review") {
		const lastResult = [...request.messages].reverse().find((message) => message.role === "toolResult");
		const toolName = lastResult === undefined ? "" : String((lastResult as { toolName?: string }).toolName ?? "");
		if (lastResult !== undefined && toolName === "task_delegate") killNow();
	}
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

	if (!flat.includes(SENTINEL)) {
		// The child: run the tool, then answer.
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: MAT, marker: "MAT" }, { id: "runner-call-1" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText(`RUNNER-CHILD-ANSWER: ${MAT}`)]);
	}
	if (last?.role === "toolResult") {
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate") return fauxAssistantMessage([fauxText("RUNNER-MAIN-DONE")]);
		if (toolName === "task_review") return fauxAssistantMessage([fauxText("RUNNER-REVIEW-DONE")]);
		return fauxAssistantMessage([fauxText("RUNNER-MAIN-DONE")]);
	}
	if (textOf().includes("REVIEW")) {
		return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-smoke", decision: "accept" }, { id: "runner-accept" })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage(
		[fauxToolCall("task_delegate", { taskId: "task-smoke", task: `count ${MAT}`, childTools: ["text_stats"] }, { id: "runner-delegate" })],
		{ stopReason: "toolUse" },
	);
};

function parseArg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const databasePath = parseArg("db");
const requestId = parseArg("request-id");
const input = parseArg("input") ?? "DELEGATE";
const killWhen = parseArg("kill-when");
if (databasePath === undefined || requestId === undefined) {
	console.error("usage: runner --db <path> --request-id <id> [--input DELEGATE|REVIEW] [--kill-when condition]");
	process.exit(2);
}

const runtime = await openProbe({
	databasePath,
	provider: "faux",
	fauxRouter: router,
	extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "You are the child agent of the recovery check." })],
	registryExtensions: [ChildTools],
});

/** Die uncleanly at a recovery boundary. */
function killNow(): never {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
}

const root = await openRoot(runtime);
runtime.harness.resume();
const submission = await root.submit({ type: "input", content: `${input} ${SENTINEL}`, requestId }, context);
const settled = await submission.wait(context);
await runtime.harness.waitForIdle(context);
if (settled.status !== "done") {
	console.error(`runner: submission ${settled.status}`);
	await runtime.close();
	process.exit(1);
}
const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-smoke", context);
console.log(
	JSON.stringify({
		ok: true,
		input,
		status: ledger?.status ?? null,
		rounds: ledger?.rounds.length ?? 0,
		childConversationId: ledger?.childConversationId ?? null,
	}),
);
await runtime.close();
process.exit(0);
