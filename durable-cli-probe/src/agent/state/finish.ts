// TASK-005.1 src/agent/state/finish.ts
//
// The completion boundary: how a sub-agent's run ends, and what the program may
// then treat as its submission.
//
// ── Source basis (pinned Pi `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`) ────────
//
//   `packages/durable/src/harness/types.ts`
//     `ToolControl = { addTools?: readonly string[]; terminate?: true; handoff?: string }`
//     `ToolExecutionResult.control?: ToolControl` — a tool returns its control on
//     its result, and nothing else can set it.
//
//   `packages/durable/src/harness/generation.ts` → `finishToolRound`
//     `terminate = slots.length > 0 && slots.every((slot) => slot.taskId !== undefined
//                  && controls.get(slot.taskId)?.terminate === true)`
//     `if (terminate || handoff !== undefined)` → `applyBoundary(…, "final", …)` and
//     `endRun(…, { status: "done", answer: assistant })`; otherwise the run is
//     handed to the next generation, i.e. **it continues**.
//
//   `packages/durable/src/harness/generation.ts` → `answer`
//     A final answer — an assistant turn with **no tool calls** — applies the
//     `"final"` boundary and runs
//     `endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id })`.
//
// ── Why the tool route is not this contract's completion boundary ─────────────
//
// `control.terminate` takes effect only when **every** call of the round asks for
// it, and a tool call cannot see its siblings. A `finish_task` call beside any
// call that does not terminate is therefore silently ignored: the run continues,
// a later round can still start business calls, and the only way to make the stop
// happen is to ask the model to keep its submission alone in its round. That is a
// request to the model, not a guarantee by the program — and "a valid submission
// followed by more business work" is exactly what AC-05 forbids. Measured, not
// assumed: `intent-spec/TASK-005.1-contracts.md` §7.3 records the run where the
// first valid submission was followed by a second business call.
//
// (`handoff` does end the run unconditionally, but it also appends a reset entry
// and moves the conversation head — a side effect on the child conversation that
// this contract does not ask for, so it is not used either.)
//
// ── The chosen protocol: a structured final answer + the settlement ──────────
//
//   1. The model does its work with the tools it is authorized to call, over as
//      many rounds as it needs.
//   2. It submits by producing a final answer whose text is the work contract as
//      JSON. The turn has no tool calls, so the harness applies the `"final"`
//      boundary and ends the run. This needs no cooperation from a sibling: a
//      turn with no tool calls has no siblings.
//   3. The program awaits the settlement it already holds (`Submission.wait`).
//      Only `done` counts: `queued`/`placed` are not settled, and `unanswered`
//      has no answer to accept.
//   4. Only then does the program read the answering entry and validate its
//      payload — {@link completeSubmission}. **No tool call is ever a
//      submission**: completion is defined after the run settled *and* the
//      result validated, so "a finish call that has not terminated the run"
//      cannot be mistaken for a successful one.
//
// The property AC-05 asks for then holds structurally rather than by prompt:
// business calls happen before the submission, and the submission is the end of
// the run.

import type { ContractValidation } from "../contracts/errors.ts";
import { Violations } from "../contracts/validate.ts";
import type { ModelWork } from "../contracts/task-result.ts";
import { validateModelWork } from "../contracts/task-result.ts";

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

/** What the program accepted, once the run settled and its answer validated. */
export type SettledSubmission = {
	/** The assistant entry that answered: the evidence that a submission exists. */
	readonly answerEntryId: string;
	/** The model's validated work content, read from that entry's text. */
	readonly work: ModelWork;
};

/**
 * The facts a caller reads after a settlement and hands in. Pure input: nothing
 * here touches the harness, so the completion rule stays a pure function of what
 * persistence actually holds.
 */
export type SubmissionCompletionInput = {
	/** The settlement `Submission.wait` returned. */
	readonly settlement: { readonly status: RunSettlementStatus };
	/** The entry that answered, when the settlement is `done`. */
	readonly answerEntryId?: string;
	/** The answering assistant message's text, exactly as persisted. */
	readonly answerText?: string;
};

/**
 * Extract the structured payload from a final answer.
 *
 * Two forms are accepted, both exact: the whole text is the JSON object, or
 * **exactly one** fenced code block is. Nothing is guessed from surrounding
 * prose — a model that wraps its answer in commentary must still put the
 * contract inside one of them, and a payload that cannot be read is refused
 * rather than partially interpreted.
 *
 * "Exactly one" is checked, not assumed. A text carrying several fenced blocks,
 * or a complete block beside an unclosed fence, does not say which block is the
 * submission; taking the first would let a model's own correction — a second
 * block — be ignored while its superseded draft is submitted. That case is
 * refused with `submission_answer_ambiguous` instead. Performs no IO.
 */
export function parseStructuredAnswer(text: string): ContractValidation<unknown> {
	const collect = new Violations();
	const trimmed = text.trim();
	if (trimmed === "") {
		collect.add("submission_answer_empty", "$", "the final answer is empty");
		return collect.finish(undefined as unknown as unknown);
	}
	const direct = tryParse(trimmed);
	if (direct.ok) return { ok: true, value: direct.value };
	const fences = scanFences(trimmed);
	// More than one complete block, or one complete block plus a fence that never
	// closes: the answer does not name a single submission.
	if (fences.blocks.length > 1 || (fences.blocks.length === 1 && fences.dangling)) {
		collect.add(
			"submission_answer_ambiguous",
			"$",
			fences.blocks.length > 1
				? `the final answer carries ${fences.blocks.length} fenced blocks; the submission must be exactly one`
				: "the final answer carries a complete fenced block and an unclosed fence; the submission must be exactly one block",
		);
		return collect.finish(undefined as unknown as unknown);
	}
	if (fences.blocks.length === 1) {
		const parsed = tryParse(fences.blocks[0] as string);
		if (parsed.ok) return { ok: true, value: parsed.value };
	}
	collect.add("submission_result_unparseable", "$", "the final answer is neither a JSON object nor a single fenced JSON block");
	return collect.finish(undefined as unknown as unknown);
}

function tryParse(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) as unknown };
	} catch {
		return { ok: false };
	}
}

/**
 * Every complete fenced block in `text`, in order, plus whether a fence was left
 * unclosed. A fence opens on any line whose content starts with ``` and closes on
 * the next line that is exactly ```; a block is complete only when both are seen.
 * Returning all of them is what lets the caller refuse an ambiguous answer rather
 * than pick one.
 */
function scanFences(text: string): { readonly blocks: readonly string[]; readonly dangling: boolean } {
	const lines = text.split(/\r?\n/);
	const blocks: string[] = [];
	let openAt = -1;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (openAt === -1) {
			if (line.trimStart().startsWith("```")) openAt = index;
			continue;
		}
		if (line.trim() === "```") {
			blocks.push(lines.slice(openAt + 1, index).join("\n").trim());
			openAt = -1;
		}
	}
	return { blocks, dangling: openAt !== -1 };
}

/**
 * Complete a submission: the run must have settled with an answer, and that
 * answer's payload must satisfy the work contract.
 *
 * This is the whole completion rule, and deliberately the only one. There is no
 * branch for a tool call, because a tool call is not a submission — the round it
 * happened in may not even have ended. The order is the contract: settle first,
 * validate second, and only then is there something a reviewer can accept.
 *
 * Performs no IO: the caller reads the settlement and the answering entry and
 * hands them in, so the rule is a pure function of persisted facts.
 */
export function completeSubmission(input: SubmissionCompletionInput): ContractValidation<SettledSubmission> {
	const collect = new Violations();
	if (!isRunEnded(input.settlement)) {
		collect.add(
			"submission_not_settled",
			"$.settlement.status",
			`the submission is ${input.settlement.status}; a run that has not settled has no submission`,
		);
		return collect.finish(undefined as unknown as SettledSubmission);
	}
	if (input.settlement.status !== "done") {
		collect.add("submission_unanswered", "$.settlement.status", "the input settled without an answer, so there is nothing to accept");
		return collect.finish(undefined as unknown as SettledSubmission);
	}
	if (input.answerEntryId === undefined || input.answerEntryId.trim() === "") {
		collect.add("submission_answer_missing", "$.answerEntryId", "a settled submission must name the entry that answered it");
		return collect.finish(undefined as unknown as SettledSubmission);
	}
	if (input.answerText === undefined) {
		collect.add("submission_answer_missing", "$.answerText", "the answering entry's text was not read");
		return collect.finish(undefined as unknown as SettledSubmission);
	}
	const parsed = parseStructuredAnswer(input.answerText);
	if (!parsed.ok) {
		for (const item of parsed.violations) collect.add(item.code, `$.answer${item.path.slice(1)}`, item.detail);
		return collect.finish(undefined as unknown as SettledSubmission);
	}
	const work = validateModelWork(parsed.value);
	if (!work.ok) {
		collect.add("submission_result_invalid", "$.answer", "the final answer does not satisfy the work contract");
		for (const item of work.violations) collect.add(item.code, `$.answer${item.path.slice(1)}`, item.detail);
		return collect.finish(undefined as unknown as SettledSubmission);
	}
	return collect.finish({ answerEntryId: input.answerEntryId, work: work.value });
}
