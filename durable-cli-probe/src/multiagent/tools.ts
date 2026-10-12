// TASK-003 src/multiagent/tools.ts
//
// The main-side management tools, registered in one extension. The main model
// plans, dispatches, reviews and cancels through these; the child side never
// sees them (the delegation round removes this extension from the child's
// agent) and never gets `executeTool()` access to them either — the child's
// `tools` whitelist resolves them out before any nested call could look them up.
//
// Every tool is `replay: "safe"`, and every mutating tool anchors its work to a
// persisted *operation binding* keyed by `<kind>:<toolTaskId>:<callId>`. A rerun
// of the same call after an interruption therefore resumes the round, requestId
// and decision it already created, while a genuinely new call gets a new key and
// a new round. Two different calls never share a key, so parallel calls stay
// distinct.
//
// Program-side authority: tool whitelists, status transitions, revision limits,
// stale-request rejection and round bookkeeping are all checked here or in the
// ledger module — the model's word is never the record. Reads and writes of one
// decision happen inside one commit, so the check and the write cannot be
// separated by a concurrent tool. `modelTools` only shapes what the model sees;
// the authorization boundary is the child's `tools` set.

import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ConversationId,
	type Cursor,
	type EntryId,
	type Extension,
	type ModelRef,
	type TaskId,
	type ToolExecutionApi,
	type ToolRegistration,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { CHILD_TOOL_NAMES, ChildTools, textCheckTool, textStatsTool } from "./child-tools.ts";
import { resolveChildTools, runDelegationRound, type DelegationHost } from "./delegation.ts";
import { entryText } from "./evidence.ts";
import {
	canRevise,
	claimRound,
	clearStaleRight,
	ExecutionRightError,
	isTerminal,
	MAX_REVISIONS,
	operationKey,
	recordTransition,
	releaseRound,
	reviewOutcome,
	RevisionLimitError,
	roundRequestId,
	TaskLedgerDoc,
	type EvidenceReference,
	type OperationBinding,
	type TaskBusinessStatus,
} from "./ledger.ts";

/** Options of the extension factory: the parts the app, not the model, controls. */
export interface MultiagentExtensionOptions {
	/** Provider/model both sides run. Recorded in the ledger per task. */
	readonly model: ModelRef;
	/** Instructions installed verbatim in every child conversation. */
	readonly childInstructions: string;
	/**
	 * Verification barrier awaited after a round's intent is committed and before
	 * its submission exists; the recovery tests kill the process there.
	 */
	readonly beforeSubmit?: (info: { readonly taskId: string; readonly round: number; readonly requestId: string }) => void | Promise<void>;
	/** Verification barrier awaited after a round's outcome is committed. */
	readonly afterOutcome?: (info: { readonly taskId: string; readonly round: number; readonly requestId: string }) => void | Promise<void>;
}

/** The full structured evidence record as the main model must see it. */
function evidenceLine(evidence: EvidenceReference): string {
	const flags = [
		`error=${evidence.isError === true}`,
		`truncated=${evidence.truncated}`,
	];
	const where = [
		`entry=${evidence.entryId}`,
		`kind=${evidence.kind}`,
		`tool=${evidence.toolName ?? "-"}`,
		`byTask=${evidence.byTaskId ?? "-"}`,
		`call=${evidence.toolCallId ?? "-"}`,
	];
	const lines = [`- ${where.join(" ")} ${flags.join(" ")}`];
	if (evidence.argsSummary !== undefined) lines.push(`  args=${evidence.argsSummary}`);
	if (evidence.diagnostics !== undefined && evidence.diagnostics.length > 0) {
		lines.push(`  diagnostics=${JSON.stringify(evidence.diagnostics)}`);
	}
	lines.push(`  ${evidence.excerpt}`);
	return lines.join("\n");
}

/** The main-model-visible report of one finished round. */
function roundReport(taskId: string, round: number, outcome: {
	childConversationId: ConversationId | undefined;
	submissionId: string | undefined;
	answerText: string | undefined;
	answerEntryId: EntryId | undefined;
	extraction: { evidence: readonly EvidenceReference[] } | undefined;
	error?: string;
	receipt?: boolean;
}): string {
	if (!outcome.extraction) {
		return JSON.stringify({ taskId, round, ok: false, error: outcome.error ?? "round failed" });
	}
	return [
		`task ${taskId} round ${round} settled${outcome.receipt === true ? " (replayed receipt)" : ""}`,
		`childConversationId: ${outcome.childConversationId ?? "unknown"}`,
		`submissionId: ${outcome.submissionId ?? "unknown"}`,
		`answerEntryId: ${outcome.answerEntryId ?? "unknown"}`,
		`toolEvidence (${outcome.extraction.evidence.length} record(s); "truncated=true" means use task_evidence with the entry id for the full text):`,
		...outcome.extraction.evidence.map((evidence) => evidenceLine(evidence)),
	].join("\n");
}

/** Summary of one operation binding, for task_status. */
function bindingSummary(binding: OperationBinding): string {
	return `${binding.opKey} round=${binding.round}${binding.decision === undefined ? "" : ` decision=${binding.decision}`}`;
}

/**
 * Build the management extension. `host` and `mainExtension` are closed over so
 * delegation can remove this very extension from the child's agent.
 */
export function createMultiagentExtension(options: MultiagentExtensionOptions): Extension {
	// Mutable on purpose: `mainExtension` is late-bound to the extension object
	// created below, so delegation can remove exactly this extension from the
	// child. Everything else is program state the model never touches.
	const host: {
		mainExtension: Extension;
		childExtension: Extension;
		childInstructions: string;
		childToolObjects: readonly ToolRegistration[];
		beforeSubmit?: MultiagentExtensionOptions["beforeSubmit"];
		afterOutcome?: MultiagentExtensionOptions["afterOutcome"];
	} = {
		mainExtension: undefined as unknown as Extension,
		childExtension: ChildTools,
		childInstructions: options.childInstructions,
		childToolObjects: [textStatsTool, textCheckTool],
		...(options.beforeSubmit === undefined ? {} : { beforeSubmit: options.beforeSubmit }),
		...(options.afterOutcome === undefined ? {} : { afterOutcome: options.afterOutcome }),
	};

	const taskDelegateTool = defineTool({
		name: "task_delegate",
		description:
			"Delegate a self-contained task to a sub-agent that runs in its own conversation with its own context. " +
			"Returns the sub-agent's final answer plus the structured evidence of every tool it ran. " +
			"One business task per call; the sub-agent conversation is created now and reused for revisions.",
		parameters: Type.Object({
			task: Type.String({ description: "What the sub-agent must do, self-contained: goal, acceptance and the materials it needs." }),
			taskId: Type.Optional(Type.String({ description: "Your stable id for this task; derived from the call when omitted." })),
			childTools: Type.Optional(
				Type.Array(Type.String(), {
					description: `Subset of the child tools to grant: ${CHILD_TOOL_NAMES.join(", ")}.`,
				}),
			),
		}),
		replay: "safe",
		// Parallel: a same-message cancel or review must be able to run while a
		// delegation waits, which is exactly the race the contract asks us to
		// survive. Ordering between rounds still comes from tool results.
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			// A stable, replay-safe id: the same call derives the same task id, a
			// different call a different one. Never `Date.now()`.
			const taskId = args.taskId ?? `task-${api.taskId}`;
			if (args.taskId !== undefined && args.taskId.trim() === "") {
				return { output: [{ type: "text", text: "taskId must not be empty." }], isError: true };
			}
			const opKey = operationKey("delegate", String(api.taskId), api.callId);
			const requestId = roundRequestId(taskId, 1);
			// Validate the whitelist before claiming anything.
			let granted: readonly ToolRegistration[];
			try {
				granted = resolveChildTools(args.childTools ?? [...CHILD_TOOL_NAMES]);
			} catch (error) {
				return { output: [{ type: "text", text: `delegate refused: ${(error as Error).message}` }], isError: true };
			}
			// One commit reserves the round: binding + round record + the
			// execution-right slot, so two parallel delegations cannot both start.
			const reserved = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, taskId, { taskId, model: options.model });
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) {
					// A rerun of this very call: resume its round (or return its
					// receipt later, which `runDelegationRound` does by itself).
					return { round: bound.round, childTools: granted.map((tool) => tool.name), error: undefined };
				}
				if (isTerminal(doc.status)) return { round: 0, childTools: [], error: `task ${taskId} is ${doc.status}; it accepts nothing further.` };
				if (doc.rounds.length > 0) return { round: 0, childTools: [], error: `task ${taskId} was already delegated; use task_revise or task_review.` };
				if (doc.activeOpKey !== undefined) {
					return { round: 0, childTools: [], error: `task ${taskId} round ${doc.activeRound} is already executing under another operation.` };
				}
				try {
					claimRound(doc, {
						opKey,
						kind: "delegate",
						toolTaskId: String(api.taskId),
						callId: api.callId,
						round: 1,
						task: args.task,
						requestId,
						at: Date.now(),
					});
				} catch (error) {
					if (error instanceof ExecutionRightError) return { round: 0, childTools: [], error: error.message };
					throw error;
				}
				return { round: 1, childTools: granted.map((tool) => tool.name), error: undefined };
			}, callContext);
			if (reserved.error !== undefined) return { output: [{ type: "text", text: reserved.error }], isError: true };

			const outcome = await runDelegationRound(
				api,
				callContext,
				host,
				{
					taskId,
					round: reserved.round,
					kind: "initial",
					task: args.task,
					model: options.model,
					opKey,
					childToolObjects: resolveChildTools(reserved.childTools.length === 0 ? [...CHILD_TOOL_NAMES] : reserved.childTools),
				},
			);
			return { output: [{ type: "text", text: roundReport(taskId, reserved.round, outcome) }], isError: outcome.ok === false };
		},
	});

	const taskReviseTool = defineTool({
		name: "task_revise",
		description:
			"Send revision feedback to a delegated task and get the revised answer plus evidence. " +
			`Reuses the same sub-agent conversation. At most ${MAX_REVISIONS} revisions per task; a further rejection fails the task.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The business task id from task_delegate." }),
			round: Type.Number({ description: "The round this feedback is about (from the delegation report). Required." }),
			task: Type.String({ description: "The revised instruction for the sub-agent." }),
			feedback: Type.String({ description: "What was wrong and what to change, from your review." }),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("revise", String(api.taskId), api.callId);
			// One commit: check the lifecycle, take the execution right and record
			// the round. A second parallel revision is refused here, not later.
			const reserved = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) {
					return { round: bound.round, childTools: [...doc.childTools], error: undefined };
				}
				if (isTerminal(doc.status)) return { round: 0, childTools: [], error: `task ${args.taskId} is ${doc.status}; it accepts nothing further.` };
				if (doc.status !== "awaiting_review" && doc.status !== "revising") {
					return { round: 0, childTools: [], error: `task ${args.taskId} is ${doc.status}, not revisable.` };
				}
				if (doc.childConversationId === undefined) return { round: 0, childTools: [], error: `task ${args.taskId} has no sub-agent conversation yet.` };
				// Stale feedback: a revision must name the round it is about. Feedback
				// derived from an older result must not be applied to a newer one, and
				// must not consume a revision.
				if (args.round !== doc.currentRound) {
					return {
						round: 0,
						childTools: [],
						error: `stale revision: task ${args.taskId} is at round ${doc.currentRound}, not ${args.round}; re-read with task_status.`,
					};
				}
				if (doc.activeOpKey !== undefined) {
					return {
						round: 0,
						childTools: [],
						error: `task ${args.taskId} round ${doc.activeRound} is already executing under another operation; review or wait for it first.`,
					};
				}
				if (!canRevise(doc.currentRound)) return { round: 0, childTools: [], error: `task ${args.taskId} already used its ${MAX_REVISIONS} revisions.` };
				const round = doc.currentRound + 1;
				try {
					claimRound(doc, {
						opKey,
						kind: "revise",
						toolTaskId: String(api.taskId),
						callId: api.callId,
						round,
						task: args.task,
						feedback: args.feedback,
						requestId: roundRequestId(args.taskId, round),
						at: Date.now(),
					});
					// A revision's intent lands the task in `revising` — from
					// `awaiting_review` when the main model revises directly, or already
					// there right after a recorded rejection.
					if (doc.status !== "revising") recordTransition(doc, "revising", Date.now(), { opKey, round });
				} catch (error) {
					if (error instanceof ExecutionRightError) return { round: 0, childTools: [], error: error.message };
					throw error;
				}
				return { round, childTools: [...doc.childTools], error: undefined };
			}, callContext);
			if (reserved.error !== undefined) return { output: [{ type: "text", text: reserved.error }], isError: true };

			// Revisions keep the tools granted at delegation time: the whitelist is
			// part of the task's authorization, not the model's per-round choice.
			const childTools = resolveChildTools(reserved.childTools.length === 0 ? [...CHILD_TOOL_NAMES] : reserved.childTools);
			const outcome = await runDelegationRound(
				api,
				callContext,
				host,
				{
					taskId: args.taskId,
					round: reserved.round,
					kind: "revision",
					task: args.task,
					feedback: args.feedback,
					model: options.model,
					opKey,
					childToolObjects: childTools,
				},
			);
			return { output: [{ type: "text", text: roundReport(args.taskId, reserved.round, outcome) }], isError: outcome.ok === false };
		},
	});

	const taskReviewTool = defineTool({
		name: "task_review",
		description:
			"Accept or reject a specific round of a delegated task. `round` is required: a decision for an older round is refused. " +
			"Rejecting persists your feedback round and lets you call task_revise; accepting closes the task. " +
			"Repeating the same decision for the same round changes nothing. A round that is still executing cannot be reviewed.",
		parameters: Type.Object({
			taskId: Type.String(),
			decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
			round: Type.Number({ description: "The round this decision is about (from the delegation report). Required." }),
			reason: Type.Optional(Type.String({ description: "Why, for a reject." })),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("review", String(api.taskId), api.callId);
			const result = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
				// Idempotent: one decision per operation; a replay reports it again.
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) {
					return { text: `task ${args.taskId} round ${bound.round} already ${bound.decision}ed (${doc.status}).`, refused: false };
				}
				if (doc.cancelRequested !== undefined) return { text: `task ${args.taskId} is being cancelled; it accepts no review.`, refused: true };
				if (isTerminal(doc.status)) return { text: `task ${args.taskId} is ${doc.status}; it accepts nothing further.`, refused: true };
				if (doc.activeOpKey !== undefined) {
					return { text: `task ${args.taskId} round ${doc.activeRound} is still executing; review it once it settles.`, refused: true };
				}
				if (doc.status !== "awaiting_review") return { text: `task ${args.taskId} is ${doc.status}, not awaiting_review.`, refused: true };
				// Stale decisions: a decision aimed at an older round must not land
				// on the newer one that arrived meanwhile.
				if (args.round !== doc.currentRound) {
					return {
						text: `stale review: task ${args.taskId} is at round ${doc.currentRound}, not ${args.round}; re-read with task_status.`,
						refused: true,
					};
				}
				let next: TaskBusinessStatus;
				try {
					next = reviewOutcome(args.taskId, doc.status, args.decision, doc.currentRound);
				} catch (error) {
					if (error instanceof RevisionLimitError) {
						// A third rejection fails the task; it is never accepted by default.
						// The rejection itself is still recorded as a review event.
						doc.operations = [
							...doc.operations,
							{ opKey, kind: "review", toolTaskId: String(api.taskId), callId: api.callId, round: args.round, createdAt: Date.now(), decision: "reject" },
						];
						doc.reviews = [
							...doc.reviews,
							{
								round: args.round,
								decision: "reject",
								...(args.reason === undefined ? {} : { reason: args.reason }),
								at: Date.now(),
								before: doc.status,
								after: "failed",
								opKey,
							},
						];
						recordTransition(doc, "failed", Date.now(), { opKey, round: args.round, reason: "revision_limit" });
						doc.failure = { reason: "revision_limit", detail: error.message, at: Date.now() };
						return { text: `task ${args.taskId} failed: revision limit reached.`, refused: false };
					}
					return { text: `review refused: ${(error as Error).message}`, refused: true };
				}
				// One commit: binding + review event + transition. Nothing can slip
				// between the checks above and these writes.
				doc.operations = [
					...doc.operations,
					{ opKey, kind: "review", toolTaskId: String(api.taskId), callId: api.callId, round: args.round, createdAt: Date.now(), decision: args.decision },
				];
				doc.reviews = [
					...doc.reviews,
					{
						round: args.round,
						decision: args.decision,
						...(args.reason === undefined ? {} : { reason: args.reason }),
						at: Date.now(),
						before: doc.status,
						after: next,
						opKey,
					},
				];
				recordTransition(doc, next, Date.now(), { opKey, round: args.round });
				return { text: `task ${args.taskId} round ${args.round} ${args.decision}ed -> ${next}.`, refused: false };
			}, callContext);
			return { output: [{ type: "text", text: result.text }], isError: result.refused === true };
		},
	});

	const taskCancelTool = defineTool({
		name: "task_cancel",
		description:
			"Cancel a delegated task: records a cancellation intent that blocks new work, aborts the sub-agent's work, confirms " +
			"nothing of it is still running, and closes the task as cancelled. History and evidence stay readable. " +
			"A terminal task refuses the cancel; a cancel that cannot confirm an idle child reports that instead of closing.",
		parameters: Type.Object({
			taskId: Type.String(),
			reason: Type.Optional(Type.String({ description: "Why the task is cancelled." })),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("cancel", String(api.taskId), api.callId);
			// Phase A: persist the cancellation intent (and this operation) before
			// touching anything. From here no new round may start, no submission may
			// be made, and an interrupted round is not turned into a failure.
			const prepared = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) {
					return { childConversationId: doc.childConversationId, status: doc.status, error: undefined };
				}
				if (isTerminal(doc.status)) {
					return { childConversationId: doc.childConversationId, status: doc.status, error: `task ${args.taskId} is ${doc.status}; it cannot be cancelled.` };
				}
				if (doc.cancelRequested === undefined) {
					doc.cancelRequested = { opKey, at: Date.now(), ...(args.reason === undefined ? {} : { reason: args.reason }) };
				}
				doc.operations = [
					...doc.operations,
					{ opKey, kind: "cancel", toolTaskId: String(api.taskId), callId: api.callId, round: doc.currentRound, createdAt: Date.now() },
				];
				return { childConversationId: doc.childConversationId, status: doc.status, error: undefined };
			}, callContext);
			if (prepared.error !== undefined) return { output: [{ type: "text", text: prepared.error }], isError: true };

			// Abort the child's ordinary ownership scope (queued inputs withdrawn,
			// running work aborted) and wait until it is idle. This works even
			// though the child is owned by the earlier, now-terminal delegate task:
			// the handle is conversation-scoped, not call-scoped.
			const childConversationId = prepared.childConversationId;
			if (childConversationId !== undefined) {
				const handle = await api.conversation(childConversationId, callContext);
				if (handle !== undefined) await handle.abort(callContext);
			}

			// The finish phase is the cancellation's admission control: it closes the
			// task only once no round holds the execution right (a round that holds it
			// may still submit) and the child has no live work. While either is true
			// the intent stays and the task stays non-terminal, so no submission can
			// ever follow a cancelled task.
			let finished: { text: string; ok: boolean } = { text: "", ok: false };
			for (let attempt = 0; attempt < 100; attempt++) {
				finished = await api.commit(async (tx) => {
					const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
					if (isTerminal(doc.status)) {
						// Honest reporting: a task that ended as something else was not
						// cancelled by this call, and that is not a success.
						if (doc.status === "cancelled") return { text: `task ${args.taskId} is already cancelled.`, ok: true };
						return { text: `cancel did not apply: task ${args.taskId} already ended as ${doc.status}.`, ok: false };
					}
					if (doc.cancelRequested === undefined) return { text: `cancel intent for task ${args.taskId} is missing.`, ok: false };
					// A round still holding the execution right may submit at any moment.
					// The right is only meaningful while its holder task runs: an aborted
					// or finished holder leaves a stale right that must not block the
					// cancel forever.
					if (doc.activeOpKey !== undefined) {
						const holderId = doc.activeToolTaskId === undefined ? Number.NaN : Number(doc.activeToolTaskId);
						const holder = Number.isFinite(holderId) ? await tx.task(holderId as TaskId) : undefined;
						if (holder !== undefined && holder.state.status !== "terminal") {
							return { text: `cancel pending: round ${doc.activeRound} still holds the execution right.`, ok: false, retry: true };
						}
						clearStaleRight(doc);
					}
					// No hidden child work: every task of the child conversation must be
					// terminal before the task itself becomes terminal.
					if (childConversationId !== undefined) {
						const live: string[] = [];
						let cursor: Cursor | undefined;
						for (let pages = 0; pages < 100; pages++) {
							const page = await tx.scanTasks({ conversationId: childConversationId }, 100, cursor);
							for (const task of page.items) {
								if (task.state.status !== "terminal") live.push(`${task.id}:${task.state.status}`);
							}
							if (page.next === undefined) break;
							cursor = page.next;
						}
						if (live.length > 0) {
							return { text: `cancel pending: child work still live (${live.join(", ")}).`, ok: false, retry: true };
						}
					}
					const reason = doc.cancelRequested.reason ?? "cancelled_by_main";
					recordTransition(doc, "cancelled", Date.now(), { opKey: doc.cancelRequested.opKey, round: doc.currentRound, reason });
					doc.failure = { reason: "cancelled", detail: reason, at: Date.now() };
					return { text: `task ${args.taskId} cancelled (${reason}).`, ok: true };
				}, callContext);
				if (finished.ok || !("retry" in finished) || finished.retry !== true) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			return { output: [{ type: "text", text: `${finished.text}${finished.ok ? "" : " The intent is kept; call task_cancel again once the round stops."}` }], isError: finished.ok === false };
		},
	});

	const taskStatusTool = defineTool({
		name: "task_status",
		description:
			"Show a task's status, version, rounds, reviews, state events, operation bindings and child conversation, " +
			"or the main conversation's child conversations when taskId is omitted.",
		parameters: Type.Object({
			taskId: Type.Optional(Type.String()),
		}),
		replay: "safe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			if (args.taskId === undefined) {
				const listing = await api.commit(async (tx) => {
					const conversations = (await tx.scanConversations({ ownerConversationId: api.conversationId }, 100)).items;
					return conversations.map((conversation) => conversation.id);
				}, callContext);
				return {
					output: [{ type: "text", text: `child conversations: ${listing.length === 0 ? "(none)" : listing.join(", ")}` }],
				};
			}
			const summary = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId!, {
					taskId: args.taskId!,
					model: options.model,
				});
				// Extracted inside the commit: the draft is not readable afterwards.
				return JSON.stringify(
					{
						taskId: doc.taskId,
						status: doc.status,
						version: doc.version,
						currentRound: doc.currentRound,
						activeOpKey: doc.activeOpKey ?? null,
						activeRound: doc.activeRound ?? null,
						cancelRequested: doc.cancelRequested ?? null,
						childConversationId: doc.childConversationId ?? null,
						childTools: [...doc.childTools],
						createdAt: doc.createdAt,
						rounds: doc.rounds.map((round) => ({
							round: round.round,
							kind: round.kind,
							opKey: round.opKey,
							requestId: round.requestId,
							submissionId: round.submissionId ?? null,
							answerEntryId: round.answerEntryId ?? null,
							evidence: round.evidence.length,
							settled: round.settledAt !== undefined,
						})),
						reviews: [...doc.reviews],
						events: [...doc.events],
						operations: doc.operations.map((binding) => bindingSummary(binding)),
						failure: doc.failure ?? null,
					},
					null,
					1,
				);
			}, callContext);
			return { output: [{ type: "text", text: summary }] };
		},
	});

	const taskEvidenceTool = defineTool({
		name: "task_evidence",
		description:
			"Retrieve the persisted evidence of a task's round: every tool result with its full field set, and the full text of one entry. " +
			"Read-only; ids are honored inside the task's own sub-agent conversation only.",
		parameters: Type.Object({
			taskId: Type.String(),
			round: Type.Optional(Type.Number({ description: "Round number; defaults to the current round." })),
			entryId: Type.Optional(Type.String({ description: "Retrieve the full persisted text of this entry." })),
		}),
		replay: "safe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const found = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, {
					taskId: args.taskId,
					model: options.model,
				});
				const roundNumber = args.round ?? doc.currentRound;
				const round = doc.rounds.find((candidate) => candidate.round === roundNumber);
				if (round === undefined) return { error: `task ${args.taskId} has no round ${roundNumber}` };
				if (args.entryId === undefined) {
					return {
						evidence: JSON.parse(JSON.stringify(round.evidence)) as EvidenceReference[],
						childConversationId: doc.childConversationId,
						roundNumber,
					};
				}
				// Entry ids are numeric; a non-numeric id can never match a record.
				const numericEntryId = Number(args.entryId);
				const childConversationId = doc.childConversationId;
				if (childConversationId === undefined) return { error: `task ${args.taskId} has no child conversation yet` };
				if (!Number.isFinite(numericEntryId)) return { error: `entry ${args.entryId} is not a number` };
				// `tx.entry()` is not conversation-scoped, so ownership is checked in
				// order: an id from another conversation is refused as such, and a
				// foreign id that happens to exist can never reach this task's text.
				const entry = await tx.entry(numericEntryId as EntryId);
				if (entry === undefined) return { error: `entry ${args.entryId} not found` };
				if (entry.conversationId !== childConversationId) {
					return { error: `entry ${args.entryId} belongs to conversation ${entry.conversationId}, not ${childConversationId}` };
				}
				if (!round.evidence.some((evidence) => evidence.entryId === numericEntryId)) {
					return { error: `entry ${args.entryId} is not evidence of task ${args.taskId} round ${roundNumber}` };
				}
				const text = entryText(entry);
				return { fullText: text ?? "", entryId: args.entryId, childConversationId, roundNumber };
			}, callContext);
			if ("error" in found) return { output: [{ type: "text", text: found.error as string }], isError: true };
			if ("fullText" in found) {
				return {
					output: [
						{
							type: "text",
							text: `entry ${found.entryId} (child ${found.childConversationId}, round ${found.roundNumber}):\n${found.fullText}`,
						},
					],
				};
			}
			const evidence = found.evidence ?? [];
			return {
				output: [
					{
						type: "text",
						text: [
							`task ${args.taskId} round ${found.roundNumber} evidence (${evidence.length} record(s)):`,
							...evidence.map((item) => evidenceLine(item)),
						].join("\n"),
					},
				],
			};
		},
	});

	const management = defineExtension({
		name: "multiagent-main",
		tools: [taskDelegateTool, taskReviseTool, taskReviewTool, taskCancelTool, taskStatusTool, taskEvidenceTool],
	});

	// Late-bind the host's self reference: the child must be able to drop this
	// exact extension, and delegation must know the main conversation at run time.
	host.mainExtension = management;
	return management;
}

/** Tool names the main agent is offered, for tests and the inspector. */
export const MANAGEMENT_TOOL_NAMES: readonly string[] = [
	"task_delegate",
	"task_revise",
	"task_review",
	"task_cancel",
	"task_status",
	"task_evidence",
];
