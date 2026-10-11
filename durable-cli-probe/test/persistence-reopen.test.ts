// TASK-001 test/persistence-reopen.test.ts
//
// Proves, against a real on-disk SQLite file and the faux provider (offline,
// deterministic), that:
//   1. A Harness over a file persists across close/reopen.
//   2. The root conversation keeps its id (1) across a reopen.
//   3. The transcript entries survive the reopen, read back through `entries()`.
//   4. A submission's `requestId` is idempotent: resubmitting it after reopen
//      returns the same submission and appends no second user entry.
//
// No agent loop is implemented here. The built-in pi.generation task does the
// work; the test only drives the public API.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssistantEntry, type Conversation, type EntryRecord } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";

/** Entries of a conversation, oldest first, as the checkout's examples read them. */
async function allEntries(conversation: Conversation): Promise<EntryRecord[]> {
	const page = await conversation.entries({}, 1000, undefined, context);
	return [...page.items].reverse();
}

const countUserEntries = (entries: readonly EntryRecord[]): number =>
	entries.filter((entry) => entry.kind === "pi.user").length;

describe("TASK-001 persistence / reopen", () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "durable-cli-probe-"));
		databasePath = join(directory, "probe.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("persists the root conversation, its entries, and requestId idempotency across a reopen", async () => {
		// ── First run ────────────────────────────────────────────────────────
		const first: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			fauxResponses: ["First answer."],
		});
		let firstRootId: number;
		let firstEntryCount: number;
		let firstSubmissionAnswer: number;
		try {
			const root = await openRoot(first);
			firstRootId = root.id;
			first.harness.resume();

			const submission = await root.submit(
				{ type: "input", content: "Hello once.", requestId: "job-1" },
				context,
			);
			const settled = await submission.wait(context);
			expect(settled.status).toBe("done");
			if (settled.status !== "done" || settled.type !== "input") throw new Error("expected an input answer");
			firstSubmissionAnswer = settled.answer;

			const entries = await allEntries(root);
			firstEntryCount = entries.length;
			// At minimum: a positional system prompt, the user input, and the answer.
			expect(countUserEntries(entries)).toBe(1);
			expect(entries.some((entry) => entry.kind === "pi.assistant")).toBe(true);
		} finally {
			await first.close();
		}

		// ── Second run over the same file ────────────────────────────────────
		const second: ProbeRuntime = await openProbe({
			databasePath,
			provider: "faux",
			// If idempotency failed, the second run would need a fresh response; it
			// must not need one, because no new model call may happen.
			fauxResponses: ["Second answer, which must never be used."],
		});
		try {
			const root = await openRoot(second);

			// (2) The root conversation keeps its id across the reopen.
			expect(root.id).toBe(firstRootId);

			// (3) The transcript survived, with the same length and the same answer.
			const reopened = await allEntries(root);
			expect(reopened.length).toBe(firstEntryCount);
			expect(reopened.map((entry) => entry.id)).toEqual(
				[...reopened].map((entry) => entry.id).sort((a, b) => a - b),
			);

			// (4) requestId idempotency: resubmitting job-1 returns the existing
			// submission and appends no entry at all.
			const replay = await root.submit(
				{ type: "input", content: "Hello once.", requestId: "job-1" },
				context,
			);
			const replayed = await replay.wait(context);
			expect(replayed.status).toBe("done");
			if (replayed.status !== "done" || replayed.type !== "input") throw new Error("expected an input answer");
			expect(replayed.answer).toBe(firstSubmissionAnswer);

			const afterReplay = await allEntries(root);
			expect(afterReplay.length).toBe(firstEntryCount);
			expect(countUserEntries(afterReplay)).toBe(1);

			// The answer entry of the replay resolves to the same stored answer.
			const entry = await root.commit((tx) => tx.entry(AssistantEntry, replayed.answer), context);
			expect(entry?.id).toBe(firstSubmissionAnswer);
		} finally {
			await second.close();
		}
	});

	it("starts a brand-new conversation file with root id 1 and a single user entry", async () => {
		const runtime = await openProbe({ databasePath, provider: "faux", fauxResponses: ["Hi."] });
		try {
			const root = await openRoot(runtime);
			expect(root.id).toBe(1);
			runtime.harness.resume();

			const submission = await root.submit({ type: "input", content: "Fresh." }, context);
			await submission.wait(context);

			const entries = await allEntries(root);
			expect(countUserEntries(entries)).toBe(1);
		} finally {
			await runtime.close();
		}
	});
});
