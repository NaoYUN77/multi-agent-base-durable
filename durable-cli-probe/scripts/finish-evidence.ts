// TASK-005.1 scripts/finish-evidence.ts
//
// Repeatable evidence for the finish protocol: run one submission through the
// real harness (offline, faux provider, real SQLite) and print the identifiers a
// reader can reopen the database with.
//
// This exists because the first round of this work quoted a one-off script whose
// command was not reproducible. Run it with:
//
//   npm run agent:finish-evidence
//   npm run agent:finish-evidence -- --db ./finish.sqlite --request-id my-run
//
// What it proves, and what it does not:
//   * it proves the run ended after the submission: exactly one assistant entry,
//     and a provider router that throws if it is ever asked for a second turn;
//   * it does not prove anything about a real model or a real task, and it is not
//     a substitute for the assertions in test/agent-state.test.ts, which is what
//     CI runs.
//
// Exit code 0 means the identifiers were printed; a non-zero exit means the
// protocol did not hold (a second model turn happened, or the submission did not
// settle as done).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot } from "../src/runtime.ts";
import { createFinishTaskTool } from "../src/agent/tools/finish-task.ts";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

const explicitDatabase = arg("db");
const requestId = arg("request-id") ?? "finish-evidence-1";
const temporaryDirectory = explicitDatabase === undefined ? mkdtempSync(join(tmpdir(), "finish-evidence-")) : undefined;
const databasePath = resolve(explicitDatabase ?? join(temporaryDirectory ?? ".", "finish-evidence.sqlite"));

const runtime = await openProbe({
	databasePath,
	provider: "faux",
	fauxToolTurns: [[{ name: "finish_task", arguments: { summary: "Revenue is 1,204 units, quoted from the material.", findings: ["quoted verbatim"] } }]],
	// The strongest available statement that no second model round happened: the
	// provider is asked, and refuses.
	fauxRouter: () => {
		throw new Error("the run made a second provider request, so the round did not stop");
	},
	extensions: [defineExtension({ name: "agent-finish", tools: [createFinishTaskTool()] })],
});

let failed = false;
try {
	const root = await openRoot(runtime);
	runtime.harness.resume();
	const submission = await root.submit({ type: "input", content: "Verify the revenue figure.", requestId }, context);
	const settled = await submission.wait(context);
	const entries = [...(await root.entries({}, 1000, undefined, context)).items].reverse();
	const assistantEntries = entries.filter((entry) => entry.kind === "pi.assistant");
	const toolResults = entries.filter((entry) => entry.kind === "pi.tool-result");

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
				toolResultEntryCount: toolResults.length,
			},
			null,
			2,
		),
	);
	if (settled.status !== "done") failed = true;
	// One assistant turn is the whole point: a second one means the round did not stop.
	if (assistantEntries.length !== 1) failed = true;
} finally {
	await runtime.close();
	if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true, force: true });
}

if (failed) {
	console.error("finish evidence: the protocol did not hold (see the counts above)");
	process.exit(1);
}
