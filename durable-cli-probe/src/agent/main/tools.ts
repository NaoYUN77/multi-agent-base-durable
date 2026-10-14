// TASK-005.2 src/agent/main/tools.ts
//
// The Main agent's three management tools. They are the *only* way the model can
// ask a question, save a plan or dispatch tasks, and each one is a write
// boundary rather than a convention:
//
//   request_clarification  the model proposes a question; the program derives the
//                          question id from its own round count, stamps the
//                          timestamp and blocking scope, records it, and refuses a
//                          duplicate of one already open.
//   save_plan              the model proposes a plan draft; the program owns the
//                          plan id, version and timestamp. A stale expected
//                          version is refused, never migrated forward.
//   dispatch_tasks         the model names a plan and a version; the program
//                          re-reads both, refuses a stale version, an open
//                          question, an unaccepted dependency, a task outside the
//                          plan or an exhausted quota, and only then hands the
//                          batch to the injected executor.
//
// Two things this file deliberately does NOT do:
//
//   * It never treats a saved plan as permission to execute it. Saving is a
//     draft (contract §"Main Agent 合同"); the admission check lives at dispatch
//     time and reads persisted facts, not the model's word.
//   * It never reads a program-owned field from the model. `askedAt`, `savedAt`,
//     `planId`, `version`, `resolvedBy` and `source` are stamped here or by the
//     contract composers; the tool parameters have nowhere to put them.

import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ConversationId,
	type Extension,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { AgentClarificationDoc, AgentPlanDoc } from "../contracts/documents.ts";
import { openQuestionIds, validateClarificationState } from "../contracts/clarification.ts";
import { nextPlanVersion, validatePlan, type Plan } from "../contracts/plan.ts";
import { validateTaskBatch, type TaskSpec } from "../contracts/task-spec.ts";
import { admissionBlockReasons } from "../state/lifecycle.ts";
import { deriveQuestionId } from "./request-id.ts";

/** What one dispatched task reported. */
export type DispatchResult = {
	readonly taskId: string;
	readonly status: "accepted" | "blocked" | "failed" | "queued";
	readonly detail?: string;
};

/** What the program, not the model, supplies to every tool call. */
export type MainToolHost = {
	/**
	 * The request this conversation is serving, or `undefined` when the service
	 * has recorded none. A tool that needs a request refuses rather than
	 * inventing a key. May be async: the service reads the persisted pointer, and
	 * a tool call must see it as it stands at that moment.
	 */
	readonly activeRequestId: () => string | undefined | Promise<string | undefined>;
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
	}) => Promise<readonly DispatchResult[]>;
	/**
	 * Dependencies of the given tasks that are not yet `accepted`. Injected
	 * because "accepted" is a fact about a task ledger the executor owns, not
	 * something this module can see. Absent means "nothing to check".
	 */
	readonly unacceptedDependencies?: (tasks: readonly TaskSpec[]) => readonly string[];
	/**
	 * Whether a question may still be asked. Injected so the service can refuse a
	 * question once the run has ended without this module knowing how runs end.
	 */
	readonly mayAsk?: () => boolean;
	/**
	 * The clock the program stamps with. Injected rather than read from `Date.now`
	 * so a test can make timestamps deterministic, and so every program-owned
	 * timestamp in one run comes from the same source.
	 */
	readonly now?: () => number;
	/**
	 * Called after a plan is saved, with the plan id. The service needs the id to
	 * read the plan back: plan documents are a family keyed by `planId`, and the
	 * Harness exposes no "list family keys" call, so the service can only list the
	 * plans it has been told about.
	 */
	readonly onPlanSaved?: (planId: string) => void;
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
 * Build the Main management extension.
 *
 * Every tool is `replay: "safe"`: a rerun after an interruption must resume the
 * operation it already created rather than create a second one. `executionMode`
 * is `"parallel"` for the same reason TASK-003's tools are — a question or a
 * dispatch may legitimately overlap another management call, and the admission
 * checks below are what keep that safe.
 */
export function createMainExtension(host: MainToolHost): Extension {
	/** One clock for every program-owned timestamp this extension writes. */
	const clock = host.now ?? Date.now;
	const requestClarification = defineTool({
		name: "request_clarification",
		description:
			"Ask the user one question when the request is genuinely ambiguous, then end this round. " +
			"Use it only when you cannot proceed without the answer; a clear request needs no question. " +
			"Do not pair it with other tools: the round only ends when every call of the round asks to stop. " +
			"The user's answer arrives later as a new input in this same conversation.",
		parameters: Type.Object({
			question: Type.String({ description: "The single question to ask, in the user's language." }),
			options: Type.Optional(Type.Array(Type.String(), { description: "Suggested answers, when a short list helps." })),
			reason: Type.String({ description: "Why the answer is needed — what cannot be decided without it." }),
			blockedTaskIds: Type.Optional(Type.Array(Type.String(), { description: "Task ids that stay blocked while this is open." })),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			if (host.mayAsk !== undefined && !host.mayAsk()) {
				return { output: [{ type: "text", text: "clarification refused: this run has already ended." }], isError: true };
			}
			const requestId = await host.activeRequestId();
			if (requestId === undefined) {
				return { output: [{ type: "text", text: "clarification refused: no active request is recorded." }], isError: true };
			}
			const blocked = readStringList(args.blockedTaskIds);
			if (!blocked.ok) {
				return { output: [{ type: "text", text: `clarification refused: blockedTaskIds ${blocked.detail}.` }], isError: true };
			}
			// The round number is the program's own count of the questions this
			// request has already asked, so the derived id is stable across a restart
			// instead of depending on wall-clock time.
			const written = await api.commit(async (tx) => {
				const state = await tx.doc(AgentClarificationDoc, api.conversationId, requestId, { requestId });
				const round = state.questions.length + 1;
				const questionId = deriveQuestionId(round, args.question);
				if (state.questions.some((question) => question.questionId === questionId)) {
					return { questionId, alreadyOpen: true } as const;
				}
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
			return {
				output: [
					{
						type: "text",
						text: written.alreadyOpen
							? `question ${written.questionId} is already open; the user has not answered it yet.`
							: `asked the user (question ${written.questionId}). This round ends now; do not call more tools.`,
					},
				],
				// Ending the round is the contract's requirement ("问题结束当前模型轮次").
				// `terminate` takes effect only when every call of the round asks for it
				// (docs/spec.md:3296), which is why the description tells the model not
				// to pair this with other tools — and why the service, not this tool,
				// owns the detection of a round that failed to end.
				control: { terminate: true },
			};
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
						return { ok: false as const, text: `save_plan refused: expected version ${expected}, but no plan ${args.planId} is stored.`, planId: undefined };
					}
				} else if (expected !== storedVersion) {
					return {
						ok: false as const,
						text: `save_plan refused: expected version ${String(expected)}, but plan ${args.planId} is at version ${storedVersion}. Re-read it first.`,
						planId: undefined,
					};
				}
				const version = storedVersion === undefined ? 1 : nextPlanVersion(storedVersion);
				const candidate: Plan = {
					schemaVersion: 1,
					planId: args.planId,
					version,
					goals: [...args.goals],
					taskIds: [...args.taskIds],
					relatedQuestionIds: [...related.value],
					...(storedVersion === undefined ? {} : { supersedes: storedVersion }),
					savedAt: clock(),
				};
				const checked = validatePlan(candidate);
				if (!checked.ok) {
					return { ok: false as const, text: `save_plan refused: ${checked.violations.map((v) => `${v.path}:${v.code}`).join(", ")}`, planId: undefined };
				}
				Object.assign(doc, checked.value);
				return { ok: true as const, text: `saved plan ${args.planId} version ${version} (${args.taskIds.length} task(s)).`, planId: args.planId };
			}, callContext);
			// Only a save that actually persisted tells the service about the id.
			if (result.ok && result.planId !== undefined) host.onPlanSaved?.(result.planId);
			return { output: [{ type: "text", text: result.text }], isError: result.ok === false };
		},
	});

	const dispatchTasks = defineTool({
		name: "dispatch_tasks",
		description:
			"Execute a saved plan. Refused when the plan version is stale, a related question is still open, a dependency is " +
			"not accepted, a task is not in the plan, or the attempt quota is exhausted. Dispatch runs the tasks; it does not create them.",
		parameters: Type.Object({
			planId: Type.String({ description: "The saved plan to execute." }),
			version: Type.Number({ description: "The exact plan version you read. A stale version is refused." }),
			tasks: Type.Array(Type.Unknown(), { description: "The task specs to run, matching the plan's taskIds." }),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const requestId = await host.activeRequestId();
			if (requestId === undefined) {
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
			// Admission reads persisted facts in one commit: the plan as stored, the
			// questions still open, the dependencies the executor reports, and the
			// plan's own task list. Which tasks the plan names comes from the plan
			// document, never from the model's `tasks` argument.
			const admitted = await api.commit(async (tx) => {
				const planDoc = await tx.doc(AgentPlanDoc, api.conversationId, args.planId, { planId: args.planId });
				const storedVersion = planDoc.version === 0 ? undefined : planDoc.version;
				const clarification = await tx.doc(AgentClarificationDoc, api.conversationId, requestId, { requestId });
				const openQuestions = openQuestionIds(clarification);
				const planned = new Set(planDoc.taskIds);
				const unplanned = batch.value.filter((task) => !planned.has(task.id)).map((task) => task.id);
				const unaccepted = host.unacceptedDependencies?.(batch.value) ?? [];
				// `admissionBlockReasons` returns a readonly list; copy it so this
				// module can add its own reason without mutating a shared value.
				const reasons: string[] = [
					...admissionBlockReasons({
					expectedPlanVersion: args.version,
					storedPlanVersion: storedVersion,
					openQuestionIds: openQuestions,
					unacceptedDependencies: unaccepted,
					// The quota ledger is a TASK-005.3+ concern. This Issue's executor is
					// injected and owns its own budget, so the contract's quota reason is
					// left unasserted rather than faked as unlimited.
					quotaRemaining: { attempts: Number.POSITIVE_INFINITY },
					}),
				];
				if (unplanned.length > 0) reasons.push("tasks_not_in_plan");
				return { reasons, version: storedVersion };
			}, callContext);
			if (admitted.reasons.length > 0) {
				return { output: [{ type: "text", text: `dispatch refused: ${admitted.reasons.join(", ")}. Nothing was executed.` }], isError: true };
			}
			// Only past admission does the injected executor see the batch.
			const results = await host.dispatch({
				conversationId: api.conversationId,
				planId: args.planId,
				planVersion: admitted.version ?? args.version,
				tasks: batch.value,
			});
			const lines = results.map((result) => `${result.taskId}: ${result.status}${result.detail === undefined ? "" : ` (${result.detail})`}`);
			const refused = results.some((result) => result.status === "failed" || result.status === "blocked");
			return {
				output: [{ type: "text", text: [`dispatched plan ${args.planId} v${String(admitted.version)}:`, ...lines].join("\n") }],
				isError: refused,
			};
		},
	});

	return defineExtension({
		name: "main-management",
		tools: [requestClarification, savePlan, dispatchTasks],
	});
}

/** Tool names the Main agent is offered, for tests and the inspector. */
export const MAIN_TOOL_NAMES: readonly string[] = ["request_clarification", "save_plan", "dispatch_tasks"];
