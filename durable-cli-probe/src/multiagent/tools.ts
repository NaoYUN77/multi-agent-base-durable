// TASK-003 src/multiagent/tools.ts
//
// The main-side management tools, registered in one extension. The main model
// plans, dispatches and reviews through these; the child side never sees them
// (the delegation round removes this extension from the child's agent) and
// never gets `executeTool()` access to them either — the child's `tools`
// whitelist resolves them out before any nested call could look them up.
//
// Every tool is `replay: "safe"`: a rerun after a crash resolves the same
// ledger state, the same child conversation and the same submission through
// the stable request ids, instead of starting a second task or a second round.
//
// Program-side authority: tool whitelists, status transitions, revision limits
// and round bookkeeping are all checked here or in the ledger module — the
// model's word is never the record. `modelTools` only shapes what the model
// sees; the authorization boundary is the child's `tools` set.

import { Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTool,
	type ConversationId,
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
	assertTransition,
	isTerminal,
	MAX_REVISIONS,
	reviewOutcome,
	RevisionLimitError,
	TaskLedgerDoc,
	type ReviewEvent,
	type TaskBusinessStatus,
} from "./ledger.ts";

/** Options of the extension factory: the parts the app, not the model, controls. */
export interface MultiagentExtensionOptions {
	/** Provider/model both sides run. Recorded in the ledger per task. */
	readonly model: ModelRef;
	/** Instructions installed verbatim in every child conversation. */
	readonly childInstructions: string;
}

/** Render one evidence reference as one compact line for the main model. */
function evidenceLine(evidence: {
	toolName?: string;
	entryId: EntryId;
	isError?: boolean;
	truncated: boolean;
	argsSummary?: string;
	excerpt: string;
}): string {
	const flag = evidence.isError === true ? " [error]" : "";
	const trunc = evidence.truncated ? " [truncated]" : "";
	const args = evidence.argsSummary === undefined ? "" : ` args=${evidence.argsSummary}`;
	return `- ${evidence.toolName ?? "answer"} entry=${evidence.entryId}${flag}${trunc}${args}\n  ${evidence.excerpt}`;
}

/** The main-model-visible report of one finished round. */
function roundReport(taskId: string, round: number, outcome: {
	childConversationId: ConversationId | undefined;
	submissionId: string | undefined;
	answerText: string | undefined;
	answerEntryId: EntryId | undefined;
	extraction: { evidence: readonly { entryId: EntryId; toolName?: string; isError?: boolean; truncated: boolean; argsSummary?: string; excerpt: string }[] } | undefined;
	error?: string;
}): string {
	if (!outcome.extraction) return JSON.stringify({ taskId, round, ok: false, error: outcome.error ?? "round failed" });
	const evidence = outcome.extraction.evidence.map((item) => evidenceLine(item));
	return [
		`task ${taskId} round ${round} settled`,
		`childConversationId: ${outcome.childConversationId ?? "unknown"}`,
		`submissionId: ${outcome.submissionId ?? "unknown"}`,
		`answerEntryId: ${outcome.answerEntryId ?? "unknown"}`,
		`toolEvidence (${outcome.extraction.evidence.length} record(s); "truncated" means use task_evidence to retrieve the full text):`,
		...evidence,
	].join("\n");
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
			task: Type.String({ description: "What the sub-agent must do, self-contained." }),
			taskId: Type.Optional(Type.String({ description: "Your stable id for this task; generated when omitted." })),
			childTools: Type.Optional(
				Type.Array(Type.String(), {
					description: `Subset of the child tools to grant: ${CHILD_TOOL_NAMES.join(", ")}.`,
				}),
			),
		}),
		replay: "safe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const taskId = args.taskId ?? `task-${Date.now().toString(36)}`;
			if (args.taskId !== undefined && args.taskId.trim() === "") {
				return { output: [{ type: "text", text: "taskId must not be empty." }], isError: true };
			}
			const childTools = resolveChildTools(args.childTools ?? [...CHILD_TOOL_NAMES]);
			const outcome = await runDelegationRound(
				api,
				callContext,
				{ ...host, childToolObjects: childTools },
				{ taskId, round: 1, kind: "initial", task: args.task, model: options.model },
			);
			return { output: [{ type: "text", text: roundReport(taskId, 1, outcome) }] };
		},
	});

	const taskReviseTool = defineTool({
		name: "task_revise",
		description:
			"Send revision feedback to a delegated task and get the revised answer plus evidence. " +
			"Reuses the same sub-agent conversation. At most " + MAX_REVISIONS + " revisions per task; a further rejection fails the task.",
		parameters: Type.Object({
			taskId: Type.String({ description: "The business task id from task_delegate." }),
			task: Type.String({ description: "The revised instruction for the sub-agent." }),
			feedback: Type.String({ description: "What was wrong and what to change, from your review." }),
		}),
		replay: "safe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const state = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, {
					taskId: args.taskId,
					model: options.model,
				});
				return {
					status: doc.status,
					currentRound: doc.currentRound,
					childTools: [...doc.childTools],
					childConversationId: doc.childConversationId,
				};
			}, callContext);
			// A revision is legal right after a recorded rejection (`revising`) or
			// as a direct follow-up to a returned round (`awaiting_review`); anything
			// else — including a terminal task — is refused.
			if (state.status !== "awaiting_review" && state.status !== "revising") {
				return { output: [{ type: "text", text: `task ${args.taskId} is ${state.status}, not revisable.` }], isError: true };
			}
			if (state.currentRound - 1 >= MAX_REVISIONS) {
				return {
					output: [{ type: "text", text: `task ${args.taskId} already used its ${MAX_REVISIONS} revisions.` }],
					isError: true,
				};
			}
			if (state.childConversationId === undefined) {
				return { output: [{ type: "text", text: `task ${args.taskId} has no sub-agent conversation yet.` }], isError: true };
			}
			// Revisions keep the tools granted at delegation time: the whitelist is
			// part of the task's authorization, not the model's per-round choice.
			const childTools = resolveChildTools(state.childTools.length === 0 ? [...CHILD_TOOL_NAMES] : [...state.childTools]);
			const round = state.currentRound + 1;
			const outcome = await runDelegationRound(
				api,
				callContext,
				{ ...host, childToolObjects: childTools },
				{
					taskId: args.taskId,
					round,
					kind: "revision",
					task: args.task,
					feedback: args.feedback,
					model: options.model,
				},
			);
			return { output: [{ type: "text", text: roundReport(args.taskId, round, outcome) }] };
		},
	});

	const taskReviewTool = defineTool({
		name: "task_review",
		description:
			"Accept or reject the current round of a delegated task. Rejecting persists your feedback round and lets you " +
			"call task_revise; accepting closes the task. Repeating the same decision for the same round changes nothing.",
		parameters: Type.Object({
			taskId: Type.String(),
			decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
			reason: Type.Optional(Type.String({ description: "Why, for a reject." })),
		}),
		replay: "safe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			const result = await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, args.taskId, {
					taskId: args.taskId,
					model: options.model,
				});
				// Idempotent: one decision per round; a rerun reports what is already there.
				const existing = doc.reviews.find((review) => review.round === doc.currentRound && review.decision === args.decision);
				if (existing !== undefined) {
					return { text: `task ${args.taskId} round ${doc.currentRound} already ${existing.decision}ed (${doc.status}).`, terminal: false };
				}
				let next: TaskBusinessStatus;
				try {
					next = reviewOutcome(args.taskId, doc.status, args.decision, doc.currentRound);
				} catch (error) {
					if (error instanceof RevisionLimitError) {
						// A third rejection fails the task; it is never accepted by default.
						const event: ReviewEvent = {
							round: doc.currentRound,
							decision: "reject",
							...(args.reason === undefined ? {} : { reason: args.reason }),
							at: Date.now(),
							before: doc.status,
							after: "failed",
						};
						doc.reviews = [...doc.reviews, event];
						assertTransition(args.taskId, doc.status, "failed");
						doc.status = "failed";
						doc.failure = { reason: "revision_limit", detail: error.message, at: Date.now() };
						doc.terminalAt = Date.now();
						return { text: `task ${args.taskId} failed: revision limit reached.`, terminal: true };
					}
					return { text: `review refused: ${(error as Error).message}`, terminal: false, refused: true };
				}
				const event: ReviewEvent = {
					round: doc.currentRound,
					decision: args.decision,
					...(args.reason === undefined ? {} : { reason: args.reason }),
					at: Date.now(),
					before: doc.status,
					after: next,
				};
				doc.reviews = [...doc.reviews, event];
				assertTransition(args.taskId, doc.status, next);
				doc.status = next;
				if (isTerminal(next)) doc.terminalAt = Date.now();
				return { text: `task ${args.taskId} round ${doc.currentRound} ${args.decision}ed -> ${next}.`, terminal: false };
			}, callContext);
			return { output: [{ type: "text", text: result.text }], isError: result.refused === true };
		},
	});

	const taskStatusTool = defineTool({
		name: "task_status",
		description: "Show a task's status, round count, reviews and child conversation, or the main conversation's child conversations when taskId is omitted.",
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
						{
							type: "text",
							text: `child conversations: ${listing.length === 0 ? "(none)" : listing.join(", ")}`,
						},
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
						currentRound: doc.currentRound,
						childConversationId: doc.childConversationId ?? null,
						childTools: [...doc.childTools],
						rounds: doc.rounds.map((round) => ({
							round: round.round,
							kind: round.kind,
							requestId: round.requestId,
							submissionId: round.submissionId ?? null,
							answerEntryId: round.answerEntryId ?? null,
							evidence: round.evidence.length,
						})),
						reviews: [...doc.reviews],
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
			"Retrieve the persisted evidence of a task's round: every tool result with entry ids, and the full text of one entry. " +
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
					return { evidence: JSON.parse(JSON.stringify(round.evidence)) as typeof round.evidence, childConversationId: doc.childConversationId, roundNumber };
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
				return { output: [{ type: "text", text: `entry ${found.entryId} (child ${found.childConversationId}, round ${found.roundNumber}):\n${found.fullText}` }] };
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
		tools: [taskDelegateTool, taskReviseTool, taskReviewTool, taskStatusTool, taskEvidenceTool],
	});

	// Late-bind the host's self reference: the child must be able to drop this
	// exact extension, and delegation must know the main conversation at run time.
	host.mainExtension = management;
	return management;
}
