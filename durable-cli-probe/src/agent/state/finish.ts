// TASK-005.1 src/agent/state/finish.ts
//
// The finish protocol: how a sub-agent's round ends on purpose, derived from the
// locked source and encoded so a caller cannot get it wrong by accident.
//
// ── Source basis (pinned Pi `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`) ────────
//
//   `packages/durable/src/harness/types.ts`
//     `ToolControl = { addTools?: readonly string[]; terminate?: true; handoff?: string }`
//     `ToolExecutionResult.control?: ToolControl`
//     a tool returns its control on the result; nothing else can set it.
//
//   `packages/durable/src/harness/generation.ts` → `finishToolRound`
//     "Every call of the round, including those answered without a task, must ask
//      to terminate."
//       terminate = slots.length > 0 && slots.every((slot) => slot.taskId !== undefined
//                && controls.get(slot.taskId)?.terminate === true)
//     On terminate (or a handoff, or a queued reset) the boundary is applied as
//     `"final"` and the run is ended:
//       endRun(tx, live, runtime.taskId, { status: "done", answer: assistant })
//     and no generation is created for a further model round — the only thing
//     that may follow is a new run for *queued user inputs*.
//
//   Consequences this module encodes:
//     1. A round ends on purpose only when **every** call of that round asks to
//        terminate. A `finish_task` call beside a call that does not terminate
//        does not stop anything.
//     2. The stop is the run ending, so the program learns it by awaiting the
//        submission it already made (`Submission.wait`) — never by trusting that
//        a tool called `finish_task` ran.
//     3. `handoff` is the *reset* variant: it ends the run and starts a new one
//        for the handoff content. That is how a question ends its round while the
//        conversation stays open.
//
// ── The alternative protocol, recorded for completeness ─────────────────────
//
// If the run could not be stopped through `control.terminate`, the only sound
// fallback is a schema-validated final answer plus `Submission.wait`: the run
// ends when the model stops issuing tool calls and produces a final answer, and
// the program settles on the submission. That is strictly weaker — it depends on
// the model choosing to stop rather than on the run actually ending — so it is a
// documented fallback, not the default, and never "make the prompt say stop".
// With `control.terminate` available in the pinned source, the fallback is not
// used here.

// ── The protocol this module settles on ──────────────────────────────────────
//
// A round of a sub-agent ends like this:
//
//   1. The model does its work with whatever business tools it is authorized to
//      call — as many rounds as it needs.
//   2. When it has something to submit, it calls `finish_task` with its own work
//      and nothing else in that round.
//   3. `finish_task` returns `control: { terminate: true }`. The harness ends the
//      run at the final boundary **iff every call of the round asked to
//      terminate** — so step 2's "and nothing else" is what makes it take effect.
//   4. The program learns the run is over from the settlement of the submission
//      it already made (`Submission.wait`), never from the tool having run.
//
// Why `finish_task` asks unconditionally instead of refusing when the conversation
// is authorized to call other tools: a tool call cannot see its siblings'
// controls, so "the authorized set contains more than finish_task" is not a fact
// about this round — it is true of every usable sub-agent, and refusing on it
// made the tool unusable in exactly the sessions that need it. What the tool can
// do honestly is *ask* and say what it asked: the terminate is a request the
// harness evaluates, and the tool's output never claims the run ended.
//
// The documented fallback, for a future Runtime that cannot rely on step 3: a
// schema-validated final answer with no tool calls, settled the same way through
// `Submission.wait`. It is strictly weaker (it depends on the model choosing to
// stop rather than on the run actually ending), so it is a fallback — never
// "make the prompt say stop".

/** What the finish decision engine was asked. */
export type FinishDecisionInput = {
	/**
	 * Whether the conversation may call tools other than `finish_task`. This is
	 * **not** a statement about what this round contains — the tool cannot see its
	 * siblings — it only decides how much the tool's own output may claim.
	 */
	readonly roundMayHaveCompetitors: boolean;
	/** Did the model's submitted work pass the contract validation? */
	readonly answerValidated: boolean;
};

export type FinishDecision =
	/** Ask the harness to end the round. `statement` is all the tool may tell the model. */
	| { readonly kind: "terminate"; readonly statement: string }
	/** Refuse the call outright: no control, an error result. */
	| { readonly kind: "refuse"; readonly code: string; readonly detail: string };

/**
 * Decide what a finish call does. Pure, no IO, no documents touched.
 *
 * An unvalidated payload is refused: we never ask to end a round on work that
 * failed its contract, because the stop would then look like a settlement of
 * something that was never valid. A valid payload is always asked for, and the
 * statement is worded to the one thing the tool knows — that it asked.
 */
export function decideFinish(input: FinishDecisionInput): FinishDecision {
	if (!input.answerValidated) {
		return { kind: "refuse", code: "finish_answer_invalid", detail: "the submitted work failed contract validation; the round was not asked to end" };
	}
	if (input.roundMayHaveCompetitors) {
		return {
			kind: "terminate",
			statement:
				"Submission recorded. This round is asking to end. The run ends only if every call of this round also asked to end, so if the run continues, call finish_task again as the only call of the round.",
		};
	}
	return { kind: "terminate", statement: "Submission recorded. This round is asking to end; the run outcome is recorded after the submission settles." };
}

/**
 * Whether the round *asked* to end. This is a request predicate, and it is named
 * as one: a tool returning `terminate` is not the run having ended.
 */
export function isTerminateRequested(input: { readonly terminateRequested: boolean }): boolean {
	return input.terminateRequested;
}

/** The statuses a submission can report; only the last two are terminal. */
export type RunSettlementStatus = "queued" | "placed" | "done" | "unanswered";

/**
 * Whether the run is over. The only honest input is the settlement the program
 * received from `Submission.wait`: a run ends when its submission settles, not
 * when a tool asked it to stop and not when a round finished. (A revision round
 * settles exactly like a first round, so "a round settled" is not "the run
 * ended" either.)
 */
export function isRunEnded(settlement: { readonly status: RunSettlementStatus }): boolean {
	return settlement.status === "done" || settlement.status === "unanswered";
}
