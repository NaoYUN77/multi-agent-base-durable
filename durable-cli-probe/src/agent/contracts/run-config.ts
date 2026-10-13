// TASK-005.1 src/agent/contracts/run-config.ts
//
// The run configuration contract.
//
// Every limit is explicit and finite: a configuration that omits a limit, or
// that asks for an unbounded one, is refused before the first sub-agent starts
// (contract §"生命周期、并行与额度"). The numbers are the *operator's or the
// test's* decision — this module never supplies a default, because a default
// would become an unbounded value nobody chose.

import { Violations, readCount, readHexHash, readNoUnknownKeys, readObject, readPositiveInteger, readSchemaVersion, readStableId, readString } from "./validate.ts";
import type { ContractValidation } from "./errors.ts";

export const RUN_CONFIG_SCHEMA_VERSION = 1;

/** How a provider/harness-level failure may be retried. Bounded, by definition. */
export type RetryPolicy = {
	readonly maxRetries: number;
	readonly backoffMs: number;
};

export type RunConfig = {
	readonly schemaVersion: number;
	/** How many sub-agents may run at the same time across the whole run. */
	readonly maxConcurrentSubAgents: number;
	/** How many sub-agents one user request may launch. */
	readonly maxSubAgentsPerRequest: number;
	readonly maxToolInvocationsPerRound: number;
	readonly maxFailedToolCallsPerRound: number;
	/** Attempts per operation: quality rework and provider retries share this budget. */
	readonly maxAttemptsPerOperation: number;
	/** Technical restarts allowed before the task is abandoned. */
	readonly maxTechnicalRestarts: number;
	readonly roundTimeoutMs: number;
	readonly providerRetry: RetryPolicy;
	readonly harnessRetry: RetryPolicy;
};

const KNOWN_FIELDS: readonly string[] = [
	"schemaVersion",
	"maxConcurrentSubAgents",
	"maxSubAgentsPerRequest",
	"maxToolInvocationsPerRound",
	"maxFailedToolCallsPerRound",
	"maxAttemptsPerOperation",
	"maxTechnicalRestarts",
	"roundTimeoutMs",
	"providerRetry",
	"harnessRetry",
];

function readRetryPolicy(value: unknown, path: string, collect: Violations): RetryPolicy | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["maxRetries", "backoffMs"]);
	const maxRetries = readCount(holder, "maxRetries", `${path}.maxRetries`, collect);
	const backoffMs = readCount(holder, "backoffMs", `${path}.backoffMs`, collect);
	if (maxRetries === undefined || backoffMs === undefined) return undefined;
	return { maxRetries, backoffMs };
}

/**
 * Validate a run configuration. `undefined` is refused: "no configuration" is
 * itself an invalid configuration, and the caller must pass one explicitly.
 *
 * Performs no IO and has no defaults: the returned config contains exactly the
 * limits that were supplied.
 */
export function validateRunConfig(input: unknown): ContractValidation<RunConfig> {
	const collect = new Violations();
	if (input === undefined) {
		collect.add("run_config_missing", "$", "a run configuration is required; there is no default");
		return collect.finish(undefined as unknown as RunConfig);
	}
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as RunConfig);
	readNoUnknownKeys(holder, "$", collect, KNOWN_FIELDS);
	const schemaVersion = readSchemaVersion(holder, "$", collect, [RUN_CONFIG_SCHEMA_VERSION]);
	const maxConcurrentSubAgents = readPositiveInteger(holder, "maxConcurrentSubAgents", "$.maxConcurrentSubAgents", collect);
	const maxSubAgentsPerRequest = readPositiveInteger(holder, "maxSubAgentsPerRequest", "$.maxSubAgentsPerRequest", collect);
	const maxToolInvocationsPerRound = readCount(holder, "maxToolInvocationsPerRound", "$.maxToolInvocationsPerRound", collect);
	const maxFailedToolCallsPerRound = readCount(holder, "maxFailedToolCallsPerRound", "$.maxFailedToolCallsPerRound", collect);
	const maxAttemptsPerOperation = readPositiveInteger(holder, "maxAttemptsPerOperation", "$.maxAttemptsPerOperation", collect);
	const maxTechnicalRestarts = readCount(holder, "maxTechnicalRestarts", "$.maxTechnicalRestarts", collect);
	const roundTimeoutMs = readPositiveInteger(holder, "roundTimeoutMs", "$.roundTimeoutMs", collect);
	const providerRetry = readRetryPolicy(holder.providerRetry, "$.providerRetry", collect);
	const harnessRetry = readRetryPolicy(holder.harnessRetry, "$.harnessRetry", collect);
	if (
		schemaVersion === undefined ||
		maxConcurrentSubAgents === undefined ||
		maxSubAgentsPerRequest === undefined ||
		maxToolInvocationsPerRound === undefined ||
		maxFailedToolCallsPerRound === undefined ||
		maxAttemptsPerOperation === undefined ||
		maxTechnicalRestarts === undefined ||
		roundTimeoutMs === undefined ||
		providerRetry === undefined ||
		harnessRetry === undefined
	) {
		return collect.finish(undefined as unknown as RunConfig);
	}
	return collect.finish({
		schemaVersion,
		maxConcurrentSubAgents,
		maxSubAgentsPerRequest,
		maxToolInvocationsPerRound,
		maxFailedToolCallsPerRound,
		maxAttemptsPerOperation,
		maxTechnicalRestarts,
		roundTimeoutMs,
		providerRetry,
		harnessRetry,
	});
}

/** One tool as it was actually authorized, with the version that ran. */
export type ToolVersion = {
	/** Tool name as the model saw it (snake_case). */
	readonly name: string;
	/** Version identifier of the implementation that actually ran. */
	readonly version: string;
};

/** Read the authorized tool list: names and the versions that actually ran. */
function readToolVersions(value: unknown, path: string, collect: Violations): ToolVersion[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		collect.add("type_array", path, "must be an array when present");
		return [];
	}
	const tools: ToolVersion[] = [];
	value.forEach((entry, index) => {
		const holder = readObject(entry, `${path}[${index}]`, collect);
		if (holder === undefined) return;
		readNoUnknownKeys(holder, `${path}[${index}]`, collect, ["name", "version"]);
		const name = readStableId(holder, "name", `${path}[${index}].name`, collect);
		const version = readString(holder, "version", `${path}[${index}].version`, collect);
		if (name === undefined || version === undefined) return;
		tools.push({ name, version });
	});
	return tools;
}

/** Config snapshot recorded with every task run: what the run actually used. */
export type TaskConfigSnapshot = {
	/** Schema version of this document shape. */
	readonly schemaVersion: number;
	/**
	 * Revision of the *behaviour contract* this configuration was built against.
	 * Distinct from schemaVersion: a contract revision can change while the shape
	 * stays identical, and a resumed run must be able to tell those apart.
	 */
	readonly contractRevision: number;
	/**
	 * Version of the **user requirement** this run was built for — the business
	 * revision of the request, bumped when the user restates what they want.
	 *
	 * Deliberately a third field: `contractRevision` versions the rules the run
	 * obeys, `taskSpecVersion` versions the dispatched spec, `planVersion` versions
	 * the plan, and none of them says *which requirement* was answered. A resumed
	 * run that cannot tell "the same requirement, new plan" from "a new
	 * requirement" would silently answer the wrong one.
	 */
	readonly requestVersion: number;
	readonly taskSpecVersion: number;
	readonly planVersion: number;
	/** The prompt the program assembled from the validated spec, never raw model prose. */
	readonly assembledPrompt: string;
	readonly skillVersion: string;
	readonly skillHash: string;
	/** The tools actually authorized for this run, with the version that ran. */
	readonly tools: ToolVersion[];
	readonly model: string;
	readonly budget: RunConfig;
	/** Stable hash of everything above, so a resumed run can prove it is the same config. */
	readonly configHash: string;
};

const SNAPSHOT_FIELDS: readonly string[] = [
	"schemaVersion",
	"contractRevision",
	"requestVersion",
	"taskSpecVersion",
	"planVersion",
	"assembledPrompt",
	"skillVersion",
	"skillHash",
	"tools",
	"model",
	"budget",
	"configHash",
];

/**
 * Validate a recorded configuration snapshot. A snapshot must be complete: a
 * resumed run compares it hash-for-hash with what it would assemble now, and a
 * missing field would make that comparison silently weaker.
 */
export function validateTaskConfigSnapshot(input: unknown): ContractValidation<TaskConfigSnapshot> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as TaskConfigSnapshot);
	readNoUnknownKeys(holder, "$", collect, SNAPSHOT_FIELDS);
	const schemaVersion = readSchemaVersion(holder, "$", collect, [RUN_CONFIG_SCHEMA_VERSION]);
	const contractRevision = readPositiveInteger(holder, "contractRevision", "$.contractRevision", collect);
	const requestVersion = readPositiveInteger(holder, "requestVersion", "$.requestVersion", collect);
	const taskSpecVersion = readPositiveInteger(holder, "taskSpecVersion", "$.taskSpecVersion", collect);
	const planVersion = readPositiveInteger(holder, "planVersion", "$.planVersion", collect);
	// The prompt the program assembled: long free text, not an identifier.
	const assembledPrompt = readString(holder, "assembledPrompt", "$.assembledPrompt", collect);
	const skillVersion = readStableId(holder, "skillVersion", "$.skillVersion", collect);
	const skillHash = readHexHash(holder, "skillHash", "$.skillHash", collect);
	const model = readStableId(holder, "model", "$.model", collect);
	const tools = readToolVersions(holder.tools, "$.tools", collect);
	const budget = validateRunConfig(holder.budget);
	if (!budget.ok) for (const item of budget.violations) collect.add(item.code, `$.budget${item.path.slice(1)}`, item.detail);
	const configHash = readHexHash(holder, "configHash", "$.configHash", collect);
	if (
		schemaVersion === undefined ||
		contractRevision === undefined ||
		requestVersion === undefined ||
		taskSpecVersion === undefined ||
		planVersion === undefined ||
		assembledPrompt === undefined ||
		skillVersion === undefined ||
		skillHash === undefined ||
		model === undefined ||
		configHash === undefined ||
		!budget.ok
	) {
		return collect.finish(undefined as unknown as TaskConfigSnapshot);
	}
	return collect.finish({
		schemaVersion,
		contractRevision,
		requestVersion,
		taskSpecVersion,
		planVersion,
		assembledPrompt,
		skillVersion,
		skillHash,
		tools,
		model,
		budget: budget.value,
		configHash,
	});
}
