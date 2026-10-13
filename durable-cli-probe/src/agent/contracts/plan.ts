// TASK-005.1 src/agent/contracts/plan.ts
//
// The plan contract and its expected-version check.
//
// A plan is a *versioned draft*, and a version check is what stops a stale one
// from being executed: reading an older version than the save expected is
// refused rather than migrated forward, because a plan that changed underneath
// a dispatcher is a different plan (contract §"Main Agent 合同"). Saving a plan
// is not an authorization to dispatch: `dispatch_tasks` needs the version the
// program read, and this file provides both sides of that check.

import { Violations, readCount, readIdArray, readNoUnknownKeys, readObject, readPositiveInteger, readSchemaVersion, readStableId, readStringList } from "./validate.ts";
import type { ContractValidation } from "./errors.ts";

export const PLAN_SCHEMA_VERSION = 1;

export type Plan = {
	readonly schemaVersion: number;
	readonly planId: string;
	/** Starts at 1 and increases by exactly one per accepted save. */
	readonly version: number;
	readonly goals: string[];
	/** Task ids the plan dispatches. They must exist in the batch that executes it. */
	readonly taskIds: string[];
	/** Questions that must be settled before the plan may be dispatched. */
	readonly relatedQuestionIds: string[];
	/** The version this one replaces, when it is a revision. */
	readonly supersedes?: number;
	readonly savedAt: number;
};

const KNOWN_FIELDS: readonly string[] = ["schemaVersion", "planId", "version", "goals", "taskIds", "relatedQuestionIds", "supersedes", "savedAt"];

/**
 * Validate one plan document. No IO, pure, idempotent: the same bytes always
 * produce the same plan, which is what makes a read-then-save comparison
 * meaningful across a reopen.
 */
export function validatePlan(input: unknown): ContractValidation<Plan> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as Plan);
	readNoUnknownKeys(holder, "$", collect, KNOWN_FIELDS);
	const schemaVersion = readSchemaVersion(holder, "$", collect, [PLAN_SCHEMA_VERSION]);
	const planId = readStableId(holder, "planId", "$.planId", collect);
	const version = readPositiveInteger(holder, "version", "$.version", collect);
	const goals = readStringList(holder.goals, "$.goals", collect);
	const taskIds = readIdArray(holder, "taskIds", "$.taskIds", collect) ?? [];
	const relatedQuestionIds = readIdArray(holder, "relatedQuestionIds", "$.relatedQuestionIds", collect) ?? [];
	const supersedes = holder.supersedes === undefined ? undefined : readPositiveInteger(holder, "supersedes", "$.supersedes", collect);
	const savedAt = readCount(holder, "savedAt", "$.savedAt", collect);
	if (goals.length === 0) collect.add("plan_goals_empty", "$.goals", "a plan must state at least one goal");
	if (taskIds.length === 0) collect.add("plan_tasks_empty", "$.taskIds", "a plan must name at least one task");
	if (supersedes !== undefined && version !== undefined && supersedes >= version) {
		collect.add("plan_supersedes_invalid", "$.supersedes", `a plan may only supersede a lower version (version ${version}, supersedes ${supersedes})`);
	}
	if (schemaVersion === undefined || planId === undefined || version === undefined || savedAt === undefined) {
		return collect.finish(undefined as unknown as Plan);
	}
	return collect.finish({
		schemaVersion,
		planId,
		version,
		goals,
		taskIds,
		relatedQuestionIds,
		...(supersedes === undefined ? {} : { supersedes }),
		savedAt,
	});
}

/** Raised when the plan version on disk is not the one the caller expected. */
export class PlanVersionError extends Error {
	readonly planId: string;
	readonly expected: number;
	readonly actual: number | undefined;
	constructor(planId: string, expected: number, actual: number | undefined) {
		super(
			actual === undefined
				? `plan ${planId}: expected version ${expected}, but no plan is stored`
				: `plan ${planId}: expected version ${expected}, but the stored version is ${actual}`,
		);
		this.name = "PlanVersionError";
		this.planId = planId;
		this.expected = expected;
		this.actual = actual;
	}
}

/**
 * Compare a stored plan against the version the caller read, refusing a stale or
 * missing one. `undefined` means "no plan stored yet", which is refused for the
 * same reason an old one is: the caller's decision was made against a specific
 * plan.
 *
 * Side effects: none. Throws {@link PlanVersionError} on mismatch, so a caller
 * that passes this check may persist its write in the same commit.
 */
export function assertPlanVersion(options: {
	readonly planId: string;
	readonly expectedVersion: number;
	readonly storedVersion: number | undefined;
}): void {
	const { planId, expectedVersion, storedVersion } = options;
	if (storedVersion === undefined || storedVersion !== expectedVersion) {
		throw new PlanVersionError(planId, expectedVersion, storedVersion);
	}
}

/**
 * The version a *next* save must use, given the version that was read. Pure.
 * Used by the save path so the increment is computed once, not per caller.
 */
export function nextPlanVersion(currentVersion: number): number {
	return currentVersion + 1;
}
