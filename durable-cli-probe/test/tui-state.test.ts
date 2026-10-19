// TASK-005.5 test/tui-state.test.ts
//
// The session the terminal entry drives, without a terminal: the real
// composition root (`openAgentSession`) over a faux provider, read through the
// same `snapshot` the screen renders and written through the same Main service
// methods the controller calls.
//
// What this proves, each from documents rather than from the screen:
//
//   * a pass derives every task's status from the runtime's documents and the
//     ledger, with no percentage and no invented start time;
//   * `/answer` reaches Main as an answer to the open question, judged
//     sufficient or not as the line said;
//   * `/cancel <id>` is recorded by the runtime and the receipt proves it;
//   * closing is not cancelling: a session closed mid-run leaves the work
//     recoverable, and the next open finishes it.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";
import { context } from "../src/runtime.ts";
import { openAgentSession, transcriptLine } from "../src/service/session.ts";
import { routeLine } from "../src/service/router.ts";
import { statusLabel } from "../src/service/view.ts";
import type { AgentSession, TaskRow, TuiSnapshot } from "../src/service/types.ts";
import { Controller } from "../src/tui/controller.ts";
import { mainRouter, runConfigOf, taskSpecOf, textStatsChildRouter } from "./helpers/batch-system.ts";

const RUN_CONFIG = runConfigOf({
	schemaVersion: 1,
	maxConcurrentSubAgents: 2,
	maxSubAgentsPerRequest: 4,
	maxToolInvocationsPerRound: 4,
	maxFailedToolCallsPerRound: 2,
	maxAttemptsPerOperation: 2,
	maxTechnicalRestarts: 1,
	roundTimeoutMs: 10_000,
	providerRetry: { maxRetries: 1, backoffMs: 5 },
	harnessRetry: { maxRetries: 0, backoffMs: 0 },
});

const BUDGET = { maxToolInvocations: 3, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 8_000 };

/**
 * Two faux models, so a switch has somewhere to go: with a catalog of one, "set
 * the model" and "did nothing" look the same from the outside.
 */
const FAUX_MODELS = [
	{ id: "faux-1", name: "Faux One", contextWindow: 128_000 },
	{ id: "faux-2", name: "Faux Two", contextWindow: 64_000 },
];

const specOf = (id: string, dependencies: readonly string[] = []) => taskSpecOf({ id, skillId: "material-summary", requestedTools: ["text_stats"], budget: BUDGET, dependencies });

function sessionOptions(databasePath: string, router: FauxResponseFactory) {
	return {
		provider: "faux" as const,
		databasePath,
		fauxRouter: router,
		maxConcurrentSubAgents: RUN_CONFIG.maxConcurrentSubAgents,
		maxSubAgentsPerRequest: RUN_CONFIG.maxSubAgentsPerRequest,
		runConfig: RUN_CONFIG,
	};
}

/** Save and dispatch exactly these specs on the second Main turn. */
function dispatchRouter(specs: readonly unknown[], child = textStatsChildRouter("MAT" )): FauxResponseFactory {
	return mainRouter(
		() => [
			[{ name: "save_plan", arguments: { planId: "plan-tui", goals: ["run"], taskIds: specs.map((spec) => (spec as { id: string }).id) } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-tui", version: 1, tasks: specs.map((spec) => spec as never) } }],
		],
		child,
	);
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value)) return value;
		if (Date.now() > deadline) throw new Error(`condition not reached; last value: ${JSON.stringify(value).slice(0, 500)}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function passes(session: AgentSession, count = 3): Promise<TuiSnapshot> {
	let snapshot = await session.snapshot(Date.now());
	for (let index = 1; index < count; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, 10));
		snapshot = await session.snapshot(Date.now());
	}
	return snapshot;
}

const rowOf = (snapshot: TuiSnapshot, taskId: string): TaskRow | undefined => snapshot.tasks.find((row) => row.taskId === taskId);

describe("TASK-005.5 session read model", { timeout: 90_000 }, () => {
	let directory: string;
	let databasePath: string;
	const opened: AgentSession[] = [];

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "tui-state-"));
		databasePath = join(directory, "tui.sqlite");
	});

	afterEach(async () => {
		for (const session of opened.splice(0)) await session.close().catch(() => {});
		await rm(directory, { recursive: true, force: true });
	});

	async function open(router: FauxResponseFactory, fauxModels?: typeof FAUX_MODELS): Promise<AgentSession> {
		const session = await openAgentSession({ ...sessionOptions(databasePath, router), ...(fauxModels === undefined ? {} : { fauxModels }) });
		opened.push(session);
		return session;
	}

	it("derives task rows, answers from the open question, and cancels one task with a receipt", async () => {
		const session = await open(dispatchRouter([specOf("t-alpha"), specOf("t-beta")]));
		const sent = await session.main.submitUserInput({ text: "please run two tasks", requestId: "req-tui-1" });
		expect(sent.kind).toBe("request");
		if (sent.kind !== "request") return;
		await sent.submission.wait(context);

		// Main saves the plan, then waits for the contract bodies that arrive with
		// the dispatch: the children answer, and the batch settles.
		await waitFor(
			() => passes(session),
			(snapshot) => snapshot.tasks.length === 2 && snapshot.tasks.every((row) => row.status === "awaiting-review"),
		);
		const settled = await passes(session);
		expect(settled.totalBatches).toBe(1);
		expect(settled.settledBatches).toBe(1);
		expect(settled.watchedTasks).toEqual(expect.arrayContaining(["t-alpha", "t-beta"]));
		for (const row of settled.tasks) {
			expect(row.statusSource).toBe("ledger");
			expect(row.title).toBe(`do ${row.taskId}`);
			expect(row.startedAt).toBeTypeOf("number");
			expect(row.toolInvocations.limit).toBe(BUDGET.maxToolInvocations);
			expect(statusLabel(row.status)).toBe("awaiting review");
		}

		const detail = await session.inspectTask("t-alpha", Date.now());
		expect(detail?.row.status).toBe("awaiting-review");
		expect(detail?.rounds.length).toBe(1);
		expect(detail?.rounds[0]?.resultSummary).toContain("MAT");
		expect(detail?.acceptance).toEqual(["the answer names the count"]);

		// An unknown id is not reported as a task.
		expect(await session.inspectTask("t-missing", Date.now())).toBeUndefined();
		expect((await session.cancelTask("t-missing")).outcome).toBe("unknown-task");

		// `/cancel <id>` on a finished task changes nothing and says why.
		const prefix = routeLine("/cancel t-al", settled);
		expect(prefix).toEqual({ kind: "cancel", taskId: "t-alpha" });
		const second = await session.cancelTask("t-alpha");
		expect(second.outcome).toBe("already-terminal");

		// The transcript is Main's conversation, reduced to lines.
		const lines = await session.transcript(50);
		expect(lines.some((line) => line.kind === "user" && line.text.includes("please run two tasks"))).toBe(true);
		expect(lines.some((line) => line.kind === "assistant")).toBe(true);

		// A reopened database still shows the finished work.
		await session.close();
		opened.splice(opened.indexOf(session), 1);
		const reopened = await open(dispatchRouter([specOf("t-alpha"), specOf("t-beta")]));
		const again = await passes(reopened);
		expect(again.tasks.map((row) => [row.taskId, row.status]).sort()).toEqual([
			["t-alpha", "awaiting-review"],
			["t-beta", "awaiting-review"],
		]);
	});

	it("switches the model in use, and refuses one the provider does not offer", async () => {
		// The provider records the model each request actually carried, so "the next
		// request uses it" is read from the request and not from the document that
		// asked for it.
		const used: string[] = [];
		const inner = mainRouter(() => [], textStatsChildRouter("MAT"));
		const recording: FauxResponseFactory = (request, options, state, model) => {
			used.push(model.id);
			return inner(request, options, state, model);
		};
		const session = await open(recording, FAUX_MODELS);
		const first = await passes(session);
		expect(first.model.current).toEqual({ provider: "faux", modelId: "faux-1" });
		expect(first.model.available.map((option) => [option.modelId, option.name])).toEqual([
			["faux-1", "Faux One"],
			["faux-2", "Faux Two"],
		]);

		// `/model` alone asks for the list; a named model is switched to, in either
		// the bare form or the `provider/modelId` form the list itself prints.
		expect(routeLine("/model", first)).toEqual({ kind: "models" });
		expect(routeLine("/model faux-2", first)).toEqual({ kind: "set-model", provider: "faux", modelId: "faux-2" });
		expect(routeLine("/model faux/faux-2", first)).toEqual({ kind: "set-model", provider: "faux", modelId: "faux-2" });
		expect(routeLine("/model faux/nope", first)).toMatchObject({ kind: "noop" });

		// An id the provider does not offer is refused before anything is written:
		// the runtime fails every request carrying such a model as `no_model`, so
		// accepting one would break the session rather than change it.
		const refused = routeLine("/model gpt-9", first);
		expect(refused.kind).toBe("noop");
		expect(refused.kind === "noop" ? refused.notice : "").toContain("faux/faux-1");
		expect(await session.setModel("faux", "gpt-9")).toMatchObject({ outcome: "unavailable" });
		expect((await passes(session)).model.current).toEqual({ provider: "faux", modelId: "faux-1" });

		const set = await session.setModel("faux", "faux-2");
		expect(set).toMatchObject({ outcome: "set", detail: "Faux Two" });
		expect((await passes(session)).model.current).toEqual({ provider: "faux", modelId: "faux-2" });

		const sent = await session.main.submitUserInput({ text: "run with the second model", requestId: "req-model" });
		expect(sent.kind).toBe("request");
		if (sent.kind !== "request") return;
		await sent.submission.wait(context);
		// Every request this window carried went to the model it was switched to.
		expect([...new Set(used)]).toEqual(["faux-2"]);

		// The switch is a document, so a reopen reads it back — the config that opens
		// the database supplies a model only when the root conversation is created,
		// and `harness.root()` ignores the agent change once the root exists.
		await session.close();
		opened.splice(opened.indexOf(session), 1);
		const reopened = await open(recording, FAUX_MODELS);
		expect((await passes(reopened)).model.current).toEqual({ provider: "faux", modelId: "faux-2" });
	});

	it("sends an answer to the open question with the judgement the line stated", async () => {
		// Main asks for a blocking detail before it plans anything.
		const router = mainRouter(
			(flat) =>
				flat.includes("ANSWERED-ONCE")
					? []
					: [[{ name: "request_clarification", arguments: { question: "Which version of the document?", reason: "two are supplied", blockedTaskIds: [] } }]],
			textStatsChildRouter("MAT"),
		);
		const session = await open(router);
		const sent = await session.main.submitUserInput({ text: "summarize the material", requestId: "req-ask" });
		expect(sent.kind).toBe("request");
		if (sent.kind !== "request") return;
		await sent.submission.wait(context);

		const asking = await waitFor(
			() => passes(session),
			(snapshot) => snapshot.request.openQuestionIds.length > 0,
		);
		const questionId = asking.request.openQuestionIds[0] as string;
		expect(asking.request.questions.find((entry) => entry.questionId === questionId)?.question).toContain("Which version");

		// A plain line is refused while a question is open; nothing is written.
		const plain = routeLine("a brand new request", asking);
		expect(plain.kind).toBe("noop");
		// The refusal names only commands the router has: a notice pointing at a bare
		// `/` (or at a command that does not exist) sends the user to "unknown command".
		const notice = plain.kind === "noop" ? plain.notice : "";
		const named = notice.match(/\/[a-z-]+/g) ?? [];
		expect(named.length).toBeGreaterThan(0);
		expect(notice).not.toMatch(/\/$|\/\s/);
		for (const command of named) expect(["/help", "/tasks", "/transcript", "/quit", "/exit", "/inspect", "/cancel", "/answer", "/withdraw", "/model"]).toContain(command);

		// `--insufficient` answers without claiming sufficiency, and the question stays open.
		const insufficient = routeLine("/answer --insufficient maybe the second one", asking);
		expect(insufficient).toEqual({ kind: "send", text: "maybe the second one", answerTo: questionId, sufficient: false });
		const controllerSession = {
			main: session.main,
			snapshot: session.snapshot,
			watch: session.watch,
			transcript: session.transcript,
			inspectTask: session.inspectTask,
			cancelTask: session.cancelTask,
			cancelAll: session.cancelAll,
			setModel: session.setModel,
			close: session.close,
		};
		const host = { requestRender: () => {}, askQuit: () => {}, dismissQuit: () => {}, leave: () => {} };
		const controller = new Controller({ session: controllerSession, host, animate: false, transcriptLimit: 50 });
		await controller.start();
		await controller.submit("/answer --insufficient maybe the second one");
		expect(controller.view().state.notice).toBe(`answered ${questionId}`);

		const after = await waitFor(
			() => passes(session),
			(snapshot) => snapshot.request.answers.some((answer) => answer.questionId === questionId),
		);
		const first = after.request.answers.find((answer) => answer.questionId === questionId);
		expect(first?.sufficient).toBe(false);
		expect(first?.text).toBe("maybe the second one");

		const sufficient = routeLine("/answer ANSWERED-ONCE", after);
		expect(sufficient).toMatchObject({ kind: "send", answerTo: questionId, sufficient: true });
		const answer = await session.main.submitUserInput({ text: "ANSWERED-ONCE", answerTo: questionId, sufficient: true });
		expect(answer.kind).toBe("answer");
	});

	it("cancels one task's batch: the stop is recorded, then the receipt proves it", async () => {
		// The child parks inside its provider call until released, so the task is
		// running while the cancellation is asked for. The park is bounded so a
		// release that never comes becomes a slow answer, not a hung suite.
		let unblock: () => void = () => {};
		const parked = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		let arrived = false;
		const fast = textStatsChildRouter("FAST");
		const child = async (request: { readonly messages: readonly Message[] }) => {
			arrived = true;
			await Promise.race([parked, new Promise((resolve) => setTimeout(resolve, 400))]);
			return fast(request);
		};
		const session = await open(dispatchRouter([specOf("t-slow")], child as never));
		const sent = await session.main.submitUserInput({ text: "run the slow task", requestId: "req-cancel" });
		expect(sent.kind).toBe("request");
		if (sent.kind !== "request") return;

		await waitFor(
			async () => arrived,
			(value) => value,
		);
		const running = await waitFor(
			() => passes(session),
			(snapshot) => rowOf(snapshot, "t-slow")?.status === "running",
		);
		expect(rowOf(running, "t-slow")?.batchId).toBeTruthy();

		const result = await session.cancelTask("t-slow");
		expect(["cancelled", "stopping"]).toContain(result.outcome);
		const stopped = await waitFor(
			() => passes(session),
			(snapshot) => rowOf(snapshot, "t-slow")?.status === "cancelled",
			30_000,
		);
		expect(rowOf(stopped, "t-slow")?.statusSource).toBe("ledger");
		unblock();
		// The stop is final: the released child does not turn the task back into a success.
		const after = await passes(session, 5);
		expect(rowOf(after, "t-slow")?.status).toBe("cancelled");
	});

	it("closing mid-run does not cancel; the next open finishes the work", async () => {
		let firstArrived: (() => void) | undefined;
		const arrived = new Promise<void>((resolve) => {
			firstArrived = resolve;
		});
		let count = 0;
		const child = (request: { readonly messages: readonly never[] }) => {
			count += 1;
			if (count === 1) firstArrived?.();
			return textStatsChildRouter("CLOSE")(request as never);
		};
		const first = await open(dispatchRouter([specOf("t-keep")], child as never));
		const sent = await first.main.submitUserInput({ text: "run a task then quit", requestId: "req-close" });
		expect(sent.kind).toBe("request");
		if (sent.kind !== "request") return;
		await arrived;

		await first.close();
		opened.splice(opened.indexOf(first), 1);

		// Nothing was cancelled at close: the ledger, if it exists, is not terminal.
		const reopened = await open(dispatchRouter([specOf("t-keep")], textStatsChildRouter("KEEP")));
		const finished = await waitFor(
			() => passes(reopened),
			(snapshot) => rowOf(snapshot, "t-keep")?.status === "awaiting-review",
			40_000,
		);
		expect(rowOf(finished, "t-keep")?.status).toBe("awaiting-review");
	});

	it("reduces only user, assistant and tool entries to transcript lines", () => {
		expect(transcriptLine({ kind: "pi.user", id: 1, model: [{ content: "hi" }] } as never)).toEqual({ entryId: "1", kind: "user", text: "hi" });
		expect(transcriptLine({ kind: "pi.tool-result", id: 2, model: [{ toolName: "text_stats", content: [{ text: "ok" }] }] } as never)).toEqual({
			entryId: "2",
			kind: "tool",
			text: "text_stats: ok",
		});
		expect(transcriptLine({ kind: "pi.extension", id: 3 } as never)).toBeUndefined();
	});
});
