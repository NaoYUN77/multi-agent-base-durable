// TASK-005.1 src/agent/contracts/validate.ts
//
// The shared, dependency-free field validators every contract in this directory
// is built from. They all take `unknown` — because everything that crosses a
// trust boundary arrives as untyped JSON — record a violation with a stable code
// and a field path instead of throwing, and never touch the disk, the network or
// the model. The contract files compose these into their own validators; the
// state machine in `../state` composes them for request-time admission.

import { hasViolation as has, type ContractValidation, type ContractViolation, violation } from "./errors.ts";
import type { ContractViolationError } from "./errors.ts";

export { hasViolation } from "./errors.ts";
export type { ContractValidation, ContractViolation } from "./errors.ts";

/** Accumulates violations and hands back the typed value, or undefined. */
export class Violations {
	readonly #found: ContractViolation[] = [];

	/** Report one violation. */
	add(code: string, path: string, detail: string): void {
		this.#found.push(violation(code, path, detail));
	}

	/** True when at least one violation was recorded. */
	get reported(): boolean {
		return this.#found.length > 0;
	}

	get list(): readonly ContractViolation[] {
		return this.#found;
	}

	/** Wrap a validated value, or fail the whole check when anything was reported. */
	finish<T>(value: T): ContractValidation<T> {
		return this.#found.length === 0 ? { ok: true, value } : { ok: false, violations: this.list };
	}
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * True for a string with the contract's stable-id shape. Exposed for callers
 * that must refuse a free-form id *before* it becomes a document key — an id
 * that fails this check cannot be written into a contract document, so letting
 * it through turns a refusal into an unreadable document.
 */
export function isStableId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value);
}

/** True for a plain object (not an array, not null, not a class instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a plain object at `path`. `undefined` is not allowed here: a contract
 * document either has the object or it violates.
 */
export function readObject(value: unknown, path: string, collect: Violations): Record<string, unknown> | undefined {
	if (!isPlainObject(value)) {
		collect.add("type_object", path, "must be an object");
		return undefined;
	}
	return value;
}

/** A present, non-empty string. */
export function readString(holder: Record<string, unknown>, field: string, path: string, collect: Violations): string | undefined {
	const value = holder[field];
	if (typeof value !== "string" || value.trim() === "") {
		collect.add("type_string", path, "must be a non-empty string");
		return undefined;
	}
	return value;
}

/** An optional string: absent or empty is reported only when `required` is set. */
export function readOptionalString(holder: Record<string, unknown>, field: string, path: string, collect: Violations): string | undefined {
	const value = holder[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		collect.add("type_string", path, "must be a string when present");
		return undefined;
	}
	return value;
}

/** A boolean that must be present and actually boolean. */
export function readBoolean(holder: Record<string, unknown>, field: string, path: string, collect: Violations): boolean | undefined {
	const value = holder[field];
	if (typeof value !== "boolean") {
		collect.add("type_boolean", path, "must be a boolean");
		return undefined;
	}
	return value;
}

/**
 * A positive integer: rejects non-numbers, `NaN`, `±Infinity`, non-integers,
 * zero and negatives. `min: 1` by default so a limit of "zero" has to be asked
 * for explicitly — an absent limit is a different (also rejected) case.
 */
export function readPositiveInteger(
	holder: Record<string, unknown>,
	field: string,
	path: string,
	collect: Violations,
	options: { readonly min?: number } = {},
): number | undefined {
	const min = options.min ?? 1;
	const value = holder[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		collect.add("limit_not_finite", path, "must be a finite number");
		return undefined;
	}
	if (!Number.isInteger(value)) {
		collect.add("limit_not_integer", path, "must be an integer");
		return undefined;
	}
	if (value < min) {
		collect.add("limit_out_of_range", path, `must be >= ${min}`);
		return undefined;
	}
	return value;
}

/** A required positive integer that may also legitimately be 0 (a quota of zero calls). */
export function readCount(holder: Record<string, unknown>, field: string, path: string, collect: Violations): number | undefined {
	return readPositiveInteger(holder, field, path, collect, { min: 0 });
}

/** A schema version: a positive integer, compared against a supported range. */
export function readSchemaVersion(
	holder: Record<string, unknown>,
	path: string,
	collect: Violations,
	supported: readonly number[],
): number | undefined {
	const value = readPositiveInteger(holder, "schemaVersion", path, collect);
	if (value === undefined) return undefined;
	if (!supported.includes(value)) {
		collect.add("schema_version_unsupported", path, `supported versions: ${supported.join(", ")}`);
		return undefined;
	}
	return value;
}

/**
 * A stable identifier. Ids are program-assigned or mapped by the program from a
 * model's draft, so the shape is deliberately narrow: lowercase, digits, dot,
 * dash, underscore, at most 128 characters. A free-form id is how one task
 * silently becomes another.
 */
export function readStableId(holder: Record<string, unknown>, field: string, path: string, collect: Violations): string | undefined {
	const value = readString(holder, field, path, collect);
	if (value === undefined) return undefined;
	if (!isStableId(value)) {
		collect.add("id_invalid", path, "must match ^[a-z0-9][a-z0-9._-]{0,127}$");
		return undefined;
	}
	return value;
}

/**
 * A list of non-empty strings. Every element is checked: an illegal item is
 * reported with its index rather than filtered out, because dropping one would
 * silently narrow a task's scope, constraints or acceptance list.
 */
export function readStringList(value: unknown, path: string, collect: Violations): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		collect.add("type_array", path, "must be an array when present");
		return [];
	}
	const items: string[] = [];
	value.forEach((entry, index) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			collect.add("type_string", `${path}[${index}]`, "must be a non-empty string");
			return;
		}
		items.push(entry);
	});
	return items;
}

/** An array of strings, each a stable identifier. */
export function readIdArray(holder: Record<string, unknown>, field: string, path: string, collect: Violations): string[] | undefined {
	const value = holder[field];
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		collect.add("type_array", path, "must be an array when present");
		return undefined;
	}
	const ids: string[] = [];
	value.forEach((entry, index) => {
		if (!isStableId(entry)) {
			collect.add("id_invalid", `${path}[${index}]`, "must match ^[a-z0-9][a-z0-9._-]{0,127}$");
			return;
		}
		ids.push(entry);
	});
	return ids;
}

/**
 * A content hash: 64 lowercase hex characters. Used for the skill manifest hash
 * and the configuration hash, where a truncated value would make the comparison
 * a snapshot is meant to support meaningless.
 */
export function readHexHash(holder: Record<string, unknown>, field: string, path: string, collect: Violations): string | undefined {
	const value = readString(holder, field, path, collect);
	if (value === undefined) return undefined;
	if (!/^[0-9a-f]{64}$/.test(value)) {
		collect.add("hash_invalid", path, "must be 64 lowercase hex characters");
		return undefined;
	}
	return value;
}

/** A string restricted to a closed set of values. */
export function readEnum<T extends string>(
	holder: Record<string, unknown>,
	field: string,
	path: string,
	collect: Violations,
	allowed: readonly T[],
): T | undefined {
	const value = readString(holder, field, path, collect);
	if (value === undefined) return undefined;
	if (!allowed.includes(value as T)) {
		collect.add("value_not_allowed", path, `must be one of ${allowed.join(", ")}`);
		return undefined;
	}
	return value as T;
}

/** An optional enum value: absent is fine, anything else must be allowed. */
export function readOptionalEnum<T extends string>(
	holder: Record<string, unknown>,
	field: string,
	path: string,
	collect: Violations,
	allowed: readonly T[],
): T | undefined {
	if (holder[field] === undefined) return undefined;
	return readEnum(holder, field, path, collect, allowed);
}

/** An optional identifier: absent is fine, present must be stable. */
export function readOptionalStableId(holder: Record<string, unknown>, field: string, path: string, collect: Violations): string | undefined {
	if (holder[field] === undefined) return undefined;
	return readStableId(holder, field, path, collect);
}

/** Unknown keys are refused: a typo'd field must not silently become a default. */
export function readNoUnknownKeys(holder: Record<string, unknown>, path: string, collect: Violations, known: readonly string[]): void {
	for (const key of Object.keys(holder)) {
		if (!known.includes(key)) collect.add("field_unknown", `${path}.${key}`, `unknown field; expected one of ${known.join(", ")}`);
	}
}

/** Reference back into a contract error, so callers can re-throw it untyped. */
export function asViolationError(error: unknown): ContractViolationError {
	if (error instanceof Error && error.name === "ContractViolationError") return error as ContractViolationError;
	throw error;
}

export { has as hasViolationAt };
