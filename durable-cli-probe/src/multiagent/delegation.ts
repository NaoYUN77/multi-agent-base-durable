// TASK-003 src/multiagent/delegation.ts
//
// One delegation round, wrapped around the Durable machinery the way the
// checkout's own foreground subagent example (`test/examples/22-subagent-
// foreground.ts`) does it: a task-owned child conversation, an explicit
// `configure` (so the child never inherits the main agent's tools or
// instructions), a stable `requestId` for replay, and a program-extracted
// answer. This module implements no model loop of its own.
//
// Execution right and receipts:
//   - The round (its number, requestId, binding and the `activeOpKey` slot) is
//     reserved by the caller in ONE commit (`claimRound` in ledger.ts), so two
//     parallel delegations or revisions cannot both start a round.
//   - Every write below re-checks that this operation still holds the round's
//     execution right; a late-finishing round whose right was taken (or whose
//     task moved on) changes nothing.
//   - A replay of an already-settled round returns the persisted receipt
//     (submission id, answer entry, answer text, evidence) and touches no
//     state — it never re-submits and never re-transitions.
//
// Cancellation:
//   - A persisted cancel intent (`cancelRequested`) blocks new work at every
//     stage: before the child exists, before the submission, and before any
//     failure write. A round interrupted by a cancel is left for the cancel to
//     close, so the task cannot end up `failed` while a cancel is in flight.

import type { Context } from "@earendil-works/chord";
import type { ConversationId, EntryId, Extension, ModelRef, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { configure } from "@earendil-works/pi-durable";
import { extractRoundEvidence, type RoundExtraction } from "./evidence.ts";
import {
	recordTransition,
	releaseRound,
	roundRequestId,
	TaskLedgerDoc,
	type EvidenceReference,
	type RoundRecord,
} from "./ledger.ts";
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
	/**
	 * Verification barrier, awaited after the round's intent is committed and
	 * before its submission exists. The cross-process tests kill the process here
	 * to exercise the "intent committed, submit not yet made" window.
	 */
	readonly beforeSubmit?: (info: { readonly taskId: string; readonly round: number; readonly requestId: string }) => void | Promise<void>;
	/**
	 * Verification barrier, awaited after the round's outcome is committed and
	 * before the tool returns. Kills here exercise "result committed, parent tool
	 * result not yet committed".
	 */
	readonly afterOutcome?: (info: { readonly taskId: string; readonly round: number; readonly requestId: string }) => void | Promise<void>;
};

/** Input of one round. The round is already reserved for `opKey`. */
export type RoundInput = {
	readonly taskId: string;
	readonly round: number;
	readonly kind: "initial" | "revision";
	readonly task: string;
	readonly feedback?: string;
	readonly model: ModelRef;
	/** The operation that owns this round (reserved by the caller). */
	readonly opKey: string;
	/** The tools granted for this task, as tool objects. */
	readonly childToolObjects: readonly ToolRegistration[];
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
	/** True when this was a replay of an already-settled round (a receipt). */
	readonly receipt?: boolean;
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

/** Turn one persisted round record into the receipt a replay returns. */
function receiptOf(round: RoundRecord, childConversationId: ConversationId | undefined): RoundOutcome {
	return {
		ok: true,
		childConversationId,
		submissionId: round.submissionId,
		answerText: round.answerText,
		answerEntryId: round.answerEntryId,
		extraction: {
			answerEntryId: round.answerEntryId as EntryId,
			answerText: round.answerText ?? "",
			evidence: [...round.evidence],
			calls: [],
		},
		receipt: true,
	};
}

/**
 * Run one delegation round whose execution right is already reserved: ensure the
 * child conversation, submit with the stable request id, wait, extract the
 * evidence, and commit the outcome — each write guarded by the execution right,
 * and every stage refusing while a cancel is pending.
 */
export async function runDelegationRound(
	api: ToolExecutionApi,
	callContext: Context,
	host: DelegationHost,
	input: RoundInput,
): Promise<RoundOutcome> {
	const requestId = roundRequestId(input.taskId, input.round);

	// ── Stage 0: still allowed to work at all, and do we already have a result? ──
	const gate = await api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
		const settled = doc.rounds.find((round) => round.requestId === requestId && round.settledAt !== undefined);
		if (settled !== undefined) return { receipt: settled, child: doc.childConversationId } as const;
		// The cancel intent is deliberately NOT checked here: it is enforced at the
		// single boundary that gates the submission (Stage 2, second admission), so
		// a round that holds the right always reaches that boundary and can be
		// observed. A *completed* cancel is terminal, which every path here refuses.
		if (doc.status === "failed" || doc.status === "accepted" || doc.status === "cancelled") {
			return { error: `task ${input.taskId} is ${doc.status}` } as const;
		}
		if (doc.activeOpKey !== undefined && doc.activeOpKey !== input.opKey) {
			return { error: `task ${input.taskId} round ${input.round} is held by another operation` } as const;
		}
		if (doc.activeOpKey === undefined) {
			// The right was released (an abandoned attempt). This operation still
			// owns the round, so it re-takes the right; a released right never means
			// "someone else may run this round".
			const own = doc.rounds.find((round) => round.requestId === requestId);
			if (own === undefined || own.opKey !== input.opKey) {
				return { error: `task ${input.taskId} round ${input.round} is not this operation's round` } as const;
			}
			doc.activeOpKey = input.opKey;
			doc.activeRound = input.round;
			doc.activeToolTaskId = String(api.taskId);
		}
		return { ok: true } as const;
	}, callContext);
	if ("receipt" in gate && gate.receipt !== undefined) return receiptOf(gate.receipt, gate.child);
	if ("error" in gate && gate.error !== undefined) {
		return {
			ok: false,
			childConversationId: undefined,
			submissionId: undefined,
			answerText: undefined,
			answerEntryId: undefined,
			extraction: undefined,
			error: gate.error,
		};
	}

	// ── Stage 1: child conversation, created once and reused forever ────────
	// This stage checks the execution right only. A cancel cannot have completed
	// while this round holds the right, so a child cannot be created *after* a
	// completed cancel; the cancel intent itself is enforced at the single
	// boundary that gates the submission (Stage 2, second admission), which also
	// keeps that boundary reachable for observation.
	let childId: ConversationId;
	try {
		childId = await api.commit(async (tx) => {
			const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
			if (doc.activeOpKey !== input.opKey) throw new Error(`task ${input.taskId} round ${input.round} is held by another operation`);
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
				tools: input.childToolObjects,
				modelTools: input.childToolObjects,
				model: input.model,
			});
			doc.childConversationId = record.id;
			doc.childTools = input.childToolObjects.map((tool) => tool.name);
			return record.id;
		}, callContext);
	} catch (error) {
		await api.commit(async (tx) => {
			const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
			releaseRound(doc, input.opKey);
		}, callContext);
		return {
			ok: false,
			childConversationId: undefined,
			submissionId: undefined,
			answerText: undefined,
			answerEntryId: undefined,
			extraction: undefined,
			error: `round ${input.round} stopped before the child conversation: ${(error as Error).message}`,
		};
	}

	// The round record itself was written by the claim commit; if it is missing,
	// the reservation is inconsistent and nothing may be submitted.
	const recorded = await api.commit(
		async (tx) =>
			(await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model })).rounds.some(
				(round) => round.requestId === requestId,
			),
		callContext,
	);
	if (!recorded) {
		await api.commit(async (tx) => {
			const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
			releaseRound(doc, input.opKey);
		}, callContext);
		return {
			ok: false,
			childConversationId: childId,
			submissionId: undefined,
			answerText: undefined,
			answerEntryId: undefined,
			extraction: undefined,
			error: "the round's reservation is missing; nothing was submitted",
		};
	}

	// ── Stage 2: admission to the submission ────────────────────────────────
	// First admission checks only the execution right: a round that holds the
	// right may always reach its barrier, where a cancellation can observe it.
	// The cancel intent itself is checked at the last moment, immediately before
	// the submission (below), which is what actually gates the submit.
	const blockedEarly = await admission(api, callContext, input, false);
	if (blockedEarly !== undefined) {
		return {
			ok: false,
			childConversationId: childId,
			submissionId: undefined,
			answerText: undefined,
			answerEntryId: undefined,
			extraction: undefined,
			error: blockedEarly,
		};
	}

	// The verification barrier sits *inside* the admission window: the gate above
	// has already passed and the submission below has not been made. The recovery
	// and admission tests park the round here.
	if (host.beforeSubmit !== undefined) await host.beforeSubmit({ taskId: input.taskId, round: input.round, requestId });

	// Second admission, immediately before the submission: a cancel that landed
	// while the round was parked stops it here. The execution right is what makes
	// the cancel itself unable to close the task during that window.
	const blockedLate = await admission(api, callContext, input, true);
	if (blockedLate !== undefined) {
		return {
			ok: false,
			childConversationId: childId,
			submissionId: undefined,
			answerText: undefined,
			answerEntryId: undefined,
			extraction: undefined,
			error: blockedLate,
		};
	}

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
		// An aborted submission is not a failure: a global stop (the main
		// conversation's abort, a cancel) must not turn the task into `failed`
		// behind the operator's back. The round stays unsettled, the execution
		// right stays held, and a resume or a cancel decides what happens next.
		if (settled.status === "unanswered" && settled.reason === "aborted") {
			// Hand the execution right back: the round is abandoned, a resume may
			// re-claim it, and a pending cancel must be able to close the task.
			await api.commit(async (tx) => {
				const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
				releaseRound(doc, input.opKey);
			}, callContext);
			return {
				ok: false,
				childConversationId: childId,
				submissionId: String(settled.id),
				answerText: undefined,
				answerEntryId: undefined,
				extraction: undefined,
				error: `round ${input.round} was aborted; the task stays ${input.kind === "revision" ? "revising" : "running"} and the round stays unsettled`,
			};
		}
		return await failRound(
			api,
			callContext,
			input,
			`submission ended ${settled.status} (${settled.type === "input" ? "" : settled.type}${settled.status === "unanswered" ? `: ${settled.reason}` : ""})`,
		);
	}

	// ── Stage 3: evidence extraction + outcome, in one guarded commit ────────
	const outcome = await api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
		// The right may have been taken (a cancel, or a later round) while the
		// submission ran: a finished round that no longer owns the task changes
		// nothing at all.
		if (doc.activeOpKey !== input.opKey) {
			return {
				ok: false as const,
				childConversationId: childId,
				submissionId: String(settled.id),
				answerText: undefined,
				answerEntryId: undefined,
				extraction: undefined,
				error: `task ${input.taskId} is no longer executing round ${input.round} (${doc.status}); the finished round was not applied`,
			};
		}
		if (doc.cancelRequested !== undefined) {
			// Abandon the round and hand the right back so the cancel can close.
			releaseRound(doc, input.opKey);
			return {
				ok: false as const,
				childConversationId: childId,
				submissionId: String(settled.id),
				answerText: undefined,
				answerEntryId: undefined,
				extraction: undefined,
				error: `task ${input.taskId} is being cancelled; the finished round was not applied`,
			};
		}
		const extraction = await extractRoundEvidence(tx, {
			conversationId: childId,
			minEntryId: settled.entry,
			maxEntryId: settled.answer,
			answerEntryId: settled.answer,
		});
		const evidence: EvidenceReference[] = [...extraction.evidence];
		// An empty final answer is a failure of the round, not something to paper
		// over with earlier assistant text.
		if (extraction.answerText.trim() === "") {
			releaseRound(doc, input.opKey);
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
		doc.rounds = doc.rounds.map((round) =>
			round.requestId === requestId
				? {
						...round,
						submissionId: String(settled.id),
						answerEntryId: extraction.answerEntryId,
						answerText: extraction.answerText,
						evidence,
						settledAt: Date.now(),
					}
				: round,
		);
		recordTransition(doc, "awaiting_review", Date.now(), { opKey: input.opKey, round: input.round });
		return {
			ok: true as const,
			childConversationId: childId,
			submissionId: String(settled.id),
			answerText: extraction.answerText,
			answerEntryId: extraction.answerEntryId,
			extraction,
		};
	}, callContext);

	if (host.afterOutcome !== undefined) await host.afterOutcome({ taskId: input.taskId, round: input.round, requestId });
	return outcome;
}

/**
 * Submission admission for one round: the operation must still hold the
 * execution right and no cancel may be pending. A refusal hands the right back,
 * so a pending cancel can close the task without waiting for a round that will
 * never submit.
 */
async function admission(
	api: ToolExecutionApi,
	callContext: Context,
	input: RoundInput,
	checkCancel: boolean,
): Promise<string | undefined> {
	return api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
		if (checkCancel && doc.cancelRequested !== undefined) {
			releaseRound(doc, input.opKey);
			return `task ${input.taskId} is being cancelled`;
		}
		if (doc.activeOpKey !== input.opKey) return `task ${input.taskId} round ${input.round} is held by another operation`;
		return undefined;
	}, callContext);
}

/**
 * Mark the round and the task failed — unless a cancel is pending, in which case
 * the round is left for the cancel to close (a cancel must not be turned into a
 * failure by the abort it caused), and unless this operation no longer holds the
 * round's execution right.
 */
async function failRound(api: ToolExecutionApi, callContext: Context, input: RoundInput, detail: string): Promise<RoundOutcome> {
	const applied = await api.commit(async (tx) => {
		const doc = await tx.doc(TaskLedgerDoc, api.conversationId, input.taskId, { taskId: input.taskId, model: input.model });
		if (doc.status === "failed" || doc.status === "accepted" || doc.status === "cancelled") return { applied: false, reason: doc.status };
		if (doc.cancelRequested !== undefined) {
			// Yield to the cancel: no failure write, and the execution right goes
			// back so the cancel's finish phase can close the task.
			releaseRound(doc, input.opKey);
			return { applied: false, reason: "cancelling" };
		}
		if (doc.activeOpKey !== input.opKey) return { applied: false, reason: "right-lost" };
		releaseRound(doc, input.opKey);
		try {
			recordTransition(doc, "failed", Date.now(), { opKey: input.opKey, round: input.round, reason: "technical_error" });
		} catch {
			return { applied: false, reason: doc.status };
		}
		doc.failure = { reason: "technical_error", detail, at: Date.now() };
		return { applied: true, reason: "failed" };
	}, callContext);
	const suffix = applied.applied ? "" : ` (not applied: ${applied.reason})`;
	return {
		ok: false,
		childConversationId: undefined,
		submissionId: undefined,
		answerText: undefined,
		answerEntryId: undefined,
		extraction: undefined,
		error: `${detail}${suffix}`,
	};
}
