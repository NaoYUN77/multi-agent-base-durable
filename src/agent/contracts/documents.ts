// TASK-005.1 src/agent/contracts/documents.ts
//
// The Durable documents the shared contracts are persisted in: one document kind
// per contract, each carrying its own `schemaVersion` inside the stored state.
//
// Two deliberate choices:
//
//   1. **No `migrate`.** The request, clarification, plan, task-spec and
//      task-config kinds are version 1 and have no older shape to interpret.
//      `task-result` is version 2, but its version 1 had no production writer,
//      so a v1 document would sit at an address this version never reads and a
//      migration would only invent content. When a *written* shape changes, the
//      migration belongs here and must only *fill in* what the older version
//      lacked — never rewrite a question, an answer, a plan version or a result,
//      because AC-03 is that a document, after a close and a reopen, holds
//      exactly what it held. (The legacy migration that does exist is
//      `src/multiagent/ledger.ts` for TASK-003's document, which this subsystem
//      shares.)
//   2. **The contract object is stored, not a placeholder of it.** The runtime
//      writes a *validated* object in the same commit that creates it, so
//      `initial()` never has to invent content: an absent field means "nothing
//      recorded yet", which is a state a caller can refuse on, rather than a
//      half-filled object somebody might mistake for real data.

import { defineDocFamily } from "@earendil-works/pi-durable";
import type { ClarificationState } from "./clarification.ts";
import { CLARIFICATION_SCHEMA_VERSION } from "./clarification.ts";
import type { Plan } from "./plan.ts";
import { PLAN_SCHEMA_VERSION } from "./plan.ts";
import type { TaskConfigSnapshot } from "./run-config.ts";
import type { TaskResult } from "./task-result.ts";
import type { TaskSpec } from "./task-spec.ts";

/** One user request, and its material. Written by the application only. */
export type AgentRequestDocState = {
	readonly schemaVersion: number;
	readonly requestId: string;
	/**
	 * The **business version of the requirement**: bumped when the user restates
	 * what they want. It is not `schemaVersion` (the document shape) and not the
	 * plan's `version` (the plan's revision) — a task must be able to say which
	 * requirement it answered, and "the newest plan" does not answer that.
	 */
	readonly requestVersion: number;
	/** The user's own words. `""` means nothing recorded yet, not an empty request. */
	readonly text: string;
	readonly materials: { readonly id: string; readonly content: string; readonly source: string }[];
	readonly requestedAt: number;
	/** Entry id of the request input, when it arrived as a conversation input. */
	readonly inputEntryId?: string;
};

export const AgentRequestDoc = defineDocFamily<AgentRequestDocState, { readonly requestId: string }>({
	kind: "app.agent.request",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ schemaVersion: 1, requestId: seed.requestId, requestVersion: 1, text: "", materials: [], requestedAt: 0 }),
});

/** Questions, answers and resolutions for one request. Answers are application-only. */
export const AgentClarificationDoc = defineDocFamily<ClarificationState, { readonly requestId: string }>({
	kind: "app.agent.clarification",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: () => ({ schemaVersion: CLARIFICATION_SCHEMA_VERSION, questions: [], answers: [], resolutions: [] }),
});

/** Plans for one plan id. `version: 0` means no version has been saved yet. */
export const AgentPlanDoc = defineDocFamily<Plan, { readonly planId: string }>({
	kind: "app.agent.plan",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	// `requestId` is empty and `requestVersion` 0 until the program binds the
	// requirement at save time: an unbound plan is one a dispatcher must refuse, not
	// one it may execute against whatever requirement happens to be active.
	initial: (seed) => ({
		schemaVersion: PLAN_SCHEMA_VERSION,
		planId: seed.planId,
		version: 0,
		requestId: "",
		requestVersion: 0,
		goals: [],
		taskIds: [],
		relatedQuestionIds: [],
		savedAt: 0,
	}),
});

/** The configuration snapshot a task actually ran with, written once. */
export type AgentTaskConfigDocState = {
	readonly schemaVersion: number;
	readonly taskId: string;
	readonly snapshot?: TaskConfigSnapshot;
};

export const AgentTaskConfigDoc = defineDocFamily<AgentTaskConfigDocState, { readonly taskId: string }>({
	kind: "app.agent.task-config",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ schemaVersion: 1, taskId: seed.taskId }),
});

/**
 * The task contract as it was *saved* for execution, written once by dispatch
 * admission.
 *
 * `Plan` carries only task ids, so without this document a dispatcher would have
 * to take the task bodies from whatever the model said in the dispatching call —
 * and a replay of that call would have no contract to reload. The body is stored
 * here in the same commit that admits the call, so "this task was authorized to
 * run" and "this is what it was told to do" cannot disagree.
 *
 * `specVersion` starts at 1 and only grows while the task has never started: a
 * running instance keeps the contract it began with.
 *
 * The plan and request references are stored flat rather than as nested objects.
 * A document stores facts; a runtime alias for the same two fields would be a
 * second shape for one fact, and this module must not depend on the runtime that
 * reads it.
 */
export type AgentTaskSpecDocState = {
	readonly schemaVersion: number;
	readonly taskId: string;
	/** 1 for the first save; +1 only while the task has never started. 0 means "never saved". */
	readonly specVersion: number;
	/** Absent until dispatch admission saves it; a dispatcher must refuse an absent body. */
	readonly spec?: TaskSpec;
	/** The plan version this body was dispatched from. */
	readonly planId: string;
	readonly planVersion: number;
	/** The requirement the plan was bound to when it was saved. */
	readonly requestId: string;
	readonly requestVersion: number;
	readonly savedAt: number;
};

export const AgentTaskSpecDoc = defineDocFamily<AgentTaskSpecDocState, { readonly taskId: string }>({
	kind: "app.agent.task-spec",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({
		schemaVersion: 1,
		taskId: seed.taskId,
		specVersion: 0,
		planId: "",
		planVersion: 0,
		requestId: "",
		requestVersion: 0,
		savedAt: 0,
	}),
});

/**
 * The settled result of one round of a task, written once by the runtime.
 *
 * Keyed by `resultId` (`res.<taskId>.r<round>`) and not by `taskId`, so a rework
 * writes a second receipt instead of overwriting the first, and a replay finds
 * exactly the receipt it already wrote. Conversation-scoped, so the receipt
 * survives the business task reaching a terminal state (task-scoped documents
 * retire with their task).
 *
 * Version 2 re-keyed this family. Version 1 was keyed by `taskId` and had no
 * production writer, so there is no data to migrate: a v1 document would sit at
 * an address this version never reads.
 */
export type AgentTaskResultDocState = {
	readonly schemaVersion: number;
	readonly resultId: string;
	readonly taskId: string;
	readonly round: number;
	readonly result?: TaskResult;
};

export const AgentTaskResultDoc = defineDocFamily<AgentTaskResultDocState, { readonly resultId: string; readonly taskId: string }>({
	kind: "app.agent.task-result",
	version: 2,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ schemaVersion: 2, resultId: seed.resultId, taskId: seed.taskId, round: 0 }),
});

/** Document kinds, so a reader can name the contract without a cast. */
export const AGENT_DOCUMENT_KINDS = {
	request: AgentRequestDoc.definition.kind,
	clarification: AgentClarificationDoc.definition.kind,
	plan: AgentPlanDoc.definition.kind,
	taskSpec: AgentTaskSpecDoc.definition.kind,
	taskConfig: AgentTaskConfigDoc.definition.kind,
	taskResult: AgentTaskResultDoc.definition.kind,
	ledger: "app.multiagent.task-ledger",
} as const;
