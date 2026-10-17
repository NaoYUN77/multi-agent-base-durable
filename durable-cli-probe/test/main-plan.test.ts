// TASK-005.2 test/main-plan.test.ts
//
// The Main service's plan and dispatch path, against a real harness and a real
// SQLite file (AC-02, AC-03, AC-04).
//
// The point these tests exist to make: **a saved plan is not permission to run
// it, and the model cannot talk its way past admission.** Every refusal below is
// checked by observing the injected executor — if admission let the batch
// through, the executor's call count would move, so "nothing was executed" is
// measured rather than read off a tool's text.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { context, openProbe, openRoot, type ProbeRuntime } from "../src/runtime.ts";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../src/agent/contracts/documents.ts";
import { validateTaskSpec, type TaskSpec } from "../src/agent/contracts/task-spec.ts";
import { openMainService } from "../src/service/main-service.ts";
import { MainServiceDoc } from "../src/agent/main/service-doc.ts";
import type { DispatchResult } from "../src/agent/main/tools.ts";
import { createMainExtension } from "../src/agent/main/tools.ts";

/** A valid TaskSpec, so the batch passes the contract and admission is the only gate. */
function taskSpec(id: string, dependencies: readonly string[] = []): TaskSpec {
	const checked = validateTaskSpec({
		schemaVersion: 1,
		id,
		purpose: `do ${id}`,
		materials: [{ id: "m1", content: "MATERIAL-CONTENT", source: "user" }],
		scope: ["one thing"],
		exclusions: [],
		constraints: [],
		outputContract: { format: "text", requiredFields: ["summary"] },
		acceptance: ["the report names the count"],
		skillId: "text-summary",
		requestedTools: ["text_stats"],
		dependencies: [...dependencies],
		budget: { maxToolInvocations: 4, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 30_000 },
	});
	if (!checked.ok) throw new Error(`fixture task spec invalid: ${JSON.stringify(checked.violations)}`);
	return checked.value;
}

/** One scripted model turn: the tool calls the model would make. */
type ScriptedCall = { readonly name: string; readonly arguments: JsonObject };

function flatten(messages: readonly unknown[]): string {
	return messages
		.map((message) => {
			const record = message as { content?: unknown; sections?: Record<string, string | null> };
			// A system message carries prompt sections in a `sections` field beside
			// `content`, so a helper that reads only `content` would report a rendered
			// section as absent. That is the whole surface these tests assert on.
			const sections = Object.values(record.sections ?? {})
				.filter((value): value is string => typeof value === "string")
				.join("\n");
			const content = record.content;
			if (typeof content === "string") return `${content}\n${sections}`;
			if (!Array.isArray(content)) return sections;
			return [
				content
					.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
					.join("\n"),
				sections,
			].join("\n");
		})
		.join("\n");
}

/** A marker the handoff payload must carry back to the next round. */
const MARKER2 = "HANDOFF-PAYLOAD-6D2A";

describe("TASK-005.2 plan — save, version, dispatch admission (AC-02, AC-03)", { timeout: 30_000 }, () => {
	let directory: string;
	let databasePath: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "main-plan-"));
		databasePath = join(directory, "main.sqlite");
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	/**
	 * Drive the service with a scripted sequence of tool calls, one entry per model
	 * turn.
	 *
	 * The router advances its turn on the first provider request of each *run*. A
	 * harness turn and a provider request are not the same thing — a round whose
	 * tool did not ask the run to end produces several provider requests — so
	 * counting every request let the script drift out from under the test. The turn
	 * is therefore keyed to the start of a run, which is what one submission
	 * produces.
	 */
	async function runScript(
		script: readonly (readonly ScriptedCall[])[],
		options: {
			readonly dispatch?: (input: { readonly tasks: readonly TaskSpec[] }) => Promise<readonly DispatchResult[]>;
			readonly unacceptedDependencies?: (tasks: readonly TaskSpec[]) => readonly string[];
			readonly authorizeDispatch?: (input: {
				readonly requestId: string;
				readonly requestVersion: number;
				readonly planId: string;
				readonly planVersion: number;
				readonly tasks: readonly TaskSpec[];
			}) => { readonly allowed: boolean; readonly reason?: string } | Promise<{ readonly allowed: boolean; readonly reason?: string }>;
			readonly dispatchQuota?: { readonly maxAttempts: number };
			readonly seededQuestions?: readonly string[];
		} = {},
	): Promise<{
		readonly runtime: ProbeRuntime;
		readonly service: Awaited<ReturnType<typeof openMainService>>;
		readonly dispatched: readonly (readonly TaskSpec[])[];
		readonly requests: readonly string[];
	}> {
		const dispatched: TaskSpec[][] = [];
		const requests: string[] = [];
		let turn = 0;
		/**
		 * The tool transcript marks the start of a new run, so it is what advances the
		 * script: a `pi.tool-result` entry means the previous round's tools finished
		 * and the harness is about to ask again, which is the next scripted turn.
		 */
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			// A `pi.tool-result` entry means the round's tools finished and the harness
			// is about to ask again — that is the next scripted turn.
			const sawToolResult = request.messages.some((message) => message.role === "toolResult");
			if (sawToolResult) turn += 1;
			// Once the script is spent the model answers with plain text, which ends
			// the run. Repeating the last entry forever would spin the conversation and
			// make every assertion about call counts meaningless.
			const calls: readonly ScriptedCall[] = turn >= script.length ? [] : script[turn] ?? [];
			if (calls.length === 0) return fauxAssistantMessage([fauxText("nothing left to do")]);
			return fauxAssistantMessage(
				calls.map((call, index) => fauxToolCall(call.name, call.arguments, { id: `call-${turn}-${index}` })),
				{ stopReason: "toolUse" },
			);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const service = await openMainService({
			harness: runtime.harness,
			registry: runtime.registry,
			context,
			conversationId: root.id,
			dispatch: async ({ tasks }) => {
				dispatched.push([...tasks]);
				return (options.dispatch === undefined ? tasks.map((task) => ({ taskId: task.id, status: "queued" as const })) : await options.dispatch({ tasks }));
			},
			...(options.unacceptedDependencies === undefined ? {} : { unacceptedDependencies: options.unacceptedDependencies }),
			...(options.authorizeDispatch === undefined ? {} : { authorizeDispatch: options.authorizeDispatch }),
			...(options.dispatchQuota === undefined ? {} : { dispatchQuota: options.dispatchQuota }),
			now: () => 1_700_000_000_000,
		});
		return { runtime, service, dispatched, requests };
	}

	/** Submit one request and let the scripted turns run to idle. */
	async function drive(harness: ProbeRuntime, service: Awaited<ReturnType<typeof openMainService>>, text = "plan the work"): Promise<void> {
		const outcome = await service.submitUserInput({ text, requestId: "req-plan" });
		if (outcome.kind !== "request") throw new Error(`expected a request, got ${outcome.kind}`);
		await outcome.submission.wait(context);
		await harness.harness.waitForIdle(context);
	}

	it("saves a plan as version 1 and reads it back (AC-02)", async () => {
		const { runtime, service } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["count the marker"], taskIds: ["t1"] } }],
		]);
		try {
			await drive(runtime, service);
			const stored = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context);
			expect(stored?.version).toBe(1);
			expect(stored?.goals).toEqual(["count the marker"]);
			expect(stored?.taskIds).toEqual(["t1"]);
			expect(stored?.supersedes).toBeUndefined();
			expect(stored?.savedAt).toBe(1_700_000_000_000);
			// The requirement identity is bound by the program: the model has no
			// parameter for it, so it cannot claim a plan belongs to a requirement it
			// does not.
			expect(stored?.requestId).toBe("req-plan");
			expect(stored?.requestVersion).toBe(1);
			// And the persisted index lists it for this request.
			expect((await service.readRequest()).plans.map((plan) => plan.planId)).toEqual(["plan-a"]);
		} finally {
			await runtime.close();
		}
	});

	it("bumps the version on a second save and records what it superseded (AC-02)", async () => {
		const { runtime, service } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["v1"], taskIds: ["t1"] } }],
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["v2"], taskIds: ["t1", "t2"], expectedVersion: 1 } }],
		]);
		try {
			await drive(runtime, service);
			const stored = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context);
			expect(stored?.version).toBe(2);
			expect(stored?.supersedes).toBe(1);
			expect(stored?.taskIds).toEqual(["t1", "t2"]);
			// The persisted index is *refreshed*, not only inserted: the restoration
			// section renders from the index, so a stale entry would tell the model
			// `plan-a v1` after the plan had moved to v2.
			const service2 = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(service2?.plans.filter((entry) => entry.planId === "plan-a").map((entry) => entry.version)).toEqual([2]);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a save whose expected version is stale, and leaves the stored plan alone (AC-02)", async () => {
		const { runtime, service } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["v1"], taskIds: ["t1"] } }],
			// The model re-sends version 1 after the plan already moved to 1; the
			// expected version must equal the stored one, and 0 is not 1.
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["stale"], taskIds: ["t9"], expectedVersion: 0 } }],
		]);
		try {
			await drive(runtime, service);
			const stored = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context);
			expect(stored?.version).toBe(1);
			expect(stored?.goals).toEqual(["v1"]);
			expect(stored?.taskIds).toEqual(["t1"]);
		} finally {
			await runtime.close();
		}
	});

	it("dispatches an admitted batch to the injected executor (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]?.map((task) => task.id)).toEqual(["t1"]);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a batch the authorization policy denies, before the executor sees it (AC-03)", async () => {
		let seen: { readonly requestId: string; readonly planId: string; readonly planVersion: number; readonly taskIds: readonly string[] } | undefined;
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{
				authorizeDispatch: async (input) => {
					seen = {
						requestId: input.requestId,
						planId: input.planId,
						planVersion: input.planVersion,
						taskIds: input.tasks.map((task) => task.id),
					};
					return { allowed: false, reason: "policy forbids this task" };
				},
			},
		);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
			expect(seen).toEqual({ requestId: "req-plan", planId: "plan-a", planVersion: 1, taskIds: ["t1"] });
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = doc?.receipts.find((entry) => entry.opKey.startsWith("dispatch:"));
			expect(receipt?.isError).toBe(true);
			expect(receipt?.result).toContain("not_authorized");
			expect(receipt?.result).toContain("policy forbids this task");
			expect(doc?.dispatchAttempts ?? []).toHaveLength(0);
			expect((await service.readRequest()).openQuestionIds).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it("lets an authorized batch reach the executor (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{ authorizeDispatch: async () => ({ allowed: true }) },
		);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);
		} finally {
			await runtime.close();
		}
	});

	it("treats a throwing authorization policy as a denial, never as permission (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{
				authorizeDispatch: async () => {
					throw new Error("policy service is offline");
				},
			},
		);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = doc?.receipts.find((entry) => entry.opKey.startsWith("dispatch:"));
			expect(receipt?.isError).toBe(true);
			expect(receipt?.result).toContain("not_authorized");
			expect(receipt?.result).toContain("policy service is offline");
		} finally {
			await runtime.close();
		}
	});

	it("refuses an invalid dispatch quota before serving (AC-03)", async () => {
		const runtime = await openProbe({ databasePath, provider: "faux", fauxResponses: ["ok"] });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			await expect(
				openMainService({
					harness: runtime.harness,
					registry: runtime.registry,
					context,
					conversationId: root.id,
					dispatch: async () => [],
					dispatchQuota: { maxAttempts: -1 },
				}),
			).rejects.toThrow("dispatchQuota.maxAttempts must be a non-negative integer");
		} finally {
			await runtime.close();
		}
	});

	it("reserves one dispatch attempt, charges nothing for a refusal, and refuses the next dispatch (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
				// Refused on the stale version: this must not spend the request's attempt.
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 99, tasks: [taskSpec("t1")] } }],
				// Admitted: this is the one attempt the budget allows.
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
				// Refused: the same request has no attempt left.
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{ dispatchQuota: { maxAttempts: 1 } },
		);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(doc?.dispatchAttempts ?? []).toHaveLength(1);
			expect(doc?.dispatchAttempts?.[0]?.requestId).toBe("req-plan");
			expect(doc?.dispatchAttempts?.[0]?.opKey.startsWith("dispatch:")).toBe(true);
			const quotaRefusals = (doc?.receipts ?? []).filter((entry) => entry.result?.includes("quota_exhausted"));
			expect(quotaRefusals).toHaveLength(1);
		} finally {
			await runtime.close();
		}
	});

	it("persists an admitted dispatch attempt across a reopen (AC-03)", async () => {
		const first = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{ dispatchQuota: { maxAttempts: 1 } },
		);
		try {
			await drive(first.runtime, first.service);
		} finally {
			await first.runtime.close();
		}

		const second = await openProbe({ databasePath, provider: "faux", fauxResponses: ["ok"] });
		try {
			const root = await openRoot(second);
			second.harness.resume();
			const doc = await second.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(doc?.dispatchAttempts ?? []).toHaveLength(1);
			expect(doc?.dispatchAttempts?.[0]?.requestId).toBe("req-plan");
		} finally {
			await second.close();
		}
	});

	it("turns blocked sub-tasks into one program-created Main question and ends the run (AC-03)", async () => {
		const { runtime, service, dispatched, requests } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1", "t2", "t3"] } }],
				[
					{
						name: "dispatch_tasks",
						arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1"), taskSpec("t2"), taskSpec("t3")] },
					},
				],
			],
			{
				dispatch: async () => [
					{ taskId: "t1", status: "blocked", detail: "the source file is missing" },
					{ taskId: "t2", status: "blocked", detail: "the account is not authorized" },
					{ taskId: "t3", status: "accepted" },
				],
			},
		);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);
			// Two provider requests: the save turn and the dispatch turn. If the
			// blocked dispatch had not ended the run, the model would have been asked
			// again and this would be three.
			expect(requests).toHaveLength(2);
			const view = await service.readRequest();
			expect(view.openQuestionIds).toHaveLength(1);
			const question = view.questions.find((entry) => entry.questionId === view.openQuestionIds[0]);
			expect(question).toBeDefined();
			if (question === undefined) return;
			// One question covers every blocked task; the model never called
			// request_clarification in this script.
			expect(question.question).toContain("t1");
			expect(question.question).toContain("the source file is missing");
			expect(question.question).toContain("t2");
			expect(question.question).toContain("the account is not authorized");
			expect(question.blockingScope).toEqual(["t1", "t2"]);
			// The dispatch ended the run with a handoff, so the model did not get a
			// next turn in which it could ignore the blocked tasks.
			expect((await service.status()).busy).toBe(false);
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = doc?.receipts.find((entry) => entry.opKey.startsWith("dispatch:"));
			expect(receipt?.isError).toBe(true);
			expect(receipt?.control?.handoff).toContain("the source file is missing");
			expect(receipt?.control?.handoff).toContain("the account is not authorized");
			// The program-created question is a real question: the application can
			// answer it, and doing so unblocks the task.
			const answer = await service.submitUserInput({ text: "use the file in the archive", answerTo: question.questionId, sufficient: true });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") return;
			await answer.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const after = await service.readRequest();
			const recorded = after.answers.find((entry) => entry.questionId === question.questionId);
			expect(recorded?.text).toBe("use the file in the archive");
			expect(recorded?.sufficient).toBe(true);
			// The answer resolved the question it answered. The handoff reset the
			// model's context, so the scripted model retried the dispatch and asked a
			// *new* question when the task was still blocked; that new question is not
			// a failure to resolve the first one.
			expect(after.openQuestionIds).not.toContain(question.questionId);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a dispatch against a stale plan version, and the executor never runs (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 99, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a dispatch while a question blocking the whole request is open (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{ seededQuestions: ["q-1"] },
		);
		try {
			// A question with no blocking scope blocks the whole request.
			await runtime.harness.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, 1 as never, "req-plan", { requestId: "req-plan" });
				state.questions = [...state.questions, { questionId: "q-1", question: "which file?", reason: "ambiguous", blockingScope: [], askedAt: 1 }];
			}, context);
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("lets an independent task dispatch while a scoped question blocks only another (AC-03)", async () => {
		// AC-03: "独立不受影响任务可执行". A question scoped to task t1 must not stop
		// a batch that dispatches t2. The model's `relatedQuestionIds` is deliberately
		// absent here, and it would not help: the question's own persisted scope is
		// the authority, so a model cannot unblock work by declining to list it.
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1", "t2"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t2")] } }],
		]);
		try {
			await runtime.harness.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, 1 as never, "req-plan", { requestId: "req-plan" });
				state.questions = [...state.questions, { questionId: "q-1", question: "which file?", reason: "ambiguous", blockingScope: ["t1"], askedAt: 1 }];
			}, context);
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);
			expect(dispatched[0]?.map((task) => task.id)).toEqual(["t2"]);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a task the scoped question names even when the plan omits it (AC-03)", async () => {
		// The inverse, and the reason the scope is authoritative: a model that drops
		// the question from `relatedQuestionIds` must not thereby unblock the task the
		// question itself says it blocks.
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await runtime.harness.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, 1 as never, "req-plan", { requestId: "req-plan" });
				state.questions = [
					...state.questions,
					{ questionId: "q-1", question: "which file?", reason: "ambiguous", blockingScope: ["t1"], askedAt: 1 },
				];
			}, context);
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a plan written for a superseded requirement version (AC-03, AC-04)", async () => {
		// A plan's own `version` says nothing about *which goal* it serves. The plan
		// is saved bound to the requirement as it stands, so after the user restates
		// the requirement the stored plan and the active requirement disagree — and
		// `dispatch_tasks` refuses on exactly that disagreement.
		//
		// The dispatch is held behind a gate rather than sequenced by turn counting:
		// the harness decides when the model speaks again, and a router that indexed
		// its script by provider request let the dispatch fire during the save run,
		// which asserted the test's own bookkeeping instead of the contract.
		const gate = { open: false };
		const saved = { done: false };
		const dispatched: string[][] = [];
		const router: FauxResponseFactory = () => {
			if (!saved.done) {
				saved.done = true;
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-a", goals: ["old goal"], taskIds: ["t1"] }, { id: "save-1" })], { stopReason: "toolUse" });
			}
			if (!gate.open) return fauxAssistantMessage([fauxText("waiting for the user to restate the requirement")]);
			return fauxAssistantMessage([fauxToolCall("dispatch_tasks", { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] }, { id: "dispatch-1" })], { stopReason: "toolUse" });
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		const root = await openRoot(runtime);
		runtime.harness.resume();
		const service = await openMainService({
			harness: runtime.harness,
			registry: runtime.registry,
			context,
			conversationId: root.id,
			dispatch: async ({ tasks }) => {
				dispatched.push(tasks.map((task) => task.id));
				return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
			},
			now: () => 1_700_000_000_000,
		});
		try {
			// Round 1: the model saves the plan while the requirement is v1.
			const first = await service.submitUserInput({ text: "plan the work", requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const stored = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context);
			expect(stored?.requestId).toBe("req-plan");
			expect(stored?.requestVersion).toBe(1);

			// The user restates the requirement: the active request moves to v2.
			const restated = await service.submitUserInput({
				text: "actually, do the other thing",
				requestId: "req-plan",
				expectedRequestVersion: 1,
			});
			expect(restated.kind).toBe("request");
			if (restated.kind !== "request") return;
			expect(restated.requestVersion).toBe(2);
			await restated.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			// Still gated: the model has had no chance to dispatch yet.
			expect(dispatched).toHaveLength(0);

			// Now the model dispatches the plan it saved — against requirement v2. The
			// nudge re-states the *same* request, so the active requirement stays v2.
			gate.open = true;
			const third = await service.submitUserInput({
				text: "go ahead",
				requestId: "req-plan",
				expectedRequestVersion: 2,
			});
			if (third.kind !== "request") throw new Error("expected a request");
			expect(third.requestVersion).toBe(3);
			await third.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The plan is still bound to v1 while the active requirement is at v3, and
			// the executor was never reached.
			expect((await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context))?.requestVersion).toBe(1);
			expect((await service.readRequest()).requestVersion).toBe(3);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses the old plan and keeps its own plan valid when a restatement is consumed (AC-03, AC-04)", async () => {
		// The reviewer's ordering point, made mechanical. A restatement queued while a
		// round runs is placed by the Harness and its run *starts* before any service
		// call reads the queue. The requirement version therefore has to be allocated
		// when the input is admitted, not when the queue is later reconciled:
		//
		//   * derived late, the run resolves the *pre-restatement* version, so the old
		//     v1 plan still matches and is admitted — the old goal runs under the new
		//     instructions;
		//   * the late bump also lands *after* the run saved its own plan, leaving that
		//     plan at v1 while the requirement moved to v2, so the work the restatement
		//     actually asked for can never be dispatched.
		//
		// Both are asserted against persisted facts and the injected executor, not
		// against what a tool printed.
		const dispatched: string[][] = [];
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async (request) => {
			const text = flatten(request.messages);
			if (!parkedOnce) {
				// Run 1 (the original requirement): save the plan for the OLD goal, then
				// park so the user's restatement is queued rather than submitted.
				if (!text.includes("saved plan")) {
					return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-old", goals: ["old goal"], taskIds: ["t1"] }, { id: "save-old" })], {
						stopReason: "toolUse",
					});
				}
				parkedOnce = true;
				await parked;
				return fauxAssistantMessage([fauxText("run 1 done")]);
			}
			// Run 2: the run made of the queued restatement. It saves a plan for the NEW
			// goal, then tries to dispatch the OLD plan — which must be refused, because
			// the plan was written for the requirement the user has now replaced.
			if (!text.includes("saved plan plan-new")) {
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-new", goals: ["new goal"], taskIds: ["t1"] }, { id: "save-new" })], {
					stopReason: "toolUse",
				});
			}
			if (!text.includes("dispatched plan") && !text.includes("dispatch refused")) {
				return fauxAssistantMessage([fauxToolCall("dispatch_tasks", { planId: "plan-old", version: 1, tasks: [taskSpec("t1")] }, { id: "dispatch-old" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async ({ tasks }) => {
					dispatched.push(tasks.map((task) => task.id));
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				now: () => 1_700_000_000_000,
			});

			const first = await service.submitUserInput({ text: "plan the old work", requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");

			// Wait until run 1 has saved its plan and is parked, so the restatement is
			// admitted to the queue rather than submitted.
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline) {
				const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
				if ((doc?.plans.length ?? 0) > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const restated = await service.submitUserInput({ text: "actually do the new work", requestId: "req-plan" });
			expect(restated.kind).toBe("queued");

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The old plan was never executed: its requirement version is not the one the
			// restatement's run serves.
			expect(dispatched).toHaveLength(0);
			// The plan the restatement's run saved is bound to the version the
			// requirement will be at — the allocated one — not to the pre-restatement v1.
			const savedNew = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-new", context);
			expect(savedNew?.requestId).toBe("req-plan");
			expect(savedNew?.requestVersion).toBe(2);

			// Reconciling the queue (any readQueue/withdrawQueued does this) must not move
			// the requirement off that version: the allocation happened at admission, so
			// there is nothing left to bump. A late derivation here is exactly what used
			// to invalidate the plan the run had just saved.
			await service.readQueue();
			const view = await service.readRequest();
			expect(view.requestVersion).toBe(2);
			expect(view.text).toBe("actually do the new work");
			expect((await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-new", context))?.requestVersion).toBe(2);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("consumes a queue record written before the allocation field existed (AC-01, AC-03)", async () => {
		// `allocatedVersion` was added to the queue record after the shape had already
		// been persisted, so a record from before that carries no value. Reading it as
		// a number would persist `undefined` as the requirement version — or `NaN`
		// through the `Math.max`, which is not strict JSON and makes the commit throw.
		// Either way the requirement would be left with a corrupt version, so the
		// missing value has to be read as "not recorded" and derived instead.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let parkedOnce = false;
		const router: FauxResponseFactory = async () => {
			if (!parkedOnce) {
				parkedOnce = true;
				await parked;
			}
			return fauxAssistantMessage([fauxText("done")]);
		};

		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
			});

			// A restatement of the *running* request, so its document already exists and
			// reconciliation takes the `Math.max` path — the one that yields `NaN`.
			const first = await service.submitUserInput({ text: "plan the work", requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			const queued = await service.submitUserInput({ text: "actually do the other thing", requestId: "req-plan" });
			expect(queued.kind).toBe("queued");

			// Rewrite the record to the older shape: no `allocatedVersion` at all.
			await runtime.harness.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, 1 as never);
				doc.queue = doc.queue.map((entry) => {
					const { allocatedVersion, ...rest } = entry as Record<string, unknown> & { allocatedVersion?: number };
					void allocatedVersion;
					return rest as never;
				});
			}, context);

			release?.();
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			// Reconciling must not throw, and must leave a real version behind.
			await service.readQueue();

			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const view = await service.readRequest();
			expect(Number.isInteger(view.requestVersion)).toBe(true);
			expect(view.requestVersion).toBeGreaterThanOrEqual(1);
			expect(Number.isInteger(doc?.requestVersion)).toBe(true);
			expect(view.text).toBe("actually do the other thing");
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("refuses a dispatch whose dependency is not accepted (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t2"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t2", ["t1"])] } }],
			],
			{ unacceptedDependencies: (tasks) => tasks.flatMap((task) => task.dependencies) },
		);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a dispatch that runs a task the plan does not name (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			// The plan names t1; the model tries to run t2 as well.
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1"), taskSpec("t2")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses an invalid task batch at the contract boundary (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			// No schemaVersion: the shared TaskSpec contract refuses it.
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [{ id: "t1", purpose: "x" }] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a dispatch when no plan was ever saved (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript([
			[{ name: "dispatch_tasks", arguments: { planId: "plan-missing", version: 1, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("keeps the plans listed by the service across a close and reopen (AC-03)", async () => {
		// The old test read the plan document directly by a key the test already
		// knew, which proved nothing about the shared service coming back. This one
		// reopens through `openMainService` and reads its public list: an in-memory
		// index loses every plan on reopen, which is exactly what was wrong before.
		const first = await runScript([[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["survive"], taskIds: ["t1"] } }]]);
		try {
			await drive(first.runtime, first.service);
		} finally {
			await first.runtime.close();
		}

		const second = await openProbe({ databasePath, provider: "faux", fauxResponses: ["ok"] });
		try {
			const root = await openRoot(second);
			second.harness.resume();
			const reopened = await openMainService({
				harness: second.harness,
				registry: second.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
				now: () => 1_700_000_000_000,
			});
			// The active request survived, and so did its plan list.
			const view = await reopened.readRequest();
			expect(view.requestId).toBe("req-plan");
			expect(view.plans.map((plan) => plan.planId)).toEqual(["plan-a"]);
			expect(view.plans[0]?.goals).toEqual(["survive"]);
			expect(view.plans[0]?.requestId).toBe("req-plan");
			await reopened.close();
		} finally {
			await second.close();
		}
	});

	it("refuses to let a second request take over a planId, and never lists another request's plan (AC-04, AC-05)", async () => {
		// A plan document is keyed by `planId` alone, so two requests that both use one
		// id share the document. The index says which request a plan was saved for, but
		// the document is the authority: without an ownership check the second request
		// silently takes over the first's plan, and the first's index entry then points
		// at a document describing someone else's goals and tasks.
		const runtime = await openProbe({
			databasePath,
			provider: "faux",
			fauxRouter: (() => {
				let turn = 0;
				return () => {
					turn += 1;
					if (turn === 1) return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-a", goals: ["A goal"], taskIds: ["t1"] }, { id: "a1" })], { stopReason: "toolUse" });
					if (turn === 2) return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-a", goals: ["B goal"], taskIds: ["t2"] }, { id: "b1" })], { stopReason: "toolUse" });
					return fauxAssistantMessage([fauxText("nothing left to do")]);
				};
			})(),
		});
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [], now: () => 1_700_000_000_000 });

			// Request A saves plan-a.
			const a = await service.submitUserInput({ text: "A work", requestId: "req-a" });
			if (a.kind !== "request") throw new Error("expected a request");
			await a.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect((await service.readRequest()).plans.map((plan) => plan.goals)).toEqual([["A goal"]]);

			// Request B tries to take the same planId. It is refused, so A's document is
			// not overwritten.
			const b = await service.submitUserInput({ text: "B work", requestId: "req-b" });
			if (b.kind !== "request") throw new Error("expected a request");
			await b.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// B has no plans: the plan belongs to A, and the ownership check refused B's
			// save rather than letting it take over.
			expect((await service.readRequest()).requestId).toBe("req-b");
			expect((await service.readRequest()).plans).toEqual([]);

			// The document still describes A's goal.
			const doc = await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context);
			expect(doc?.requestId).toBe("req-a");
			expect(doc?.goals).toEqual(["A goal"]);
		} finally {
			await runtime.close();
		}
	});

	it("refuses to dispatch a superseded plan version (AC-03)", async () => {
		// The contract's "saving is not permission to execute" rule, made concrete:
		// the plan was saved and is real, but the version the model is dispatching
		// has been superseded, so nothing runs.
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["v1"], taskIds: ["t1"] } }],
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["v2"], taskIds: ["t1"], expectedVersion: 1 } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			// The plan really is stored, at version 2.
			expect((await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context))?.version).toBe(2);
			// And dispatching the superseded version 1 reached no executor.
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("does not execute a dispatch twice when the call is replayed (AC-03)", async () => {
		// `replay: "safe"` is not exactly-once: the locked Harness re-executes a
		// call that is replayed after an interruption. The receipt is what makes the
		// replay report the result it already produced instead of dispatching again.
		//
		// The replay is driven at the *tool* boundary, with the same call identity —
		// the tool task id and the call id, which is what a replay repeats. (A second
		// `submitUserInput` would be deduplicated by the Harness's submission key
		// before any tool ran, which is why it proved nothing.)
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);

			// The identity the original call recorded: `dispatch:<taskId>:<callId>`.
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = doc?.receipts.find((entry) => entry.opKey.startsWith("dispatch:"));
			expect(receipt).toBeDefined();
			const [kind, taskId, ...callParts] = receipt!.opKey.split(":");
			expect(kind).toBe("dispatch");

			// Re-execute the *same* call through the extension, with the same identity a
			// replay would carry.
			const extension = createMainExtension({
				activeRequest: async () => ({ requestId: "req-plan", requestVersion: 1 }),
				dispatch: async ({ tasks }) => {
					(dispatched as TaskSpec[][]).push([...tasks]);
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				readOperation: async (opKey) => {
					const found = doc?.receipts.find((entry) => entry.opKey === opKey);
					return found === undefined ? undefined : { result: found.result, control: found.control };
				},
				recordOperation: async () => {},
				now: () => 1_700_000_000_000,
			});
			const dispatch = extension.tools?.find((tool) => tool.name === "dispatch_tasks");
			expect(dispatch).toBeDefined();
			const api = {
				taskId: taskId as never,
				callId: callParts.join(":"),
				conversationId: 1 as never,
				commit: async (change: (tx: never) => unknown) => await runtime.harness.commit(change as never, context),
			};
			const replayed = await dispatch!.execute(
				{ planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } as never,
				api as never,
				context,
			);
			expect(replayed.isError).toBeFalsy();
			expect(JSON.stringify(replayed.output)).toContain("dispatched plan plan-a");
			// The executor was not reached a second time.
			expect(dispatched).toHaveLength(1);
		} finally {
			await runtime.close();
		}
	});

	it("reports a dispatch that was begun but never finished instead of running it again (AC-03)", async () => {
		// The window `replay: "safe"` leaves open: the executor ran, the process died
		// before the receipt was written. The begun-but-unfinished marker is what makes
		// a replay report that instead of dispatching a second time.
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(1);
			// The identity the original call recorded, so the replay repeats it exactly.
			const before = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = before?.receipts.find((entry) => entry.opKey.startsWith("dispatch:"));
			expect(receipt).toBeDefined();
			const [, taskId, ...callParts] = receipt!.opKey.split(":");

			// Simulate the crash: drop the finished result, leaving only the start
			// marker the tool writes before the executor runs.
			await runtime.harness.commit(async (tx) => {
				const doc = await tx.doc(MainServiceDoc, 1 as never);
				doc.receipts = doc.receipts.map((entry) => (entry.opKey === receipt!.opKey ? { opKey: entry.opKey, at: entry.at } : entry));
			}, context);
			const after = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(after?.receipts.find((entry) => entry.opKey === receipt!.opKey)?.result).toBeUndefined();

			const extension = createMainExtension({
				activeRequest: async () => ({ requestId: "req-plan", requestVersion: 1 }),
				dispatch: async ({ tasks }) => {
					(dispatched as TaskSpec[][]).push([...tasks]);
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				readOperation: async (opKey) => {
					const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
					const found = doc?.receipts.find((entry) => entry.opKey === opKey);
					return found === undefined ? undefined : { result: found.result, control: found.control };
				},
				recordOperation: async () => {},
				now: () => 1_700_000_000_000,
			});
			const dispatch = extension.tools?.find((tool) => tool.name === "dispatch_tasks");
			const api = {
				taskId: taskId as never,
				callId: callParts.join(":"),
				conversationId: 1 as never,
				commit: async (change: (tx: never) => unknown) => await runtime.harness.commit(change as never, context),
			};
			const replayed = await dispatch!.execute(
				{ planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } as never,
				api as never,
				context,
			);
			expect(replayed.isError).toBe(true);
			// The uncertain semantics are preserved: not re-running is not the same as
			// having succeeded, and the report says so rather than reading as a
			// completion receipt.
			const text = JSON.stringify(replayed.output);
			expect(text).toContain("did NOT complete");
			expect(text).toContain("may have partially run");
			expect(text).toContain("outcome is unknown");
			expect(text).toContain("not a success");
			// And it did not run the batch again.
			expect(dispatched).toHaveLength(1);
		} finally {
			await runtime.close();
		}
	});

	it("replays a save whose receipt was lost as the original success, not a stale refusal (AC-02)", async () => {
		// The window the reviewer named: the plan is committed but the process dies
		// before its receipt lands. A `replay: "safe"` rerun then finds the plan at
		// version 1 while the original call asked for version 0 — and would refuse the
		// save that in fact succeeded. The receipt is written in the *same*
		// transaction as the plan, so this window does not exist; the test proves it by
		// replaying the same call identity and getting the original result back.
		const { runtime, service } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
		]);
		try {
			await drive(runtime, service);
			const before = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = before?.receipts.find((entry) => entry.opKey.startsWith("save-plan:"));
			expect(receipt).toBeDefined();
			const [, taskId, ...callParts] = receipt!.opKey.split(":");

			// Replay the same call. The plan is already at version 1, so a naive
			// re-decision would refuse; the receipt returns the original success.
			const extension = createMainExtension({
				activeRequest: async () => ({ requestId: "req-plan", requestVersion: 1 }),
				dispatch: async () => [],
				readOperation: async (opKey) => {
					const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
					const found = doc?.receipts.find((entry) => entry.opKey === opKey);
					return found === undefined ? undefined : { result: found.result, isError: found.isError, control: found.control };
				},
				recordOperation: async () => {},
				now: () => 1_700_000_000_000,
			});
			const save = extension.tools?.find((tool) => tool.name === "save_plan");
			const api = {
				taskId: taskId as never,
				callId: callParts.join(":"),
				conversationId: 1 as never,
				commit: async (change: (tx: never) => unknown) => await runtime.harness.commit(change as never, context),
			};
			const replayed = await save!.execute({ planId: "plan-a", goals: ["g"], taskIds: ["t1"] } as never, api as never, context);
			expect(replayed.isError).toBeFalsy();
			expect(JSON.stringify(replayed.output)).toContain("saved plan plan-a version 1");
			// The plan did not advance a second version: the replay was a replay.
			expect((await runtime.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context))?.version).toBe(1);
		} finally {
			await runtime.close();
		}
	});

	it("replays a refused save as an error, not an ordinary tool result (AC-02)", async () => {
		// The reviewer's point about `isError`: a refusal that replays without its error
		// flag reads to the model as a success. The flag travels with the receipt.
		const { runtime, service } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["stale"], taskIds: ["t1"], expectedVersion: 0 } }],
		]);
		try {
			await drive(runtime, service);
			const before = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipts = before?.receipts.filter((entry) => entry.opKey.startsWith("save-plan:")) ?? [];
			const refused = receipts.find((entry) => entry.isError === true);
			expect(refused).toBeDefined();
			expect(refused!.result).toContain("save_plan refused");
			const [, taskId, ...callParts] = refused!.opKey.split(":");

			const extension = createMainExtension({
				activeRequest: async () => ({ requestId: "req-plan", requestVersion: 1 }),
				dispatch: async () => [],
				readOperation: async (opKey) => {
					const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
					const found = doc?.receipts.find((entry) => entry.opKey === opKey);
					return found === undefined ? undefined : { result: found.result, isError: found.isError, control: found.control };
				},
				recordOperation: async () => {},
				now: () => 1_700_000_000_000,
			});
			const save = extension.tools?.find((tool) => tool.name === "save_plan");
			const api = {
				taskId: taskId as never,
				callId: callParts.join(":"),
				conversationId: 1 as never,
				commit: async (change: (tx: never) => unknown) => await runtime.harness.commit(change as never, context),
			};
			const replayed = await save!.execute({ planId: "plan-a", goals: ["stale"], taskIds: ["t1"], expectedVersion: 0 } as never, api as never, context);
			expect(replayed.isError).toBe(true);
			expect(JSON.stringify(replayed.output)).toContain("save_plan refused");
		} finally {
			await runtime.close();
		}
	});

	it("replays a refused dispatch as an error, not an ordinary tool result (AC-03)", async () => {
		// The dispatch half of the same rule the save replay follows: a refusal
		// recorded `isError: true`, and a replay that drops the flag turns a refused
		// dispatch into an ordinary tool result the model reads as a success.
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } }],
			// A stale version: refused at admission, nothing executed.
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 9, tasks: [taskSpec("t1")] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
			const before = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const receipt = before?.receipts.find((entry) => entry.opKey.startsWith("dispatch:"));
			expect(receipt).toBeDefined();
			expect(receipt!.isError).toBe(true);
			const [, taskId, ...callParts] = receipt!.opKey.split(":");

			const extension = createMainExtension({
				activeRequest: async () => ({ requestId: "req-plan", requestVersion: 1 }),
				dispatch: async () => [],
				readOperation: async (opKey) => {
					const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
					const found = doc?.receipts.find((entry) => entry.opKey === opKey);
					return found === undefined ? undefined : { result: found.result, isError: found.isError, control: found.control };
				},
				recordOperation: async () => {},
				now: () => 1_700_000_000_000,
			});
			const dispatch = extension.tools?.find((tool) => tool.name === "dispatch_tasks");
			const api = {
				taskId: taskId as never,
				callId: callParts.join(":"),
				conversationId: 1 as never,
				commit: async (change: (tx: never) => unknown) => await runtime.harness.commit(change as never, context),
			};
			const replayed = await dispatch!.execute({ planId: "plan-a", version: 9, tasks: [taskSpec("t1")] } as never, api as never, context);
			expect(replayed.isError).toBe(true);
			expect(JSON.stringify(replayed.output)).toContain("dispatch refused");
		} finally {
			await runtime.close();
		}
	});

	it("refuses a dependency-bearing dispatch when no checker can vouch for it (AC-03)", async () => {
		// "No unaccepted dependencies" is only a fact when something established it.
		// With no `unacceptedDependencies` supplied, the absence of the check must not
		// read as the absence of blockers — otherwise a batch that declares a
		// dependency reaches the executor unverified.
		const { runtime, service, dispatched } = await runScript([
			[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1", "t2"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1"), taskSpec("t2", ["t1"])] } }],
		]);
		try {
			await drive(runtime, service);
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("ends the run when the question shares its round with another tool (AC-02)", async () => {
		// The reason `handoff` replaced `terminate`: `terminate` fires only when
		// *every* call of the round asks for it, so one sibling call silently kept
		// the run going. `handoff` ends the run from any single call, which is what
		// AC-02's "问题结束当前模型轮次" asks for. The sibling still runs — the
		// control is applied at the boundary, after the round's tools are terminal.
		const { runtime, service, requests } = await runScript([
			[
				{ name: "request_clarification", arguments: { question: "Which file?", reason: "two files match" } },
				{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"] } },
			],
		]);
		try {
			await drive(runtime, service);
			// Exactly one provider request: the round ended, and no second turn ran.
			expect(requests).toHaveLength(1);
			// The question is open and the plan was saved — both happened in that one
			// round, and neither was lost to the reset.
			expect((await service.readRequest()).openQuestionIds).toHaveLength(1);
			expect((await service.readRequest()).plans.map((plan) => plan.planId)).toEqual(["plan-a"]);
			// The conversation is still the same one, and the handoff left a reset
			// point in it rather than starting a new conversation.
			const entries = await (await runtime.harness.conversation(1 as never, context))!.entries({ order: "ascending" }, 200, undefined, context);
			expect(entries.items.some((entry) => entry.kind === "pi.reset")).toBe(true);
			expect(entries.items.some((entry) => entry.kind === "pi.tool-result")).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("gives the next round the request, the answer and the open questions (AC-01, AC-02)", async () => {
		// A handoff *replaces* the model's context, so anything it omits is context
		// the next round cannot see. The payload is therefore asserted on the reset
		// entry itself — the thing the next generation actually starts from.
		const { runtime, service } = await runScript([
			[{ name: "request_clarification", arguments: { question: "Which file?", reason: "two files match" } }],
		]);
		try {
			await drive(runtime, service, `${MARKER2} plan the work`);
			const entries = await (await runtime.harness.conversation(1 as never, context))!.entries({ order: "ascending" }, 200, undefined, context);
			const reset = entries.items.find((entry) => entry.kind === "pi.reset");
			expect(reset).toBeDefined();
			// The payload the program built, as the model will receive it.
			const payload = reset?.model?.[0]?.content;
			expect(typeof payload).toBe("string");
			const text = typeof payload === "string" ? payload : "";
			// The request as the user actually typed it.
			expect(text).toContain(MARKER2);
			expect(text).toContain("req-plan v1");
			// The question and why it was asked.
			expect(text).toContain("Which file?");
			expect(text).toContain("two files match");
			// And it did not invent an answer the user never gave.
			expect(text).toContain("has not answered yet");
		} finally {
			await runtime.close();
		}
	});

	it("carries a recorded answer in the handoff the next round reads (AC-01, AC-02)", async () => {
		// The other half of the same contract: once the user HAS answered, the next
		// round must start from that answer rather than re-asking. The payload is
		// read from the reset entry, which is where a reset context begins.
		const gate = { answered: false };
		const asked = { done: false };
		const router: FauxResponseFactory = () => {
			if (!asked.done) {
				asked.done = true;
				return fauxAssistantMessage([fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match" }, { id: "ask-1" })], { stopReason: "toolUse" });
			}
			if (!gate.answered) return fauxAssistantMessage([fauxText("waiting for the user")]);
			return fauxAssistantMessage([fauxText("the user answered, so I can plan now")]);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({ harness: runtime.harness, registry: runtime.registry, context, conversationId: root.id, dispatch: async () => [] });

			const first = await service.submitUserInput({ text: `${MARKER2} plan the work`, requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			// The user answers, and the next round is unlocked.
			const answer = await service.submitUserInput({ text: "Use report.txt", answerTo: questionId, sufficient: true });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") return;
			await answer.submission.wait(context);
			// The handoff for *this* run was built before the answer existed, so the
			// next round's payload is read after the gate opens.
			gate.answered = true;
			const second = await service.submitUserInput({ text: `${MARKER2} now plan it`, requestId: "req-plan", expectedRequestVersion: 1 });
			if (second.kind !== "request") throw new Error("expected a request");
			await second.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The answer reached the model, and it is not the question any more.
			expect((await service.readRequest()).openQuestionIds).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it("re-renders the restoration facts from committed state before every request (AC-01, AC-02)", async () => {
		// The handoff payload is a snapshot taken when the question tool completed; a
		// sibling tool in the same round can write after it. The restoration section
		// is therefore asserted on the *provider request itself* — rendered from
		// whatever is committed at preparation time — rather than only on the reset
		// entry the payload landed in.
		//
		// The proof that it is live state and not a snapshot: turn 1 saves a plan,
		// turn 2 asks a question, and the round prepared *after* the user's answer
		// must show both — the plan (written a round earlier) and the answer (written
		// between the two runs).
		const requests: string[] = [];
		let turn = 0;
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			turn += 1;
			if (turn === 1) {
				return fauxAssistantMessage([fauxToolCall("save_plan", { planId: "plan-a", goals: ["g"], taskIds: ["t1"] }, { id: "call-1" })], { stopReason: "toolUse" });
			}
			if (turn === 2) {
				return fauxAssistantMessage([fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match" }, { id: "call-2" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("nothing left to do")]);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
				now: () => 1_700_000_000_000,
			});

			const outcome = await service.submitUserInput({ text: `${MARKER2} plan the work`, requestId: "req-plan" });
			if (outcome.kind !== "request") throw new Error("expected a request");
			await outcome.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			// The section as it stood while the question was open, on the request that
			// asked it: the plan from the previous round is already visible, which a
			// payload-only view of *that* round would not show.
			const asking = requests[requests.length - 1] ?? "";
			expect(asking).toContain("main-restoration");
			expect(asking).toContain("Request req-plan v1");
			expect(asking).toContain(MARKER2);
			expect(asking).toContain("plan-a v1");

			// Now the user answers, and the next run is prepared. Its request must carry
			// the request, the recorded answer and the plan — read from committed state,
			// not from the earlier payload.
			requests.length = 0;
			const answer = await service.submitUserInput({ text: "Use report.txt", answerTo: questionId, sufficient: true });
			expect(answer.kind).toBe("answer");
			if (answer.kind !== "answer") return;
			await answer.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			const after = requests[requests.length - 1] ?? "";
			expect(after).toContain("Request req-plan v1");
			expect(after).toContain("Use report.txt");
			expect(after).toContain("plan-a v1");
			expect(after).toContain("Open questions: (none)");
		} finally {
			await runtime.close();
		}
	});

	it("walks insufficient → re-ask → sufficient → plan as one legal chain (AC-02)", async () => {
		// The whole AC-02 chain, not one link of it. Each step is asserted on a
		// durable fact: the question stays open on a vague reply, the follow-up
		// reaches the provider, the question closes, and only then does a dispatch
		// get through — with the executor's call count as the evidence that it did.
		const requests: string[] = [];
		const dispatched: string[][] = [];
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			// The round is decided by the newest user input, not by a running count:
			// one run may take several provider requests, so counting them would let
			// the script drift out from under the test.
			let newest = -1;
			for (let index = request.messages.length - 1; index >= 0; index--) {
				if (request.messages[index]!.role === "user") {
					newest = index;
					break;
				}
			}
			const said = newest >= 0 ? flatten([request.messages[newest]!]) : "";
			const tail = request.messages.slice(newest + 1);
			const sawToolResult = tail.some((message) => message.role === "toolResult");
			if (sawToolResult) return fauxAssistantMessage([fauxText("nothing left to do")]);
			if (said.includes("plan the work")) {
				// The plan is saved AND the question asked in the same round, so that in
				// the next step the open question is the *only* thing standing between
				// the model and a dispatch — otherwise a missing plan would refuse it
				// first and the assertion would prove nothing about the question.
				return fauxAssistantMessage(
					[
						fauxToolCall("save_plan", { planId: "plan-a", goals: ["g"], taskIds: ["t1"] }, { id: "save-0" }),
						fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match" }, { id: "ask-1" }),
					],
					{ stopReason: "toolUse" },
				);
			}
			// The vague reply: the model tries to dispatch anyway. It must be refused
			// while the question is still open, so the executor never runs.
			if (said.includes("not sure")) {
				return fauxAssistantMessage([fauxToolCall("dispatch_tasks", { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] }, { id: "disp-early" })], { stopReason: "toolUse" });
			}
			if (said.includes("Use report.txt")) {
				// The answer's own run: the question is resolved by the time the model
				// speaks, so the dispatch that was refused a step ago is admitted now.
				return fauxAssistantMessage([fauxToolCall("dispatch_tasks", { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] }, { id: "disp-late" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("nothing left to do")]);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async ({ tasks }) => {
					dispatched.push(tasks.map((task) => task.id));
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				now: () => 1_700_000_000_000,
			});

			// 1. The model asks (and saves the plan it will later dispatch); the question
			// is open and nothing ran.
			const first = await service.submitUserInput({ text: `${MARKER2} plan the work`, requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;
			// The plan exists, so the open question really is the only blocker below.
			expect((await service.readRequest()).plans.map((plan) => plan.planId)).toEqual(["plan-a"]);
			expect(dispatched).toHaveLength(0);

			// 2. A vague reply: recorded, but not sufficient — the question stays open.
			const vague = await service.submitUserInput({ text: "not sure", answerTo: questionId, sufficient: false });
			if (vague.kind !== "answer") throw new Error("expected an answer");
			await vague.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect((await service.readRequest()).openQuestionIds).toEqual([questionId]);
			// The model tried to dispatch here and was refused: the executor never ran.
			expect(dispatched).toHaveLength(0);

			// 3. A sufficient follow-up: it reaches the provider, closes the question,
			// and the dispatch the model had been refused is admitted in that same run —
			// the executor runs, which is the evidence the chain actually completed.
			requests.length = 0;
			const clear = await service.submitUserInput({ text: "Use report.txt", answerTo: questionId, sufficient: true });
			if (clear.kind !== "answer") throw new Error("expected an answer");
			await clear.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect(requests.some((text) => text.includes("Use report.txt"))).toBe(true);
			expect((await service.readRequest()).openQuestionIds).toEqual([]);
			expect(dispatched).toEqual([["t1"]]);
		} finally {
			await runtime.close();
		}
	});

	it("answers a simple, unambiguous request directly, asking nothing and creating no sub-task (AC-02)", async () => {
		// The contract's other AC-02 branch, and the one no test covered: a request
		// clear enough to serve as it stands. The evidence has to be the *absence* of
		// work rather than the model's word for it — the provider is asked once, no
		// question is recorded, and the executor (the only surface that can create a
		// sub-task) never runs — while the user still gets the answer itself.
		const answer = "The file holds 3 markers.";
		const requests: string[] = [];
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			return fauxAssistantMessage([fauxText(answer)]);
		};
		const dispatched: (readonly TaskSpec[])[] = [];
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async ({ tasks }) => {
					dispatched.push([...tasks]);
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				now: () => 1_700_000_000_000,
			});

			const outcome = await service.submitUserInput({ text: "count the markers in report.txt", requestId: "req-plan" });
			if (outcome.kind !== "request") throw new Error("expected a request");
			await outcome.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// One provider request carrying the user's words: the run did not go round
			// again looking for work to delegate.
			expect(requests).toHaveLength(1);
			expect(requests[0]).toContain("count the markers in report.txt");

			// Nothing was delegated, and no plan was recorded to delegate from.
			expect(dispatched).toEqual([]);
			const view = await service.readRequest();
			expect(view.requestId).toBe("req-plan");
			expect(view.text).toBe("count the markers in report.txt");
			// Not one question, so the direct answer was not a vague request quietly
			// served as if it were clear.
			expect(view.questions).toEqual([]);
			expect(view.openQuestionIds).toEqual([]);
			expect(view.plans).toEqual([]);

			// And the answer reached the conversation as an assistant turn: a run that
			// creates no sub-task still has to have served the user.
			const entries = await (await runtime.harness.conversation(1 as never, context))!.entries({ order: "ascending" }, 200, undefined, context);
			const spoken = entries.items
				.filter((entry) => entry.kind === "pi.assistant")
				.map((entry) => flatten(entry.model ?? []))
				.join("\n");
			expect(spoken).toContain(answer);
			// No tool ran at all, so `save_plan` / `dispatch_tasks` cannot have been
			// called and then rolled back.
			expect(entries.items.filter((entry) => entry.kind === "pi.tool-result")).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it("narrows a still-open question's scope on a re-ask, so an independent task runs (AC-03)", async () => {
		// A question asked *without* `blockedTaskIds` blocks the whole request. The
		// model then works out that only t1 is really in doubt, and the only way it can
		// say so is to ask the same question again. That re-ask used to hit the
		// duplicate branch and write nothing, so the scope stayed empty and t2 stayed
		// blocked for as long as the question was open — indefinitely, once an answer
		// is judged insufficient. The evidence is the executor: t2 runs while the
		// question is still open and scoped to t1 alone.
		const requests: string[] = [];
		const dispatched: string[][] = [];
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			let newest = -1;
			for (let index = request.messages.length - 1; index >= 0; index--) {
				if (request.messages[index]!.role === "user") {
					newest = index;
					break;
				}
			}
			const said = newest >= 0 ? flatten([request.messages[newest]!]) : "";
			const sawToolResult = request.messages.slice(newest + 1).some((message) => message.role === "toolResult");
			if (sawToolResult) return fauxAssistantMessage([fauxText("nothing left to do")]);
			if (said.includes("plan the work")) {
				return fauxAssistantMessage(
					[
						fauxToolCall("save_plan", { planId: "plan-a", goals: ["g"], taskIds: ["t1", "t2"] }, { id: "save-0" }),
						fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match" }, { id: "ask-1" }),
					],
					{ stopReason: "toolUse" },
				);
			}
			if (said.includes("not sure")) {
				// The re-ask: same words, now naming what actually depends on the answer.
				return fauxAssistantMessage(
					[fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match", blockedTaskIds: ["t1"] }, { id: "ask-2" })],
					{ stopReason: "toolUse" },
				);
			}
			if (said.includes("still unsure")) {
				// t2 does not depend on the answer, so it is dispatched while the question
				// is still open.
				return fauxAssistantMessage(
					[fauxToolCall("dispatch_tasks", { planId: "plan-a", version: 1, tasks: [taskSpec("t2")] }, { id: "disp-t2" })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([fauxText("nothing left to do")]);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async ({ tasks }) => {
					dispatched.push(tasks.map((task) => task.id));
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				now: () => 1_700_000_000_000,
			});

			const first = await service.submitUserInput({ text: "plan the work", requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;
			// The premise: the question as first asked blocks the entire request.
			const opened = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-plan", context);
			expect(opened?.questions[0]?.blockingScope).toEqual([]);

			// An insufficient answer, whose run re-asks with the narrower scope. It is the
			// same question — one answer per question — so no second copy is created.
			const vague = await service.submitUserInput({ text: "not sure", answerTo: questionId, sufficient: false });
			if (vague.kind !== "answer") throw new Error("expected an answer");
			await vague.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const narrowed = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-plan", context);
			expect(narrowed?.questions.filter((question) => question.question === "Which file?")).toHaveLength(1);
			expect(narrowed?.questions[0]?.blockingScope).toEqual(["t1"]);

			// A second insufficient answer: the question is still open, and t2 — which the
			// question no longer blocks — is admitted and actually executed.
			const again = await service.submitUserInput({ text: "still unsure", answerTo: questionId, sufficient: false });
			if (again.kind !== "answer") throw new Error("expected an answer");
			await again.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			expect((await service.readRequest()).openQuestionIds).toEqual([questionId]);
			expect(dispatched).toEqual([["t2"]]);
			expect(requests.some((text) => text.includes("still unsure"))).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("ends the run when the model re-asks the same question after an insufficient answer (AC-02)", async () => {
		// The branch the earlier chain test did not cover: after a vague reply the model
		// asks the *same words* again. A question with that text is already recorded,
		// so the re-ask used to hit the duplicate path and return bare text with no
		// handoff — the run continued instead of waiting for the user. It must end the
		// run exactly as a first ask does.
		const requests: string[] = [];
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			let newest = -1;
			for (let index = request.messages.length - 1; index >= 0; index--) {
				if (request.messages[index]!.role === "user") {
					newest = index;
					break;
				}
			}
			const said = newest >= 0 ? flatten([request.messages[newest]!]) : "";
			const sawToolResult = request.messages.slice(newest + 1).some((message) => message.role === "toolResult");
			if (sawToolResult) return fauxAssistantMessage([fauxText("nothing left to do")]);
			// Both the first ask and the re-ask use the same words, which is the point.
			if (said.includes("plan the work") || said.includes("not sure")) {
				return fauxAssistantMessage([fauxToolCall("request_clarification", { question: "Which file?", reason: "two files match" }, { id: `ask-${newest}` })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage([fauxText("nothing left to do")]);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
				now: () => 1_700_000_000_000,
			});

			const first = await service.submitUserInput({ text: `${MARKER2} plan the work`, requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const questionId = (await service.readRequest()).openQuestionIds[0]!;

			// The vague reply: recorded, not sufficient, question stays open. The model's
			// own run for this answer is where it re-asks — the service refuses a plain
			// input while a question is open, so the re-ask cannot be a separate submit.
			const vague = await service.submitUserInput({ text: "not sure", answerTo: questionId, sufficient: false });
			if (vague.kind !== "answer") throw new Error("expected an answer");
			await vague.submission.wait(context);
			await runtime.harness.waitForIdle(context);

			// The question is still the same open question, and it is still answerable —
			// a re-ask must not create a second, unanswerable copy.
			const view = await service.readRequest();
			expect(view.openQuestionIds).toEqual([questionId]);
			const stored = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-plan", context);
			expect(stored?.questions.filter((question) => question.question === "Which file?")).toHaveLength(1);
			// And the re-ask ended its run rather than continuing the model round: the
			// conversation holds a reset entry per ask (the first ask and the re-ask).
			const entries = await (await runtime.harness.conversation(1 as never, context))!.entries({ order: "ascending" }, 200, undefined, context);
			expect(entries.items.filter((entry) => entry.kind === "pi.reset").length).toBeGreaterThanOrEqual(2);
			// The answer's own run took exactly one provider request: the re-ask ended
			// it instead of letting the model speak again.
			expect(requests.filter((text) => text.includes("not sure"))).toHaveLength(1);
		} finally {
			await runtime.close();
		}
	});

	it("refuses a caller-supplied request id that is not a stable id, before writing anything", async () => {
		// The id becomes a document key and is embedded in every id derived from it
		// (question ids carry the request id), so an invalid one would either fail a
		// later write or persist a document no contract reader can load. It is
		// refused up front instead.
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: () => fauxAssistantMessage([fauxText("unused")]) });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
			});
			const refused = await service.submitUserInput({ text: "plan the work", requestId: "Req/1" });
			expect(refused.kind).toBe("refused");
			expect(refused.kind === "refused" ? refused.reason : "").toContain("requestId must match");
			// Nothing was written: no requirement, no admission, no queue record.
			expect((await service.readRequest()).requestId).toBeUndefined();
			expect(await service.readQueue()).toEqual([]);
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			expect(doc?.activeRequestId).toBeUndefined();
			expect(doc?.admissions ?? []).toEqual([]);
		} finally {
			await runtime.close();
		}
	});

	it("keys a queued input against the request it names, not the active one", async () => {
		// Two requirements can be in play at once: one being served, one named by
		// the queued input. The submission key is the input's identity, so its
		// version must be the *named* request's own. Keying it on the active
		// request's version makes the key claim a version req-b never had — and a
		// retry, which reads req-b's unchanged version, could never re-derive it.
		let release: (() => void) | undefined;
		const parked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let run = 0;
		const router: FauxResponseFactory = async () => {
			run += 1;
			if (run === 2) await parked;
			return fauxAssistantMessage([fauxText("done")]);
		};
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: router });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
				now: () => 1_700_000_000_000,
			});
			// req-a reaches version 1, then version 2, and a run of it parks.
			const first = await service.submitUserInput({ text: "A work", requestId: "req-a" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			const second = await service.submitUserInput({ text: "A more", requestId: "req-a" });
			if (second.kind !== "request") throw new Error("expected a request");
			expect(second.requestVersion).toBe(2);

			// Queue an input for a *different*, never-written request while req-a v2
			// is being served, then retry the same input.
			const queued = await service.submitUserInput({ text: "B work", requestId: "req-b" });
			expect(queued.kind).toBe("queued");
			const retried = await service.submitUserInput({ text: "B work", requestId: "req-b" });
			expect(retried.kind).toBe("queued");

			const records = (await service.readQueue()).filter((entry) => entry.requestId === "req-b");
			expect(records).toHaveLength(1);
			expect(records[0]!.requestVersion).toBe(1);
			expect(records[0]!.allocatedVersion).toBe(1);
			const doc = await runtime.harness.snapshot(MainServiceDoc, 1 as never, context);
			const admissions = (doc?.admissions ?? []).filter((entry) => entry.requestId === "req-b");
			expect(admissions).toHaveLength(1);
			expect(admissions[0]!.key.startsWith("queued:req-b:v1:")).toBe(true);
			// req-b's own requirement was never written: the input is queued against
			// its initial version, not consumed.
			const request = await runtime.harness.snapshot(AgentRequestDoc, 1 as never, "req-b", context);
			expect(request?.requestedAt ?? 0).toBe(0);
		} finally {
			release?.();
			await runtime.close();
		}
	});

	it("refuses a dispatch when the requirement cannot be resolved inside the admission commit", async () => {
		// The requirement was resolvable when the tool began but not in the
		// transaction that admits the batch — a rejected restatement became live in
		// between. Admitting against the earlier read would execute the old goal
		// under the new requirement, so the batch is refused instead.
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: () => fauxAssistantMessage([fauxText("unused")]) });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const dispatched: TaskSpec[][] = [];
			let calls = 0;
			const extension = createMainExtension({
				activeRequest: async () => {
					calls += 1;
					return calls === 1 ? { requestId: "req-plan", requestVersion: 1 } : undefined;
				},
				dispatch: async ({ tasks }) => {
					dispatched.push([...tasks]);
					return tasks.map((task) => ({ taskId: task.id, status: "queued" as const }));
				},
				readOperation: async () => undefined,
				recordOperation: async () => {},
				now: () => 1_700_000_000_000,
			});
			const dispatch = extension.tools?.find((tool) => tool.name === "dispatch_tasks");
			expect(dispatch).toBeDefined();
			const result = await dispatch!.execute(
				{ planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } as never,
				{
					taskId: "task-1" as never,
					callId: "call-1",
					conversationId: root.id,
					commit: async (change: (tx: never) => unknown) => await runtime.harness.commit(change as never, context),
				} as never,
				context,
			);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result.output)).toContain("could not be resolved");
			expect(dispatched).toHaveLength(0);
		} finally {
			await runtime.close();
		}
	});

	it("refuses the second of two concurrent answers once the question is resolved", async () => {
		// The open-state check before the write is a committed read, but not the
		// same commit: two answers racing can both pass it. The commit repeats the
		// check, so the loser is refused instead of replacing a settled exchange.
		const runtime = await openProbe({ databasePath, provider: "faux", fauxRouter: () => fauxAssistantMessage([fauxText("done")]) });
		try {
			const root = await openRoot(runtime);
			runtime.harness.resume();
			const service = await openMainService({
				harness: runtime.harness,
				registry: runtime.registry,
				context,
				conversationId: root.id,
				dispatch: async () => [],
				now: () => 1_700_000_000_000,
			});
			const first = await service.submitUserInput({ text: "plan the work", requestId: "req-plan" });
			if (first.kind !== "request") throw new Error("expected a request");
			await first.submission.wait(context);
			await runtime.harness.waitForIdle(context);
			await runtime.harness.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, 1 as never, "req-plan", { requestId: "req-plan" });
				state.questions = [...state.questions, { questionId: "q-1", question: "which file?", reason: "ambiguous", blockingScope: [], askedAt: 1 }];
			}, context);

			const outcomes = await Promise.all([
				service.submitUserInput({ text: "use report.txt", answerTo: "q-1", sufficient: true }),
				service.submitUserInput({ text: "use archive.txt", answerTo: "q-1", sufficient: true }),
			]);
			const answered = outcomes.filter((outcome) => outcome.kind === "answer");
			const refused = outcomes.filter((outcome) => outcome.kind === "refused");
			expect(answered).toHaveLength(1);
			expect(refused).toHaveLength(1);
			expect(refused[0]!.kind === "refused" ? refused[0]!.reason : "").toContain("not open");
			const stored = await runtime.harness.snapshot(AgentClarificationDoc, 1 as never, "req-plan", context);
			expect(stored?.answers).toHaveLength(1);
			expect(stored?.resolutions.filter((resolution) => resolution.questionId === "q-1")).toHaveLength(1);
			await runtime.harness.waitForIdle(context);
		} finally {
			await runtime.close();
		}
	});
});
