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
import { AgentClarificationDoc, AgentPlanDoc } from "../src/agent/contracts/documents.ts";
import { validateTaskSpec, type TaskSpec } from "../src/agent/contracts/task-spec.ts";
import { openMainService } from "../src/service/main-service.ts";
import type { DispatchResult } from "../src/agent/main/tools.ts";

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
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			if (!Array.isArray(content)) return "";
			return content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
				.join("\n");
		})
		.join("\n");
}

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
	 * Drive the service with a scripted sequence of tool calls, one per model turn.
	 * The router pops the next scripted turn per request, so a test writes the
	 * conversation the model would have had.
	 */
	async function runScript(
		script: readonly (readonly ScriptedCall[])[],
		options: {
			readonly dispatch?: (input: { readonly tasks: readonly TaskSpec[] }) => Promise<readonly DispatchResult[]>;
			readonly unacceptedDependencies?: (tasks: readonly TaskSpec[]) => readonly string[];
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
		const router: FauxResponseFactory = (request) => {
			requests.push(flatten(request.messages));
			const calls: readonly ScriptedCall[] = script[turn++] ?? [];
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

	it("refuses a dispatch while a related question is open (AC-03)", async () => {
		const { runtime, service, dispatched } = await runScript(
			[
				[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["g"], taskIds: ["t1"], relatedQuestionIds: ["q-1"] } }],
				[{ name: "dispatch_tasks", arguments: { planId: "plan-a", version: 1, tasks: [taskSpec("t1")] } }],
			],
			{ seededQuestions: ["q-1"] },
		);
		try {
			// A question is open for this request: the dispatch must be refused even
			// though the plan version is correct.
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

	it("keeps the plan readable across a close and reopen (AC-03)", async () => {
		const first = await runScript([[{ name: "save_plan", arguments: { planId: "plan-a", goals: ["survive"], taskIds: ["t1"] } }]]);
		try {
			await drive(first.runtime, first.service);
		} finally {
			await first.runtime.close();
		}

		const second = await openProbe({ databasePath, provider: "faux", fauxResponses: ["ok"] });
		try {
			const stored = await second.harness.snapshot(AgentPlanDoc, 1 as never, "plan-a", context);
			expect(stored?.version).toBe(1);
			expect(stored?.goals).toEqual(["survive"]);
		} finally {
			await second.close();
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
});
