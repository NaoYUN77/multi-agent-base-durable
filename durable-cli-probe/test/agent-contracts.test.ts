// TASK-005.1 test/agent-contracts.test.ts
//
// The pure contract layer: every validator takes untrusted input, refuses what
// it must refuse with a stable code and a field path, and never touches the disk,
// the network or the model. Everything here runs offline and deterministically.
//
// Which acceptance item each block serves:
//   AC-01  schema coverage: unknown/invalid ids, cycles, old versions, and
//          negative / non-integer / infinite quotas are all refused — and so is
//          a *non-array* batch, a silently filtered list item and a
//          `blockingScope` that is not an array.
//   AC-03  questions, answers, versions and results survive a close/reopen — the
//          JSON roundtrip tests below are the local form of that.
//   AC-04  the model's right to write ends at its own work: status, identity and
//          evidence are runtime-owned, and cross-task evidence cannot be forged
//          from a model payload.

import { describe, expect, it } from "vitest";
import { composeModelResolution, composeUserAnswer, openQuestionIds, validateClarificationState } from "../src/agent/contracts/clarification.ts";
import { PlanVersionError, assertPlanVersion, nextPlanVersion, validatePlan } from "../src/agent/contracts/plan.ts";
import { RUN_CONFIG_SCHEMA_VERSION, validateRunConfig, validateTaskConfigSnapshot } from "../src/agent/contracts/run-config.ts";
import { TASK_RESULT_SCHEMA_VERSION, assembleTaskResult, validateModelWork, validateTaskResult, type PersistedEntryIndex } from "../src/agent/contracts/task-result.ts";
import { TASK_SPEC_SCHEMA_VERSION, validateTaskBatch, validateTaskSpec } from "../src/agent/contracts/task-spec.ts";
import { assertFieldOwner, modelForbiddenPaths, modelWritablePaths, ownerOf } from "../src/agent/state/authorization.ts";
import { AGENT_DOCUMENT_KINDS } from "../src/agent/contracts/documents.ts";

/** A spec that passes, so each test can break exactly one thing. */
const validTaskSpec = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
	schemaVersion: TASK_SPEC_SCHEMA_VERSION,
	id: "task-verify-source",
	purpose: "Check the source material against the run's own claims.",
	materials: [{ id: "mat-1", content: "Revenue is 1,204 units.", source: "provided-by-user" }],
	scope: ["Read the supplied material only."],
	exclusions: ["No network access."],
	constraints: ["Quote figures verbatim."],
	outputContract: { format: "text", requiredFields: ["summary"] },
	acceptance: ["States the figure and where it came from."],
	skillId: "text-check",
	requestedTools: ["text_check"],
	dependencies: [],
	budget: { maxToolInvocations: 4, maxAttempts: 3, maxTechnicalRestarts: 2, timeoutMs: 60_000 },
	...overrides,
});

const validRunConfig = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
	schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
	maxConcurrentSubAgents: 2,
	maxSubAgentsPerRequest: 2,
	maxToolInvocationsPerRound: 8,
	maxFailedToolCallsPerRound: 2,
	maxAttemptsPerOperation: 3,
	maxTechnicalRestarts: 2,
	roundTimeoutMs: 120_000,
	providerRetry: { maxRetries: 1, backoffMs: 25 },
	harnessRetry: { maxRetries: 1, backoffMs: 25 },
	...overrides,
});

describe("TASK-005.1 contracts — task spec (AC-01)", () => {
	it("accepts a complete spec", () => {
		expect(validateTaskSpec(validTaskSpec()).ok).toBe(true);
	});

	it("refuses an unknown field rather than ignoring it", () => {
		const result = validateTaskSpec(validTaskSpec({ taskPromt: "typo" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("field_unknown");
	});

	it("refuses an invalid id and an unsupported schema version", () => {
		expect(validateTaskSpec(validTaskSpec({ id: "Not A Stable Id" })).ok).toBe(false);
		expect(validateTaskSpec(validTaskSpec({ schemaVersion: TASK_SPEC_SCHEMA_VERSION + 1 })).ok).toBe(false);
		const missing = { ...(validTaskSpec() as Record<string, unknown>) };
		delete missing.schemaVersion;
		expect(validateTaskSpec(missing).ok).toBe(false);
	});

	it("refuses negative, non-integer and infinite quotas", () => {
		expect(validateTaskSpec(validTaskSpec({ budget: { maxToolInvocations: -1, maxAttempts: 3, maxTechnicalRestarts: 2, timeoutMs: 60_000 } })).ok).toBe(false);
		expect(validateTaskSpec(validTaskSpec({ budget: { maxToolInvocations: 4, maxAttempts: 2.5, maxTechnicalRestarts: 2, timeoutMs: 60_000 } })).ok).toBe(false);
		const infinite = validateTaskSpec(validTaskSpec({ budget: { maxToolInvocations: 4, maxAttempts: 3, maxTechnicalRestarts: 2, timeoutMs: Number.POSITIVE_INFINITY } }));
		expect(infinite.ok).toBe(false);
		if (!infinite.ok) expect(infinite.violations.map((item) => item.code)).toContain("limit_not_finite");
	});

	it("refuses an empty scope and an empty acceptance list", () => {
		expect(validateTaskSpec(validTaskSpec({ scope: [] })).ok).toBe(false);
		expect(validateTaskSpec(validTaskSpec({ acceptance: [] })).ok).toBe(false);
	});
});
describe("TASK-005.1 contracts — task batch graph (AC-01)", () => {
	it("accepts a batch whose dependencies resolve", () => {
		const result = validateTaskBatch([validTaskSpec({ id: "task-a" }), validTaskSpec({ id: "task-b", dependencies: ["task-a"] })]);
		expect(result.ok).toBe(true);
	});

	it("refuses a non-array batch instead of reading it as an empty one", () => {
		for (const input of [null, undefined, {}, "plan", 42]) {
			const result = validateTaskBatch(input);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("type_array");
		}
	});

	it("refuses an unknown dependency, a cycle and a duplicate id", () => {
		const unknown = validateTaskBatch([validTaskSpec({ id: "task-a", dependencies: ["task-missing"] })]);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.violations.map((item) => item.code)).toContain("dependency_unknown");

		const cycle = validateTaskBatch([validTaskSpec({ id: "task-a", dependencies: ["task-b"] }), validTaskSpec({ id: "task-b", dependencies: ["task-a"] })]);
		expect(cycle.ok).toBe(false);
		if (!cycle.ok) expect(cycle.violations.map((item) => item.code)).toContain("dependency_cycle");

		expect(validateTaskBatch([validTaskSpec({ id: "task-a" }), validTaskSpec({ id: "task-a" })]).ok).toBe(false);
		expect(validateTaskBatch([]).ok).toBe(false);
	});
});

describe("TASK-005.1 contracts — list items are checked, not filtered (AC-01)", () => {
	it("reports a non-string finding with its index, and refuses the payload", () => {
		const result = validateModelWork({ summary: "ok", findings: [42, "valid"] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.violations.map((item) => item.code)).toContain("type_string");
			expect(result.violations.some((item) => item.path === "$.findings[0]")).toBe(true);
		}
	});

	it("reports illegal scope, constraint, acceptance and goal items", () => {
		const spec = validateTaskSpec(validTaskSpec({ scope: ["ok", 7], constraints: [""], acceptance: [null] }));
		expect(spec.ok).toBe(false);
		if (!spec.ok) {
			expect(spec.violations.some((item) => item.path === "$.scope[1]")).toBe(true);
			expect(spec.violations.some((item) => item.path === "$.constraints[0]")).toBe(true);
			expect(spec.violations.some((item) => item.path === "$.acceptance[0]")).toBe(true);
		}
	});
});

describe("TASK-005.1 contracts — run config (AC-01)", () => {
	it("refuses a missing configuration: there is no default", () => {
		const result = validateRunConfig(undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("run_config_missing");
	});

	it("refuses an infinite limit and an unknown field", () => {
		const infinite = validateRunConfig(validRunConfig({ providerRetry: { maxRetries: Number.POSITIVE_INFINITY, backoffMs: 25 } }));
		expect(infinite.ok).toBe(false);
		if (!infinite.ok) expect(infinite.violations.map((item) => item.code)).toContain("limit_not_finite");
		expect(validateRunConfig(validRunConfig({ maxConcurrentSubagent: 3 })).ok).toBe(false);
	});

	it("accepts an explicit finite configuration", () => {
		const result = validateRunConfig(validRunConfig());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.roundTimeoutMs).toBe(120_000);
	});
});

describe("TASK-005.1 contracts — config snapshot (AC-01, AC-03)", () => {
	const snapshot = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
		schemaVersion: RUN_CONFIG_SCHEMA_VERSION,
		// The behaviour contract revision is separate from the schema version.
		contractRevision: 1,
		taskSpecVersion: 1,
		planVersion: 2,
		assembledPrompt: "Check the supplied material only.",
		skillVersion: "1.0.0",
		skillHash: "a".repeat(64),
		tools: [{ name: "text_check", version: "1.0.0" }],
		model: "faux-faux-1",
		budget: JSON.parse(JSON.stringify(validateRunConfig(validRunConfig()).ok ? (validateRunConfig(validRunConfig()) as { value: unknown }).value : null)),
		configHash: "b".repeat(64),
		...overrides,
	});

	it("accepts a snapshot carrying the contract revision and the tool versions", () => {
		const result = validateTaskConfigSnapshot(snapshot());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.contractRevision).toBe(1);
			expect(result.value.tools).toEqual([{ name: "text_check", version: "1.0.0" }]);
		}
	});

	it("refuses a snapshot without a contract revision or with a bare tool name", () => {
		const missing = { ...(snapshot() as Record<string, unknown>) };
		delete missing.contractRevision;
		expect(validateTaskConfigSnapshot(missing).ok).toBe(false);
		const bare = validateTaskConfigSnapshot(snapshot({ tools: ["text_check"] }));
		expect(bare.ok).toBe(false);
		if (!bare.ok) expect(bare.violations.some((item) => item.path === "$.tools[0]")).toBe(true);
	});

	it("round-trips a snapshot through JSON without changing it", () => {
		const first = validateTaskConfigSnapshot(snapshot());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const restored = validateTaskConfigSnapshot(JSON.parse(JSON.stringify(first.value)));
		expect(restored.ok).toBe(true);
		if (restored.ok) expect(restored.value).toEqual(first.value);
	});
});
describe("TASK-005.1 contracts — field authorization (AC-04)", () => {
	it("the model may write its work and nothing else", () => {
		expect(modelWritablePaths()).toEqual(["result.work.summary", "result.work.findings", "result.work.unresolved", "result.work.artifacts"]);
		expect(modelForbiddenPaths()).toContain("result.runtime.status");
		expect(modelForbiddenPaths()).toContain("result.evidence");
		expect(modelForbiddenPaths()).toContain("clarification.answers");
	});

	it("refuses a model write of status, evidence or an answer, and an undeclared field", () => {
		expect(() => assertFieldOwner("model", "result.runtime.status")).toThrow(/runtime/);
		expect(() => assertFieldOwner("model", "result.evidence")).toThrow(/runtime/);
		expect(() => assertFieldOwner("model", "clarification.answers")).toThrow(/application/);
		expect(() => assertFieldOwner("model", "result.work.nothing")).toThrow();
		expect(ownerOf("result.work.artifacts")).toBe("model");
		expect(ownerOf("request.text")).toBe("application");
	});
});

describe("TASK-005.1 contracts — result ownership (AC-04)", () => {
	const runtime = () => ({
		taskId: "task-verify-source",
		round: 1,
		status: "completed" as const,
		attempts: 1,
		technicalRestarts: 0,
		toolInvocations: 2,
		sideEffect: "recorded" as const,
		settledAt: 1_700_000_000_000,
	});
	const validResult = (): unknown => ({
		schemaVersion: TASK_RESULT_SCHEMA_VERSION,
		resultId: "result-1",
		runtime: runtime(),
		evidence: [{ entryId: "42", kind: "pi.tool-result", byTaskId: "task-verify-source" }],
		work: { summary: "The figure matches.", findings: [], unresolved: [], artifacts: [] },
	});

	it("accepts a program-assembled result", () => {
		expect(validateTaskResult(validResult()).ok).toBe(true);
	});

	it("refuses a model payload that carries runtime fields", () => {
		const result = validateModelWork({ summary: "x", status: "completed" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.violations.map((item) => item.code)).toContain("reserved_field");
			expect(result.violations.some((item) => item.path === "$.status")).toBe(true);
		}
	});

	it("refuses cross-task evidence smuggled into model work", () => {
		const result = validateModelWork({ summary: "x", evidence: [{ entryId: "9", kind: "pi.tool-result" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("reserved_field");
	});

	it("refuses a non-completed outcome without a classification", () => {
		const failed = validResult() as Record<string, Record<string, unknown>>;
		failed.runtime.status = "failed";
		const result = validateTaskResult(failed);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("failure_kind_missing");
	});

	it("round-trips a result through JSON without changing it (AC-03/AC-04)", () => {
		const first = validateTaskResult(validResult());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const restored = validateTaskResult(JSON.parse(JSON.stringify(first.value)));
		expect(restored.ok).toBe(true);
		if (restored.ok) expect(restored.value).toEqual(first.value);
	});
});

describe("TASK-005.1 contracts — evidence attribution (AC-04)", () => {
	const context = { childConversationId: "2", businessTaskId: "task-a", ownedDurableTaskIds: ["7"], round: 1 };
	const known = new Map<string, PersistedEntryIndex>([
		["1", { entryId: "1", conversationId: "2", taskId: "7", toolCallId: "c1", kind: "pi.tool-result" }],
		// A real entry of *another* conversation: the foreign-evidence negative case.
		["9", { entryId: "9", conversationId: "3", taskId: "8", kind: "pi.tool-result" }],
	]);

	it("accepts an entry that belongs to this task's child conversation", () => {
		const result = assembleTaskResult({
			resultId: "result-1",
			runtime: { taskId: "task-a", round: 1, status: "completed", attempts: 1, technicalRestarts: 0, toolInvocations: 1, sideEffect: "recorded", settledAt: 1 },
			work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
			evidence: [{ entryId: "1", kind: "pi.tool-result", byTaskId: "task-a", toolCallId: "c1" }],
			knownEntries: known,
			attribution: context,
		});
		expect(result.ok).toBe(true);
	});

	it("refuses an entry of another conversation, even when the reference names this task", () => {
		const result = assembleTaskResult({
			resultId: "result-1",
			runtime: { taskId: "task-a", round: 1, status: "completed", attempts: 1, technicalRestarts: 0, toolInvocations: 1, sideEffect: "recorded", settledAt: 1 },
			work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
			evidence: [{ entryId: "9", kind: "pi.tool-result", byTaskId: "task-a" }],
			knownEntries: known,
			attribution: context,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("evidence_conversation_foreign");
	});

	it("refuses an unknown entry, a foreign business task and a non-owned durable task", () => {
		const base = {
			resultId: "result-1",
			runtime: { taskId: "task-a", round: 1, status: "completed" as const, attempts: 1, technicalRestarts: 0, toolInvocations: 1, sideEffect: "recorded" as const, settledAt: 1 },
			work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
		};
		const unknown = assembleTaskResult({ ...base, evidence: [{ entryId: "404", kind: "pi.tool-result" }], knownEntries: known, attribution: context });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.violations.map((item) => item.code)).toContain("evidence_entry_unknown");

		const foreign = assembleTaskResult({ ...base, evidence: [{ entryId: "1", kind: "pi.tool-result", byTaskId: "task-b" }], knownEntries: known, attribution: context });
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) expect(foreign.violations.map((item) => item.code)).toContain("evidence_task_foreign");

		const notOwned = assembleTaskResult({
			...base,
			evidence: [{ entryId: "9", kind: "pi.tool-result" }],
			knownEntries: known,
			attribution: { ...context, childConversationId: "3", ownedDurableTaskIds: [] },
		});
		expect(notOwned.ok).toBe(false);
		if (!notOwned.ok) expect(notOwned.violations.map((item) => item.code)).toContain("evidence_task_mismatch");
	});
});
describe("TASK-005.1 contracts — clarification (AC-03)", () => {
	const state = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
		schemaVersion: 1,
		questions: [{ questionId: "q-1", question: "Which version?", reason: "Two are supplied.", blockingScope: ["scope"], askedAt: 10 }],
		answers: [{ questionId: "q-1", text: "The 2026 one.", source: "application", sufficient: true, answeredAt: 20 }],
		resolutions: [{ questionId: "q-1", resolvedAt: 21, resolvedBy: "model", basis: { kind: "answer", answerAt: 20 } }],
		...overrides,
	});

	it("refuses an answer that claims a source other than the application", () => {
		const payload = state() as Record<string, unknown[]>;
		(payload.answers as Record<string, unknown>[])[0].source = "model";
		const result = validateClarificationState(payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("answer_source_forbidden");
	});

	it("refuses a resolution that cites an answer that was never given", () => {
		const payload = state() as Record<string, unknown[]>;
		(payload.resolutions as Record<string, unknown>[])[0].basis = { kind: "answer", answerAt: 999 };
		const result = validateClarificationState(payload);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("resolution_answer_mismatch");
	});

	it("refuses a resolution of a question that was never asked", () => {
		const result = validateClarificationState({
			schemaVersion: 1,
			questions: [],
			answers: [],
			resolutions: [{ questionId: "q-ghost", resolvedAt: 1, resolvedBy: "model", basis: { kind: "original_input", detail: "the user said so" } }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("resolution_unknown_question");
	});

	it("keeps a question blocking when the answer is not sufficient, and unblocks when it is", () => {
		const vague = validateClarificationState(
			state({
				answers: [{ questionId: "q-1", text: "I am not sure, explain the options.", source: "application", sufficient: false, answeredAt: 20 }],
				resolutions: [],
			}),
		);
		expect(vague.ok).toBe(true);
		if (vague.ok) expect(openQuestionIds(vague.value)).toEqual(["q-1"]);

		const settled = validateClarificationState(state());
		expect(settled.ok).toBe(true);
		if (settled.ok) expect(openQuestionIds(settled.value)).toEqual([]);
	});

	it("accepts a resolution on the original input without any answer", () => {
		const onInput = validateClarificationState({
			schemaVersion: 1,
			questions: [{ questionId: "q-1", question: "Which?", reason: "two", blockingScope: [], askedAt: 1 }],
			answers: [],
			resolutions: [{ questionId: "q-1", resolvedAt: 2, resolvedBy: "model", basis: { kind: "original_input", detail: "the request already names the version" } }],
		});
		expect(onInput.ok).toBe(true);
		if (onInput.ok) expect(openQuestionIds(onInput.value)).toEqual([]);
	});

	it("round-trips a clarification state through JSON without changing it", () => {
		const first = validateClarificationState(state());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const restored = validateClarificationState(JSON.parse(JSON.stringify(first.value)));
		expect(restored.ok).toBe(true);
		if (restored.ok) expect(restored.value).toEqual(first.value);
	});
});

describe("TASK-005.1 contracts — write boundaries (AC-03, AC-04)", () => {
	it("the answer writer stamps the source, and a model payload cannot carry one", () => {
		const refused = composeUserAnswer({ questionId: "q-1", text: "The 2026 one.", sufficient: true, source: "application" }, { at: 20 });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.violations.map((item) => item.code)).toContain("field_unknown");

		const composed = composeUserAnswer({ questionId: "q-1", text: "The 2026 one.", sufficient: true, inputEntryId: "31" }, { at: 20 });
		expect(composed.ok).toBe(true);
		if (composed.ok) {
			expect(composed.value.source).toBe("application");
			expect(composed.value.answeredAt).toBe(20);
			expect(composed.value.sufficient).toBe(true);
		}
	});

	it("the model resolution is stamped as the model's and cannot claim the application", () => {
		const refused = composeModelResolution({ questionId: "q-1", basis: { kind: "answer", answerAt: 20 }, resolvedBy: "application" }, { at: 21 });
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.violations.map((item) => item.code)).toContain("field_unknown");

		const composed = composeModelResolution({ questionId: "q-1", basis: { kind: "answer", answerAt: 20 } }, { at: 21 });
		expect(composed.ok).toBe(true);
		if (composed.ok) expect(composed.value.resolvedBy).toBe("model");
	});
});

describe("TASK-005.1 contracts — plan version (AC-03)", () => {
	const plan = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
		schemaVersion: 1,
		planId: "plan-1",
		version: 2,
		goals: ["Check the figures."],
		taskIds: ["task-verify-source"],
		relatedQuestionIds: [],
		supersedes: 1,
		savedAt: 1_700_000_000_000,
		...overrides,
	});

	it("accepts a versioned plan", () => {
		expect(validatePlan(plan()).ok).toBe(true);
	});

	it("refuses a plan that supersedes itself or a later version", () => {
		expect(validatePlan(plan({ supersedes: 2 })).ok).toBe(false);
		expect(validatePlan(plan({ supersedes: 3 })).ok).toBe(false);
	});

	it("refuses a stale read, a missing plan, and accepts a matching one", () => {
		expect(() => assertPlanVersion({ planId: "plan-1", expectedVersion: 2, storedVersion: 1 })).toThrow(PlanVersionError);
		expect(() => assertPlanVersion({ planId: "plan-1", expectedVersion: 2, storedVersion: undefined })).toThrow(PlanVersionError);
		expect(() => assertPlanVersion({ planId: "plan-1", expectedVersion: 2, storedVersion: 2 })).not.toThrow();
		expect(nextPlanVersion(2)).toBe(3);
	});
});

describe("TASK-005.1 contracts — document kinds", () => {
	it("declares one document kind per contract", () => {
		expect(AGENT_DOCUMENT_KINDS.request).toBe("app.agent.request");
		expect(AGENT_DOCUMENT_KINDS.clarification).toBe("app.agent.clarification");
		expect(AGENT_DOCUMENT_KINDS.plan).toBe("app.agent.plan");
		expect(AGENT_DOCUMENT_KINDS.taskConfig).toBe("app.agent.task-config");
		expect(AGENT_DOCUMENT_KINDS.taskResult).toBe("app.agent.task-result");
		expect(AGENT_DOCUMENT_KINDS.ledger).toBe("app.multiagent.task-ledger");
	});
});
