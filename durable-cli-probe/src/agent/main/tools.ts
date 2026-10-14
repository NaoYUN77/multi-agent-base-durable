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

import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ConversationId,
	type Extension,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { AgentClarificationDoc, AgentPlanDoc, AgentRequestDoc } from "../contracts/documents.ts";
import { openQuestionIds, validateClarificationState, type ClarificationState } from "../contracts/clarification.ts";
import { nextPlanVersion, validatePlan, type Plan } from "../contracts/plan.ts";
import { validateTaskBatch, type TaskSpec } from "../contracts/task-spec.ts";
import { admissionBlockReasons } from "../state/lifecycle.ts";
import { MainServiceDoc } from "./service-doc.ts";
import { deriveQuestionId } from "./request-id.ts";
import { mainRestorationSection } from "./restoration.ts";

/** What one dispatched task reported. */
export type DispatchResult = {
	readonly taskId: string;
	readonly status: "accepted" | "blocked" | "failed" | "queued";
	readonly detail?: string;
};

/** What the program, not the model, supplies to every tool call. */
export type MainToolHost = {
	/**
	 * The request this conversation is serving, with its business version, or
	 * `undefined` when the service has recorded none. A tool that needs a request
	 * refuses rather than inventing a key.
	 */
	readonly activeRequest: () => Promise<{ readonly requestId: string; readonly requestVersion: number } | undefined>;
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
	 * Build the text a clarification hands back to the next round. The program
	 * assembles it from persisted facts, never from the model: the handoff payload
	 * *replaces* the model's context, so anything it omits is context the next
	 * round cannot see. The service owns this because only it can read the request
	 * document, the recorded answers and the plan index.
	 */
	readonly buildHandoff?: (input: {
		readonly requestId: string;
		readonly questionId: string;
		readonly question: string;
		readonly reason: string;
	}) => Promise<string>;
	/**
	 * Record a finished management operation so a replay returns the same result
	 * instead of redoing it. Keyed by the real tool call. `control` is stored with
	 * the result so a replayed question still ends the run.
	 */
	readonly recordOperation?: (input: {
		readonly opKey: string;
		readonly result: string;
		readonly control?: { readonly handoff?: string };
	}) => Promise<void>;
	/**
	 * Record that a management operation has *started* but not finished, before it
	 * runs its side effect. A crash in that window is then reported as interrupted
	 * rather than silently re-executed.
	 */
	readonly beginOperation?: (input: { readonly opKey: string }) => Promise<void>;
	/** Read back a recorded operation, or `undefined` when it never ran. */
	readonly readOperation?: (opKey: string) => Promise<{ readonly result?: string; readonly control?: { readonly handoff?: string } } | undefined>;
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
};

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
export function blockingQuestionIdsFor(state: ClarificationState, taskIds: readonly string[]): readonly string[] {
	const open = new Set(openQuestionIds(state));
	const wanted = new Set(taskIds);
	return state.questions
		.filter((question) => open.has(question.questionId))
		.filter((question) => question.blockingScope.length === 0 || question.blockingScope.some((scope) => wanted.has(scope)))
		.map((question) => question.questionId);
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
	async function replayOf(opKey: string): Promise<{ readonly result?: string; readonly control?: { readonly handoff?: string } } | undefined> {
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
			blockedTaskIds: Type.Optional(Type.Array(Type.String(), { description: "Task ids that stay blocked while this is open. Omit to block the whole request." })),
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
			const written = await api.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, api.conversationId, active.requestId, { requestId: active.requestId });
				// Round 1 first. If an identical question is already recorded, this is a
				// re-ask of that question, not a new one: the contract holds one answer
				// per question, so a "second" copy of the same words would leave the
				// first one permanently unanswerable and the user would be asked twice.
				const sameText = state.questions.find((question) => question.question === args.question);
				if (sameText !== undefined) {
					return { questionId: sameText.questionId, alreadyOpen: true } as const;
				}
				const round = state.questions.length + 1;
				const questionId = deriveQuestionId(active.requestId, round, args.question);
				// A *question* is model-authored by design — the model is what noticed
				// the ambiguity. What the program owns (the id, the timestamp, the
				// blocking scope) is stamped here, and the whole state is re-validated
				// through the shared contract before it is left written.
				state.questions = [
					...state.questions,
					{ questionId, question: args.question, reason: args.reason, blockingScope: [...blocked.value], askedAt: clock() },
				];
				const checked = validateClarificationState(state);
				if (!checked.ok) {
					throw new Error(`clarification state invalid: ${checked.violations.map((v) => `${v.path}:${v.code}`).join(", ")}`);
				}
				return { questionId, alreadyOpen: false } as const;
			}, callContext);

			if (written.alreadyOpen) {
				// A duplicate ask is not a completed operation: recording a receipt for
				// it would make a later, genuine ask of the same question replay this
				// refusal instead of ending the run. So this path leaves no receipt.
				return { output: [{ type: "text", text: `question ${written.questionId} is already open; the user has not answered it yet.` }] };
			}
			const text = `asked the user (question ${written.questionId}). This run ends now.`;

			// Ending the run is the contract's requirement ("问题结束当前模型轮次"), and
			// `handoff` is the only public control that guarantees it: `terminate`
			// fires only when *every* call of the round asks for it, so one sibling
			// call would silently keep the run going. The payload is built by the
			// program from persisted facts, because a handoff replaces the model's
			// context — a bare handoff would drop the request, the materials and the
			// recorded answers that the next round needs.
			const handoff =
				host.buildHandoff === undefined
					? text
					: await host.buildHandoff({
							requestId: active.requestId,
							questionId: written.questionId,
							question: args.question,
							reason: args.reason,
						});
			// The control travels with the receipt, so a replay ends the run the same
			// way rather than returning bare text and letting the round continue.
			await host.recordOperation?.({ opKey, result: text, control: { handoff } });
			return { output: [{ type: "text", text }], control: { handoff } };
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
			if (replayed !== undefined) return { output: [{ type: "text", text: replayed.result ?? "plan already saved" }] };

			const active = await host.activeRequest();
			if (active === undefined) {
				return { output: [{ type: "text", text: "save_plan refused: no active request is recorded." }], isError: true };
			}
			const related = readStringList(args.relatedQuestionIds);
			if (!related.ok) {
				return { output: [{ type: "text", text: `save_plan refused: relatedQuestionIds ${related.detail}.` }], isError: true };
			}
			const result = await api.commit(async (tx) => {
				const doc = await tx.doc(AgentPlanDoc, api.conversationId, args.planId, { planId: args.planId });
				const storedVersion = doc.version === 0 ? undefined : doc.version;
				const expected = args.expectedVersion;
				// The contract's `assertPlanVersion` rule as a refusal with a stable
				// reason: "no plan stored yet" is refused for the same reason a stale
				// one is, because the caller's decision was made against a specific plan.
				if (storedVersion === undefined) {
					if (expected !== undefined && expected !== 0) {
						return { ok: false as const, version: 0, text: `save_plan refused: expected version ${expected}, but no plan ${args.planId} is stored.` };
					}
				} else if (expected !== storedVersion) {
					return {
						ok: false as const,
						version: 0,
						text: `save_plan refused: expected version ${String(expected)}, but plan ${args.planId} is at version ${storedVersion}. Re-read it first.`,
					};
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
					return { ok: false as const, version: 0, text: `save_plan refused: ${checked.violations.map((v) => `${v.path}:${v.code}`).join(", ")}` };
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
				return {
					ok: true as const,
					version,
					text: `saved plan ${args.planId} version ${version} for request ${active.requestId} v${active.requestVersion} (${args.taskIds.length} task(s)).`,
				};
			}, callContext);
			await host.recordOperation?.({ opKey, result: result.text });
			return { output: [{ type: "text", text: result.text }], isError: result.ok === false };
		},
	});

	const dispatchTasks = defineTool({
		name: "dispatch_tasks",
		description:
			"Execute a saved plan. Refused when the plan version is stale, the plan was written for a different requirement, " +
			"a question blocking these tasks is still open, a dependency is not accepted, a task is not in the plan, or the " +
			"attempt quota is exhausted. Dispatch runs the tasks; it does not create them.",
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
				return { output: [{ type: "text", text: replayed.result }] };
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
				const planDoc = await tx.doc(AgentPlanDoc, api.conversationId, args.planId, { planId: args.planId });
				const storedVersion = planDoc.version === 0 ? undefined : planDoc.version;
				const clarification = await tx.doc(AgentClarificationDoc, api.conversationId, active.requestId, { requestId: active.requestId });
				const taskIds = batch.value.map((task) => task.id);
				const blocking = blockingQuestionIdsFor(clarification, taskIds);
				const planned = new Set(planDoc.taskIds);
				const unplanned = taskIds.filter((id) => !planned.has(id));
				const unaccepted = host.unacceptedDependencies?.(batch.value) ?? [];
				const reasons: string[] = [
					...admissionBlockReasons({
						expectedPlanVersion: args.version,
						storedPlanVersion: storedVersion,
						openQuestionIds: blocking,
						unacceptedDependencies: unaccepted,
						// The quota ledger is a TASK-005.3+ concern. This Issue's executor
						// is injected and owns its own budget, so the contract's quota
						// reason is left unasserted rather than faked as unlimited.
						quotaRemaining: { attempts: Number.POSITIVE_INFINITY },
					}),
				];
				// The plan must have been written for the requirement being served now.
				// A plan's own version says nothing about *which goal* it serves, so a
				// plan from v1 would otherwise execute after the user restated the
				// requirement — doing the old goal under the new one.
				if (storedVersion !== undefined && (planDoc.requestId !== active.requestId || planDoc.requestVersion !== active.requestVersion)) {
					reasons.push("plan_request_mismatch");
				}
				if (unplanned.length > 0) reasons.push("tasks_not_in_plan");
				return { reasons, version: storedVersion };
			}, callContext);
			if (admitted.reasons.length > 0) {
				const text = `dispatch refused: ${admitted.reasons.join(", ")}. Nothing was executed.`;
				// A refusal is a completed decision: a replay of this call must report
				// the same refusal rather than re-running admission against state that
				// may have moved.
				await host.recordOperation?.({ opKey, result: text });
				return { output: [{ type: "text", text }], isError: true };
			}
			// The call is marked as started *before* the executor runs. A crash between
			// here and the receipt below therefore leaves a recorded start with no
			// result, which a replay reports as interrupted instead of dispatching a
			// second time — `replay: "safe"` alone would happily run it again.
			await host.beginOperation?.({ opKey });
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
			const text = [`dispatched plan ${args.planId} v${String(admitted.version)}:`, ...lines].join("\n");
			// The receipt is recorded after the executor returns, so a replay of this
			// call reports what actually happened instead of dispatching a second time.
			await host.recordOperation?.({ opKey, result: text });
			return { output: [{ type: "text", text }], isError: refused };
		},
	});

	return defineExtension({
		name: "main-management",
		tools: [requestClarification, savePlan, dispatchTasks],
		// The restoration facts ride on a *section* rather than only on the handoff
		// payload, so they are re-read from committed state before every provider
		// request. The payload is a snapshot taken when the question tool completed,
		// and a sibling tool in the same round may write after it; the section is
		// never one write behind.
		sections: [mainRestorationSection],
	});
}

/** Tool names the Main agent is offered, for tests and the inspector. */
export const MAIN_TOOL_NAMES: readonly string[] = ["request_clarification", "save_plan", "dispatch_tasks"];

/** The request document, re-exported so a caller can name the contract without a second import. */
export { AgentRequestDoc };
