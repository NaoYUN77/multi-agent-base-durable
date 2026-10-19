// TASK-001 src/runtime.ts
//
// The minimal Pi Durable assembly, isolated from the Vacation demo.
//
// This file only wires existing public APIs together; it implements no agent
// loop, no tool, and no task. Everything it calls is exported by the pinned
// checkout:
//   - Harness.open / harness.root / harness.resume / harness.close
//   - createRegistry + createModels + a provider
//   - openNodeSqliteStorage (Node built-in SQLite)
//
// No API key is read, logged, or persisted here. The default provider is the
// faux provider from pi-ai, which needs no credentials. A real provider is
// opt-in and is never written to disk:
//   - `deepseek` uses pi-ai's built-in DeepSeek provider (DEEPSEEK_API_KEY,
//     base_url https://api.deepseek.com). This is the probe's real-model default.
//   - `openai` uses pi-ai's built-in OpenAI provider (OPENAI_API_KEY, fixed base_url).
//   - `custom` builds an OpenAI-compatible provider over an explicit base_url,
//     api_key, and model id, for gateways the built-ins do not cover.
//
// The api_key is only ever passed as an in-memory string to the provider's auth
// resolver. It is not printed, not logged, and not written to SQLite.

import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	createProvider,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxModelDefinition,
	type FauxProviderHandle,
	type FauxResponseFactory,
	type Model,
	type Models,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import {
	createRegistry,
	Harness,
	type Extension,
	type HarnessSettings,
	type JsonObject,
	type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** The context every call in this probe runs under. Matches the checkout's own examples. */
export const context: Context = BACKGROUND_CONTEXT;

/** Provider choices this probe supports. */
export type ProviderKind =
	/** Offline, deterministic, no credentials. Default. */
	| "faux"
	/** pi-ai's built-in DeepSeek provider; reads DEEPSEEK_API_KEY; base_url https://api.deepseek.com. */
	| "deepseek"
	/** pi-ai's built-in OpenAI provider; reads OPENAI_API_KEY; fixed api.openai.com base_url. */
	| "openai"
	/** An OpenAI-compatible endpoint given explicitly: base_url + api_key + model id. */
	| "custom";

export interface ProbeOptions {
	/** SQLite file. Parent directories are created by the storage adapter. Use ":memory:" for a throwaway run. */
	readonly databasePath: string;
	/** Which provider to install. Defaults to `faux`. */
	readonly provider?: ProviderKind;
	/** Model id to install as the agent's model. Defaults per provider; required for `custom`. */
	readonly modelId?: string;
	/** Faux answers, in order, used only when `provider` is `faux`. */
	readonly fauxResponses?: readonly string[];
	/**
	 * The faux provider's model catalog, used only when `provider` is `faux`.
	 * Defaults to the provider's own single model. A catalog of more than one is
	 * what lets a model switch be observed at all.
	 */
	readonly fauxModels?: readonly FauxModelDefinition[];
	/**
	 * TASK-002: faux turns that call a tool, used only when `provider` is `faux`.
	 * Each entry is one assistant turn of tool calls; the faux provider emits them
	 * verbatim, so the real `pi.tool` task runs. Appended after `fauxResponses`, so
	 * a script can interleave text turns and tool turns.
	 */
	readonly fauxToolTurns?: readonly (readonly { readonly name: string; readonly arguments: JsonObject }[])[];
	/**
	 * TASK-003: a scripted response *router* for the faux provider, used only
	 * when `provider` is `faux`. Unlike `fauxResponses`, it sees every actual
	 * request (`TranscriptContext.messages`), which is what the multiagent
	 * isolation proofs need: the request the provider receives is the evidence,
	 * not the model's word about it. Appended after `fauxResponses` and
	 * `fauxToolTurns`, so a scripted sequence stays deterministic until it ends.
	 */
	readonly fauxRouter?: FauxResponseFactory;
	/**
	 * Base URL for `provider: "custom"`. Include the API version path, e.g.
	 * `https://api.deepseek.com` or `https://gateway.example.com/v1`.
	 */
	readonly baseUrl?: string;
	/**
	 * API key for `provider: "custom"`. Passed straight to the provider's auth;
	 * never logged or persisted. Prefer reading it from an env var in the caller.
	 */
	readonly apiKey?: string;
	/** Provider id to report for `custom`. Defaults to `custom`. */
	readonly customProviderId?: string;
	/** Context window for `custom`'s model, in tokens. Defaults to 128000. */
	readonly contextWindow?: number;
	/** Max output tokens for `custom`'s model. Defaults to 8192. */
	readonly maxTokens?: number;
	/**
	 * TASK-002: extensions to install into the registry alongside the built-in
	 * tasks, and to select for the root conversation. The probe's own code, never
	 * persisted. The optional `notion-read` extension arrives this way.
	 */
	readonly extensions?: readonly Extension[];
	/**
	 * TASK-003: extensions installed into the registry but *not* selected for the
	 * root conversation. The child-side tools arrive this way: a delegated task
	 * grants them per-task through `configure`, so the main agent must not see
	 * them at all, while the registry must still resolve them.
	 */
	readonly registryExtensions?: readonly Extension[];
	/**
	 * TASK-003: Harness settings. The compaction test narrows
	 * `compaction.keepRecentTokens` so a short deterministic transcript still
	 * crosses the built-in compaction threshold; every other default stands.
	 */
	readonly settings?: HarnessSettings;
}

/** Everything a caller needs to run submissions and to close cleanly. */
export interface ProbeRuntime {
	readonly harness: Harness;
	readonly models: Models;
	readonly registry: Registry;
	readonly provider: ProviderKind;
	readonly modelRef: { readonly provider: string; readonly modelId: string };
	/** The faux handle, present only when the faux provider is installed. */
	readonly faux: FauxProviderHandle | undefined;
	/** Extension names this run installed, in install order. TASK-002 reports these. */
	readonly installedExtensions: readonly string[];
	/** The extension objects selected for the root conversation's agent. */
	readonly selectedExtensions: readonly Extension[];
	/** Errors the Harness reported asynchronously. */
	readonly reports: unknown[];
	close(): Promise<void>;
}

const DEFAULT_MODEL_ID: Record<ProviderKind, string> = {
	faux: "faux-1",
	// Both DeepSeek ids come from the checkout's generated catalog
	// (packages/ai/src/providers/data/deepseek.json): deepseek-flash, deepseek-v4-pro.
	deepseek: "deepseek-flash",
	openai: "gpt-4o-mini",
	custom: "",
};

/**
 * Build an OpenAI-compatible provider for an explicit endpoint.
 *
 * The built-in providers hard-code their base URLs, so a gateway or a
 * self-hosted OpenAI-compatible server needs this. Only the OpenAI Chat
 * Completions API is used, which is the widest common denominator for
 * compatible servers.
 */
async function buildCustomProvider(options: ProbeOptions): Promise<{
	provider: ReturnType<typeof createProvider<"openai-completions">>;
	modelId: string;
	providerId: string;
}> {
	const baseUrl = options.baseUrl;
	const apiKey = options.apiKey;
	const modelId = options.modelId;
	const providerId = options.customProviderId ?? "custom";
	if (baseUrl === undefined || baseUrl.trim() === "") throw new Error("provider custom requires baseUrl");
	if (apiKey === undefined || apiKey.trim() === "") throw new Error("provider custom requires apiKey");
	if (modelId === undefined || modelId.trim() === "") throw new Error("provider custom requires modelId");

	// Imported lazily so a faux-only run never loads the OpenAI SDK.
	const { openAICompletionsApi } = await import("@earendil-works/pi-ai/api/openai-completions.lazy");

	const model: Model<"openai-completions"> = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: options.maxTokens ?? 8_192,
	};

	const provider = createProvider<"openai-completions">({
		id: providerId,
		name: `OpenAI-compatible (${providerId})`,
		baseUrl,
		auth: {
			// The key is captured in this closure only; nothing prints or stores it.
			apiKey: {
				name: `${providerId} API key`,
				resolve: async () => ({ auth: { apiKey }, source: "probe option" }),
			},
		},
		models: [model],
		api: openAICompletionsApi() as ProviderStreams,
	});
	return { provider, modelId, providerId };
}

/**
 * Build Models for the chosen provider.
 *
 * The faux provider never touches the network, so this path works with no
 * credentials at all. The openai path reads OPENAI_API_KEY from the environment
 * inside the provider itself; this function never copies the key anywhere.
 */
async function buildModels(
	options: ProbeOptions,
	fauxResponses: readonly string[],
	fauxToolTurns: ProbeOptions["fauxToolTurns"],
): Promise<{ models: Models; faux: FauxProviderHandle | undefined; modelId: string; providerId: string }> {
	const provider = options.provider ?? "faux";
	const models = createModels();
	if (provider === "faux") {
		// The catalog is the provider's own; an empty list falls back to its default,
		// so a caller that passes nothing gets the same single model as before.
		const faux = fauxProvider(options.fauxModels === undefined ? {} : { models: [...options.fauxModels] });
		models.setProvider(faux.provider);
		// Tool-call turns first, then text turns. A real turn order is "call the
		// tools, then answer", and the Harness settles the submission on the first
		// turn that ends without a tool call — so a text turn queued first would
		// finish the run before any `pi.tool` task ran, which is exactly what
		// TASK-002 needs to exercise.
		faux.setResponses([
			...(fauxToolTurns ?? []).map((calls) =>
				// `stopReason: "toolUse"` is what makes the built-in generation task
				// create a real `pi.tool` task. With the default "stop" the turn is
				// treated as a finished answer and the calls are never run.
				fauxAssistantMessage(
					calls.map((call) => fauxToolCall(call.name, call.arguments)),
					{ stopReason: "toolUse" },
				),
			),
			...fauxResponses.map((text) => fauxAssistantMessage(text)),
			// TASK-003: a router answers every remaining request from the request
			// itself; it is appended last so fixed scripts keep their order.
			...(options.fauxRouter === undefined ? [] : Array.from({ length: 200 }, () => options.fauxRouter!)),
		]);
		return { models, faux, modelId: options.modelId ?? DEFAULT_MODEL_ID.faux, providerId: "faux" };
	}
	if (provider === "deepseek") {
		if (process.env.DEEPSEEK_API_KEY === undefined) {
			throw new Error("DEEPSEEK_API_KEY is not set; export it or use the faux provider.");
		}
		// The built-in provider already carries base_url https://api.deepseek.com
		// and the correct per-model `compat` settings from the generated catalog.
		const { deepseekProvider } = await import("@earendil-works/pi-ai/providers/deepseek");
		models.setProvider(deepseekProvider());
		return {
			models,
			faux: undefined,
			modelId: options.modelId ?? DEFAULT_MODEL_ID.deepseek,
			providerId: "deepseek",
		};
	}
	if (provider === "openai") {
		if (process.env.OPENAI_API_KEY === undefined) {
			throw new Error("OPENAI_API_KEY is not set; use the faux provider or export the key.");
		}
		const { openaiProvider } = await import("@earendil-works/pi-ai/providers/openai");
		models.setProvider(openaiProvider());
		return { models, faux: undefined, modelId: options.modelId ?? DEFAULT_MODEL_ID.openai, providerId: "openai" };
	}
	const custom = await buildCustomProvider(options);
	models.setProvider(custom.provider);
	return { models, faux: undefined, modelId: custom.modelId, providerId: custom.providerId };
}

/**
 * Assemble a Harness over a SQLite file.
 *
 * No `env` is passed: this probe has no tools that touch the file system or a
 * shell, so the optional execution environment is simply absent. That is the
 * same choice the Vacation demo makes, and it keeps the probe free of any
 * capability interface.
 */
export async function openProbe(options: ProbeOptions): Promise<ProbeRuntime> {
	const provider = options.provider ?? "faux";
	const reports: unknown[] = [];

	const built = await buildModels(options, options.fauxResponses ?? [], options.fauxToolTurns);

	// The registry is this process's code, never persisted. createRegistry()
	// seeds the built-in tasks (generation, compaction, tool) that Harness.open
	// requires; any caller-supplied extension (such as TASK-002's `notion-read`)
	// is installed on top.
	const registry = createRegistry();
	const extensions = options.extensions ?? [];
	for (const extension of extensions) registry.install(extension);
	// Installed but not selected for the root: the registry can resolve them
	// when a child conversation's agent is configured to include them.
	for (const extension of options.registryExtensions ?? []) registry.install(extension);
	const installedExtensions = registry.snapshot().installed().map((extension) => extension.name);

	const storage = await openNodeSqliteStorage(options.databasePath);
	const harness = await Harness.open(
		storage,
		{
			models: built.models,
			registry,
			onReport: (error) => reports.push(error),
			...(options.settings === undefined ? {} : { settings: options.settings }),
		},
		context,
	);

	return {
		harness,
		models: built.models,
		registry,
		provider,
		modelRef: { provider: built.providerId, modelId: built.modelId },
		faux: built.faux,
		installedExtensions,
		selectedExtensions: extensions,
		reports,
		async close() {
			// close() writes no task outcome, so a reopened Harness continues
			// whatever was interrupted rather than seeing it as finished.
			await harness.close(context);
		},
	};
}

/**
 * Root conversation with the agent model configured.
 *
 * The first `root()` call creates conversation ID 1 and its built-in documents.
 * Later calls, including after a restart, return the existing root and ignore
 * the agent change. The extensions a run installed are selected here as objects;
 * an array selects exactly these, in order.
 */
export async function openRoot(runtime: ProbeRuntime) {
	const extensions = runtime.selectedExtensions;
	const agent =
		extensions.length === 0
			? { model: runtime.modelRef }
			: { model: runtime.modelRef, extensions: [...extensions] };
	return runtime.harness.root(context, { agent });
}
