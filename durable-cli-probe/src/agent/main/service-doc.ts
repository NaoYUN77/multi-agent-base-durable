// TASK-005.2 src/agent/main/service-doc.ts
//
// The Main service's own conversation-scoped state: which user request the
// service is currently serving, and that request's business version.
//
// Why this document exists at all. The clarification and plan documents are
// *families* keyed by `requestId`, so reading one back requires already knowing
// its key. After a restart the service has no in-memory key left, and AC-01
// requires that a question left open by the previous process can still be
// answered by the next one. One plain conversation-scoped document holding the
// active key is what makes that possible without scanning every document kind.
//
// Authorization: this is program state, written only by the service. No model
// tool writes it, and no model field is read from it.

import { defineDoc } from "@earendil-works/pi-durable";

export const MAIN_SERVICE_SCHEMA_VERSION = 1;

export type MainServiceState = {
	readonly schemaVersion: number;
	/**
	 * The request the service is serving. Absent means "no request recorded yet",
	 * which is a state the service refuses to answer a question against rather
	 * than a request it invents.
	 */
	readonly activeRequestId?: string;
	/** Business version of the active requirement. Bumped when the user restates it. */
	readonly requestVersion: number;
	/**
	 * A persisted cancellation intent for the conversation. Written before any
	 * abort signal, so a process that dies mid-cancel leaves a readable intent
	 * rather than a conversation that looks untouched.
	 */
	readonly cancelRequested?: { readonly at: number; readonly reason?: string };
};

/**
 * The active-request pointer. `scope: "conversation"` because a Main service
 * serves exactly one conversation; `history: "latest"` because only the current
 * pointer matters — the request documents themselves keep the history.
 */
export const MainServiceDoc = defineDoc<MainServiceState>({
	kind: "app.agent.main-service",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ schemaVersion: MAIN_SERVICE_SCHEMA_VERSION, requestVersion: 1 }),
});
