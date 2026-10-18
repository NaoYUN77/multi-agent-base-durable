// TASK-005.4 test/agent-budget.test.ts
//
// AC-02 — concurrency, queueing, fairness, cumulative instances, mutual
// exclusion, and settlement accounting.
// AC-03 — a 429 is retried and can be exhausted; a schema-broken call can be
// repaired and can be exhausted; auth failures and unknown effects are not
// blindly retried; a new call id cannot buy back a spent round budget.
//
// Every number is stated in this file. Nothing here is a product default.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type FauxResponseFactory,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { AuthorizedTool } from "../src/agent/builder/authorization.ts";
import { AgentTaskResultDoc } from "../src/agent/contracts/documents.ts";
import { context } from "../src/runtime.ts";
import {
	type ChildRouter,
	childAnswer,
	driveMain,
	flattenRequest,
	openBatchSystem,
	onlyBatchId,
	readBatch,
	readBatchIndex,
	readLedger,
	readQuota,
	readScheduler,
	runConfigOf,
	submittedTaskId,
} from "./helpers/batch-system.ts";

const MAIN_MARKER = "MAIN-MARKER-3B90";
const MATERIAL = "MATERIAL-2: alpha beta alpha beta";

/** A gate the test opens when it wants the parked child to continue. */
type Gate = { readonly promise: Promise<void>; readonly open: () => void };

function gate(): Gate {
	let open: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open: () => open?.() };
}

function configOf(overrides: Record<string, unknown>): ReturnType<typeof runConfigOf> {
	return runConfigOf({
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
		...overrides,
	});
}

const BUDGET = { maxToolInvocations: 3, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 8_000 };

function specBody(id: string, options: { readonly requestedTools?: readonly string[] } = {}): JsonObject {
	return {
		schemaVersion: 1,
		id,
		purpose: `do ${id}`,
		materials: [{ id: "material-1", content: MATERIAL, source: "user note" }],
		scope: ["use only the supplied material"],
		exclusions: [],
		constraints: ["use only the granted tools"],
		outputContract: { format: "text", requiredFields: ["summary"] },
		acceptance: ["the answer names the count"],
		skillId: "material-summary",
		requestedTools: [...(options.requestedTools ?? ["text_stats"])],
		dependencies: [],
		budget: { ...BUDGET },
	};
}

type MainStep = readonly { readonly name: string; readonly arguments: JsonObject }[];

/** A Main script plus a child router, distinguished by the `# Task` submission line. */
function routerOf(steps: (flat: string) => readonly MainStep[], child: ChildRouter): FauxResponseFactory {
	let turn = 0;
	return (request) => {
		const flat = flattenRequest(request.messages);
		if (submittedTaskId(flat) !== undefined) return child(request);
		if (request.messages.some((message) => message.role === "toolResult")) turn += 1;
		const calls = steps(flat)[turn] ?? [];
		if (calls.length === 0) return fauxAssistantMessage([fauxText("nothing left to do")]);
		return fauxAssistantMessage(
			calls.map((call, index) => fauxToolCall(call.name, call.arguments, { id: `main-call-${turn}-${index}` })),
			{ stopReason: "toolUse" },
		);
	};
}

function saveAndDispatch(tasks: readonly JsonObject[]): (flat: string) => readonly MainStep[] {
	return () => [
		[{ name: "save_plan", arguments: { planId: "plan-budget", goals: ["run"], taskIds: tasks.map((task) => String(task.id)) } }],
		[{ name: "dispatch_tasks", arguments: { planId: "plan-budget", version: 1, tasks: [...tasks] } }],
	];
}

/** A child that parks on its first request until the test opens its gate, then answers. */
function parkedChild(onArrive: (taskId: string) => void, gates: Map<string, Gate>): ChildRouter {
	const parked = new Set<string>();
	return async (request) => {
		const taskId = submittedTaskId(flattenRequest(request.messages));
		if (taskId === undefined) throw new Error("child router saw Main");
		const held = gates.get(taskId);
		if (held !== undefined && !parked.has(taskId)) {
			parked.add(taskId);
			onArrive(taskId);
			await held.promise;
		}
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: `child-${taskId}` })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(childAnswer(`finished ${taskId}`))]);
	};
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("TASK-005.4 budget — capacity, fairness, resources (AC-02)", { timeout: 60_000 }, () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-budget-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("runs at most the configured number at once and serves the queue in the order it formed", async () => {
		const gates = new Map<string, Gate>([
			["task-a", gate()],
			["task-b", gate()],
			["task-c", gate()],
		]);
		const order: string[] = [];
		const system = await openBatchSystem({
			databasePath: join(directory, "capacity.sqlite"),
			router: routerOf(
				saveAndDispatch([specBody("task-a"), specBody("task-b"), specBody("task-c")]),
				parkedChild((taskId) => order.push(taskId), gates),
			),
			runConfig: configOf({ maxConcurrentSubAgents: 1, maxSubAgentsPerRequest: 3 }),
		});
		try {
			const driving = driveMain(system, `${MAIN_MARKER} queue three`);
			await waitFor(() => order.length === 1, "no child started");
			const first = (await readScheduler(system)).active;
			expect(first).toHaveLength(1);
			const waiting = (await readScheduler(system)).queue.map((entry) => entry.taskId);
			expect(waiting).toHaveLength(2);
			gates.get(order[0] ?? "")?.open();
			await waitFor(() => order.length === 2, "the second child never started after the first settled");
			expect((await readScheduler(system)).active.map((slot) => slot.taskId)).toEqual([order[1]]);
			// Fairness: the queue's head is what ran next, not whichever item polled first.
			expect(order[1]).toBe(waiting[0]);
			gates.get(order[1] ?? "")?.open();
			await waitFor(() => order.length === 3, "the third child never started");
			expect(order[2]).toBe(waiting[1]);
			expect((await readScheduler(system)).queue).toEqual([]);
			gates.get(order[2] ?? "")?.open();
			await driving;
			const batch = await readBatch(system, await onlyBatchId(system));
			expect(batch?.items.every((item) => item.receipt?.status === "completed")).toBe(true);
			expect((await readScheduler(system)).active).toEqual([]);
		} finally {
			for (const held of gates.values()) held.open();
			await system.runtime.close();
		}
	});

	it("keeps two tasks with conflicting writes from running together, even below the concurrency cap", async () => {
		// A test-only tool whose declared effect is a write to one named document.
		const resourceTool = defineTool({
			name: "resource_write",
			description: "Write the named ledger document.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => ({ output: [{ type: "text" as const, text: "written" }] }),
		});
		const ResourceExtension = defineExtension({ name: "test-resource-tool", tools: [resourceTool] });
		const resourceGrant: AuthorizedTool = {
			name: "resource_write",
			version: "1.0.0",
			registration: resourceTool,
			extension: ResourceExtension,
			effects: { reads: [], writes: ["doc:ledger"] },
		};
		const gates = new Map<string, Gate>([
			["task-left", gate()],
			["task-right", gate()],
		]);
		const order: string[] = [];
		const system = await openBatchSystem({
			databasePath: join(directory, "resource.sqlite"),
			router: routerOf(
				saveAndDispatch([specBody("task-left", { requestedTools: ["resource_write"] }), specBody("task-right", { requestedTools: ["resource_write"] })]),
				parkedChild((taskId) => order.push(taskId), gates),
			),
			runConfig: configOf({ maxConcurrentSubAgents: 2, maxSubAgentsPerRequest: 4 }),
			extraTools: [resourceGrant],
		});
		try {
			const driving = driveMain(system, `${MAIN_MARKER} conflict`);
			await waitFor(() => order.length === 1, "no child started");
			// The cap is two, so a queued item here can only be a resource conflict.
			const during = await readScheduler(system);
			expect(during.active).toHaveLength(1);
			expect(during.queue).toHaveLength(1);
			expect(order).toHaveLength(1);
			gates.get(order[0] ?? "")?.open();
			await waitFor(() => order.length === 2, "the conflicting item never ran after the holder settled");
			expect((await readScheduler(system)).active.map((slot) => slot.taskId)).toEqual([order[1]]);
			gates.get(order[1] ?? "")?.open();
			await driving;
			const batch = await readBatch(system, await onlyBatchId(system));
			expect(batch?.items.map((item) => item.receipt?.status)).toEqual(["completed", "completed"]);
		} finally {
			for (const held of gates.values()) held.open();
			await system.runtime.close();
		}
	});

	it("counts instances across the whole request and refuses a third execution", async () => {
		const child: ChildRouter = (request) => {
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "child-stats" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer("done"))]);
		};
		const first = [specBody("task-one"), specBody("task-two")];
		const steps = (): readonly MainStep[] => [
			[{ name: "save_plan", arguments: { planId: "plan-budget", goals: ["run"], taskIds: ["task-one", "task-two", "task-three"] } }],
			[{ name: "dispatch_tasks", arguments: { planId: "plan-budget", version: 1, tasks: first } }],
			[
				{
					name: "dispatch_tasks",
					arguments: {
						planId: "plan-budget",
						version: 1,
						tasks: [{ ...specBody("task-three"), dependencies: [] }],
					},
				},
			],
		];
		const system = await openBatchSystem({
			databasePath: join(directory, "instances.sqlite"),
			router: routerOf(steps, child),
			runConfig: configOf({ maxSubAgentsPerRequest: 2 }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} spend two instances`);
			expect((await readQuota(system, "req-batch"))?.instancesUsed).toBe(2);
			expect((await readScheduler(system)).active).toEqual([]);
			// Two dispatch calls were admitted; the second batch's only member was
			// refused at admission because the request's instance allowance was spent.
			const ids = await readBatchIndex(system);
			expect(ids).toHaveLength(2);
			const receipts: { status?: string; detail?: string }[] = [];
			for (const id of ids) {
				const batch = await readBatch(system, id);
				for (const item of batch?.items ?? []) if (item.receipt !== undefined) receipts.push(item.receipt);
			}
			const refused = receipts.find((receipt) => receipt.status === "failed");
			expect(refused?.detail).toContain("instance_budget_exhausted");
			expect((await readQuota(system, "req-batch"))?.instancesUsed).toBe(2);
		} finally {
			await system.runtime.close();
		}
	});
});

describe("TASK-005.4 budget — provider retry, schema repair, no blind retry (AC-03)", { timeout: 60_000 }, () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "agent-failure-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("retries a 429 once and completes the round on the second attempt", async () => {
		const requests = new Map<string, number>();
		const child: ChildRouter = (request) => {
			const flat = flattenRequest(request.messages);
			const taskId = submittedTaskId(flat) ?? "?";
			const count = (requests.get(taskId) ?? 0) + 1;
			requests.set(taskId, count);
			if (count === 1) {
				return fauxAssistantMessage([fauxText("provider said no")], { stopReason: "error", errorMessage: "429 rate limit exceeded" });
			}
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult" && count === 2) {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "child-stats" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer("completed after a retry"))]);
		};
		const system = await openBatchSystem({
			databasePath: join(directory, "retry.sqlite"),
			router: routerOf(saveAndDispatch([specBody("task-retry")]), child),
			runConfig: configOf({ providerRetry: { maxRetries: 1, backoffMs: 5 } }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} retry a 429`);
			const receipt = (await readBatch(system, await onlyBatchId(system)))?.items[0]?.receipt;
			expect(receipt?.status).toBe("completed");
			const quota = await readQuota(system, "req-batch");
			expect(quota?.operations[0]?.providerRetriesUsed).toBe(1);
			expect(quota?.operations[0]?.rounds[0]?.round).toBe(1);
			const ledger = await readLedger(system, "task-retry");
			expect(ledger?.rounds[0]?.execution?.attempts).toHaveLength(2);
		} finally {
			await system.runtime.close();
		}
	});

	it("exhausts the provider retry budget and reports a quota failure Main must decide", async () => {
		const child: ChildRouter = () =>
			fauxAssistantMessage([fauxText("still limited")], { stopReason: "error", errorMessage: "429 rate limit exceeded" });
		const system = await openBatchSystem({
			databasePath: join(directory, "retry-exhausted.sqlite"),
			router: routerOf(saveAndDispatch([specBody("task-retry")]), child),
			runConfig: configOf({ providerRetry: { maxRetries: 1, backoffMs: 5 } }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} exhaust the retry`);
			const receipt = (await readBatch(system, await onlyBatchId(system)))?.items[0]?.receipt;
			expect(receipt?.status).toBe("failed");
			expect(receipt?.failureKind).toBe("quota");
			expect(receipt?.requiresMainDecision).toBe(true);
			expect((await readQuota(system, "req-batch"))?.operations[0]?.providerRetriesUsed).toBe(1);
		} finally {
			await system.runtime.close();
		}
	});

	it("accepts a repaired schema call and charges the refusal that preceded it", async () => {
		const requests = new Map<string, number>();
		const child: ChildRouter = (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages)) ?? "?";
			const count = (requests.get(taskId) ?? 0) + 1;
			requests.set(taskId, count);
			if (count === 1) {
				// `text` is required, so Durable refuses this before `execute()`.
				return fauxAssistantMessage([fauxToolCall("text_stats", { marker: "alpha" }, { id: "child-bad" })], { stopReason: "toolUse" });
			}
			if (count === 2) {
				return fauxAssistantMessage([fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: "child-good" })], {
					stopReason: "toolUse",
				});
			}
			return fauxAssistantMessage([fauxText(childAnswer("repaired the call"))]);
		};
		const system = await openBatchSystem({
			databasePath: join(directory, "repair.sqlite"),
			router: routerOf(saveAndDispatch([specBody("task-repair")]), child),
			runConfig: configOf({ maxFailedToolCallsPerRound: 2 }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} repair the call`);
			const receipt = (await readBatch(system, await onlyBatchId(system)))?.items[0]?.receipt;
			expect(receipt?.status).toBe("completed");
			const round = (await readQuota(system, "req-batch"))?.operations[0]?.rounds[0];
			expect(round?.failedToolCallsUsed).toBe(1);
			expect(round?.toolInvocationsUsed).toBe(1);
		} finally {
			await system.runtime.close();
		}
	});

	it("stops admitting business calls once the failed-call allowance is spent, even with new call ids", async () => {
		let executed = 0;
		const countingTool = defineTool({
			name: "counting_tool",
			description: "Counts executions.",
			parameters: Type.Object({}),
			replay: "safe",
			execute: async () => {
				executed += 1;
				return { output: [{ type: "text" as const, text: "counted" }] };
			},
		});
		const CountingExtension = defineExtension({ name: "test-counting-tool", tools: [countingTool] });
		const countingGrant: AuthorizedTool = {
			name: "counting_tool",
			version: "1.0.0",
			registration: countingTool,
			extension: CountingExtension,
			effects: { reads: [], writes: [] },
		};
		const requests = new Map<string, number>();
		const child: ChildRouter = (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages)) ?? "?";
			const count = (requests.get(taskId) ?? 0) + 1;
			requests.set(taskId, count);
			if (count === 1) return fauxAssistantMessage([fauxToolCall("text_stats", { marker: "alpha" }, { id: "bad-1" })], { stopReason: "toolUse" });
			if (count === 2) return fauxAssistantMessage([fauxToolCall("counting_tool", {}, { id: "new-id-2" })], { stopReason: "toolUse" });
			return fauxAssistantMessage([fauxText(childAnswer("stopped calling"))]);
		};
		const system = await openBatchSystem({
			databasePath: join(directory, "exhausted.sqlite"),
			router: routerOf(saveAndDispatch([specBody("task-exhaust", { requestedTools: ["text_stats", "counting_tool"] })]), child),
			runConfig: configOf({ maxFailedToolCallsPerRound: 1 }),
			extraTools: [countingGrant],
		});
		try {
			await driveMain(system, `${MAIN_MARKER} exhaust the failures`);
			// The second call never reached its tool: a new call id is not new budget.
			expect(executed).toBe(0);
			const round = (await readQuota(system, "req-batch"))?.operations[0]?.rounds[0];
			expect(round?.failedToolCallsUsed).toBe(1);
			expect(round?.toolInvocationsUsed).toBe(0);
		} finally {
			await system.runtime.close();
		}
	});

	it("does not retry an auth failure against the provider", async () => {
		const requests = new Map<string, number>();
		const child: ChildRouter = (request) => {
			const taskId = submittedTaskId(flattenRequest(request.messages)) ?? "?";
			requests.set(taskId, (requests.get(taskId) ?? 0) + 1);
			return fauxAssistantMessage([fauxText("denied")], { stopReason: "error", errorMessage: "401 unauthorized: invalid api key" });
		};
		const system = await openBatchSystem({
			databasePath: join(directory, "auth.sqlite"),
			router: routerOf(saveAndDispatch([specBody("task-auth")]), child),
			runConfig: configOf({ providerRetry: { maxRetries: 3, backoffMs: 5 }, maxTechnicalRestarts: 0 }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} reject the key`);
			const receipt = (await readBatch(system, await onlyBatchId(system)))?.items[0]?.receipt;
			expect(receipt?.status).toBe("failed");
			expect(receipt?.failureKind).toBe("technical");
			expect(receipt?.requiresMainDecision).toBe(true);
			expect((await readQuota(system, "req-batch"))?.operations[0]?.providerRetriesUsed).toBe(0);
			expect(requests.get("task-auth")).toBe(1);
		} finally {
			await system.runtime.close();
		}
	});

	it("counts every admitted call, so a new call id cannot hide the round's spend", async () => {
		let calls = 0;
		const child: ChildRouter = (request) => {
			const last = [...request.messages].reverse().find((message) => message.role !== "system");
			if (last?.role !== "toolResult") {
				calls += 1;
				return fauxAssistantMessage(
					[fauxToolCall("text_stats", { text: MATERIAL, marker: "alpha" }, { id: `call-${calls}` })],
					{ stopReason: "toolUse" },
				);
			}
			if (calls < 2) {
				return fauxAssistantMessage(
					[fauxToolCall("text_stats", { text: MATERIAL, marker: "beta" }, { id: `call-${calls + 1}` })],
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage([fauxText(childAnswer("two calls"))]);
		};
		const system = await openBatchSystem({
			databasePath: join(directory, "count.sqlite"),
			router: routerOf(saveAndDispatch([specBody("task-count")]), child),
			runConfig: configOf({ maxToolInvocationsPerRound: 4 }),
		});
		try {
			await driveMain(system, `${MAIN_MARKER} count calls`);
			const round = (await readQuota(system, "req-batch"))?.operations[0]?.rounds[0];
			expect(round?.toolInvocationsUsed).toBe(2);
			const receipt = (await readBatch(system, await onlyBatchId(system)))?.items[0]?.receipt;
			expect(receipt?.resultId).toBe("res.task-count.r1");
			const result = await system.runtime.harness.snapshot(AgentTaskResultDoc, system.root.id, "res.task-count.r1", context);
			expect(result?.result?.runtime.toolInvocations).toBe(2);
		} finally {
			await system.runtime.close();
		}
	});
});
