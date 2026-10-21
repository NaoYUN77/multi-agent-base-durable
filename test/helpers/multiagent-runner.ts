// TASK-003 test/helpers/multiagent-runner.ts
//
// A deterministic, scripted runner for the cross-process recovery checks. It is
// spawned by test/multiagent-recovery.test.ts as a real child process, so a
// SIGKILL is a real unclean stop, not a simulated one.
//
// Usage:
//   node --conditions=source --experimental-strip-types test/helpers/multiagent-runner.ts \
//     --db <absolute path> --request-id <id> --input <DELEGATE|REVIEW|REVISE|RESUME> \
//     [--kill-when <child-conversation|awaiting_review|revising-intent|tool-pause>]
//
// Modes:
//   DELEGATE  the main agent delegates `task-smoke`; the child runs text_stats
//             and answers; the main agent finishes with text (no review).
//   REVIEW    the main agent accepts `task-smoke`'s current round.
//   REVISE    the main agent sends a revision and finishes.
//   CANCEL    the main agent cancels `task-smoke`.
//   RESUME    nothing is submitted: the process opens the database, resumes
//             whatever was interrupted, waits for idle, and reports the ledger.
//             This is how a restart continues an interrupted round on its own.
//
// Kill conditions (the process dies uncleanly at the named boundary):
//   child-conversation  on the child's first model request (intent committed,
//                       submission in flight)
//   awaiting_review     when the main agent sees the delegation's tool result
//                       (the round settled, the main model has not reviewed)
//   revising-intent     on the child's first request of a *revision* round
//                       (the revision intent is committed, its submission in
//                       flight)
//   tool-pause          while the local tool is executing: the child asks for a
//                       pause and the process kills itself inside it
//   pre-submit          at the round's verification barrier: the intent is
//                       committed and NO submission exists yet
//   after-outcome       at the barrier after the round's outcome is committed
//                       and before the parent tool result exists
//   wait-for-file       hold at the round's verification barrier until
//                       `--release-file <path>` exists, then continue. Entering
//                       the barrier writes `<release-file>.entered`, so a driver
//                       can prove the round really is inside the admission
//                       window (gate passed, submission not yet made) instead of
//                       inferring it from concurrency.
//
// `--no-task-id` makes the delegation omit `taskId`, so the derived business id
// (from the tool task) is what recovery has to keep stable.

import { createRequire } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, openProbe, openRoot } from "../../src/runtime.ts";
import { ChildTools } from "../../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../../src/multiagent/ledger.ts";

const SENTINEL = "RUNNER-SENTINEL-2D7B";
const MAT = "MAT-RECOVER-5A1C";
const REVISION_MARK = "REVISION-ROUND-TWO";
/** Long enough that the killer lands inside the tool, short enough to keep the test quick. */
const TOOL_PAUSE_MS = 1_500;
const TOOL_KILL_AFTER_MS = 300;

function parseArg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const databasePath = parseArg("db");
const requestId = parseArg("request-id");
const input = parseArg("input") ?? "DELEGATE";
const killWhen = parseArg("kill-when");
const omitTaskId = process.argv.includes("--no-task-id");
const releaseFile = parseArg("release-file");
/** The verification barriers must fire once, not on every round. */
let barrierFired = false;
if (databasePath === undefined || requestId === undefined) {
	console.error("usage: runner --db <path> --request-id <id> [--input DELEGATE|REVIEW|REVISE|RESUME] [--kill-when condition]");
	process.exit(2);
}

/** Die uncleanly at a recovery boundary. */
function killNow(): never {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
}

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

	// ── Child side ──────────────────────────────────────────────────────────
	if (!flat.includes(SENTINEL)) {
		if (killWhen === "child-conversation") killNow();
		if (killWhen === "revising-intent" && textOf().includes(REVISION_MARK)) killNow();
		if (last?.role !== "toolResult") {
			const args: Record<string, string | number> = { text: MAT, marker: "MAT" };
			if (killWhen === "tool-pause") {
				args.pauseMs = TOOL_PAUSE_MS;
				// The kill must land inside the tool, not on a model turn.
				setTimeout(() => killNow(), TOOL_KILL_AFTER_MS);
			}
			return fauxAssistantMessage([fauxToolCall("text_stats", args, { id: "runner-call-1" })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage([fauxText(`RUNNER-CHILD-ANSWER: ${MAT}`)]);
	}

	// ── Main side ───────────────────────────────────────────────────────────
	if (last?.role === "toolResult") {
		const toolName = (last as { toolName?: string }).toolName;
		if (toolName === "task_delegate" && killWhen === "awaiting_review") killNow();
		return fauxAssistantMessage([fauxText("RUNNER-MAIN-DONE")]);
	}
	if (textOf().includes("REVISE")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_revise", { taskId: "task-smoke", round: 1, task: `${REVISION_MARK} count ${MAT}`, feedback: "again" }, { id: "runner-revise" })],
			{ stopReason: "toolUse" },
		);
	}
	if (textOf().includes("CANCEL")) {
		return fauxAssistantMessage([fauxToolCall("task_cancel", { taskId: "task-smoke", reason: "driver cancel" }, { id: "runner-cancel" })], {
			stopReason: "toolUse",
		});
	}
	if (textOf().includes("REVIEW")) {
		return fauxAssistantMessage(
			[fauxToolCall("task_review", { taskId: "task-smoke", decision: "accept", round: 1 }, { id: "runner-accept" })],
			{ stopReason: "toolUse" },
		);
	}
	return fauxAssistantMessage(
		[
			fauxToolCall(
				"task_delegate",
				omitTaskId ? { task: `count ${MAT}`, childTools: ["text_stats"] } : { taskId: "task-smoke", task: `count ${MAT}`, childTools: ["text_stats"] },
				{ id: "runner-delegate" },
			),
		],
		{ stopReason: "toolUse" },
	);
};

const runtime = await openProbe({
	databasePath,
	provider: "faux",
	fauxRouter: router,
	extensions: [
		createMultiagentExtension({
			model: { provider: "faux", modelId: "faux-1" },
			childInstructions: "You are the child agent of the recovery check.",
			// The verification barriers: kill exactly at the named window, once.
			// The pre-submit barriers park/kill at the true window: after the
			// cancellation gate, immediately before the submission.
			atSubmit: async () => {
				if (killWhen === "pre-submit" && !barrierFired) {
					barrierFired = true;
					killNow();
				}
				if (killWhen === "wait-for-file" && releaseFile !== undefined) {
					// Handshake: prove we are inside the admission window (the gate has
					// passed, the submission has not been made), then hold until the
					// driver releases us.
					writeFileSync(`${releaseFile}.entered`, "entered");
					const deadline = Date.now() + 60_000;
					while (!existsSync(releaseFile) && Date.now() < deadline) {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				}
			},
			afterOutcome: () => {
				if (killWhen === "after-outcome" && !barrierFired) {
					barrierFired = true;
					killNow();
				}
			},
		}),
	],
	registryExtensions: [ChildTools],
});

const root = await openRoot(runtime);
runtime.harness.resume();

/**
 * The business task id. With `--no-task-id` the tool derives it from the tool
 * task, so the runner reads it back from the ledger document itself.
 */
function resolveTaskId(): string {
	if (!omitTaskId) return "task-smoke";
	const require = createRequire(import.meta.url);
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(databasePath!, { readOnly: true });
	try {
		const rows = db.prepare("SELECT key_value FROM documents WHERE kind LIKE ?").all("%multiagent.task-ledger%") as { key_value: string }[];
		if (rows.length !== 1) throw new Error(`expected exactly one ledger document, found ${rows.length}`);
		return JSON.parse(rows[0]!.key_value) as string;
	} finally {
		db.close();
	}
}

// RESUME: submit nothing; let the Harness continue whatever was interrupted.
if (input === "RESUME") {
	await runtime.harness.waitForIdle(context);
	const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, resolveTaskId(), context);
	console.log(
		JSON.stringify({
			ok: true,
			input,
			status: ledger?.status ?? null,
			rounds: ledger?.rounds.length ?? 0,
			settledRounds: ledger?.rounds.filter((round) => round.submissionId !== undefined).length ?? 0,
			childConversationId: ledger?.childConversationId ?? null,
		}),
	);
	await runtime.close();
	process.exit(0);
}

const submission = await root.submit({ type: "input", content: `${input} ${SENTINEL}`, requestId }, context);
const settled = await submission.wait(context);
await runtime.harness.waitForIdle(context);
if (settled.status !== "done") {
	console.error(`runner: submission ${settled.status}`);
	await runtime.close();
	process.exit(1);
}
const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, resolveTaskId(), context);
console.log(
	JSON.stringify({
		ok: true,
		input,
		taskId: resolveTaskId(),
		status: ledger?.status ?? null,
		rounds: ledger?.rounds.length ?? 0,
		childConversationId: ledger?.childConversationId ?? null,
	}),
);
await runtime.close();
process.exit(0);
