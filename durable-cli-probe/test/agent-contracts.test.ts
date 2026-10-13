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
import { completeSubmission, isRunEnded, parseStructuredAnswer } from "../src/agent/state/finish.ts";
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
		// And the user requirement version is separate from both.
		requestVersion: 3,
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

	it("accepts a snapshot carrying the contract revision, the request version and the tool versions", () => {
		const result = validateTaskConfigSnapshot(snapshot());
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.contractRevision).toBe(1);
			expect(result.value.requestVersion).toBe(3);
			expect(result.value.tools).toEqual([{ name: "text_check", version: "1.0.0" }]);
		}
	});

	it("refuses a snapshot without a contract revision, without a requirement version, or with a bare tool name", () => {
		const missing = { ...(snapshot() as Record<string, unknown>) };
		delete missing.contractRevision;
		expect(validateTaskConfigSnapshot(missing).ok).toBe(false);

		// The requirement version is not implied by any other version field.
		const noRequirement = { ...(snapshot() as Record<string, unknown>) };
		delete noRequirement.requestVersion;
		const refused = validateTaskConfigSnapshot(noRequirement);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.violations.some((item) => item.path === "$.requestVersion")).toBe(true);

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
	// The attribution context is round-scoped: `roundDurableTaskIds` names the
	// durable tasks *this round* created, not every task the business task ever
	// owned, which is what stops a previous round's entry from standing in.
	const context = { childConversationId: "2", businessTaskId: "task-a", round: 1, roundDurableTaskIds: ["7"], submissionId: "sub-1" };
	const known = new Map<string, PersistedEntryIndex>([
		// This round's own tool result.
		["1", { entryId: "1", conversationId: "2", taskId: "7", kind: "pi.tool-result", toolCallId: "c1", toolName: "text_check", submissionId: "sub-1" }],
		// The same child conversation, but produced by an earlier round.
		["2", { entryId: "2", conversationId: "2", taskId: "6", kind: "pi.tool-result", toolCallId: "c0", toolName: "text_check", submissionId: "sub-0" }],
		// This round's assistant entry: real, but not a tool result.
		["3", { entryId: "3", conversationId: "2", taskId: "7", kind: "pi.assistant", submissionId: "sub-1" }],
		// A real entry of *another* conversation: the foreign-evidence negative case.
		["9", { entryId: "9", conversationId: "3", taskId: "8", kind: "pi.tool-result" }],
	]);
	const runtime = (overrides: Readonly<Record<string, unknown>> = {}) => ({
		taskId: "task-a",
		round: 1,
		status: "completed" as const,
		attempts: 1,
		technicalRestarts: 0,
		toolInvocations: 1,
		sideEffect: "recorded" as const,
		settledAt: 1,
		...overrides,
	});
	const assemble = (input: Readonly<Record<string, unknown>>) =>
		assembleTaskResult({
			resultId: "result-1",
			runtime: runtime(),
			work: { summary: "ok", findings: [], unresolved: [], artifacts: [] },
			evidence: [],
			knownEntries: known,
			attribution: context,
			...input,
		} as Parameters<typeof assembleTaskResult>[0]);

	it("accepts an entry that belongs to this task's child conversation and this round", () => {
		const result = assemble({ evidence: [{ entryId: "1", kind: "pi.tool-result", byTaskId: "task-a", toolCallId: "c1", toolName: "text_check" }] });
		expect(result.ok).toBe(true);
	});

	it("refuses an entry of another conversation, even when the reference names this task", () => {
		const result = assemble({ evidence: [{ entryId: "9", kind: "pi.tool-result", byTaskId: "task-a" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("evidence_conversation_foreign");
	});

	it("refuses an unknown entry, a foreign business task and a non-owned durable task", () => {
		const unknown = assemble({ evidence: [{ entryId: "404", kind: "pi.tool-result" }] });
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.violations.map((item) => item.code)).toContain("evidence_entry_unknown");

		const foreign = assemble({ evidence: [{ entryId: "1", kind: "pi.tool-result", byTaskId: "task-b" }] });
		expect(foreign.ok).toBe(false);
		if (!foreign.ok) expect(foreign.violations.map((item) => item.code)).toContain("evidence_task_foreign");

		const notOwned = assemble({
			evidence: [{ entryId: "9", kind: "pi.tool-result" }],
			attribution: { ...context, childConversationId: "3", roundDurableTaskIds: [] },
		});
		expect(notOwned.ok).toBe(false);
		if (!notOwned.ok) expect(notOwned.violations.map((item) => item.code)).toContain("evidence_task_mismatch");
	});

	it("refuses a result whose own identity names another task or another round", () => {
		// A perfectly legitimate entry of round 1 must not make a round-99 result
		// look verifiable: the identity is checked before the evidence is.
		const otherTask = assemble({ runtime: runtime({ taskId: "task-b" }), evidence: [{ entryId: "1", kind: "pi.tool-result" }] });
		expect(otherTask.ok).toBe(false);
		if (!otherTask.ok) expect(otherTask.violations.map((item) => item.code)).toContain("result_task_mismatch");

		const otherRound = assemble({ runtime: runtime({ round: 99 }), evidence: [{ entryId: "1", kind: "pi.tool-result" }] });
		expect(otherRound.ok).toBe(false);
		if (!otherRound.ok) expect(otherRound.violations.map((item) => item.code)).toContain("result_round_mismatch");
	});

	it("refuses a previous round's entry inside the same child conversation", () => {
		const result = assemble({ evidence: [{ entryId: "2", kind: "pi.tool-result", toolCallId: "c0" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("evidence_task_mismatch");
	});

	it("refuses a forged kind and a tool call or tool name the entry does not carry", () => {
		// The entry is a `pi.assistant`; the reference claims a tool result.
		const forgedKind = assemble({ evidence: [{ entryId: "3", kind: "pi.tool-result" }] });
		expect(forgedKind.ok).toBe(false);
		if (!forgedKind.ok) expect(forgedKind.violations.map((item) => item.code)).toContain("evidence_kind_mismatch");

		// The entry carries no tool name at all, so a claimed one cannot be checked.
		const unverifiableName = assemble({ evidence: [{ entryId: "3", kind: "pi.assistant", toolName: "invented" }] });
		expect(unverifiableName.ok).toBe(false);
		if (!unverifiableName.ok) expect(unverifiableName.violations.map((item) => item.code)).toContain("evidence_toolname_unverifiable");

		const wrongName = assemble({ evidence: [{ entryId: "1", kind: "pi.tool-result", toolName: "other_tool" }] });
		expect(wrongName.ok).toBe(false);
		if (!wrongName.ok) expect(wrongName.violations.map((item) => item.code)).toContain("evidence_toolname_mismatch");

		const wrongCall = assemble({ evidence: [{ entryId: "1", kind: "pi.tool-result", toolCallId: "invented" }] });
		expect(wrongCall.ok).toBe(false);
		if (!wrongCall.ok) expect(wrongCall.violations.map((item) => item.code)).toContain("evidence_toolcall_mismatch");
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
			resolutions: [{ questionId: "q-ghost", resolvedAt: 1, resolvedBy: "model", basis: { kind: "original_input", inputEntryId: "31", detail: "the user said so" } }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.map((item) => item.code)).toContain("resolution_unknown_question");
	});

	it("refuses an `original_input` resolution that does not name an input entry", () => {
		// `detail` alone is a claim, not a reference: the binding is mandatory.
		const result = validateClarificationState({
			schemaVersion: 1,
			questions: [{ questionId: "q-1", question: "Which?", reason: "two", blockingScope: [], askedAt: 1 }],
			answers: [],
			resolutions: [{ questionId: "q-1", resolvedAt: 2, resolvedBy: "model", basis: { kind: "original_input", detail: "the request already names the version" } }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.violations.some((item) => item.path === "$.resolutions[0].basis.inputEntryId")).toBe(true);
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

	it("accepts a resolution on the original input, and keeps the question open when the reference is gone", () => {
		const onInput = validateClarificationState({
			schemaVersion: 1,
			questions: [{ questionId: "q-1", question: "Which?", reason: "two", blockingScope: [], askedAt: 1 }],
			answers: [],
			resolutions: [{ questionId: "q-1", resolvedAt: 2, resolvedBy: "model", basis: { kind: "original_input", inputEntryId: "31", detail: "the request already names the version" } }],
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
		const grounding = { requestId: "req-1", originalInputEntryIds: ["31"], recordedAnswers: [{ questionId: "q-1", answeredAt: 20, sufficient: true }] };
		const refused = composeModelResolution({ questionId: "q-1", basis: { kind: "answer", answerAt: 20 }, resolvedBy: "application" }, { at: 21 }, grounding);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.violations.map((item) => item.code)).toContain("field_unknown");

		const composed = composeModelResolution({ questionId: "q-1", basis: { kind: "answer", answerAt: 20 } }, { at: 21 }, grounding);
		expect(composed.ok).toBe(true);
		if (composed.ok) expect(composed.value.resolvedBy).toBe("model");
	});

	it("refuses a resolution whose basis does not resolve to something the program persisted", () => {
		const grounding = { requestId: "req-1", originalInputEntryIds: ["31"], recordedAnswers: [{ questionId: "q-1", answeredAt: 20, sufficient: true }] };

		// The original input is a free-text claim unless it names a real entry of
		// this request — the backdoor the grounding closes.
		const unbound = composeModelResolution(
			{ questionId: "q-1", basis: { kind: "original_input", inputEntryId: "77", detail: "The user authorized everything." } },
			{ at: 2 },
			grounding,
		);
		expect(unbound.ok).toBe(false);
		if (!unbound.ok) expect(unbound.violations.map((item) => item.code)).toContain("resolution_original_input_unbound");

		const bound = composeModelResolution(
			{ questionId: "q-1", basis: { kind: "original_input", inputEntryId: "31", detail: "The request already names the version." } },
			{ at: 2 },
			grounding,
		);
		expect(bound.ok).toBe(true);

		// An answer that was never recorded, and one recorded at another moment.
		const noAnswer = composeModelResolution({ questionId: "q-9", basis: { kind: "answer", answerAt: 20 } }, { at: 3 }, grounding);
		expect(noAnswer.ok).toBe(false);
		if (!noAnswer.ok) expect(noAnswer.violations.map((item) => item.code)).toContain("resolution_answer_missing");

		const wrongMoment = composeModelResolution({ questionId: "q-1", basis: { kind: "answer", answerAt: 999 } }, { at: 3 }, grounding);
		expect(wrongMoment.ok).toBe(false);
		if (!wrongMoment.ok) expect(wrongMoment.violations.map((item) => item.code)).toContain("resolution_answer_mismatch");
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

describe("TASK-005.1 contracts — the completion boundary is the settled answer (AC-05)", () => {
	const work = { summary: "Revenue is 1,204 units.", findings: ["quoted verbatim"], unresolved: [], artifacts: [] };

	it("reads the payload from a bare JSON answer and from a fenced block", () => {
		const bare = parseStructuredAnswer(JSON.stringify(work));
		expect(bare.ok).toBe(true);
		if (bare.ok) expect(bare.value).toEqual(work);

		const fenced = parseStructuredAnswer(`Here is the result:\n\`\`\`json\n${JSON.stringify(work)}\n\`\`\``);
		expect(fenced.ok).toBe(true);
		if (fenced.ok) expect(fenced.value).toEqual(work);
	});

	it("refuses prose, an empty answer and an unterminated fence", () => {
		for (const text of ["I finished the review.", "", "```json\n{\"summary\":\"x\"}", "no payload here"]) {
			const parsed = parseStructuredAnswer(text);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.violations.map((item) => item.code)).toContain(text.trim() === "" ? "submission_answer_empty" : "submission_result_unparseable");
		}
	});

	it("accepts a submission only after the run settled with a valid answer", () => {
		const settled = completeSubmission({ settlement: { status: "done" }, answerEntryId: "21", answerText: JSON.stringify(work) });
		expect(settled.ok).toBe(true);
		if (settled.ok) {
			expect(settled.value.answerEntryId).toBe("21");
			expect(settled.value.work).toEqual(work);
		}
	});

	it("refuses a run that has not settled: a tool call is not a submission", () => {
		for (const status of ["queued", "placed"] as const) {
			const early = completeSubmission({ settlement: { status }, answerEntryId: "21", answerText: JSON.stringify(work) });
			expect(early.ok).toBe(false);
			if (!early.ok) expect(early.violations.map((item) => item.code)).toContain("submission_not_settled");
		}
		const unanswered = completeSubmission({ settlement: { status: "unanswered" } });
		expect(unanswered.ok).toBe(false);
		if (!unanswered.ok) expect(unanswered.violations.map((item) => item.code)).toContain("submission_unanswered");
	});

	it("refuses a settled answer that is unreadable, invalid, missing or carries reserved fields", () => {
		const unreadable = completeSubmission({ settlement: { status: "done" }, answerEntryId: "21", answerText: "All done." });
		expect(unreadable.ok).toBe(false);
		if (!unreadable.ok) expect(unreadable.violations.map((item) => item.code)).toContain("submission_result_unparseable");

		const invalid = completeSubmission({ settlement: { status: "done" }, answerEntryId: "21", answerText: JSON.stringify({ findings: ["x"] }) });
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) {
			expect(invalid.violations.map((item) => item.code)).toContain("submission_result_invalid");
			expect(invalid.violations.some((item) => item.path === "$.answer.summary")).toBe(true);
		}

		const reserved = completeSubmission({ settlement: { status: "done" }, answerEntryId: "21", answerText: JSON.stringify({ ...work, status: "completed" }) });
		expect(reserved.ok).toBe(false);
		if (!reserved.ok) expect(reserved.violations.map((item) => item.code)).toContain("reserved_field");

		const noAnswer = completeSubmission({ settlement: { status: "done" }, answerText: JSON.stringify(work) });
		expect(noAnswer.ok).toBe(false);
		if (!noAnswer.ok) expect(noAnswer.violations.map((item) => item.code)).toContain("submission_answer_missing");
	});

	it("separates a settled run from a run that is still going", () => {
		expect(isRunEnded({ status: "done" })).toBe(true);
		expect(isRunEnded({ status: "unanswered" })).toBe(true);
		expect(isRunEnded({ status: "queued" })).toBe(false);
		expect(isRunEnded({ status: "placed" })).toBe(false);
	});
});
