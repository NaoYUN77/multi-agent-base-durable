// TASK-005.4 test/helpers/batch-system.ts
//
// Shared wiring for the batch runtime's four test files. It exists so the four
// suites prove different properties against the *same* composition root instead
// of each inventing its own slightly different one — a suite that wired Main
// differently could pass while the shipping composition would not.
//
// What is deliberately **not** here: any numeric limit. Every suite passes its
// own `RunConfig`, `TaskSpec` budget and concurrency numbers explicitly, because
// Issue #19 forbids turning a test's fixture values into a product default —
// and a helper that supplied them would do exactly that quietly.

import { fileURLToPath } from "node:url";
import type { Conversation, ConversationId, Cursor, Extension } from "@earendil-works/pi-durable";
import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type JsonObject,
	type Message,
} from "@earendil-works/pi-ai";
import { context, openProbe, openRoot, type ProbeRuntime } from "../../src/runtime.ts";
import { ChildTools } from "../../src/multiagent/child-tools.ts";
import { TaskLedgerDoc } from "../../src/multiagent/ledger.ts";
import type { ContractValidation } from "../../src/agent/contracts/errors.ts";
import { validateRunConfig, type RunConfig } from "../../src/agent/contracts/run-config.ts";
import { validateTaskSpec, type TaskSpec } from "../../src/agent/contracts/task-spec.ts";
import { loadSkillRegistry, type SkillRegistry } from "../../src/agent/builder/skill-registry.ts";
import { LOCAL_TEXT_TOOLS, LOCAL_TEXT_TOOL_NAMES } from "../../src/agent/builder/tool-catalog.ts";
import type { AuthorizedTool, TaskAuthorizationPolicy } from "../../src/agent/builder/authorization.ts";
import {
	createBatchRuntime,
	runtimeHarnessSettings,
	type BatchRuntime,
} from "../../src/agent/runtime/runtime.ts";
import {
	AgentBatchDoc,
	AgentQuotaDoc,
	BatchIndexDoc,
	SchedulerDoc,
	type BatchState,
	type RequestQuotaState,
	type SchedulerState,
} from "../../src/agent/runtime/documents.ts";
import { AgentTaskResultDoc, type AgentTaskResultDocState } from "../../src/agent/contracts/documents.ts";
import type { BatchId } from "../../src/agent/runtime/index.ts";
import { openMainService, type MainService } from "../../src/service/main-service.ts";

/** The bundled skills directory, addressed from the source tree rather than the process cwd. */
export const REPOSITORY_SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));

/** Unwrap a contract validation or fail the test with the violation list. */
export function must<T>(result: ContractValidation<T>, what: string): T {
	if (result.ok) return result.value;
	throw new Error(`${what} is invalid: ${result.violations.map((entry) => `${entry.path}:${entry.code}`).join(", ")}`);
}

/** Validate a run configuration, failing loudly when a suite's fixture is malformed. */
export function runConfigOf(input: unknown): RunConfig {
	return must(validateRunConfig(input), "run config");
}

/**
 * One valid task contract. The skill, the tool list and **all four budget
 * numbers** are required: a suite that wants a limit must say the number.
 */
export function taskSpecOf(options: {
	readonly id: string;
	readonly skillId: string;
	readonly requestedTools: readonly string[];
	readonly dependencies?: readonly string[];
	readonly budget: {
		readonly maxToolInvocations: number;
		readonly maxAttempts: number;
		readonly maxTechnicalRestarts: number;
		readonly timeoutMs: number;
	};
	readonly materials?: readonly { readonly id: string; readonly content: string; readonly source: string }[];
}): TaskSpec {
	return must(
		validateTaskSpec({
			schemaVersion: 1,
			id: options.id,
			purpose: `do ${options.id}`,
			materials: [...(options.materials ?? [{ id: "material-1", content: "MATERIAL-CONTENT", source: "user note" }])],
			scope: ["use only the supplied material"],
			exclusions: [],
			constraints: ["use only the granted tools"],
			outputContract: { format: "text", requiredFields: ["summary"] },
			acceptance: ["the answer names the count"],
			skillId: options.skillId,
			requestedTools: [...options.requestedTools],
			dependencies: [...(options.dependencies ?? [])],
			budget: { ...options.budget },
		}),
		`task spec ${options.id}`,
	);
}

/** Flatten the text a provider request carried, including rendered prompt sections. */
export function flattenRequest(messages: readonly unknown[]): string {
	return messages
		.map((message) => {
			const typed = message as { content?: unknown; sections?: Record<string, string | null> };
			const sections = Object.values(typed.sections ?? {})
				.filter((value): value is string => typeof value === "string")
				.join("\n");
			const content = typed.content;
			if (typeof content === "string") return `${content}\n${sections}`;
			if (!Array.isArray(content)) return sections;
			return `${content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
				.join("\n")}\n${sections}`;
		})
		.join("\n");
}

/** The text of the last non-system message, which is what a scripted router branches on. */
export function lastMessageText(messages: readonly unknown[]): string {
	const last = [...messages].reverse().find((message) => (message as { role?: string }).role !== "system") as
		| { content?: unknown }
		| undefined;
	const content = last?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: string }).text ?? "") : ""))
		.join("\n");
}

/** A child's final answer: the work contract as JSON, which is what makes a round complete. */
export function childAnswer(summary: string, findings: readonly string[] = []): string {
	return JSON.stringify({ summary, findings: [...findings], unresolved: [], artifacts: [] });
}

/** The `# Task <id>` line of a child submission, or `undefined` for a Main request. */
export function submittedTaskId(flat: string): string | undefined {
	return /^# Task ([^\s]+)$/m.exec(flat)?.[1];
}

/**
 * A router a test may call directly.
 *
 * The harness's `FauxResponseFactory` takes four arguments, three of which only
 * the harness supplies; a test that composes two routers (Main and child) in one
 * function needs to call the child's half itself. Taking fewer parameters is
 * assignable to the factory type, so a `ChildRouter` can still be handed to the
 * probe.
 */
export type ChildRouter = (request: { readonly messages: readonly Message[] }) => AssistantMessage | Promise<AssistantMessage>;

/** Default child router: run `text_stats`, then answer the work contract. */
export function textStatsChildRouter(marker: string): ChildRouter {
	return (request) => {
		const flat = flattenRequest(request.messages ?? []);
		const last = [...(request.messages ?? [])].reverse().find((message) => message.role !== "system");
		if (submittedTaskId(flat) === undefined) return fauxAssistantMessage([fauxText("unexpected non-child request")]);
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: marker, marker: "MAT" }, { id: "child-call-1" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(childAnswer(`the marker appears in ${marker}`))]);
	};
}

/** One Main turn: the tool calls to make before the next turn. */
export type MainStep = readonly { readonly name: string; readonly arguments: JsonObject }[];

/**
 * Serve Main from a script and children from `child`.
 *
 * The script advances once per provider request that follows a completed tool
 * round. A stateless "turn 0 or turn 1" reading would re-run the dispatch
 * forever, because the request after the dispatch also carries tool results.
 *
 * @param script - returns the tool calls of turn `n`; an out-of-range turn is the
 *   final text-only answer.
 * @param child - serves every request whose flattened transcript carries a
 *   `# Task <id>` submission line, which is how a child submission is
 *   distinguished from a Main turn without the harness telling us.
 */
export function mainRouter(script: (flat: string) => readonly MainStep[], child: ChildRouter): FauxResponseFactory {
	let turn = 0;
	return (request) => {
		const flat = flattenRequest(request.messages);
		if (submittedTaskId(flat) !== undefined) return child(request);
		if (request.messages.some((message) => message.role === "toolResult")) turn += 1;
		const calls = script(flat)[turn] ?? [];
		if (calls.length === 0) return fauxAssistantMessage([fauxText("nothing left to do")]);
		return fauxAssistantMessage(
			calls.map((call, index) => fauxToolCall(call.name, call.arguments, { id: `main-call-${turn}-${index}` })),
			{ stopReason: "toolUse" },
		);
	};
}

/**
 * Serve Main from a script that reads the transcript, for a process that may be
 * reopened over an interrupted run.
 *
 * `mainRouter` counts turns in memory, so a reopened process starts again at
 * turn 0 even though its transcript already holds the previous turns' results —
 * and a script indexed by that counter would repeat an action that has already
 * happened. Here the transcript alone decides what this request should do, and
 * the tool call ids are derived from it too, so a call is named the same way
 * whichever process issues it.
 *
 * @param script - the tool calls this request should make, given the flattened
 *   transcript; an empty list is the final text-only answer.
 * @param child - serves every request whose flattened transcript carries a
 *   `# Task <id>` submission line.
 */
export function transcriptRouter(script: (flat: string) => MainStep, child: ChildRouter): FauxResponseFactory {
	return (request) => {
		const flat = flattenRequest(request.messages);
		if (submittedTaskId(flat) !== undefined) return child(request);
		const calls = script(flat);
		if (calls.length === 0) return fauxAssistantMessage([fauxText("nothing left to do")]);
		// Counted from the transcript rather than from a counter in this process, so the
		// id of a call does not depend on how many turns happened to run here.
		const turn = request.messages.filter((message) => message.role === "assistant").length + 1;
		return fauxAssistantMessage(
			calls.map((call, index) => fauxToolCall(call.name, call.arguments, { id: `main-call-${turn}-${index}` })),
			{ stopReason: "toolUse" },
		);
	};
}

export type BatchSystem = {
	readonly runtime: ProbeRuntime;
	readonly root: Conversation;
	readonly service: MainService;
	readonly batch: BatchRuntime;
	readonly skills: SkillRegistry;
	readonly policy: TaskAuthorizationPolicy;
};

export type BatchSystemOptions = {
	readonly databasePath: string;
	readonly router: FauxResponseFactory;
	readonly runConfig: RunConfig;
	/** Extra extensions selected on the Main conversation. */
	readonly mainExtensions?: readonly Extension[];
	/** Extra tools a child may be granted. Their extensions are installed, never selected on Main. */
	readonly extraTools?: readonly AuthorizedTool[];
	readonly now?: () => number;
	readonly wait?: (ms: number) => Promise<void>;
	readonly admissionPollMs?: number;
};

/**
 * Open the whole stack over one database: probe, root, skill registry, batch
 * runtime and Main service.
 *
 * The settings are `runtimeHarnessSettings()`, not a test-local copy: the
 * runtime's counters mean what they say only when the harness is not retrying
 * underneath it, and a helper that opened the harness differently would make
 * every retry assertion prove the wrong thing.
 */
export async function openBatchSystem(options: BatchSystemOptions): Promise<BatchSystem> {
	const extraTools = options.extraTools ?? [];
	const installed = [ChildTools, ...extraTools.map((tool) => tool.extension)];
	const runtime = await openProbe({
		databasePath: options.databasePath,
		provider: "faux",
		fauxRouter: options.router,
		settings: runtimeHarnessSettings(),
		...(options.mainExtensions === undefined ? {} : { extensions: options.mainExtensions }),
		registryExtensions: installed,
	});
	const root = await openRoot(runtime);
	const skills = await loadSkillRegistry({ root: REPOSITORY_SKILLS });
	const tools = [...LOCAL_TEXT_TOOLS, ...extraTools];
	const policy: TaskAuthorizationPolicy = {
		skills,
		allowedSkills: ["text-stats", "material-summary"],
		allowedTools: [...LOCAL_TEXT_TOOL_NAMES, ...extraTools.map((tool) => tool.name)],
		tools,
	};
	const now = options.now ?? Date.now;
	const batch = createBatchRuntime({
		harness: runtime.harness,
		registry: runtime.registry,
		mainConversationId: root.id,
		context,
		model: runtime.modelRef,
		runConfig: options.runConfig,
		toolPolicy: policy,
		now,
		...(options.wait === undefined ? {} : { wait: options.wait }),
		...(options.admissionPollMs === undefined ? {} : { admissionPollMs: options.admissionPollMs }),
	});
	const service = await openMainService({
		harness: runtime.harness,
		registry: runtime.registry,
		context,
		conversationId: root.id,
		runtime: batch,
		now,
		...(options.mainExtensions === undefined ? {} : { extensionsExtra: options.mainExtensions }),
	});
	// Resume last, and only after Main's tools exist: recovery immediately
	// re-executes whatever the interrupted process was in the middle of, and an
	// interrupted `dispatch_tasks` needs the batch runtime and the Main service
	// that are installed above. Resuming first would let the replayed call run
	// against a half-built host.
	runtime.harness.resume();
	return { runtime, root, service, batch, skills, policy };
}

/** Submit one user input and wait until the whole harness is idle. */
export async function driveMain(
	system: BatchSystem,
	text: string,
	requestId = "req-batch",
): Promise<void> {
	const outcome = await system.service.submitUserInput({ text, requestId });
	if (outcome.kind !== "request") throw new Error(`expected a request, got ${outcome.kind}`);
	await outcome.submission.wait(context);
	await system.runtime.harness.waitForIdle(context);
}

// ── Document readers. Every one is a `snapshot`, so reading never creates. ────

/** The admitted batch ids of this session. */
export async function readBatchIndex(system: BatchSystem): Promise<readonly BatchId[]> {
	return (await system.runtime.harness.snapshot(BatchIndexDoc, context))?.batches ?? [];
}

/** Exactly one admitted batch, or a failure naming how many were found. */
export async function onlyBatchId(system: BatchSystem): Promise<BatchId> {
	const ids = await readBatchIndex(system);
	const first = ids[0];
	if (ids.length !== 1 || first === undefined) throw new Error(`expected exactly one admitted batch, found ${ids.length}`);
	return first;
}

export async function readBatch(system: BatchSystem, batchId: BatchId): Promise<Readonly<BatchState> | undefined> {
	return await system.runtime.harness.snapshot(AgentBatchDoc, system.root.id, String(batchId), context);
}

export async function readQuota(system: BatchSystem, requestId: string): Promise<Readonly<RequestQuotaState> | undefined> {
	return await system.runtime.harness.snapshot(AgentQuotaDoc, system.root.id, requestId, context);
}

export async function readScheduler(system: BatchSystem): Promise<Readonly<SchedulerState>> {
	return (await system.runtime.harness.snapshot(SchedulerDoc, context)) ?? { schemaVersion: 1, active: [], queue: [] };
}

export async function readLedger(system: BatchSystem, taskId: string) {
	return await system.runtime.harness.snapshot(TaskLedgerDoc, system.root.id, taskId, context);
}

/**
 * One persisted task result document, or `undefined` when no round wrote it.
 *
 * The family key is the result id alone (`res.<taskId>.r<round>`), which is what
 * a family `snapshot` takes; the read creates nothing, so a result no round wrote
 * answers `undefined` rather than a seed.
 */
export async function readResult(system: BatchSystem, resultId: string): Promise<Readonly<AgentTaskResultDocState> | undefined> {
	return await system.runtime.harness.snapshot(AgentTaskResultDoc, system.root.id, resultId, context);
}

/** One persisted entry, reduced to the facts an evidence reference can name. */
export type PersistedEntry = {
	readonly entryId: string;
	readonly kind: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
};

/**
 * Every entry of one conversation, oldest first, as plain values. A test's
 * evidence resolver.
 *
 * The scan runs inside a commit, and a scanned record is an overlay view that
 * dies with that commit, so each entry is copied while the commit is open. The
 * copy keeps identity, kind and tool attribution — the fields a result's
 * evidence reference can name, and therefore the fields a resolver compares.
 */
export async function readEntries(system: BatchSystem, conversationId: ConversationId): Promise<readonly PersistedEntry[]> {
	return await system.runtime.harness.commit(async (tx) => {
		const items: PersistedEntry[] = [];
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await tx.scanEntries({ conversationId, order: "ascending" }, 500, cursor);
			for (const entry of page.items) {
				let toolCallId: string | undefined;
				let toolName: string | undefined;
				for (const message of entry.model ?? []) {
					if (message.role !== "toolResult") continue;
					if ("toolCallId" in message && typeof message.toolCallId === "string") toolCallId = message.toolCallId;
					if ("toolName" in message && typeof message.toolName === "string") toolName = message.toolName;
					break;
				}
				items.push({
					entryId: String(entry.id),
					kind: entry.kind,
					...(toolCallId === undefined ? {} : { toolCallId }),
					...(toolName === undefined ? {} : { toolName }),
				});
			}
			if (page.next === undefined) return items;
			cursor = page.next;
		}
	}, context);
}
