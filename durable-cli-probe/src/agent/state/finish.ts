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

/** What the finish decision engine was asked. */
export type FinishDecisionInput = {
	/** Did the model call the finish tool at all? */
	readonly finishRequested: boolean;
	/** Other tool calls the model made in the same round, by name. */
	readonly competingCalls: readonly string[];
	/** Did the model's final answer pass the contract validation? */
	readonly answerValidated: boolean;
};

export type FinishDecision =
	/** End the round: return `control: { terminate: true }`. */
	| { readonly kind: "terminate" }
	/** Do not end it, and do not claim it ended. */
	| { readonly kind: "continue"; readonly reason: string }
	/** Refuse the call outright: no control, an error result. */
	| { readonly kind: "refuse"; readonly code: string; readonly detail: string };

/**
 * Decide what a finish call does. Pure, no IO, no documents touched.
 *
 * The rules, in order:
 *   * an unvalidated answer is refused — we never stop a round on a payload that
 *     failed its contract, because the stop would look like a settlement;
 *   * a finish call beside calls that do not terminate cannot stop the round
 *     (source rule 1), so it reports `continue` with the competing names, which
 *     is what lets a caller put that in the tool's output back to the model.
 */
export function decideFinish(input: FinishDecisionInput): FinishDecision {
	if (input.finishRequested && !input.answerValidated) {
		return { kind: "refuse", code: "finish_answer_invalid", detail: "the final answer failed contract validation; the round was not terminated" };
	}
	if (!input.finishRequested) {
		return input.competingCalls.length === 0
			? { kind: "continue", reason: "no finish call" }
			: { kind: "continue", reason: `the round has unfinished calls: ${input.competingCalls.join(", ")}` };
	}
	if (input.competingCalls.length > 0) {
		return { kind: "continue", reason: `finish needs every call of the round to terminate; these do not: ${input.competingCalls.join(", ")}` };
	}
	return { kind: "terminate" };
}

/**
 * Whether the run is over, as opposed to a round being over. A round ends on
 * success, failure or cancellation; the *run* ends only when the conversation
 * stops generating on its own — which, with `terminate`, is at the final
 * boundary and therefore immediately. Callers must not treat "a round settled"
 * as "the run ended": a revision round settles the same way.
 */
export function isRunEnded(input: { readonly roundStatus: "completed" | "failed" | "cancelled"; readonly terminateRequested: boolean }): boolean {
	return input.terminateRequested;
}
