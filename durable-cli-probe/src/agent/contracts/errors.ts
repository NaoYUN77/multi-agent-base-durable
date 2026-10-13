// TASK-005.1 src/agent/contracts/errors.ts
//
// The one error shape every contract validator in this directory reports through.
//
// Validation is a *result*, not a throw: a caller that assembles a TaskSpec from
// several sources (a config file, a request from the TUI, a model's draft) needs
// every violation at once, with the field path of each, instead of fixing them
// one exception at a time. `assertValid` exists for the places that do want the
// throwing style (tool entry points, tests), so both styles stay consistent.

/** One violation: a stable code, the field path it was found at, and why. */
export type ContractViolation = {
	/** Stable, machine-readable code. Never contains a value, only the rule. */
	readonly code: string;
	/** Dot path from the document root, e.g. `budget.maxToolInvocationsPerRound` or `dependencies[2]`. */
	readonly path: string;
	/** Human-readable detail for operators and logs. */
	readonly detail: string;
};

/** Successful validation: the value is now typed at `T`. */
export type ContractValidation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly violations: readonly ContractViolation[] };

export class ContractViolationError extends Error {
	readonly violations: readonly ContractViolation[];
	constructor(violations: readonly ContractViolation[]) {
		super(`contract violation: ${violations.map((violation) => `${violation.path}: ${violation.code} (${violation.detail})`).join("; ")}`);
		this.name = "ContractViolationError";
		this.violations = violations;
	}
}

/** Build one violation. */
export function violation(code: string, path: string, detail: string): ContractViolation {
	return { code, path, detail };
}

/** Collect violations with the throwing style callers expect at a trust boundary. */
export function assertValid<T>(result: ContractValidation<T>): T {
	if (result.ok) return result.value;
	throw new ContractViolationError(result.violations);
}

/**
 * True when every violation at `path` or below it matches one of `codes`.
 * Used by tests that assert a specific rule fired, without pinning the whole
 * violation list (so adding new rules does not break existing assertions).
 */
export function hasViolation(result: { readonly ok: false; readonly violations: readonly ContractViolation[] }, code: string, path?: string): boolean {
	return result.violations.some((violation) => violation.code === code && (path === undefined || violation.path === path));
}
