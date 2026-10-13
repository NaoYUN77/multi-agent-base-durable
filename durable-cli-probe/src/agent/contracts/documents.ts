// TASK-005.1 src/agent/contracts/documents.ts
//
// The Durable documents the shared contracts are persisted in: one document kind
// per contract, each carrying its own `schemaVersion` inside the stored state.
//
// Two deliberate choices:
//
//   1. **No `migrate`.** These are all version 1 document kinds, so there is no
//      older shape to interpret. When a later version changes a shape, the
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

/** One user request, and its material. Written by the application only. */
export type AgentRequestDocState = {
	readonly schemaVersion: number;
	readonly requestId: string;
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
	initial: (seed) => ({ schemaVersion: 1, requestId: seed.requestId, text: "", materials: [], requestedAt: 0 }),
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
	initial: (seed) => ({ schemaVersion: PLAN_SCHEMA_VERSION, planId: seed.planId, version: 0, goals: [], taskIds: [], relatedQuestionIds: [], savedAt: 0 }),
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

/** The settled result of a task, written once by the runtime. */
export type AgentTaskResultDocState = {
	readonly schemaVersion: number;
	readonly taskId: string;
	readonly result?: TaskResult;
};

export const AgentTaskResultDoc = defineDocFamily<AgentTaskResultDocState, { readonly taskId: string }>({
	kind: "app.agent.task-result",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	initial: (seed) => ({ schemaVersion: 1, taskId: seed.taskId }),
});

/** Document kinds, so a reader can name the contract without a cast. */
export const AGENT_DOCUMENT_KINDS = {
	request: AgentRequestDoc.definition.kind,
	clarification: AgentClarificationDoc.definition.kind,
	plan: AgentPlanDoc.definition.kind,
	taskConfig: AgentTaskConfigDoc.definition.kind,
	taskResult: AgentTaskResultDoc.definition.kind,
	ledger: "app.multiagent.task-ledger",
} as const;
