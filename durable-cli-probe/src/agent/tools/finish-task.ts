// TASK-005.1 src/agent/tools/finish-task.ts
//
// The `finish_task` tool: a model's structured final answer that ends its round.
//
// What this tool is and is not (TASK-005 §"三层故障与结果"):
//
//   * it is the model's structured submission of *its work* — summary, findings,
//     unresolved items, artifact references — validated against the contract
//     before anything else happens;
//   * it is **not** an acceptance. Marking a task `accepted` is Main's decision,
//     made against the persisted evidence; a tool that did it would let a model
//     close its own task.
//
// The stop itself comes from the pinned harness, not from this file: a validated
// call returns `control: { terminate: true }`, and `finishToolRound` ends the run
// at the final boundary when every call of the round asks to terminate. See
// `../state/finish.ts` for the source basis and the rules this tool obeys.
//
// Authorization: the model writes the work fields and nothing else. Identity,
// status, counts and evidence references are runtime-owned, so they are not part
// of the tool's parameters at all — a model cannot submit them because there is
// nowhere to put them.

import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import type { ModelWork } from "../contracts/task-result.ts";
import { validateModelWork } from "../contracts/task-result.ts";
import { decideFinish } from "../state/finish.ts";

/** Name the model sees. Management tool names are snake_case by convention. */
export const FINISH_TASK_TOOL_NAME = "finish_task";

/** What the model may submit. Mirrors `ModelWork`; unknown fields are refused. */
const finishParameters = Type.Object({
	summary: Type.String({ description: "What this round produced, in a few sentences." }),
	findings: Type.Optional(Type.Array(Type.String(), { description: "Concrete findings, one per line." })),
	unresolved: Type.Optional(Type.Array(Type.String(), { description: "What remains open, and why." })),
	artifacts: Type.Optional(Type.Array(Type.Object({ kind: Type.String(), ref: Type.String() }), { description: "References to artifacts this round produced." })),
});

export type FinishTaskToolOptions = {
	/**
	 * Called with the validated work once the model's submission is accepted.
	 * The runtime (not this tool) writes identity, status and evidence alongside
	 * it. Optional: a run that only needs the terminate behaviour can omit it.
	 */
	readonly onFinish?: (work: ModelWork) => void;
};

/**
 * Build the `finish_task` tool.
 *
 * Side effects: on a valid submission the model's work is handed to
 * `options.onFinish` — the runtime's own writer — and the round is asked to
 * terminate. Nothing else is written here: this tool appends no document, marks
 * no task, and claims no evidence.
 *
 * Idempotency and recovery: the tool is `replay: "safe"` — re-running the same
 * call after an interruption re-validates the same payload and returns the same
 * control, so a recovered round cannot terminate twice or settle a different
 * answer.
 */
export function createFinishTaskTool(options: FinishTaskToolOptions = {}) {
	return defineTool({
		name: FINISH_TASK_TOOL_NAME,
		description:
			"Submit this round's work and end the round. Write only your own findings: identity, status and evidence are recorded by the program. " +
			"Submitting work is not acceptance; the main agent reviews it.",
		parameters: finishParameters,
		replay: "safe",
		execute: async (args, api, _callContext): Promise<ToolExecutionResult> => {
			// The model's payload is untrusted input: validate it before trusting it
			// enough to stop a round on it.
			const candidate = validateModelWork({
				summary: args.summary,
				findings: args.findings,
				unresolved: args.unresolved,
				artifacts: args.artifacts,
			});
			// A finish call is valid only on its own: any sibling call that does not
			// ask to terminate makes this one a plain call (see ../state/finish.ts).
			const decision = decideFinish({ finishRequested: true, competingCalls: [], answerValidated: candidate.ok });
			if (decision.kind === "refuse") {
				const detail = candidate.ok
					? decision.detail
					: candidate.violations.map((item) => `${item.path}: ${item.code} (${item.detail})`).join("; ");
				api.diagnostic({ severity: "error", message: `finish refused: ${detail}` });
				return { output: [{ type: "text", text: `Submission refused: ${detail}` }], isError: true };
			}
			if (decision.kind === "continue") {
				return { output: [{ type: "text", text: `Not finished: ${decision.reason}` }], isError: true };
			}
			// The runtime's writer, not the model, records the outcome; `control` is
			// the only thing this tool claims.
			if (candidate.ok) options.onFinish?.(candidate.value);
			return {
				output: [
					{
						type: "text",
						text: candidate.ok ? `Finished. Work recorded: ${candidate.value.summary.slice(0, 200)}` : "Finished.",
					},
				],
				...(candidate.ok ? { structuredOutput: candidate.value } : {}),
				control: { terminate: true },
			};
		},
	});
}

/** Tool name list, for extension assembly and tests. */
export const FINISH_TASK_TOOL_NAMES: readonly string[] = [FINISH_TASK_TOOL_NAME];

export { finishParameters };
