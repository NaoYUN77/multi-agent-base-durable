// TASK-005.1 src/agent/state/authorization.ts
//
// The field authorization matrix: who may write what.
//
// The contract splits every persisted field between three writers with different
// rights (TASK-005 §"三层故障与结果", §"任务、Skill、工厂与权限"):
//
//   * **application** — the user's answers, the task identity, the plan and the
//     configuration. These come from the user or the program, never from a model;
//   * **model** — the work content: summary, findings, unresolved items, artifact
//     references. The model's right to write ends there;
//   * **runtime** — the outcome: identity of the result, the real run status, the
//     error classification, the attempt counts, whether a side effect may exist,
//     and every evidence reference. Observed by the program, not by the model.
//
// Keeping the matrix here, as data, is what makes it checkable: a tool that
// receives model output looks the path up and refuses anything the model may not
// write, with the field named. A model cannot forge a status, an evidence
// reference, or an answer.

/** Who may write a field. */
export type FieldOwner = "application" | "model" | "runtime";

/** Every durable field path this subsystem owns, with its writer. */
export const FIELD_OWNERS: Readonly<Record<string, FieldOwner>> = {
	// ── application: the user and the program ──────────────────────────────
	"request.text": "application",
	"request.materials": "application",
	"request.requestedAt": "application",
	"clarification.questions": "application",
	// Only ever "application" — a model cannot record an answer.
	"clarification.answers": "application",
	"clarification.answers[].source": "application",
	"clarification.resolutions[].resolvedBy": "application",
	"plan.goals": "application",
	"plan.taskIds": "application",
	"plan.version": "application",
	"plan.relatedQuestionIds": "application",
	"taskConfig.assembledPrompt": "application",
	"taskConfig.skillVersion": "application",
	"taskConfig.skillHash": "application",
	"taskConfig.tools": "application",
	"taskConfig.budget": "application",
	"taskConfig.configHash": "application",
	"taskSpec.id": "application",
	"taskSpec.dependencies": "application",
	"taskSpec.budget": "application",
	"taskSpec.acceptance": "application",
	"taskSpec.skillId": "application",

	// ── model: the work content only ───────────────────────────────────────
	"result.work.summary": "model",
	"result.work.findings": "model",
	"result.work.unresolved": "model",
	"result.work.artifacts": "model",

	// ── runtime: what only the program observes ─────────────────────────────
	"result.resultId": "runtime",
	"result.runtime": "runtime",
	"result.runtime.taskId": "runtime",
	"result.runtime.round": "runtime",
	"result.runtime.status": "runtime",
	"result.runtime.failureKind": "runtime",
	"result.runtime.attempts": "runtime",
	"result.runtime.technicalRestarts": "runtime",
	"result.runtime.toolInvocations": "runtime",
	"result.runtime.sideEffect": "runtime",
	"result.runtime.settledAt": "runtime",
	"result.evidence": "runtime",
};

/** Raised when a writer touches a field it does not own. */
export class FieldAuthorizationError extends Error {
	readonly path: string;
	readonly actor: FieldOwner;
	readonly owner: FieldOwner;
	constructor(path: string, actor: FieldOwner, owner: FieldOwner) {
		super(`${actor} may not write ${path}: it is owned by ${owner}`);
		this.name = "FieldAuthorizationError";
		this.path = path;
		this.actor = actor;
		this.owner = owner;
	}
}

/** Who owns a field path, or undefined when the path is not in the matrix. */
export function ownerOf(path: string): FieldOwner | undefined {
	const exact = FIELD_OWNERS[path];
	if (exact !== undefined) return exact;
	// `answers[3]` style indices: the owner of the collection applies.
	for (const [known, owner] of Object.entries(FIELD_OWNERS)) {
		const prefix = known.endsWith("[]") ? known.slice(0, -2) : known;
		if (path.startsWith(`${prefix}[`)) return owner;
	}
	return undefined;
}

/**
 * Refuse a write by `actor` at `path` unless `actor` owns it. Unknown paths are
 * refused too: a field nobody declared has no authorization, and "nobody thought
 * about it" is not a permission model.
 */
export function assertFieldOwner(actor: FieldOwner, path: string): void {
	const owner = ownerOf(path);
	if (owner === undefined) throw new FieldAuthorizationError(path, actor, "application");
	if (owner !== actor) throw new FieldAuthorizationError(path, actor, owner);
}

/** Every field path a model may write. */
export function modelWritablePaths(): readonly string[] {
	return Object.entries(FIELD_OWNERS).filter(([, owner]) => owner === "model").map(([path]) => path);
}

/** True when `path` is one the model may write. */
export function isModelWritable(path: string): boolean {
	return ownerOf(path) === "model";
}

/**
 * The paths a model is *not* allowed to write, as a stable list. Used by tool
 * descriptions (so the model is told where its authority ends) and by tests.
 */
export function modelForbiddenPaths(): readonly string[] {
	return Object.keys(FIELD_OWNERS).filter((path) => ownerOf(path) !== "model");
}
