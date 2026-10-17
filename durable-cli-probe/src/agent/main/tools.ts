// TASK-005.2 src/agent/main/tools.ts
//
// The Main agent's three management tools. They are the *only* way the model can
// ask a question, save a plan or dispatch tasks, and each one is a write
// boundary rather than a convention:
//
//   request_clarification  the model proposes a question; the program derives the
//                          question id from its own request identity and round
//                          count, stamps the timestamp and blocking scope, records
//                          it, and ends the run with a *program-built* handoff.
//   save_plan              the model proposes a plan draft; the program owns the
//                          plan id, version, requirement identity and timestamp.
//                          A stale expected version is refused, never migrated.
//   dispatch_tasks         the model names a plan and a version; the program
//                          re-reads both, refuses a stale version, a plan written
//                          for a different requirement, an open question that
//                          actually blocks the named tasks, an unaccepted
//                          dependency, a task outside the plan or an exhausted
//                          quota, and only then hands the batch to the executor.
//
// Three things this file deliberately does NOT do:
//
//   * It never treats a saved plan as permission to execute it. Saving is a draft
//     (contract §"Main Agent 合同"); admission reads persisted facts at dispatch
//     time, not the model's word.
//   * It never reads a program-owned field from the model. `askedAt`, `savedAt`,
//     `planId`, `version`, `requestId`, `requestVersion`, `resolvedBy` and
//     `source` are stamped here or by the contract composers.
//   * It never lets a replay re-do work. `replay: "safe"` means a rerun after an
//     interruption re-executes, so every tool first looks for a persisted
//     operation receipt keyed by the real tool call and returns that instead.

import { Type, type Message } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ConversationId,
	type Extension,
	type ToolExecutionResult,
	type Tx,
} from "@earendil-works/pi-durable";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../contracts/documents.ts";
import { openQuestionIds, validateClarificationState, type ClarificationState } from "../contracts/clarification.ts";
import { nextPlanVersion, validatePlan, type Plan } from "../contracts/plan.ts";
import { validateTaskBatch, type TaskSpec } from "../contracts/task-spec.ts";
import { admissionBlockReasons } from "../state/lifecycle.ts";
import { MainServiceDoc, type DispatchAttempt } from "./service-doc.ts";
import { deriveQuestionId } from "./request-id.ts";
import { mainRestorationSection } from "./restoration.ts";

/** What one dispatched task reported. */
export type DispatchResult = {
	readonly taskId: string;
	readonly status: "accepted" | "blocked" | "failed" | "queued";
	readonly detail?: string;
};

/** Everything an injected dispatch-authorization policy is allowed to see. */
export type DispatchAuthorizationRequest = {
	/** The requirement the admitted batch belongs to. */
	readonly requestId: string;
	readonly requestVersion: number;
	/** The plan being executed, as stored. */
	readonly planId: string;
	readonly planVersion: number;
	/** The validated batch. The policy may deny the whole batch or inspect tasks. */
	readonly tasks: readonly TaskSpec[];
};

/**
 * The policy's answer. Denial is fail-closed: a thrown policy is a denial too,
 * so an unavailable authorization source can never be read as permission.
 */
export type DispatchAuthorization = {
	readonly allowed: boolean;
	/** Why the batch was denied, carried into the refusal text. */
	readonly reason?: string;
};

/** What the program, not the model, supplies to every tool call. */
export type MainToolHost = {
	/**
	 * The request this conversation is serving, with its business version, or
	 * `undefined` when the service has recorded none. A tool that needs a request
	 * refuses rather than inventing a key.
	 */
	readonly activeRequest: (tx?: Tx) => Promise<{ readonly requestId: string; readonly requestVersion: number } | undefined>;
	/**
	 * Execute an admitted batch. Injected: this Issue uses a faux executor and
	 * never creates a real sub-agent. Called *after* admission, so a refused
	 * dispatch cannot reach it.
	 */
	readonly dispatch: (input: {
		readonly conversationId: ConversationId;
		readonly planId: string;
		readonly planVersion: number;
		readonly tasks: readonly TaskSpec[];
		/**
		 * The stable identity of this tool call. Handed over so an executor that
		 * wants to be idempotent can dedupe on it: the plan and the task list are
		 * not unique to one call, and a rerun after an interruption carries the same
		 * identity.
		 */
		readonly operationKey?: string;
	}) => Promise<readonly DispatchResult[]>;
	/**
	 * Dependencies of the given tasks that are not yet `accepted`. Injected
	 * because "accepted" is a fact about a task ledger the executor owns. Absent
	 * means "nothing to check".
	 */
	readonly unacceptedDependencies?: (tasks: readonly TaskSpec[]) => readonly string[];
	/**
	 * Whether this host authorizes the batch. Called during admission, before the
	 * executor sees anything. Absent means no external policy is configured; the
	 * program's structural checks still apply. A policy that throws is treated as
	 * a denial, never as permission.
	 */
	readonly authorizeDispatch?: (input: DispatchAuthorizationRequest) => DispatchAuthorization | Promise<DispatchAuthorization>;
	/**
	 * The number of admitted dispatch operations allowed per user request.
	 *
	 * One admitted `dispatch_tasks` call consumes one attempt. The check and the
	 * reservation happen in the admission transaction, so a refused dispatch
	 * consumes nothing and a replay cannot spend twice. Persisted in the service
	 * document, so the budget survives a reopen. Absent means no budget is
	 * configured (the historical behavior); when present it must be a
	 * non-negative integer, validated at `openMainService`.
	 */
	readonly dispatchQuota?: { readonly maxAttempts: number };
	/**
	 * Build the text a clarification hands back to the next round. The program
	 * assembles it from persisted facts, never from the model: the handoff payload
	 * *replaces* the model's context, so anything it omits is context the next
	 * round cannot see. The service owns this because only it can read the request
	 * document, the recorded answers and the plan index.
	 *
	 * `tx` is passed when the caller is inside its own transaction, so the handoff
	 * and the write it describes commit together rather than in two steps.
	 */
	readonly buildHandoff?: (
		input: {
			readonly requestId: string;
			readonly questionId: string;
			readonly question: string;
			readonly reason: string;
		},
		tx?: Tx,
	) => Promise<string>;
	/**
	 * Record a finished management operation so a replay returns the same result
	 * instead of redoing it. Keyed by the real tool call.
	 *
	 * `tx` is passed when the caller is inside the transaction that made the
	 * business change, which is the point: a receipt written in a *second*
	 * transaction leaves a window where the question or plan is committed but its
	 * result is not, and a `replay: "safe"` rerun in that window either re-asks or
	 * fails on a now-stale expected version. Same transaction, no window.
	 */
	readonly recordOperation?: (
		input: {
			readonly opKey: string;
			readonly result: string;
			/** Whether the call reported an error, so a replay stays an error. */
			readonly isError?: boolean;
			readonly control?: { readonly handoff?: string };
		},
		tx?: Tx,
	) => Promise<void>;
	/**
	 * Record that a management operation has *started* but not finished, before it
	 * runs its side effect. A crash in that window is then reported as interrupted
	 * rather than silently re-executed.
	 *
	 * `tx` is passed when the caller is inside its own transaction, so the start
	 * marker commits with the admission decision and the quota reservation. That
	 * removes the window in which a crash after admission re-admits the call (and
	 * spends a second attempt) because no receipt exists yet.
	 */
	readonly beginOperation?: (input: { readonly opKey: string }, tx?: Tx) => Promise<void>;
	/** Read back a recorded operation, or `undefined` when it never ran. */
	readonly readOperation?: (
		opKey: string,
	) => Promise<{ readonly result?: string; readonly isError?: boolean; readonly control?: { readonly handoff?: string } } | undefined>;
	/**
	 * The clock the program stamps with. Injected rather than read from `Date.now`
	 * so a test can make timestamps deterministic.
	 */
	readonly now?: () => number;
	/**
	 * Whether `save_plan` records the saved plan in the service's index. Off for
	 * tests that exercise the tool without the service's index.
	 *
	 * When on, the tool writes the index entry into the service's own document
	 * *inside its own transaction*, so the index and the plan cannot disagree, and
	 * the entry survives a reopen: an in-memory list vanished on every open and
	 * mixed one request's plans into another's view.
	 */
	readonly indexPlans?: boolean;
	/**
	 * Called during every generation attempt of this conversation, before the
	 * provider request is issued. The service uses it as its **consumption
	 * boundary**: a queued input is placed and its run started by the Harness before
	 * any service call observes the queue, so activating it here — rather than when
	 * a caller happens to read the queue — is what keeps the requirement current for
	 * the run that is actually serving it.
	 *
	 * It runs *after* the attempt's prompt has been built: Pi renders the system
	 * sections and appends the system entries in the `prepare` phase
	 * (`generation.ts:150`) and runs this hook in the `request` phase (`:197`).
	 * Reconciling here therefore cannot change what preparation already wrote, so
	 * it is handed the messages this attempt is about to send and may return a
	 * replacement for them — which is what lets a run whose requirement the
	 * pointer did not yet name correct the prompt it was prepared with.
	 *
	 * Awaited, so the activation is committed before the request is issued. Absent
	 * means the caller drives reconciliation itself.
	 */
	readonly beforeRequest?: (request: BeforeRequest) => Promise<BeforeRequestResult>;
};

/** One generation attempt, offered to the host before the provider request is issued. */
export type BeforeRequest = {
	readonly conversationId: ConversationId;
	/** The exact messages this attempt will send, before any host correction. */
	readonly messages: readonly Message[];
};

/** `undefined` sends the attempt's own messages; a value replaces them for this request only. */
export type BeforeRequestResult = { readonly messages: readonly Message[] } | undefined;

/** Read a model-supplied string list, refusing a non-array rather than coercing it. */
function readStringList(value: unknown): { readonly ok: true; readonly value: string[] } | { readonly ok: false; readonly detail: string } {
	if (value === undefined) return { ok: true, value: [] };
	if (!Array.isArray(value)) return { ok: false, detail: "must be an array of strings" };
	const items: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") return { ok: false, detail: "must contain only strings" };
		items.push(entry);
	}
	return { ok: true, value: items };
}

/**
 * The stable identity of one tool call: the tool task and the call id, both
 * program-assigned. Two different calls never share it, and a replay of the same
 * call always does.
 */
function operationKey(kind: string, taskId: unknown, callId: string): string {
	return `${kind}:${String(taskId)}:${callId}`;
}

/**
 * Which open questions actually block a dispatch of `taskIds`.
 *
 * The rule AC-03 states is that *independent* tasks must still run. A question
 * blocks a task when it blocks the whole request (empty `blockingScope`) or when
 * its scope names one of the tasks being dispatched. A question scoped to a task
 * that is not in this batch blocks nothing here.
 *
 * The plan's own `relatedQuestionIds` is deliberately *not* consulted: a model
 * that forgot to list a question — or removed it — must not thereby unblock work
 * the question really blocks. The question's persisted scope is the authority.
 */
/** The ids of questions that already have a resolution. */
function resolvedIds(state: ClarificationState): ReadonlySet<string> {
	return new Set(state.resolutions.map((resolution) => resolution.questionId));
}

export function blockingQuestionIdsFor(state: ClarificationState, taskIds: readonly string[]): readonly string[] {
	const open = new Set(openQuestionIds(state));
	const wanted = new Set(taskIds);
	return state.questions
		.filter((question) => open.has(question.questionId))
		.filter((question) => question.blockingScope.length === 0 || question.blockingScope.some((scope) => wanted.has(scope)))
		.map((question) => question.questionId);
}

/** Why the program, not the model, asks a question after a blocked dispatch. */
const BLOCKED_QUESTION_REASON = "A dispatched task reported blocked; only the user can decide how to unblock it.";

/**
 * The one user-facing question for every blocked result of a dispatch.
 *
 * Deterministic from the executor's result, so a retry of the same logical
 * dispatch asks the same words and can reuse an open question instead of
 * forking a second one. Details are included because they are the only material
 * the user needs to decide; the task ids become the question's blocking scope.
 */
function blockedQuestionText(results: readonly DispatchResult[]): string {
	const parts = results.map((result) => (result.detail === undefined ? result.taskId : `${result.taskId} (${result.detail})`));
	return `The dispatched task(s) reported blocked: ${parts.join("; ")}. How should they continue?`;
}

/** The dispatch attempts already spent on one requirement. */
function dispatchAttemptsOf(doc: { readonly dispatchAttempts?: readonly DispatchAttempt[] }): readonly DispatchAttempt[] {
	return doc.dispatchAttempts ?? [];
}

/**
 * Build the Main management extension.
 *
 * `executionMode` is `"parallel"` so a question or a dispatch may overlap another
 * management call; the admission checks and the operation receipts below are what
 * keep that safe.
 */
export function createMainExtension(host: MainToolHost): Extension {
	/** One clock for every program-owned timestamp this extension writes. */
	const clock = host.now ?? Date.now;

	/** The recorded state of this call, when it has one. */
	async function replayOf(
		opKey: string,
	): Promise<{ readonly result?: string; readonly isError?: boolean; readonly control?: { readonly handoff?: string } } | undefined> {
		return host.readOperation === undefined ? undefined : await host.readOperation(opKey);
	}

	const requestClarification = defineTool({
		name: "request_clarification",
		description:
			"Ask the user one question when the request is genuinely ambiguous, then end this run. " +
			"Use it only when you cannot proceed without the answer; a clear request needs no question. " +
			"The user's answer arrives later as a new input in this same conversation, and the application " +
			"restores the request, its materials and any recorded answers for you when the run resumes.",
		parameters: Type.Object({
			question: Type.String({ description: "The single question to ask, in the user's language." }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Suggested answers, when a short list helps." })),
			reason: Type.String({ description: "Why the answer is needed — what cannot be decided without it." }),
			blockedTaskIds: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Task ids that stay blocked while this is open. Omit to block the whole request. " +
						"Re-asking the same question with this set narrows the scope you already declared, so tasks that turn out not to depend on the answer can still run.",
				}),
			),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("clarify", api.taskId, api.callId);
			const replayed = await replayOf(opKey);
			if (replayed !== undefined) {
				// A replay must end the run exactly as the original did: returning only
				// the text would let the round continue past a question that was
				// already asked.
				return {
					output: [{ type: "text", text: replayed.result ?? "clarification already asked" }],
					isError: replayed.isError === true,
					...(replayed.control === undefined ? {} : { control: replayed.control }),
				};
			}

			const active = await host.activeRequest();
			if (active === undefined) {
				return { output: [{ type: "text", text: "clarification refused: no active request is recorded." }], isError: true };
			}
			const blocked = readStringList(args.blockedTaskIds);
			if (!blocked.ok) {
				return { output: [{ type: "text", text: `clarification refused: blockedTaskIds ${blocked.detail}.` }], isError: true };
			}
			// The question write and its receipt are one transaction. Writing the
			// question first and the receipt second leaves a window where a
			// `replay: "safe"` rerun finds the question already recorded, takes the
			// duplicate branch, and loses the handoff — the run would not end.
			const written = await api.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, api.conversationId, active.requestId, { requestId: active.requestId });
				// A re-ask of the *same words* is the same question only while that
				// question is still open: the contract holds one answer per question, so
				// a second copy would leave the first permanently unanswerable. It must
				// still end the run — the model asking again after an insufficient answer
				// is exactly AC-02's "补充仍模糊继续问", and returning bare text would
				// let the round continue instead.
				//
				// Once the question has been *resolved*, the same words are a new
				// question: the requirement has moved on, and reusing the resolved id
				// would ask the user for something the service then refuses as "question
				// ... is not open" — the ask and the answer disagree about which question
				// is being answered. The new question gets its own id, and the resolved
				// one keeps its answer and its history.
				const resolved = resolvedIds(state);
				const sameText = state.questions.find((question) => question.question === args.question && !resolved.has(question.questionId));
				const alreadyOpen = sameText !== undefined;
				const questionId = sameText === undefined ? deriveQuestionId(active.requestId, state.questions.length + 1, args.question) : sameText.questionId;
				if (sameText === undefined) {
					// A *question* is model-authored by design — the model is what
					// noticed the ambiguity. What the program owns (the id, the
					// timestamp, the blocking scope) is stamped here, and the whole state
					// is re-validated through the shared contract before it is written.
					state.questions = [
						...state.questions,
						{ questionId, question: args.question, reason: args.reason, blockingScope: [...blocked.value], askedAt: clock() },
					];
					const checked = validateClarificationState(state);
					if (!checked.ok) {
						throw new Error(`clarification state invalid: ${checked.violations.map((v) => `${v.path}:${v.code}`).join(", ")}`);
					}
				} else if (Array.isArray(args.blockedTaskIds)) {
					// An explicit scope on a re-ask *narrows* the open question. Without
					// this the scope was frozen at the first ask: a model that first asked
					// without `blockedTaskIds` (scope empty = blocks the whole request) could
					// never narrow it to the one task really in doubt, and AC-03's
					// independent tasks stayed blocked for as long as the question remained
					// open — which, after an insufficient answer, is indefinitely.
					//
					// Only an explicit list changes it: a re-ask that omits `blockedTaskIds`
					// leaves the recorded scope alone, so asking again can never silently
					// widen a scope the model had already narrowed. Widening stays possible,
					// but has to be asked for.
					state.questions = state.questions.map((question) =>
						question.questionId === questionId ? { ...question, blockingScope: [...blocked.value] } : question,
					);
					const checked = validateClarificationState(state);
					if (!checked.ok) {
						throw new Error(`clarification state invalid: ${checked.violations.map((v) => `${v.path}:${v.code}`).join(", ")}`);
					}
				}
				const text = alreadyOpen
					? `question ${questionId} is still open; the user has not answered it yet. This run ends now.`
					: `asked the user (question ${questionId}). This run ends now.`;
				// Ending the run is the contract's requirement ("问题结束当前模型轮次"),
				// and `handoff` is the only public control that guarantees it:
				// `terminate` fires only when *every* call of the round asks for it, so
				// one sibling call would silently keep the run going. The payload is
				// built by the program from persisted facts, because a handoff replaces
				// the model's context — a bare handoff would drop the request, the
				// materials and the recorded answers the next round needs.
				const handoff =
					host.buildHandoff === undefined
						? text
						: await host.buildHandoff({ requestId: active.requestId, questionId, question: args.question, reason: args.reason }, tx);
				// The receipt is written in this same transaction, so the question and
				// the result that ends the run can never disagree.
				await host.recordOperation?.({ opKey, result: text, control: { handoff } }, tx);
				return { questionId, text, handoff } as const;
			}, callContext);

			return { output: [{ type: "text", text: written.text }], control: { handoff: written.handoff } };
		},
	});

	const savePlan = defineTool({
		name: "save_plan",
		description:
			"Save a versioned draft plan. Saving is not permission to execute it — dispatch_tasks checks the plan again. " +
			"Pass the version you read (omit it for the first save); a stale version is refused rather than migrated.",
		parameters: Type.Object({
			planId: Type.String({ description: "Your stable id for this plan." }),
			goals: Type.Array(Type.String(), { description: "What the plan achieves." }),
			taskIds: Type.Array(Type.String(), { description: "Task ids the plan dispatches; each must exist in the batch." }),
			relatedQuestionIds: Type.Optional(Type.Array(Type.String(), { description: "Questions that must be settled before dispatch." })),
			expectedVersion: Type.Optional(Type.Number({ description: "The version you read. Omit only for the first save." })),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("save-plan", api.taskId, api.callId);
			const replayed = await replayOf(opKey);
			if (replayed !== undefined) {
				// The stored error flag travels with the result: a refused save that
				// replayed as an ordinary tool result would read as a success.
				return { output: [{ type: "text", text: replayed.result ?? "plan already saved" }], isError: replayed.isError === true };
			}

			const active = await host.activeRequest();
			if (active === undefined) {
				return { output: [{ type: "text", text: "save_plan refused: no active request is recorded." }], isError: true };
			}
			const related = readStringList(args.relatedQuestionIds);
			if (!related.ok) {
				return { output: [{ type: "text", text: `save_plan refused: relatedQuestionIds ${related.detail}.` }], isError: true };
			}
			const result = await api.commit(async (tx) => {
				// Every return path records its receipt in this same transaction — the
				// refusals too. A refusal whose receipt lands in a second transaction
				// leaves a window where the rerun re-decides against moved state, and a
				// success whose receipt is missing replays into a stale-version refusal.
				const finish = async (text: string, ok: boolean): Promise<{ readonly ok: boolean; readonly text: string }> => {
					await host.recordOperation?.({ opKey, result: text, isError: !ok }, tx);
					return { ok, text };
				};
				const doc = await tx.doc(AgentPlanDoc, api.conversationId, args.planId, { planId: args.planId });
				const storedVersion = doc.version === 0 ? undefined : doc.version;
				const expected = args.expectedVersion;
				// A plan document is keyed by `planId` alone, so two requests that both
				// use one id share it. Without this check the second request would
				// silently take over the first's plan — and the first's index entry
				// would then point at a document describing someone else's goal.
				if (storedVersion !== undefined && doc.requestId !== active.requestId) {
					return await finish(
						`save_plan refused: plan ${args.planId} already belongs to request ${doc.requestId}; use a different planId.`,
						false,
					);
				}
				// The contract's `assertPlanVersion` rule as a refusal with a stable
				// reason: "no plan stored yet" is refused for the same reason a stale
				// one is, because the caller's decision was made against a specific plan.
				if (storedVersion === undefined) {
					if (expected !== undefined && expected !== 0) {
						return await finish(`save_plan refused: expected version ${expected}, but no plan ${args.planId} is stored.`, false);
					}
				} else if (expected !== storedVersion) {
					return await finish(
						`save_plan refused: expected version ${String(expected)}, but plan ${args.planId} is at version ${storedVersion}. Re-read it first.`,
						false,
					);
				}
				const version = storedVersion === undefined ? 1 : nextPlanVersion(storedVersion);
				const candidate: Plan = {
					schemaVersion: 1,
					planId: args.planId,
					version,
					// The requirement identity is bound here, from the program's own
					// pointer. The model has no parameter for it, so it cannot claim a
					// plan belongs to a requirement it does not.
					requestId: active.requestId,
					requestVersion: active.requestVersion,
					goals: [...args.goals],
					taskIds: [...args.taskIds],
					relatedQuestionIds: [...related.value],
					...(storedVersion === undefined ? {} : { supersedes: storedVersion }),
					savedAt: clock(),
				};
				const checked = validatePlan(candidate);
				if (!checked.ok) {
					return await finish(`save_plan refused: ${checked.violations.map((v) => `${v.path}:${v.code}`).join(", ")}`, false);
				}
				Object.assign(doc, checked.value);
				// The index entry is written in this same transaction, so the plan and
				// the service's list of it can never disagree. The alternative — a
				// second transaction after the tool returns — can leave a plan the
				// service cannot list if the process dies between the two.
				if (host.indexPlans === true) {
					const service = await tx.doc(MainServiceDoc, api.conversationId);
					// The entry is *refreshed*, not only inserted: a plan re-saved at a
					// higher version must not leave the index claiming the old one, which
					// is what the restoration section renders from.
					const entry = { planId: args.planId, requestId: active.requestId, requestVersion: active.requestVersion, version };
					const known = service.plans.some((existing) => existing.planId === args.planId && existing.requestId === active.requestId);
					service.plans = known
						? service.plans.map((existing) =>
								existing.planId === args.planId && existing.requestId === active.requestId ? entry : existing,
							)
						: [...service.plans, entry];
				}
				return await finish(
					`saved plan ${args.planId} version ${version} for request ${active.requestId} v${active.requestVersion} (${args.taskIds.length} task(s)).`,
					true,
				);
			}, callContext);
			return { output: [{ type: "text", text: result.text }], isError: result.ok === false };
		},
	});

	const dispatchTasks = defineTool({
		name: "dispatch_tasks",
		description:
			"Execute a saved plan. Refused when the plan version is stale, the plan was written for a different requirement, " +
			"a question blocking these tasks is still open, a dependency is not accepted, a task is not in the plan, the host " +
			"does not authorize the batch, or the attempt quota is exhausted. If a task reports blocked, the program asks the " +
			"user one question covering the blocked tasks and ends this run. Dispatch runs the tasks; it does not create them.",
		parameters: Type.Object({
			planId: Type.String({ description: "The saved plan to execute." }),
			version: Type.Number({ description: "The exact plan version you read. A stale version is refused." }),
			tasks: Type.Array(Type.Unknown(), { description: "The task specs to run, matching the plan's taskIds." }),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("dispatch", api.taskId, api.callId);
			const replayed = await replayOf(opKey);
			if (replayed !== undefined) {
				// A recorded call with no result was begun but never finished: it died in
				// the window between the executor's effects and the receipt. Re-dispatching
				// would run the batch a second time, so it is reported instead — and
				// reported as an *error with unknown outcome*, not as a completion. Not
				// re-running is not the same as having succeeded: the batch may have
				// partially taken effect, and nothing here can tell whether it did. A
				// finished call replays its result verbatim.
				if (replayed.result === undefined) {
					const text =
						`dispatch ${args.planId} did NOT complete: it was interrupted after starting and may have partially run. ` +
						`Its outcome is unknown — this is not a success and not a completion receipt. Do not treat the tasks as done.`;
					return { output: [{ type: "text", text }], isError: true };
				}
				// The stored error flag travels with the result, as `save_plan`'s replay
				// does: a dispatch refused at admission, or one whose batch failed or
				// blocked, recorded `isError: true`, and replaying it as an ordinary tool
				// result would turn that refusal into a success. The control travels too:
				// a dispatch that ended the run with a blocked-task question must end it
				// again when replayed, or the rerun would continue past the question.
				return {
					output: [{ type: "text", text: replayed.result }],
					isError: replayed.isError === true,
					...(replayed.control === undefined ? {} : { control: replayed.control }),
				};
			}

			const active = await host.activeRequest();
			if (active === undefined) {
				return { output: [{ type: "text", text: "dispatch refused: no active request is recorded." }], isError: true };
			}
			// The batch is validated through the shared TaskSpec contract before
			// anything else: an invalid batch is refused here, not half-executed.
			const batch = validateTaskBatch(args.tasks);
			if (!batch.ok) {
				return {
					output: [{ type: "text", text: `dispatch refused: ${batch.violations.map((v) => `${v.path}:${v.code}`).join(", ")}` }],
					isError: true,
				};
			}
			// Admission reads persisted facts in one commit: the plan as stored, its
			// requirement identity, the questions that block *these* tasks, the
			// dependencies the executor reports, and the plan's own task list.
			const admitted = await api.commit(async (tx) => {
				// The requirement is read *inside* this transaction. Reading it before
				// the commit made the check compare a plan against a pointer value that
				// could already have moved, which is not the same as "the requirement
				// being served when admission ran".
				const current = await host.activeRequest(tx);
				const activeRequestId = current?.requestId ?? active.requestId;
				const activeRequestVersion = current?.requestVersion ?? active.requestVersion;
				const planDoc = await tx.doc(AgentPlanDoc, api.conversationId, args.planId, { planId: args.planId });
				const storedVersion = planDoc.version === 0 ? undefined : planDoc.version;
				const clarification = await tx.doc(AgentClarificationDoc, api.conversationId, activeRequestId, { requestId: activeRequestId });
				const taskIds = batch.value.map((task) => task.id);
				const blocking = blockingQuestionIdsFor(clarification, taskIds);
				const planned = new Set(planDoc.taskIds);
				const unplanned = taskIds.filter((id) => !planned.has(id));
				// A batch that declares dependencies is only admissible when something can
				// actually vouch for them. With no checker supplied, "no unaccepted
				// dependencies" is not a fact that was established — it is the absence of
				// the check — so the batch is refused rather than waved through. A batch
				// with no dependencies needs no checker and is unaffected.
				const dependsOn = batch.value.some((task) => task.dependencies.length > 0);
				const checkerMissing = dependsOn && host.unacceptedDependencies === undefined;
				const unaccepted = checkerMissing ? [] : (host.unacceptedDependencies?.(batch.value) ?? []);
				// Quota is read from the service document inside this transaction. The
				// reservation itself is written only after every other gate passed, so a
				// refused dispatch spends nothing. Counting by `opKey` makes a retried
				// commit or a replay idempotent rather than a second charge.
				const serviceDoc = host.dispatchQuota === undefined ? undefined : await tx.doc(MainServiceDoc, api.conversationId);
				const usedAttempts = serviceDoc === undefined ? 0 : dispatchAttemptsOf(serviceDoc).filter((attempt) => attempt.requestId === activeRequestId).length;
				const remainingAttempts =
					host.dispatchQuota === undefined ? Number.POSITIVE_INFINITY : Math.max(0, host.dispatchQuota.maxAttempts - usedAttempts);
				const reasons: string[] = [
					...admissionBlockReasons({
						expectedPlanVersion: args.version,
						storedPlanVersion: storedVersion,
						openQuestionIds: blocking,
						unacceptedDependencies: unaccepted,
						quotaRemaining: { attempts: remainingAttempts },
					}),
				];
				// The plan must have been written for the requirement being served now.
				// A plan's own version says nothing about *which goal* it serves, so a
				// plan from v1 would otherwise execute after the user restated the
				// requirement — doing the old goal under the new one.
				if (storedVersion !== undefined && (planDoc.requestId !== activeRequestId || planDoc.requestVersion !== activeRequestVersion)) {
					reasons.push("plan_request_mismatch");
				}
				if (unplanned.length > 0) reasons.push("tasks_not_in_plan");
				if (checkerMissing) reasons.push("dependency_check_unavailable");
				// Authorization is consulted only when the batch is otherwise admissible:
				// an external policy is not asked about work that cannot run anyway. A
				// policy that throws is a denial, never permission.
				if (reasons.length === 0 && host.authorizeDispatch !== undefined) {
					let authorization: DispatchAuthorization;
					try {
						authorization = await host.authorizeDispatch({
							requestId: activeRequestId,
							requestVersion: activeRequestVersion,
							planId: args.planId,
							planVersion: storedVersion ?? args.version,
							tasks: batch.value,
						});
					} catch (error) {
						authorization = {
							allowed: false,
							reason: `authorization check failed: ${error instanceof Error ? error.message : String(error)}`,
						};
					}
					if (!authorization.allowed) {
						reasons.push(authorization.reason === undefined ? "not_authorized" : `not_authorized: ${authorization.reason}`);
					}
				}
				// A refusal is a completed decision: a replay of this call must report the
				// same refusal rather than re-running admission against state that may
				// have moved. It is recorded in the admission transaction, so the
				// decision and its receipt cannot disagree.
				if (reasons.length > 0) {
					const text = `dispatch refused: ${reasons.join(", ")}. Nothing was executed.`;
					await host.recordOperation?.({ opKey, result: text, isError: true }, tx);
					return { reasons, version: storedVersion, refusal: text, requestId: activeRequestId, requestVersion: activeRequestVersion };
				}
				// Reserve the attempt in this transaction, before the executor runs. The
				// check above and this write are one commit: two dispatches cannot both
				// observe the last attempt. A crash after this commit leaves the started
				// marker below, so a replay reports an unknown outcome instead of
				// re-admitting and spending a second attempt.
				if (serviceDoc !== undefined && !dispatchAttemptsOf(serviceDoc).some((attempt) => attempt.opKey === opKey)) {
					serviceDoc.dispatchAttempts = [...dispatchAttemptsOf(serviceDoc), { requestId: activeRequestId, opKey, at: clock() }];
				}
				await host.beginOperation?.({ opKey }, tx);
				return { reasons, version: storedVersion, refusal: undefined, requestId: activeRequestId, requestVersion: activeRequestVersion };
			}, callContext);
			if (admitted.refusal !== undefined) {
				return { output: [{ type: "text", text: admitted.refusal }], isError: true };
			}
			// Only past admission does the injected executor see the batch. It is handed
			// the operation identity so an executor that wants to be idempotent has a
			// stable key to dedupe on, rather than only the plan and the tasks.
			const results = await host.dispatch({
				conversationId: api.conversationId,
				planId: args.planId,
				planVersion: admitted.version ?? args.version,
				tasks: batch.value,
				operationKey: opKey,
			});
			const lines = results.map((result) => `${result.taskId}: ${result.status}${result.detail === undefined ? "" : ` (${result.detail})`}`);
			const refused = results.some((result) => result.status === "failed" || result.status === "blocked");
			const dispatchText = [`dispatched plan ${args.planId} v${String(admitted.version)}:`, ...lines].join("\n");
			const blocked = results.filter((result) => result.status === "blocked");
			// A blocked sub-task is not something the model can resolve from what it
			// has: the program records one question for the whole blocked set and ends
			// the run. This is the "子blocked统一Main提问" boundary — it does not depend
			// on the model remembering to call `request_clarification` next round.
			if (blocked.length > 0) {
				const question = blockedQuestionText(blocked);
				const scope = blocked.map((result) => result.taskId);
				const written = await api.commit(async (tx) => {
					const state = await tx.doc(AgentClarificationDoc, api.conversationId, admitted.requestId, { requestId: admitted.requestId });
					const resolved = resolvedIds(state);
					const sameText = state.questions.find((entry) => entry.question === question && !resolved.has(entry.questionId));
					const questionId =
						sameText === undefined ? deriveQuestionId(admitted.requestId, state.questions.length + 1, question) : sameText.questionId;
					if (sameText === undefined) {
						state.questions = [
							...state.questions,
							{ questionId, question, reason: BLOCKED_QUESTION_REASON, blockingScope: [...scope], askedAt: clock() },
						];
						const checked = validateClarificationState(state);
						if (!checked.ok) {
							throw new Error(
								`clarification state invalid: ${checked.violations.map((violation) => `${violation.path}:${violation.code}`).join(", ")}`,
							);
						}
					} else if (sameText.blockingScope.length > 0 && scope.some((taskId) => !sameText.blockingScope.includes(taskId))) {
						// The program observed these tasks blocked, so they are genuinely
						// waiting on this answer. Add them to the question's scope instead of
						// reusing a narrower one that would leave them dispatchable again. An
						// empty scope already blocks the whole request and is left alone.
						state.questions = state.questions.map((entry) =>
							entry.questionId === questionId
								? { ...entry, blockingScope: [...new Set([...entry.blockingScope, ...scope])] }
								: entry,
						);
						const checked = validateClarificationState(state);
						if (!checked.ok) {
							throw new Error(
								`clarification state invalid: ${checked.violations.map((violation) => `${violation.path}:${violation.code}`).join(", ")}`,
							);
						}
					}
					const text = `${dispatchText}\nblocked task(s) need the user: asked question ${questionId}. This run ends now.`;
					const handoff =
						host.buildHandoff === undefined
							? text
							: await host.buildHandoff({ requestId: admitted.requestId, questionId, question, reason: BLOCKED_QUESTION_REASON }, tx);
					// The question and the result that ends the run commit together, so a
					// replay returns the same control and a crash cannot leave one without
					// the other.
					await host.recordOperation?.({ opKey, result: text, isError: true, control: { handoff } }, tx);
					return { questionId, text, handoff };
				}, callContext);
				return { output: [{ type: "text", text: written.text }], isError: true, control: { handoff: written.handoff } };
			}
			// The receipt is recorded after the executor returns, so a replay of this
			// call reports what actually happened instead of dispatching a second time.
			// It carries `isError`, so a failed dispatch replays as a failure rather
			// than as an ordinary tool result.
			await host.recordOperation?.({ opKey, result: dispatchText, isError: refused });
			return { output: [{ type: "text", text: dispatchText }], isError: refused };
		},
	});

	return defineExtension({
		name: "main-management",
		tools: [requestClarification, savePlan, dispatchTasks],
		// The restoration facts ride on a *section* rather than only on the handoff
		// payload, so they are rendered from committed state for every attempt, during
		// that attempt's preparation. The payload is a snapshot taken when the question
		// tool completed, and a sibling tool in the same round may write after it; the
		// section is never one write behind the payload.
		sections: [mainRestorationSection],
		// The consumption boundary, on the built-in generation task. Registered only
		// when the host supplies one, so a test that drives reconciliation itself is
		// unaffected.
		...(host.beforeRequest === undefined
			? {}
			: {
					hooks: [
						{
							task: "pi.generation",
							handlers: {
								beforeRequest: async (
									request: { readonly messages: readonly Message[] },
									api: { readonly conversationId: ConversationId },
								) => {
									return await host.beforeRequest?.({ conversationId: api.conversationId, messages: request.messages });
								},
							},
						},
					],
				}),
	});
}

/** Tool names the Main agent is offered, for tests and the inspector. */
export const MAIN_TOOL_NAMES: readonly string[] = ["request_clarification", "save_plan", "dispatch_tasks"];

/** The request document, re-exported so a caller can name the contract without a second import. */
export { AgentRequestDoc };
