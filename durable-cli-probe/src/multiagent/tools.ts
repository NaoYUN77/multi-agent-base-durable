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
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { CHILD_TOOL_NAMES, ChildTools, textCheckTool, textStatsTool } from "./child-tools.ts";
import { resolveChildTools, runDelegationRound, type DelegationHost } from "./delegation.ts";
import { entryText } from "./evidence.ts";
import {
	canRevise,
	isTerminal,
	MAX_REVISIONS,
	operationKey,
	recordTransition,
	reviewOutcome,
	RevisionLimitError,
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
}): string {
	if (!outcome.extraction) {
		return JSON.stringify({ taskId, round, ok: false, error: outcome.error ?? "round failed" });
	}
	return [
		`task ${taskId} round ${round} settled`,
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
		childToolObjects: readonly { readonly name: string }[];
	} = {
		mainExtension: undefined as unknown as Extension,
		childExtension: ChildTools,
		childInstructions: options.childInstructions,
		childToolObjects: [textStatsTool, textCheckTool],
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
			const resolved = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, taskId, { taskId, model: options.model });
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) return { round: bound.round, replay: true as const, error: undefined };
				// A new call: the task must not already have a life of its own.
				if (isTerminal(doc.status)) return { round: 0, error: `task ${taskId} is ${doc.status}; it accepts nothing further.` };
				if (doc.rounds.length > 0) return { round: 0, error: `task ${taskId} was already delegated; use task_revise or task_review.` };
				doc.operations = [
					...doc.operations,
					{
						opKey,
						kind: "delegate",
						toolTaskId: String(api.taskId),
						callId: api.callId,
						round: 1,
						createdAt: Date.now(),
					},
				];
				return { round: 1, replay: false as const, error: undefined };
			}, callContext);
			if (resolved.error !== undefined) return { output: [{ type: "text", text: resolved.error }], isError: true };

			const childTools = resolveChildTools(args.childTools ?? [...CHILD_TOOL_NAMES]);
			const outcome = await runDelegationRound(
				api,
				callContext,
				{ ...host, childToolObjects: childTools },
				{ taskId, round: resolved.round, kind: "initial", task: args.task, model: options.model, opKey },
			);
			return { output: [{ type: "text", text: roundReport(taskId, resolved.round, outcome) }], isError: outcome.ok === false };
		},
	});

	const taskReviseTool = defineTool({
		name: "task_revise",
		description:
			"Send revision feedback to a delegated task and get the revised answer plus evidence. " +
			`Reuses the same sub-agent conversation. At most ${MAX_REVISIONS} revisions per task; a further rejection fails the task.`,
		parameters: Type.Object({
			taskId: Type.String({ description: "The business task id from task_delegate." }),
			task: Type.String({ description: "The revised instruction for the sub-agent." }),
			feedback: Type.String({ description: "What was wrong and what to change, from your review." }),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("revise", String(api.taskId), api.callId);
			const resolved = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
				// Replay of the same call resumes the round it already created.
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) return { round: bound.round, childTools: [...doc.childTools], error: undefined };
				if (isTerminal(doc.status)) return { round: 0, childTools: [], error: `task ${args.taskId} is ${doc.status}; it accepts nothing further.` };
				if (doc.status !== "awaiting_review" && doc.status !== "revising") {
					return { round: 0, childTools: [], error: `task ${args.taskId} is ${doc.status}, not revisable.` };
				}
				if (doc.childConversationId === undefined) return { round: 0, childTools: [], error: `task ${args.taskId} has no sub-agent conversation yet.` };
				if (!canRevise(doc.currentRound)) return { round: 0, childTools: [], error: `task ${args.taskId} already used its ${MAX_REVISIONS} revisions.` };
				const round = doc.currentRound + 1;
				doc.operations = [
					...doc.operations,
					{ opKey, kind: "revise", toolTaskId: String(api.taskId), callId: api.callId, round, createdAt: Date.now() },
				];
				return { round, childTools: [...doc.childTools], error: undefined };
			}, callContext);
			if (resolved.error !== undefined) return { output: [{ type: "text", text: resolved.error }], isError: true };

			// Revisions keep the tools granted at delegation time: the whitelist is
			// part of the task's authorization, not the model's per-round choice.
			const childTools = resolveChildTools(resolved.childTools.length === 0 ? [...CHILD_TOOL_NAMES] : resolved.childTools);
			const outcome = await runDelegationRound(
				api,
				callContext,
				{ ...host, childToolObjects: childTools },
				{
					taskId: args.taskId,
					round: resolved.round,
					kind: "revision",
					task: args.task,
					feedback: args.feedback,
					model: options.model,
					opKey,
				},
			);
			return { output: [{ type: "text", text: roundReport(args.taskId, resolved.round, outcome) }], isError: outcome.ok === false };
		},
	});

	const taskReviewTool = defineTool({
		name: "task_review",
		description:
			"Accept or reject a specific round of a delegated task. Rejecting persists your feedback round and lets you call " +
			"task_revise; accepting closes the task. Pass round to bind the decision explicitly; a decision for an older round " +
			"is refused. Repeating the same decision for the same round changes nothing.",
		parameters: Type.Object({
			taskId: Type.String(),
			decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
			reason: Type.Optional(Type.String({ description: "Why, for a reject." })),
			round: Type.Optional(Type.Number({ description: "The round this decision is about; defaults to the current round." })),
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
				if (isTerminal(doc.status)) {
					return { text: `task ${args.taskId} is ${doc.status}; it accepts nothing further.`, refused: true };
				}
				if (doc.status !== "awaiting_review") {
					return { text: `task ${args.taskId} is ${doc.status}, not awaiting_review.`, refused: true };
				}
				const targetRound = args.round ?? doc.currentRound;
				// Stale decisions: a decision aimed at an older round must not land
				// on the newer one that arrived meanwhile.
				if (targetRound !== doc.currentRound) {
					return {
						text: `stale review: task ${args.taskId} is at round ${doc.currentRound}, not ${targetRound}; re-read with task_status.`,
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
							{ opKey, kind: "review", toolTaskId: String(api.taskId), callId: api.callId, round: targetRound, createdAt: Date.now(), decision: "reject" },
						];
						doc.reviews = [
							...doc.reviews,
							{
								round: targetRound,
								decision: "reject",
								...(args.reason === undefined ? {} : { reason: args.reason }),
								at: Date.now(),
								before: doc.status,
								after: "failed",
								opKey,
							},
						];
						recordTransition(doc, "failed", Date.now(), { opKey, round: targetRound, reason: "revision_limit" });
						doc.failure = { reason: "revision_limit", detail: error.message, at: Date.now() };
						return { text: `task ${args.taskId} failed: revision limit reached.`, refused: false };
					}
					return { text: `review refused: ${(error as Error).message}`, refused: true };
				}
				// One commit: binding + review event + transition. Nothing can slip
				// between the checks above and these writes.
				doc.operations = [
					...doc.operations,
					{ opKey, kind: "review", toolTaskId: String(api.taskId), callId: api.callId, round: targetRound, createdAt: Date.now(), decision: args.decision },
				];
				doc.reviews = [
					...doc.reviews,
					{
						round: targetRound,
						decision: args.decision,
						...(args.reason === undefined ? {} : { reason: args.reason }),
						at: Date.now(),
						before: doc.status,
						after: next,
						opKey,
					},
				];
				recordTransition(doc, next, Date.now(), { opKey, round: targetRound });
				return { text: `task ${args.taskId} round ${targetRound} ${args.decision}ed -> ${next}.`, refused: false };
			}, callContext);
			return { output: [{ type: "text", text: result.text }], isError: result.refused === true };
		},
	});

	const taskCancelTool = defineTool({
		name: "task_cancel",
		description:
			"Cancel a delegated task: aborts the sub-agent's work, confirms nothing of it is still running, and closes the task " +
			"as cancelled. History and evidence stay readable. A terminal task refuses the cancel.",
		parameters: Type.Object({
			taskId: Type.String(),
			reason: Type.Optional(Type.String({ description: "Why the task is cancelled." })),
		}),
		replay: "safe",
		executionMode: "parallel",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const opKey = operationKey("cancel", String(api.taskId), api.callId);
			const prepared = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
				const bound = doc.operations.find((operation) => operation.opKey === opKey);
				if (bound !== undefined) return { status: doc.status, childConversationId: doc.childConversationId, replay: true as const, error: undefined };
				if (isTerminal(doc.status)) return { status: doc.status, childConversationId: doc.childConversationId, error: `task ${args.taskId} is ${doc.status}; it cannot be cancelled.` };
				doc.operations = [
					...doc.operations,
					{ opKey, kind: "cancel", toolTaskId: String(api.taskId), callId: api.callId, round: doc.currentRound, createdAt: Date.now() },
				];
				return { status: doc.status, childConversationId: doc.childConversationId, replay: false as const, error: undefined };
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

			const finished = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, { taskId: args.taskId, model: options.model });
				if (isTerminal(doc.status)) return { text: `task ${args.taskId} is ${doc.status} (cancel had nothing left to close).`, ok: true as const };
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
						return { text: `cancel incomplete: child work still live (${live.join(", ")}).`, ok: false as const };
					}
				}
				const reason = args.reason ?? "cancelled_by_main";
				recordTransition(doc, "cancelled", Date.now(), { opKey, round: doc.currentRound, reason });
				doc.failure = { reason: "cancelled", detail: reason, at: Date.now() };
				return { text: `task ${args.taskId} cancelled (${reason}).`, ok: true as const };
			}, callContext);
			return { output: [{ type: "text", text: finished.text }], isError: finished.ok === false };
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
					output: [
						{ type: "text", text: `child conversations: ${listing.length === 0 ? "(none)" : listing.join(", ")}` },
					],
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
						childConversationId: doc.childConversationId ?? null,
						childTools: [...doc.childTools],
						createdAt: doc.createdAt,
						rounds: doc.rounds.map((round) => ({
							round: round.round,
							kind: round.kind,
							requestId: round.requestId,
							submissionId: round.submissionId ?? null,
							answerEntryId: round.answerEntryId ?? null,
							evidence: round.evidence.length,
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
