// TASK-005.1 src/agent/contracts/task-spec.ts
//
// The task specification contract: what the Main Agent dispatches and the
// Builder configures from.
//
// Two properties are load-bearing and are enforced here rather than by
// convention:
//
//   1. Structural fields are authoritative. A free-text `notes` field exists for
//      the human's context, but nothing downstream reads it as an instruction:
//      the program generates the child's submission text from these validated
//      fields, so a model's prose can never widen a task's scope, add a tool or
//      drop an acceptance item (contract §"任务、Skill、工厂与权限").
//   2. The dependency graph is closed. A dependency on an id that is not in the
//      same batch is refused, and so is a cycle: both would otherwise surface as
//      a task that can never be admitted, discovered only by the scheduler much
//      later.

import { Violations, readCount, readIdArray, readNoUnknownKeys, readObject, readOptionalString, readPositiveInteger, readSchemaVersion, readStableId, readString, readStringList } from "./validate.ts";
import type { ContractValidation } from "./errors.ts";

/** Current schema version of the task specification. */
export const TASK_SPEC_SCHEMA_VERSION = 1;

/** One piece of material the task may use, with where it came from. */
export type TaskMaterial = {
	readonly id: string;
	readonly content: string;
	/** Where the material came from. Recorded, never inferred. */
	readonly source: string;
};

/** What the task must produce, before any work starts. */
export type TaskOutputContract = {
	readonly format: string;
	readonly requiredFields: string[];
	readonly maxItems?: number;
};

/** Explicit, finite limits. Nothing here may be unbounded. */
export type TaskBudget = {
	readonly maxToolInvocations: number;
	readonly maxAttempts: number;
	readonly maxTechnicalRestarts: number;
	readonly timeoutMs: number;
};

export type TaskSpec = {
	readonly schemaVersion: number;
	readonly id: string;
	/** 目标/用途: what this task is for. */
	readonly purpose: string;
	readonly materials: TaskMaterial[];
	readonly scope: string[];
	readonly exclusions: string[];
	readonly constraints: string[];
	readonly outputContract: TaskOutputContract;
	readonly acceptance: string[];
	/** Skill id that must resolve in the local skill manifest. */
	readonly skillId: string;
	/** Tools the task *requests*; the authorized set is a subset decision, not a right. */
	readonly requestedTools: string[];
	/** Task ids that must reach an accepted state first. Verified within the batch. */
	readonly dependencies: string[];
	readonly budget: TaskBudget;
	/** Free text for humans and prompts. Never an instruction to any component. */
	readonly notes?: string;
};

const KNOWN_FIELDS: readonly string[] = [
	"schemaVersion",
	"id",
	"purpose",
	"materials",
	"scope",
	"exclusions",
	"constraints",
	"outputContract",
	"acceptance",
	"skillId",
	"requestedTools",
	"dependencies",
	"budget",
	"notes",
];

function readMaterial(value: unknown, path: string, collect: Violations): TaskMaterial | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["id", "content", "source"]);
	const id = readStableId(holder, "id", `${path}.id`, collect);
	const content = readString(holder, "content", `${path}.content`, collect);
	const source = readString(holder, "source", `${path}.source`, collect);
	if (id === undefined || content === undefined || source === undefined) return undefined;
	return { id, content, source };
}

function readMaterialList(value: unknown, path: string, collect: Violations): TaskMaterial[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		collect.add("type_array", path, "must be an array when present");
		return [];
	}
	const materials: TaskMaterial[] = [];
	value.forEach((entry, index) => {
		const material = readMaterial(entry, `${path}[${index}]`, collect);
		if (material !== undefined) materials.push(material);
	});
	return materials;
}

function readOutputContract(value: unknown, path: string, collect: Violations): TaskOutputContract | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["format", "requiredFields", "maxItems"]);
	const format = readString(holder, "format", `${path}.format`, collect);
	const requiredFields = readIdArray(holder, "requiredFields", `${path}.requiredFields`, collect) ?? [];
	if (format === undefined) return undefined;
	if (requiredFields.length === 0) {
		collect.add("output_contract_empty", `${path}.requiredFields`, "an output contract must name at least one required field");
		return undefined;
	}
	const maxItems = holder.maxItems === undefined ? undefined : readPositiveInteger(holder, "maxItems", `${path}.maxItems`, collect);
	return maxItems === undefined ? { format, requiredFields } : { format, requiredFields, maxItems };
}

function readBudget(value: unknown, path: string, collect: Violations): TaskBudget | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["maxToolInvocations", "maxAttempts", "maxTechnicalRestarts", "timeoutMs"]);
	const maxToolInvocations = readCount(holder, "maxToolInvocations", `${path}.maxToolInvocations`, collect);
	const maxAttempts = readCount(holder, "maxAttempts", `${path}.maxAttempts`, collect);
	const maxTechnicalRestarts = readCount(holder, "maxTechnicalRestarts", `${path}.maxTechnicalRestarts`, collect);
	// A zero timeout is a hang waiting to happen; the run config carries the round bound.
	const timeoutMs = readPositiveInteger(holder, "timeoutMs", `${path}.timeoutMs`, collect);
	if (maxToolInvocations === undefined || maxAttempts === undefined || maxTechnicalRestarts === undefined || timeoutMs === undefined) return undefined;
	if (maxAttempts < 1) {
		collect.add("budget_attempts_zero", `${path}.maxAttempts`, "at least one attempt must be allowed");
		return undefined;
	}
	return { maxToolInvocations, maxAttempts, maxTechnicalRestarts, timeoutMs };
}

/**
 * Validate one task specification.
 *
 * @param input - unknown, model- or operator-authored JSON.
 * @returns the typed spec, or every violation found with its field path.
 * Performs no IO: nothing is read from disk, no model is called, and no
 * document is written. Pure and idempotent — the same input always yields the
 * same result.
 */
export function validateTaskSpec(input: unknown): ContractValidation<TaskSpec> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as TaskSpec);
	readNoUnknownKeys(holder, "$", collect, KNOWN_FIELDS);
	const schemaVersion = readSchemaVersion(holder, "$", collect, [TASK_SPEC_SCHEMA_VERSION]);
	const id = readStableId(holder, "id", "$.id", collect);
	const purpose = readString(holder, "purpose", "$.purpose", collect);
	const materials = readMaterialList(holder.materials, "$.materials", collect);
	const scope = readStringList(holder.scope, "$.scope", collect);
	const exclusions = readStringList(holder.exclusions, "$.exclusions", collect);
	const constraints = readStringList(holder.constraints, "$.constraints", collect);
	const outputContract = readOutputContract(holder.outputContract, "$.outputContract", collect);
	const acceptance = readStringList(holder.acceptance, "$.acceptance", collect);
	const skillId = readStableId(holder, "skillId", "$.skillId", collect);
	const requestedTools = readIdArray(holder, "requestedTools", "$.requestedTools", collect) ?? [];
	const dependencies = readIdArray(holder, "dependencies", "$.dependencies", collect) ?? [];
	const budget = readBudget(holder.budget, "$.budget", collect);
	const notes = readOptionalString(holder, "notes", "$.notes", collect);
	if (acceptance.length === 0) collect.add("acceptance_empty", "$.acceptance", "a task must state at least one acceptance item");
	if (scope.length === 0) collect.add("scope_empty", "$.scope", "a task must state its scope");
	if (
		schemaVersion === undefined ||
		id === undefined ||
		purpose === undefined ||
		outputContract === undefined ||
		skillId === undefined ||
		budget === undefined
	) {
		return collect.finish(undefined as unknown as TaskSpec);
	}
	return collect.finish({
		schemaVersion,
		id,
		purpose,
		materials,
		scope,
		exclusions,
		constraints,
		outputContract,
		acceptance,
		skillId,
		requestedTools,
		dependencies,
		budget,
		...(notes === undefined ? {} : { notes }),
	});
}

/**
 * Validate a batch of task specifications as a unit: ids unique, every
 * dependency resolvable inside the batch, and no dependency cycle. A batch is
 * what one plan dispatches, so these properties can only be checked across it.
 */
export function validateTaskBatch(input: unknown): ContractValidation<readonly TaskSpec[]> {
	const collect = new Violations();
	if (!Array.isArray(input)) return collect.finish([] as readonly TaskSpec[]);
	if (input.length === 0) {
		collect.add("batch_empty", "$", "a plan must dispatch at least one task");
		return collect.finish([] as readonly TaskSpec[]);
	}
	const specs: TaskSpec[] = [];
	// First pass: shape, so later passes can trust the ids.
	input.forEach((entry, index) => {
		const result = validateTaskSpec(entry);
		if (result.ok) specs.push(result.value);
		else {
			for (const item of result.violations) collect.add(item.code, `$[${index}].${item.path === "$" ? "" : item.path.slice(2)}`, item.detail);
		}
	});
	if (specs.length !== input.length) return collect.finish([] as readonly TaskSpec[]);

	const byId = new Map<string, TaskSpec>();
	for (const spec of specs) {
		if (byId.has(spec.id)) collect.add("batch_duplicate_id", `$[${specs.indexOf(spec)}].id`, `task id ${spec.id} appears more than once`);
		byId.set(spec.id, spec);
	}
	// Second pass: the graph.
	for (const spec of specs) {
		for (const dependency of spec.dependencies) {
			if (!byId.has(dependency)) collect.add("dependency_unknown", `$[${spec.id}].dependencies`, `unknown task id ${dependency}`);
		}
	}
	for (const cycle of findDependencyCycles(specs)) {
		collect.add("dependency_cycle", `$[${cycle[0]}].dependencies`, `dependency cycle: ${cycle.join(" -> ")}`);
	}
	return collect.finish(specs);
}

/** Depth-first cycle detection over the batch's dependency edges. */
function findDependencyCycles(specs: readonly TaskSpec[]): readonly string[][] {
	const edges = new Map<string, readonly string[]>(specs.map((spec) => [spec.id, spec.dependencies]));
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];
	const found: string[][] = [];

	const visit = (id: string): void => {
		const current = state.get(id);
		if (current === "done") return;
		if (current === "visiting") {
			const start = stack.indexOf(id);
			found.push([...stack.slice(start === -1 ? 0 : start), id]);
			return;
		}
		state.set(id, "visiting");
		stack.push(id);
		for (const next of edges.get(id) ?? []) visit(next);
		stack.pop();
		state.set(id, "done");
	};

	for (const spec of specs) if (found.length === 0) visit(spec.id);
	return found;
}
