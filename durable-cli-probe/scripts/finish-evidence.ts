// TASK-005.1 scripts/finish-evidence.ts
//
// Repeatable evidence for the completion boundary: run one submission through
// the real harness (offline, faux provider, real SQLite) and print the
// identifiers a reader can reopen the database with.
//
// This exists because an early round of this work quoted a one-off script whose
// command was not reproducible. Run it with:
//
//   npm run agent:finish-evidence
//   npm run agent:finish-evidence -- --db ./finish.sqlite --request-id my-run
//
// The script deliberately reproduces the shape that failed before: a session with
// a business tool, one business call in an early round, and the submission as a
// structured final answer. What it proves:
//   * the run ends on the answering turn (a turn with no tool calls), and the
//     provider router — which refuses — is never asked for another turn;
//   * no business tool result appears *after* the answering entry, so no business
//     call can follow the submission;
//   * the submission is accepted only through `completeSubmission`, i.e. after the
//     settlement and after the payload validates.
// It does not prove anything about a real model or a real task, and it is not a
// substitute for test/agent-state.test.ts, which is what CI runs.
//
// Exit code 0 means the boundary held and the identifiers were printed; a
// non-zero exit means it did not (a second model turn, a business call after the
// answer, or a submission that did not settle as done and validate).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot } from "../src/runtime.ts";
import { completeSubmission } from "../src/agent/state/finish.ts";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

/** A business tool: the kind of call the completion boundary must stop allowing. */
const reviewBusinessTool = defineTool({
	name: "review_business",
	description: "A business call that does not end the run.",
	parameters: Type.Object({}),
	replay: "safe",
	execute: async () => ({ output: [{ type: "text", text: "business work done" }] }),
});

/** The answering assistant message's text, as persisted. */
function assistantTextOf(entry: EntryRecord | undefined): string | undefined {
	if (entry === undefined) return undefined;
	const parts: string[] = [];
	for (const message of entry.model ?? []) {
		const typed = message as { role?: string; content?: unknown };
		if (typed.role !== "assistant") continue;
		if (typeof typed.content === "string") parts.push(typed.content);
		else if (Array.isArray(typed.content)) {
			for (const part of typed.content) {
				if (typeof part === "object" && part !== null && "text" in part) parts.push(String((part as { text?: unknown }).text ?? ""));
			}
		}
	}
	return parts.length === 0 ? undefined : parts.join("\n");
}

const explicitDatabase = arg("db");
const requestId = arg("request-id") ?? "finish-evidence-1";
const temporaryDirectory = explicitDatabase === undefined ? mkdtempSync(join(tmpdir(), "finish-evidence-")) : undefined;
const databasePath = resolve(explicitDatabase ?? join(temporaryDirectory ?? ".", "finish-evidence.sqlite"));

const submissionWork = {
	summary: "Revenue is 1,204 units, quoted from the material.",
	findings: ["quoted verbatim"],
	unresolved: [],
	artifacts: [],
};

const runtime = await openProbe({
	databasePath,
	provider: "faux",
	// Round 1: business work. Round 2: the structured final answer that submits.
	fauxToolTurns: [[{ name: "review_business", arguments: {} }]],
	fauxResponses: [JSON.stringify(submissionWork)],
	// The strongest available statement that no further model round happened: the
	// provider is asked, and refuses.
	fauxRouter: () => {
		throw new Error("the run made a further provider request, so the submission did not end it");
	},
	extensions: [defineExtension({ name: "agent-finish", tools: [reviewBusinessTool] })],
});

let failed = false;
try {
	const root = await openRoot(runtime);
	runtime.harness.resume();
	const submission = await root.submit({ type: "input", content: "Verify the revenue figure.", requestId }, context);
	const settled = await submission.wait(context);
	const entries = [...(await root.entries({}, 1000, undefined, context)).items].reverse();
	const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
	const answerEntryId = settled.status === "done" ? String(settled.answer) : undefined;
	const answerIndex = entries.findIndex((entry) => String(entry.id) === answerEntryId);
	// A business call after the answering entry is exactly the failure this
	// boundary exists to prevent.
	const businessResultsAfterAnswer =
		answerIndex === -1
			? []
			: entries.slice(answerIndex + 1).filter((entry) => entry.kind === "pi.tool-result" && entry.byTaskId !== undefined).length;

	const completion = completeSubmission({
		settlement: settled,
		...(answerEntryId === undefined ? {} : { answerEntryId }),
		...(answerEntryId === undefined ? {} : { answerText: assistantTextOf(entries.find((entry) => String(entry.id) === answerEntryId)) }),
	});

	console.log(
		JSON.stringify(
			{
				databasePath,
				requestId,
				conversationId: root.id,
				settledStatus: settled.status,
				submissionEntryId: settled.status === "done" ? settled.entry : undefined,
				answerEntryId: settled.status === "done" ? settled.answer : undefined,
				entryKinds: entries.map((entry) => `${entry.kind}#${entry.id}`),
				assistantEntryCount: assistantEntries.length,
				businessToolResultCount: entries.filter((entry) => entry.kind === "pi.tool-result").length,
				businessResultsAfterAnswer,
				submissionValid: completion.ok,
				submissionSummary: completion.ok ? completion.value.work.summary : undefined,
				submissionViolations: completion.ok ? undefined : completion.violations.map((item) => item.code),
			},
			null,
			2,
		),
	);

	if (settled.status !== "done") failed = true;
	// Two turns: the business call, then the answering turn that ended the run.
	if (assistantEntries.length !== 2) failed = true;
	if (businessResultsAfterAnswer !== 0) failed = true;
	if (!completion.ok) failed = true;
} finally {
	await runtime.close();
	if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (failed) {
	console.error("finish evidence: the completion boundary did not hold (see the counts above)");
	process.exit(1);
}
