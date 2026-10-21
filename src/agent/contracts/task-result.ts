// TASK-005.1 src/agent/contracts/task-result.ts
//
// The task result contract, and the field authorization that goes with it.
//
// A task result has two authors with two different rights (contract §"三层故障与
// 结果"):
//
//   * the **runtime** owns identity, the real run status, the error
//     classification, the attempt counts, whether a side effect is known, and
//     every evidence reference — because those come from Durable tasks,
//     submissions and entries, and must not be inferable from model text;
//   * the **model** owns the work content: the summary, the findings, the
//     unresolved items and references to artifacts it wrote.
//
// The split is enforced structurally: `validateModelWork` refuses anything that
// is not the model's to write, with a stable code naming the reserved field. A
// model that claims `status: "completed"` or attaches an evidence reference is
// rejected before the document is assembled, so a forged result cannot be
// persisted, let alone read back as evidence.

import { Violations, readBoolean, readCount, readEnum, readNoUnknownKeys, readObject, readOptionalEnum, readOptionalStableId, readPositiveInteger, readSchemaVersion, readStableId, readString, readStringList } from "./validate.ts";
import type { ContractValidation } from "./errors.ts";

export const TASK_RESULT_SCHEMA_VERSION = 1;

/** What the model is allowed to write. Everything else is reserved. */
export type ModelWork = {
	readonly summary: string;
	readonly findings: string[];
	readonly unresolved: string[];
	/** Artifacts the model produced or referenced. Not Durable evidence. */
	readonly artifacts: TaskArtifact[];
};

export type TaskArtifact = {
	readonly kind: string;
	readonly ref: string;
};

/** What only the runtime may write, because only it observed it. */
export type RuntimeOutcome = {
	readonly taskId: string;
	readonly round: number;
	readonly status: "completed" | "failed" | "cancelled";
	/** How a non-completed outcome is classified. Technical failures reach Main, they do not end the task. */
	readonly failureKind?: "technical" | "quality" | "cancelled" | "quota";
	/** Attempts spent on this operation, quality rework included. */
	readonly attempts: number;
	/** Technical restarts spent. Counted separately from quality attempts. */
	readonly technicalRestarts: number;
	readonly toolInvocations: number;
	/**
	 * Whether Main must decide how this operation continues. Set on a round that
	 * exhausted its technical budget: the round is over and nothing further will
	 * happen to it on its own, but the *task* is not abandoned — Main may start a
	 * technical restart or a targeted rework. A quality failure does not set it
	 * (the work was done and reviewed), and a cancelled round does not set it (the
	 * decision was already made).
	 */
	readonly requiresMainDecision?: boolean;
	/** Whether a side effect may exist that nobody recorded. Never claimed as "none" without proof. */
	readonly sideEffect: "unknown" | "none" | "recorded";
	readonly settledAt: number;
};

/** Reference to persisted evidence: an entry of this task's own child conversation. */
export type ResultEvidenceReference = {
	readonly entryId: string;
	readonly kind: string;
	readonly byTaskId?: string;
	readonly toolCallId?: string;
	readonly toolName?: string;
};

export type TaskResult = {
	readonly schemaVersion: number;
	/** Program-assigned identity of this result record. */
	readonly resultId: string;
	readonly runtime: RuntimeOutcome;
	readonly evidence: ResultEvidenceReference[];
	readonly work: ModelWork;
};

const MODEL_WORK_FIELDS: readonly string[] = ["summary", "findings", "unresolved", "artifacts"];
const RUNTIME_FIELDS: readonly string[] = [
	"schemaVersion",
	"resultId",
	"taskId",
	"round",
	"status",
	"failureKind",
	"attempts",
	"technicalRestarts",
	"toolInvocations",
	"sideEffect",
	"settledAt",
	"evidence",
	"runtime",
];
const KNOWN_FIELDS: readonly string[] = [...MODEL_WORK_FIELDS, "work", ...RUNTIME_FIELDS];

function readArtifact(value: unknown, path: string, collect: Violations): TaskArtifact | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["kind", "ref"]);
	const kind = readStableId(holder, "kind", `${path}.kind`, collect);
	const ref = readString(holder, "ref", `${path}.ref`, collect);
	if (kind === undefined || ref === undefined) return undefined;
	return { kind, ref };
}

/**
 * Validate the model-authored part of a result.
 *
 * @param input - unknown, the model's structured output.
 * @returns the typed work content, or a violation whose code names the reserved
 * field that was written. Performs no IO; pure and idempotent.
 */
export function validateModelWork(input: unknown): ContractValidation<ModelWork> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as ModelWork);
	// Unknown keys are refused *and* the refusal says why: a reserved field is
	// not a typo, it is an escalation of privilege.
	readNoUnknownKeys(holder, "$", collect, MODEL_WORK_FIELDS);
	for (const field of RUNTIME_FIELDS) {
		if (holder[field] !== undefined) {
			collect.add("reserved_field", `$.${field}`, `${field} is runtime-owned; the model may not write it`);
		}
	}
	const summary = readString(holder, "summary", "$.summary", collect);
	const findings = readStringList(holder.findings, "$.findings", collect);
	const unresolved = readStringList(holder.unresolved, "$.unresolved", collect);
	const artifacts: TaskArtifact[] = [];
	if (Array.isArray(holder.artifacts)) {
		holder.artifacts.forEach((entry, index) => {
			const artifact = readArtifact(entry, `$.artifacts[${index}]`, collect);
			if (artifact !== undefined) artifacts.push(artifact);
		});
	} else if (holder.artifacts !== undefined) {
		collect.add("type_array", "$.artifacts", "must be an array when present");
	}
	if (summary === undefined) return collect.finish(undefined as unknown as ModelWork);
	return collect.finish({ summary, findings, unresolved, artifacts });
}

function readEvidence(value: unknown, path: string, collect: Violations): ResultEvidenceReference | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["entryId", "kind", "byTaskId", "toolCallId", "toolName"]);
	const entryId = readString(holder, "entryId", `${path}.entryId`, collect);
	const kind = readStableId(holder, "kind", `${path}.kind`, collect);
	if (entryId === undefined || kind === undefined) return undefined;
	const byTaskId = readOptionalStableId(holder, "byTaskId", `${path}.byTaskId`, collect);
	const toolCallId = readOptionalStableId(holder, "toolCallId", `${path}.toolCallId`, collect);
	const toolName = readOptionalStableId(holder, "toolName", `${path}.toolName`, collect);
	return {
		entryId,
		kind,
		...(byTaskId === undefined ? {} : { byTaskId }),
		...(toolCallId === undefined ? {} : { toolCallId }),
		...(toolName === undefined ? {} : { toolName }),
	};
}

function readRuntime(value: unknown, path: string, collect: Violations): RuntimeOutcome | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, [
		"taskId",
		"round",
		"status",
		"failureKind",
		"attempts",
		"technicalRestarts",
		"toolInvocations",
		"requiresMainDecision",
		"sideEffect",
		"settledAt",
	]);
	const taskId = readStableId(holder, "taskId", `${path}.taskId`, collect);
	const round = readPositiveInteger(holder, "round", `${path}.round`, collect);
	const status = readEnum(holder, "status", `${path}.status`, collect, ["completed", "failed", "cancelled"] as const);
	const failureKind = readOptionalEnum(holder, "failureKind", `${path}.failureKind`, collect, ["technical", "quality", "cancelled", "quota"] as const);
	const attempts = readCount(holder, "attempts", `${path}.attempts`, collect);
	const technicalRestarts = readCount(holder, "technicalRestarts", `${path}.technicalRestarts`, collect);
	const toolInvocations = readCount(holder, "toolInvocations", `${path}.toolInvocations`, collect);
	const requiresMainDecision = holder.requiresMainDecision === undefined ? undefined : readBoolean(holder, "requiresMainDecision", `${path}.requiresMainDecision`, collect);
	const sideEffect = readEnum(holder, "sideEffect", `${path}.sideEffect`, collect, ["unknown", "none", "recorded"] as const);
	const settledAt = readCount(holder, "settledAt", `${path}.settledAt`, collect);
	if (status !== "completed" && failureKind === undefined) {
		collect.add("failure_kind_missing", `${path}.failureKind`, "a non-completed outcome must be classified");
	}
	if (
		taskId === undefined ||
		round === undefined ||
		status === undefined ||
		attempts === undefined ||
		technicalRestarts === undefined ||
		toolInvocations === undefined ||
		sideEffect === undefined ||
		settledAt === undefined
	) {
		return undefined;
	}
	if (status !== "completed" && status !== "failed" && status !== "cancelled") return undefined;
	return {
		taskId,
		round,
		status,
		attempts,
		technicalRestarts,
		toolInvocations,
		sideEffect,
		settledAt,
		...(failureKind === undefined ? {} : { failureKind: failureKind as RuntimeOutcome["failureKind"] }),
		...(requiresMainDecision === undefined ? {} : { requiresMainDecision }),
	};
}

/**
 * Validate a complete task result: program-assembled, so the runtime fields are
 * present. Use {@link validateModelWork} on anything the model produced.
 */
export function validateTaskResult(input: unknown): ContractValidation<TaskResult> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as TaskResult);
	readNoUnknownKeys(holder, "$", collect, KNOWN_FIELDS);
	const schemaVersion = readSchemaVersion(holder, "$", collect, [TASK_RESULT_SCHEMA_VERSION]);
	const resultId = readStableId(holder, "resultId", "$.resultId", collect);
	const work = validateModelWork(holder.work);
	if (!work.ok) for (const item of work.violations) collect.add(item.code, `$.work${item.path.slice(1)}`, item.detail);
	const runtime = readRuntime(holder.runtime, "$.runtime", collect);
	const evidence: ResultEvidenceReference[] = [];
	if (Array.isArray(holder.evidence)) {
		holder.evidence.forEach((entry, index) => {
			const reference = readEvidence(entry, `$.evidence[${index}]`, collect);
			if (reference !== undefined) evidence.push(reference);
		});
	} else if (holder.evidence !== undefined) {
		collect.add("type_array", "$.evidence", "must be an array when present");
	}
	if (schemaVersion === undefined || resultId === undefined || runtime === undefined || !work.ok) {
		return collect.finish(undefined as unknown as TaskResult);
	}
	return collect.finish({ schemaVersion, resultId, runtime, evidence, work: work.value });
}

// ── Evidence attribution ─────────────────────────────────────────────────────
//
// Shape validation cannot answer AC-04's "cross-task evidence cannot be forged":
// a reference that *looks* right is not a reference that belongs to this task.
// The check below is the one the runtime performs before it attaches evidence,
// and it needs the facts only persistence can supply: which conversation the
// entry lives in, which durable task produced it, which durable tasks belong to
// *this round*, and what the entry itself says about its tool call.
//
// Two rules that a shape check cannot express, and this one does:
//
//   * **The result's own identity is bound too.** A result claiming another
//     business task, or another round, is refused before its evidence is even
//     considered — otherwise a perfectly legitimate entry of round 1 would make
//     a round-99 result look verifiable.
//   * **A reference must describe the entry it points at.** The declared `kind`
//     is compared with the persisted one, and a declared `toolCallId`/`toolName`
//     must be *present and equal* on the entry. "The entry happens not to carry
//     that field" is not a pass: it is exactly the hole a forged reference needs.
//
// Note the two id spaces: `entry.taskId` is Durable's task id (a harness
// concept) and `businessTaskId` is the application's. They are never compared to
// each other by name; the bridge is the program's own binding list.

/** What the harness can say about one persisted entry. */
export type PersistedEntryIndex = {
	readonly entryId: string;
	readonly conversationId: string;
	/** Durable task id that produced the entry, when it was durable work. */
	readonly taskId?: string;
	readonly kind: string;
	/** The tool call the entry answers, when the entry is a tool result. */
	readonly toolCallId?: string;
	/** The tool that produced the entry, when the entry is a tool result. */
	readonly toolName?: string;
	/** The submission the entry belongs to, when the entry records one. */
	readonly submissionId?: string;
};

/** Where the evidence is supposed to come from. */
export type EvidenceAttributionContext = {
	/** Child conversation this task's work happened in. */
	readonly childConversationId: string;
	/** Business task id that owns the work. Must equal the runtime outcome's. */
	readonly businessTaskId: string;
	/** Round the result settles. Must equal the runtime outcome's round. */
	readonly round: number;
	/**
	 * Durable task ids bound to **this round**, not to the whole business task.
	 *
	 * This is what separates "round 1's evidence" from "round 2's evidence" inside
	 * one child conversation: a reworked task runs several durable tasks, and only
	 * the ones this round created may back this round's result. The whole-task
	 * list would let a previous round's entry impersonate the current one.
	 */
	readonly roundDurableTaskIds: readonly string[];
	/** The submission whose work this round is, when the caller knows it. */
	readonly submissionId?: string;
};

/**
 * Verify that every evidence reference really belongs to this task's work.
 *
 * Refuses, with a stable code: an entry that is not in the index at all
 * (`evidence_entry_unknown`), an entry from another conversation
 * (`evidence_conversation_foreign`), a reference whose declared `kind` is not the
 * persisted kind (`evidence_kind_mismatch`), a reference naming another business
 * task (`evidence_task_foreign`), an entry with no durable-task attribution at
 * all (`evidence_task_unattributed`), an entry produced by a durable task outside
 * this round (`evidence_task_mismatch`), an entry from another submission
 * (`evidence_submission_mismatch`), and a declared tool call or tool name that
 * the entry does not carry or does not match (`evidence_toolcall_unverifiable`,
 * `evidence_toolcall_mismatch`, `evidence_toolname_unverifiable`,
 * `evidence_toolname_mismatch`).
 *
 * Performs no IO: the caller reads the entries and hands them in, so the check
 * stays a pure function of persisted facts.
 */
export function verifyEvidenceAttribution(
	references: readonly ResultEvidenceReference[],
	known: ReadonlyMap<string, PersistedEntryIndex>,
	context: EvidenceAttributionContext,
): ContractValidation<readonly ResultEvidenceReference[]> {
	const collect = new Violations();
	const accepted: ResultEvidenceReference[] = [];
	const roundOwned = new Set(context.roundDurableTaskIds);
	references.forEach((reference, index) => {
		const path = `$.evidence[${index}]`;
		const entry = known.get(reference.entryId);
		if (entry === undefined) {
			collect.add("evidence_entry_unknown", `${path}.entryId`, `no entry ${reference.entryId} is known in this task's child conversation`);
			return;
		}
		if (entry.conversationId !== context.childConversationId) {
			collect.add("evidence_conversation_foreign", `${path}.entryId`, `entry ${reference.entryId} belongs to conversation ${entry.conversationId}, not ${context.childConversationId}`);
			return;
		}
		// The reference must describe the entry it names, not a different one.
		if (reference.kind !== entry.kind) {
			collect.add("evidence_kind_mismatch", `${path}.kind`, `entry ${reference.entryId} is a ${entry.kind}, not a ${reference.kind}`);
			return;
		}
		if (reference.byTaskId !== undefined && reference.byTaskId !== context.businessTaskId) {
			collect.add("evidence_task_foreign", `${path}.byTaskId`, `entry ${reference.entryId} is claimed for task ${reference.byTaskId}, not ${context.businessTaskId}`);
			return;
		}
		// Round-scoped: an entry the round did not produce cannot be its evidence.
		if (entry.taskId === undefined) {
			collect.add("evidence_task_unattributed", `${path}.entryId`, `entry ${reference.entryId} carries no durable task attribution, so it cannot be attributed to round ${context.round}`);
			return;
		}
		if (!roundOwned.has(entry.taskId)) {
			collect.add("evidence_task_mismatch", `${path}.entryId`, `entry ${reference.entryId} was produced by durable task ${entry.taskId}, which is not part of round ${context.round}`);
			return;
		}
		if (context.submissionId !== undefined && entry.submissionId !== undefined && entry.submissionId !== context.submissionId) {
			collect.add("evidence_submission_mismatch", `${path}.entryId`, `entry ${reference.entryId} belongs to submission ${entry.submissionId}, not ${context.submissionId}`);
			return;
		}
		// A declared tool call must be verifiable on the entry, never merely plausible.
		if (reference.toolCallId !== undefined) {
			if (entry.toolCallId === undefined) {
				collect.add("evidence_toolcall_unverifiable", `${path}.toolCallId`, `entry ${reference.entryId} records no tool call, so the claimed ${reference.toolCallId} cannot be checked`);
				return;
			}
			if (reference.toolCallId !== entry.toolCallId) {
				collect.add("evidence_toolcall_mismatch", `${path}.toolCallId`, `entry ${reference.entryId} belongs to tool call ${entry.toolCallId}, not ${reference.toolCallId}`);
				return;
			}
		}
		if (reference.toolName !== undefined) {
			if (entry.toolName === undefined) {
				collect.add("evidence_toolname_unverifiable", `${path}.toolName`, `entry ${reference.entryId} records no tool name, so the claimed ${reference.toolName} cannot be checked`);
				return;
			}
			if (reference.toolName !== entry.toolName) {
				collect.add("evidence_toolname_mismatch", `${path}.toolName`, `entry ${reference.entryId} was produced by ${entry.toolName}, not ${reference.toolName}`);
				return;
			}
		}
		accepted.push(reference);
	});
	if (collect.reported) return { ok: false, violations: collect.list };
	return { ok: true, value: accepted };
}

/**
 * Assemble a task result from its three sources: the program-assigned identity,
 * the runtime's observed outcome, and the model's validated work.
 *
 * The order matters. Identity is checked first — a result that names another
 * business task or another round is not this round's result, however clean its
 * evidence is. Then the model's work, then the evidence, which is attributed
 * against the persisted entries before the result is returned, so a forged or
 * foreign reference never reaches a document.
 */
export function assembleTaskResult(input: {
	readonly resultId: string;
	readonly runtime: RuntimeOutcome;
	readonly work: unknown;
	readonly evidence: readonly ResultEvidenceReference[];
	readonly knownEntries: ReadonlyMap<string, PersistedEntryIndex>;
	readonly attribution: EvidenceAttributionContext;
}): ContractValidation<TaskResult> {
	const collect = new Violations();
	if (input.runtime.taskId !== input.attribution.businessTaskId) {
		collect.add(
			"result_task_mismatch",
			"$.runtime.taskId",
			`runtime names task ${input.runtime.taskId}, but the attribution context is ${input.attribution.businessTaskId}`,
		);
	}
	if (input.runtime.round !== input.attribution.round) {
		collect.add("result_round_mismatch", "$.runtime.round", `runtime names round ${input.runtime.round}, but the attribution context is round ${input.attribution.round}`);
	}
	const work = validateModelWork(input.work);
	if (!work.ok) {
		for (const item of work.violations) collect.add(item.code, `$.work${item.path.slice(1)}`, item.detail);
		return { ok: false, violations: collect.list };
	}
	const attribution = verifyEvidenceAttribution(input.evidence, input.knownEntries, input.attribution);
	if (!attribution.ok) {
		for (const item of attribution.violations) collect.add(item.code, item.path, item.detail);
		return { ok: false, violations: collect.list };
	}
	if (collect.reported) return { ok: false, violations: collect.list };
	return validateTaskResult({
		schemaVersion: TASK_RESULT_SCHEMA_VERSION,
		resultId: input.resultId,
		runtime: input.runtime,
		evidence: attribution.value,
		work: work.value,
	});
}
