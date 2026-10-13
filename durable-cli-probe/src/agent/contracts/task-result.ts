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

import { Violations, readCount, readEnum, readNoUnknownKeys, readObject, readOptionalEnum, readOptionalStableId, readPositiveInteger, readSchemaVersion, readStableId, readString, readStringList } from "./validate.ts";
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
// entry lives in, which durable task produced it, and which durable tasks the
// program has already bound to this business task.
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
	readonly toolCallId?: string;
	readonly kind: string;
};

/** Where the evidence is supposed to come from. */
export type EvidenceAttributionContext = {
	/** Child conversation this task's work happened in. */
	readonly childConversationId: string;
	/** Business task id that owns the work. */
	readonly businessTaskId: string;
	/**
	 * Durable task ids the program has bound to this business task (the ledger's
	 * operation bindings). An entry produced by any other durable task is not
	 * this task's evidence.
	 */
	readonly ownedDurableTaskIds: readonly string[];
	/** Round the result settles. */
	readonly round: number;
};

/**
 * Verify that every evidence reference really belongs to this task's work.
 *
 * Refuses, with a stable code: an entry that is not in the index at all
 * (`evidence_entry_unknown`), an entry from another conversation
 * (`evidence_conversation_foreign`), a reference naming another business task
 * (`evidence_task_foreign`), an entry produced by a durable task this business
 * task does not own (`evidence_task_mismatch`), and a tool-call reference that
 * does not match the entry's own tool call (`evidence_toolcall_mismatch`).
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
	const owned = new Set(context.ownedDurableTaskIds);
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
		if (reference.byTaskId !== undefined && reference.byTaskId !== context.businessTaskId) {
			collect.add("evidence_task_foreign", `${path}.byTaskId`, `entry ${reference.entryId} is claimed for task ${reference.byTaskId}, not ${context.businessTaskId}`);
			return;
		}
		if (entry.taskId !== undefined && !owned.has(entry.taskId)) {
			collect.add("evidence_task_mismatch", `${path}.entryId`, `entry ${reference.entryId} was produced by durable task ${entry.taskId}, which ${context.businessTaskId} does not own`);
			return;
		}
		if (reference.toolCallId !== undefined && entry.toolCallId !== undefined && reference.toolCallId !== entry.toolCallId) {
			collect.add("evidence_toolcall_mismatch", `${path}.toolCallId`, `entry ${reference.entryId} belongs to tool call ${entry.toolCallId}, not ${reference.toolCallId}`);
			return;
		}
		accepted.push(reference);
	});
	if (collect.reported) return { ok: false, violations: collect.list };
	return { ok: true, value: accepted };
}

/**
 * Assemble a task result from its three sources: the program-assigned identity,
 * the runtime's observed outcome, and the model's validated work. Evidence is
 * attributed against the persisted entries *before* the result is returned, so a
 * forged or foreign reference never reaches a document.
 */
export function assembleTaskResult(input: {
	readonly resultId: string;
	readonly runtime: RuntimeOutcome;
	readonly work: unknown;
	readonly evidence: readonly ResultEvidenceReference[];
	readonly knownEntries: ReadonlyMap<string, PersistedEntryIndex>;
	readonly attribution: EvidenceAttributionContext;
}): ContractValidation<TaskResult> {
	const work = validateModelWork(input.work);
	if (!work.ok) return { ok: false, violations: work.violations };
	const attribution = verifyEvidenceAttribution(input.evidence, input.knownEntries, input.attribution);
	if (!attribution.ok) return attribution;
	return validateTaskResult({
		schemaVersion: TASK_RESULT_SCHEMA_VERSION,
		resultId: input.resultId,
		runtime: input.runtime,
		evidence: input.evidence,
		work: work.value,
	});
}
