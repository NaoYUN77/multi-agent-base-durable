// TASK-005.1 test/agent-contracts.test.ts
//
// The pure contract layer: every validator takes untrusted input, refuses what
// it must refuse with a stable code and a field path, and never touches the disk,
// the network or the model. Everything here runs offline and deterministically.
//
// Which acceptance item each block serves:
//   AC-01  schema coverage: unknown/invalid ids, cycles, old versions, and
//          negative / non-integer / infinite quotas are all refused.
//   AC-03  questions, answers, versions and results survive a close/reopen — the
//          JSON roundtrip tests below are the local form of that.
//   AC-04  the model's right to write ends at its own work: status, identity and
//          evidence are runtime-owned, and cross-task evidence cannot be forged
//          from a model payload.

import { describe, expect, it } from "vitest";
import { validateClarificationState, openQuestionIds } from "../src/agent/contracts/clarification.ts";
import { PlanVersionError, assertPlanVersion, nextPlanVersion, validatePlan } from "../src/agent/contracts/plan.ts";
import { RUN_CONFIG_SCHEMA_VERSION, validateRunConfig } from "../src/agent/contracts/run-config.ts";
import { TASK_RESULT_SCHEMA_VERSION, validateModelWork, validateTaskResult } from "../src/agent/contracts/task-result.ts";
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
		const result = validateTaskSpec(validTaskSpec());
		expect(result.ok).toBe(true);
	});

	it("refuses an unknown field rather than ignoring it", () => {
		const result = validateTaskSpec(validTaskSpec({ taskPromt: "typo" }));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("field_unknown");
	});

	it("refuses an invalid id, an unsupported schema version and no dependencies field", () => {
		expect(validateTaskSpec(validTaskSpec({ id: "Not A Stable Id" })).ok).toBe(false);
		expect(validateTaskSpec(validTaskSpec({ schemaVersion: TASK_SPEC_SCHEMA_VERSION + 1 })).ok).toBe(false);
		expect(validateTaskSpec({ ...(validTaskSpec() as Record<string, unknown>), schemaVersion: undefined }).ok).toBe(false);
	});

	it("refuses negative, non-integer and infinite quotas", () => {
		const negative = validTaskSpec({ budget: { maxToolInvocations: -1, maxAttempts: 3, maxTechnicalRestarts: 2, timeoutMs: 60_000 } });
		expect(validateTaskSpec(negative).ok).toBe(false);

		const fractional = validTaskSpec({ budget: { maxToolInvocations: 4, maxAttempts: 2.5, maxTechnicalRestarts: 2, timeoutMs: 60_000 } });
		expect(validateTaskSpec(fractional).ok).toBe(false);

		const infinite = validTaskSpec({ budget: { maxToolInvocations: 4, maxAttempts: 3, maxTechnicalRestarts: 2, timeoutMs: Number.POSITIVE_INFINITY } });
		const result = validateTaskSpec(infinite);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("limit_not_finite");
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

	it("refuses an unknown dependency, a cycle, a duplicate id and an empty batch", () => {
		const unknown = validateTaskBatch([validTaskSpec({ id: "task-a", dependencies: ["task-missing"] })]);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.violations.map((item) => item.code)).toContain("dependency_unknown");

		const cycle = validateTaskBatch([validTaskSpec({ id: "task-a", dependencies: ["task-b"] }), validTaskSpec({ id: "task-b", dependencies: ["task-a"] })]);
		expect(cycle.ok).toBe(false);
		if (!cycle.ok) expect(cycle.violations.map((item) => item.code)).toContain("dependency_cycle");

		const duplicate = validateTaskBatch([validTaskSpec({ id: "task-a" }), validTaskSpec({ id: "task-a" })]);
		expect(duplicate.ok).toBe(false);

		expect(validateTaskBatch([]).ok).toBe(false);
	});
});

describe("TASK-005.1 contracts — run config (AC-01)", () => {
	it("refuses a missing configuration: there is no default", () => {
		const result = validateRunConfig(undefined);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("run_config_missing");
	});

	it("refuses an infinite limit and an unknown field", () => {
		const infinite = validRunConfig({ providerRetry: { maxRetries: Number.POSITIVE_INFINITY, backoffMs: 25 } });
		const result = validateRunConfig(infinite);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("limit_not_finite");
		expect(validateRunConfig(validRunConfig({ maxConcurrentSubagent: 3 })).ok).toBe(false);
	});

	it("accepts an explicit finite configuration", () => {
		const result = validateRunConfig(validRunConfig());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.roundTimeoutMs).toBe(120_000);
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
	const validResult = (): unknown => ({
		schemaVersion: TASK_RESULT_SCHEMA_VERSION,
		resultId: "result-1",
		runtime: {
			taskId: "task-verify-source",
			round: 1,
			status: "completed",
			attempts: 1,
			technicalRestarts: 0,
			toolInvocations: 2,
			sideEffect: "recorded",
			settledAt: 1_700_000_000_000,
		},
		evidence: [{ entryId: "42", kind: "pi.tool-result", byTaskId: "task-verify-source" }],
		work: { summary: "The figure matches.", findings: ["Revenue is 1,204 units."], unresolved: [], artifacts: [] },
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

describe("TASK-005.1 contracts — clarification (AC-03)", () => {
	const stateWithAnswer = (): unknown => ({
		schemaVersion: 1,
		questions: [{ questionId: "q-1", question: "Which version?", reason: "Two are supplied.", blockingScope: ["scope"], askedAt: 10 }],
		answers: [{ questionId: "q-1", text: "The 2026 one.", source: "application", answeredAt: 20 }],
		resolutions: [{ questionId: "q-1", resolvedAt: 21, resolvedBy: "model", basis: { kind: "answer", answerAt: 20 } }],
	});

	it("refuses an answer that claims a source other than the application", () => {
		const state = stateWithAnswer() as Record<string, unknown[]>;
		(state.answers as Record<string, unknown>[])[0].source = "model";
		const result = validateClarificationState(state);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("answer_source_forbidden");
	});

	it("refuses a resolution that cites an answer that was never given", () => {
		const state = stateWithAnswer() as Record<string, unknown[]>;
		(state.resolutions as Record<string, unknown>[])[0].basis = { kind: "answer", answerAt: 999 };
		const result = validateClarificationState(state);
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

	it("keeps open questions blocking, and accepts a resolution on the original input", () => {
		const open = validateClarificationState({
			schemaVersion: 1,
			questions: [{ questionId: "q-1", question: "Which?", reason: "two", blockingScope: [], askedAt: 1 }],
			answers: [],
			resolutions: [],
		});
		expect(open.ok).toBe(true);
		if (open.ok) expect(openQuestionIds(open.value)).toEqual(["q-1"]);

		const onInput = validateClarificationState({
			schemaVersion: 1,
			questions: [{ questionId: "q-1", question: "Which?", reason: "two", blockingScope: [], askedAt: 1 }],
			answers: [],
			resolutions: [{ questionId: "q-1", resolvedAt: 2, resolvedBy: "model", basis: { kind: "original_input", detail: "the request already names the version" } }],
		});
		expect(onInput.ok).toBe(true);
		if (onInput.ok) expect(openQuestionIds(onInput.value)).toEqual([]);
	});

	it("round-trips a clarification state through JSON without changing it (AC-03)", () => {
		const first = validateClarificationState(stateWithAnswer());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const restored = validateClarificationState(JSON.parse(JSON.stringify(first.value)));
		expect(restored.ok).toBe(true);
		if (restored.ok) expect(restored.value).toEqual(first.value);
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
		const result = validatePlan(plan());
		expect(result.ok).toBe(true);
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
