// TASK-005.5 src/service/session.ts
//
// The production composition root: one function that opens the whole stack over
// one database, in the order that makes a crash at any point resumable.
//
//   openProbe            Harness + provider + registry (+ the child-side tools, installed only)
//   openRoot             the Main conversation, with its agent configured
//   skill registry, policy  what a child may be granted
//   createBatchRuntime   the durable batch runtime of Issue #19
//   openMainService      Main's control surface (extension selected, open reconciliation)
//   harness.resume()     last
//
// `resume()` is last for the same reason the test helper does it last: recovery
// immediately re-executes whatever the interrupted process was in the middle of,
// and an interrupted `dispatch_tasks` needs the batch runtime and the Main
// service installed above it. Resuming earlier would let a replayed call run
// against a half-built host.
//
// Closing is a lifecycle operation, not a business one: `close()` stops the
// watches, closes the Harness, and never calls `requestCancel`, `stopAll` or
// `abort`. Work that was running pauses at its last durable point and is
// replayed by the runtime on the next open.

import { fileURLToPath } from "node:url";
import { AgentDoc, type EntryRecord, LiveDoc } from "@earendil-works/pi-durable";
import { AgentTaskSpecDoc } from "../agent/contracts/documents.ts";
import { loadSkillRegistry } from "../agent/builder/skill-registry.ts";
import { LOCAL_TEXT_TOOLS, LOCAL_TEXT_TOOL_NAMES } from "../agent/builder/tool-catalog.ts";
import type { TaskAuthorizationPolicy } from "../agent/builder/authorization.ts";
import { createBatchRuntime, runtimeHarnessSettings, startRuntimeWatches } from "../agent/runtime/index.ts";
import { TaskLedgerDoc } from "../multiagent/ledger.ts";
import { ChildTools } from "../multiagent/child-tools.ts";
import { context as backgroundContext, openProbe, openRoot } from "../runtime.ts";
import { openMainService } from "./main-service.ts";
import { createAnalysisReader } from "./analysis.ts";
import { startChangeFeed } from "./changes.ts";
import type { AgentSession, AgentSessionOptions, ModelOption, TranscriptLine, TuiSnapshot } from "./types.ts";
/** The bundled skills directory, addressed from the source tree rather than the process cwd. */
const REPOSITORY_SKILLS = fileURLToPath(new URL("../../skills", import.meta.url));

/** The skills a task may name in this deployment: the ones the repository bundles for local text work. */
const ALLOWED_SKILLS: readonly string[] = ["text-stats", "material-summary"];

/** The newest transcript lines the TUI shows. */
export const TRANSCRIPT_LIMIT = 200;

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
		.filter((text) => text !== "")
		.join("\n");
}

/** Reduce one conversation entry to a transcript line; kinds the TUI does not show are skipped. */
export function transcriptLine(entry: EntryRecord): TranscriptLine | undefined {
	switch (entry.kind) {
		case "pi.user":
		case "pi.assistant": {
			const text = (entry.model ?? []).map((message) => textOf(message.content)).filter((part) => part !== "").join("\n");
			if (text === "") return undefined;
			return { entryId: String(entry.id), kind: entry.kind === "pi.user" ? "user" : "assistant", text };
		}
		case "pi.tool-result": {
			const message = (entry.model ?? [])[0] as { readonly toolName?: unknown; readonly content?: unknown } | undefined;
			const name = typeof message?.toolName === "string" ? message.toolName : "tool";
			return { entryId: String(entry.id), kind: "tool", text: `${name}: ${textOf(message?.content)}` };
		}
		default:
			return undefined;
	}
}

/**
 * Open a session the terminal entry renders.
 *
 * @throws when the Harness cannot be opened (missing directory, locked file, a
 *   provider without credentials). The entry maps that to exit code 1.
 */
export async function openAgentSession(options: AgentSessionOptions): Promise<AgentSession> {
	const now = options.now ?? Date.now;
	const context = backgroundContext;
	const runtime = await openProbe({
		databasePath: options.databasePath,
		provider: options.provider,
		settings: runtimeHarnessSettings(),
		...(options.modelId === undefined ? {} : { modelId: options.modelId }),
		...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
		// The key never leaves the environment: it is handed to the provider in memory
		// for custom endpoints, and nothing here copies, prints or stores it.
		...(options.apiKeyEnv === undefined ? {} : { apiKey: process.env[options.apiKeyEnv] }),
		...(options.fauxRouter === undefined ? {} : { fauxRouter: options.fauxRouter }),
		...(options.fauxModels === undefined ? {} : { fauxModels: options.fauxModels }),
		...(options.extraMainExtensions === undefined ? {} : { extensions: options.extraMainExtensions }),
		// Installed, never selected on Main: a child is granted these per task.
		registryExtensions: [ChildTools],
	});
	try {
		const root = await openRoot(runtime);
		const skills = await loadSkillRegistry({ root: REPOSITORY_SKILLS });
		const policy: TaskAuthorizationPolicy = {
			skills,
			allowedSkills: [...ALLOWED_SKILLS],
			allowedTools: [...LOCAL_TEXT_TOOL_NAMES],
			tools: [...LOCAL_TEXT_TOOLS],
		};
		const batch = createBatchRuntime({
			harness: runtime.harness,
			registry: runtime.registry,
			mainConversationId: root.id,
			context,
			model: runtime.modelRef,
			runConfig: {
				...options.runConfig,
				maxConcurrentSubAgents: options.maxConcurrentSubAgents,
				maxSubAgentsPerRequest: options.maxSubAgentsPerRequest,
			},
			toolPolicy: policy,
			now,
			...(options.wait === undefined ? {} : { wait: options.wait }),
			...(options.admissionPollMs === undefined ? {} : { admissionPollMs: options.admissionPollMs }),
		});
		const main = await openMainService({
			harness: runtime.harness,
			registry: runtime.registry,
			context,
			conversationId: root.id,
			runtime: batch,
			now,
			...(options.extraMainExtensions === undefined ? {} : { extensionsExtra: options.extraMainExtensions }),
		});
		const conversation = await runtime.harness.conversation(root.id, context);
		if (conversation === undefined) throw new Error("main service: the Main conversation vanished while the session opened");
		const mainConversationId = root.id;
		// The models this session can offer: the installed provider's own catalog.
		// One provider is installed per session, so this is the whole list, and its
		// ids are exactly what a request is resolved against at run time.
		const availableModels: readonly ModelOption[] = runtime.models.getModels(runtime.modelRef.provider).map((model) => ({
			provider: runtime.modelRef.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
		}));
		const analysis = createAnalysisReader({
			harness: runtime.harness,
			main,
			mainConversationId,
			context,
			runConfig: options.runConfig,
			openReconciliation: main.openReconciliation,
			availableModels,
		});

		// Watches are acquired from what a pass read: the runtime's own documents
		// through its read surface, and one ledger and spec per known task.
		const listeners = new Set<() => void>();
		let newest: TuiSnapshot | undefined;
		let stopped = false;
		const runtimeWatches = startRuntimeWatches({ harness: runtime.harness, mainConversationId, context, onChange: () => feed.mark() });
		const feed = startChangeFeed({
			onPass: async (setWatched) => {
				if (stopped) return;
				newest = await analysis.snapshot(now());
				const taskIds = [...new Set(newest?.watchedTasks ?? [])];
				await setWatched([
					{ key: "status:agent", acquire: async () => await runtime.harness.watchDoc(AgentDoc, root.id, context) },
					{ key: "status:live", acquire: async () => await runtime.harness.watchDoc(LiveDoc, root.id, context) },
					...taskIds.flatMap((taskId) => [
						{ key: `ledger:${taskId}`, acquire: async () => await runtime.harness.watchDoc(TaskLedgerDoc, root.id, taskId, context) },
						{ key: `spec:${taskId}`, acquire: async () => await runtime.harness.watchDoc(AgentTaskSpecDoc, root.id, taskId, context) },
					]),
				]);
				runtimeWatches.grow({ batches: newest?.watchedBatches ?? [], requests: newest?.watchedRequests ?? [] });
				for (const listener of listeners) listener();
			},
		});

		const session: AgentSession = {
			main,
			conversationId: root.id,
			context,
			snapshot: async (clock) => {
				const snapshot = await analysis.snapshot(clock);
				newest = snapshot;
				return snapshot;
			},
			watch: async (listener) => {
				listeners.add(listener);
				return {
					mark: () => feed.mark(),
					flush: async () => await feed.flush(),
					stop: async () => {
						listeners.delete(listener);
					},
				};
			},
			transcript: async (limit) => {
				const view = await conversation.context(context);
				return view.entries
					.map((entry) => transcriptLine(entry))
					.filter((line): line is TranscriptLine => line !== undefined)
					.slice(-limit);
			},
			cancelTask: async (taskId, reason) => await main.cancelTask(taskId, reason),
			inspectTask: async (taskId, clock) => await analysis.inspectTask(taskId, clock),
			cancelAll: async (reason) => await main.requestCancel(reason),
			setModel: async (provider, modelId) => {
				// The same resolution the runtime makes at request time. An id that
				// misses here is one every later request would fail as `no_model`, so
				// it is refused instead of written.
				const model = runtime.models.getModel(provider, modelId);
				if (model === undefined) {
					return { provider, modelId, outcome: "unavailable", detail: `the installed provider does not offer ${provider}/${modelId}` };
				}
				await conversation.configure({ model: { provider, modelId } }, context);
				return { provider, modelId, outcome: "set", detail: model.name };
			},
			close: async () => {
				stopped = true;
				listeners.clear();
				await feed.stop();
				await runtimeWatches.stop();
				await runtime.close();
			},
		};
		// Resume last: see the header.
		runtime.harness.resume();
		return session;
	} catch (error) {
		await runtime.close().catch(() => {});
		throw error;
	}
}
