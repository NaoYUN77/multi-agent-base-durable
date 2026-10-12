// TASK-003 src/multiagent/delegation.ts
//
// One delegation round, wrapped around the Durable machinery the way the
// checkout's own foreground subagent example (`test/examples/22-subagent-
// foreground.ts`) does it: a task-owned child conversation, an explicit
// `configure` (so the child never inherits the main agent's tools or
// instructions), a stable `requestId` for replay, and a program-extracted
// answer. This module implements no model loop of its own.
//
// Recovery shape (contract §"应用工具与台账"): the round's intent is committed
// *before* the submission exists, with the stable request id recorded, so a
// rerun — after a crash or a replay of a `replay: "safe"` tool — resolves the
// same child conversation and the same submission instead of creating new ones.
// The ownership question the Issue flagged is settled by measurement, not by
// assumption: a child created by tool Task A stays usable from a later tool
// Task B (the revision call) once A is terminal. See the PR's ownership probe.
//
// The caller (tools.ts) owns round *numbering* through operation bindings:
// the round number passed here is already the one the persisted operation is
// bound to, so a rerun of the same tool call resumes the same round instead of
// minting the next one.

import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Extension, ModelRef, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { configure } from "@earendil-works/pi-durable";
import { extractRoundEvidence, type RoundExtraction } from "./evidence.ts";
import { roundRequestId, recordTransition, TaskLedgerDoc, type EvidenceReference, type RoundRecord } from "./ledger.ts";
import { textCheckTool, textStatsTool } from "./child-tools.ts";

/** Everything a round run needs from its host. The main conversation id comes
 * from the executing tool call (`api.conversationId`), never from the model. */
export type DelegationHost = {
	/** The main-side extension, removed from the child so it cannot delegate or review. */
	readonly mainExtension: Extension;
	/** The child-side extension, added to the child so its tools resolve. */
	readonly childExtension: Extension;
	/** Instructions installed verbatim in the child conversation. */
	readonly childInstructions: string;
	/** The child tools granted for this task, as tool objects (the program's whitelist). */
	readonly childToolObjects: readonly ToolRegistration[];
};

/** Input of one round. */
export type RoundInput = {
	readonly taskId: string;
	readonly round: number;
	readonly kind: "initial" | "revision";
	readonly task: string;
	readonly feedback?: string;
	readonly model: ModelRef;
	/** The operation that owns this round (task/call association for events). */
	readonly opKey: string;
};

/** What a settled round reports to the ledger and to the main model. */
export type RoundOutcome = {
	readonly ok: boolean;
	readonly childConversationId: ConversationId | undefined;
	readonly submissionId: string | undefined;
	readonly answerText: string | undefined;
	readonly answerEntryId: EntryId | undefined;
	readonly extraction: RoundExtraction | undefined;
	readonly error?: string;
};

const CHILD_TOOL_OBJECTS = [textStatsTool, textCheckTool] as const;

/**
 * Resolve the granted child tools by name, rejecting anything the child side
 * does not register. The main model chooses a subset; the program enforces the
 * universe.
 */
export function resolveChildTools(names: readonly string[]): readonly ToolRegistration[] {
	const resolved = CHILD_TOOL_OBJECTS.filter((tool) => names.includes(tool.name));
	const unknown = names.filter((name) => !CHILD_TOOL_OBJECTS.some((tool) => tool.name === name));
	if (unknown.length > 0) throw new Error(`unknown child tool(s): ${unknown.join(", ")}`);
	if (resolved.length === 0) throw new Error("a task must grant at least one child tool");
	return resolved;
}

/**
 * Run one delegation round inside a tool execution: ensure the child
 * conversation, commit the round intent, submit with the stable request id,
 * wait, extract the evidence, and commit the outcome.
 *
 * Status bookkeeping:
 *   - initial round: ledger starts `running`, this call ends at `awaiting_review`
 *     (or `failed` on a technical error — never dressed up as an answer).
 *   - revision round: the operation binding already moved the task to
 *     `revising`; this call ends at `awaiting_review` again (or `failed`).
 */
export async function runDelegationRound(
	api: ToolExecutionApi,
	callContext: Context,
	host: DelegationHost,
	input: RoundInput,
): Promise<RoundOutcome> {
	const requestId = roundRequestId(input.taskId, input.round);

	// ── Phase 1: child conversation, created once and reused forever ────────
	const childId = await api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, {
			taskId: input.taskId,
			model: input.model,
		});
		if (doc.mainConversationId === undefined) doc.mainConversationId = api.conversationId;
		if (doc.createdAt === 0) doc.createdAt = Date.now();
		if (doc.childConversationId !== undefined) return doc.childConversationId;
		const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
		const record = existing ?? (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }));
		// The child starts as a copy of the main agent, so the management
		// extension is removed and the child-side one is added by hand: the
		// delegated tool must resolve, and nothing else may.
		await configure(tx, record.id, {
			extensions: { remove: [host.mainExtension], add: [host.childExtension] },
			instructions: host.childInstructions,
			tools: host.childToolObjects,
			modelTools: host.childToolObjects,
			model: input.model,
		});
		doc.childConversationId = record.id;
		doc.childTools = host.childToolObjects.map((tool) => tool.name);
		return record.id;
	}, callContext);

	// ── Phase 2: the round's intent, committed before the submission ─────────
	await api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, {
			taskId: input.taskId,
			model: input.model,
		});
		// Idempotent: a rerun of the same round must not append a second record.
		if (doc.rounds.some((round) => round.requestId === requestId)) return;
		const round: RoundRecord = {
			round: input.round,
			kind: input.kind,
			requestId,
			task: input.task,
			...(input.feedback === undefined ? {} : { feedback: input.feedback }),
			evidence: [],
			startedAt: Date.now(),
		};
		doc.rounds = [...doc.rounds, round];
		doc.currentRound = input.round;
		// A revision's intent lands the task in `revising` — from `awaiting_review`
		// when the main model revises directly, or already there right after a
		// recorded rejection (the recorded transition was the rejection's).
		if (input.kind === "revision" && doc.status !== "revising") {
			recordTransition(doc, "revising", Date.now(), { opKey: input.opKey, round: input.round });
		}
	}, callContext);

	// ── Phase 3: submit with the stable request id and wait ─────────────────
	const handle = await api.conversation(childId, callContext);
	if (handle === undefined) {
		return await failRound(api, callContext, input, `child conversation ${childId} not found`);
	}
	let settled;
	try {
		const submission = await handle.submit(
			{ type: "input", content: input.feedback === undefined ? input.task : `${input.task}\n\n评审反馈：${input.feedback}`, requestId },
			callContext,
		);
		settled = await submission.wait(callContext);
	} catch (error) {
		return await failRound(api, callContext, input, `submission failed: ${String(error)}`);
	}
	if (settled.status !== "done" || settled.type !== "input") {
		return await failRound(
			api,
			callContext,
			input,
			`submission ended ${settled.status} (${settled.type === "input" ? "" : settled.type}${settled.status === "unanswered" ? `: ${settled.reason}` : ""})`,
		);
	}

	// ── Phase 4: evidence extraction + outcome, in one commit ────────────────
	return api.commit(async (tx) => {
		const extraction = await extractRoundEvidence(tx, {
			conversationId: childId,
			minEntryId: settled.entry,
			maxEntryId: settled.answer,
			answerEntryId: settled.answer,
		});
		// An empty final answer is a failure of the round, not something to
		// paper over with earlier assistant text.
		if (extraction.answerText.trim() === "") {
			const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, {
				taskId: input.taskId,
				model: input.model,
			});
			try {
				recordTransition(doc, "failed", Date.now(), { opKey: input.opKey, round: input.round, reason: "empty_answer" });
			} catch {
				// Already terminal: leave the terminal record alone.
			}
			doc.failure = { reason: "empty_answer", detail: `round ${input.round} settled without answer text`, at: Date.now() };
			return {
				ok: false as const,
				childConversationId: childId,
				submissionId: String(settled.id),
				answerText: extraction.answerText,
				answerEntryId: extraction.answerEntryId,
				extraction,
				error: "the sub-agent settled without an answer",
			};
		}
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, {
			taskId: input.taskId,
			model: input.model,
		});
		const evidence: EvidenceReference[] = [...extraction.evidence];
		doc.rounds = doc.rounds.map((round) =>
			round.requestId === requestId
				? {
						...round,
						submissionId: String(settled.id),
						answerEntryId: extraction.answerEntryId,
						evidence,
						settledAt: Date.now(),
					}
				: round,
		);
		// Atomic terminal/lifecycle check: a terminal or already-advanced task
		// must not be dragged back by a late-finishing round.
		try {
			recordTransition(doc, "awaiting_review", Date.now(), { opKey: input.opKey, round: input.round });
		} catch {
			return {
				ok: false as const,
				childConversationId: childId,
				submissionId: String(settled.id),
				answerText: extraction.answerText,
				answerEntryId: extraction.answerEntryId,
				extraction,
				error: `task ${input.taskId} is ${doc.status}; the finished round was not applied`,
			};
		}
		return {
			ok: true as const,
			childConversationId: childId,
			submissionId: String(settled.id),
			answerText: extraction.answerText,
			answerEntryId: extraction.answerEntryId,
			extraction,
		};
	}, callContext);
}

/** Mark the round and the task failed; a technical error is never an answer. */
async function failRound(
	api: ToolExecutionApi,
	callContext: Context,
	input: RoundInput,
	detail: string,
): Promise<RoundOutcome> {
	await api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, {
			taskId: input.taskId,
			model: input.model,
		});
		if (doc.status === "failed" || doc.status === "accepted" || doc.status === "cancelled") return;
		try {
			recordTransition(doc, "failed", Date.now(), { opKey: input.opKey, round: input.round, reason: "technical_error" });
		} catch {
			// Not a legal failure from here (should not happen); leave as-is.
			return;
		}
		doc.failure = { reason: "technical_error", detail, at: Date.now() };
	}, callContext);
	return {
		ok: false,
		childConversationId: undefined,
		submissionId: undefined,
		answerText: undefined,
		answerEntryId: undefined,
		extraction: undefined,
		error: detail,
	};
}
