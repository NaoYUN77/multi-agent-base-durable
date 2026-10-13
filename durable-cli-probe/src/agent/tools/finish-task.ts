// TASK-005.1 src/agent/tools/finish-task.ts
//
// The `finish_task` tool: a model's structured submission of its own work.
//
// Two things this tool deliberately does not do:
//
//   * it does **not** accept a task. Marking a task `accepted` is Main's decision
//     against the persisted evidence; a tool that did it would let a model close
//     its own task.
//   * it does **not** report completion. What the model submits is a request to
//     end its round; the outcome is known only once the submission settles, and
//     the runtime's writer — not this tool — records the result then.
//
// The stop itself comes from the pinned harness: `control: { terminate: true }`
// ends the run at the final boundary, **but only when every call of the round
// asks to terminate**. A tool call cannot see its siblings' controls, so the
// only thing this tool can honestly check is whether a competing call *could*
// exist: the conversation's authorized tool set. When the child is authorized to
// call anything besides `finish_task`, this tool refuses the submission instead
// of returning a control that would be ignored — a round that continues while
// the model was told "Finished" is exactly the failure AC-05 guards against.
//
// Authorization: the model writes the work fields and nothing else. Identity,
// status, counts and evidence references are runtime-owned, so they are not part
// of the tool's parameters at all — a model cannot submit them because there is
// nowhere to put them.

import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
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

/**
 * Build the `finish_task` tool.
 *
 * Side effects: none of its own. It returns a tool result carrying the model's
 * validated work in `structuredOutput` (so the program that awaits the submission
 * can read it), and asks the harness to end the round when — and only when — the
 * submission can actually end it. It writes no document, marks no task, and
 * claims no evidence.
 *
 * Idempotency and recovery: the tool is `replay: "safe"` — re-running the same
 * call after an interruption re-validates the same payload and returns the same
 * control, so a recovered round cannot terminate twice or settle a different
 * answer.
 */
export function createFinishTaskTool() {
	return defineTool({
		name: FINISH_TASK_TOOL_NAME,
		description:
			"Submit this round's work and ask to end the round. Write only your own findings: identity, status and evidence are recorded by the program. " +
			"Submitting work is not acceptance; the main agent reviews it.",
		parameters: finishParameters,
		replay: "safe",
		execute: async (args, api, callContext): Promise<ToolExecutionResult> => {
			// The model's payload is untrusted input: validate before trusting it
			// enough to ask the run to end on it.
			const candidate = validateModelWork({
				summary: args.summary,
				findings: args.findings,
				unresolved: args.unresolved,
				artifacts: args.artifacts,
			});
			// The only honest proxy for "this call is alone in its round": what this
			// conversation is authorized to call. Any second tool means a competing
			// call can exist, and the harness would not terminate.
			const agent = await api.agent(callContext);
			const competing = agent.tools.map((tool) => tool.name).filter((name) => name !== FINISH_TASK_TOOL_NAME);
			const decision = decideFinish({ finishRequested: true, authorizedCompetingCalls: competing, answerValidated: candidate.ok });
			if (decision.kind !== "terminate") {
				const detail = decision.kind === "refuse" ? decision.detail : decision.reason;
				api.diagnostic({ severity: "error", message: `finish refused: ${detail}` });
				return { output: [{ type: "text", text: `Submission refused: ${detail}` }], isError: true };
			}
			// Asking to end the round is not the same as having ended it. The result
			// is recorded by whoever awaits the submission, after it settles.
			return {
				output: [
					{
						type: "text",
						text: candidate.ok
							? "Submission accepted. This round is asking to end; the run outcome is recorded after it settles."
							: "Submission accepted without work content.",
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
