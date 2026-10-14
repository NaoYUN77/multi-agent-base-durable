// TASK-005.2 src/agent/main/restoration.ts
//
// The Main agent's restoration section: the facts the model needs to keep
// serving a request, re-rendered from *committed* state before every provider
// request.
//
// Why a section and not only the handoff payload. `request_clarification` ends
// the run with a handoff, and the handoff payload is built by the program from
// persisted facts — but it is a snapshot taken at the moment the question tool
// completed. A sibling tool in the same round may write *after* it (the round's
// tools are parallel and the control is collected at the boundary), so a payload
// alone can be one write behind. This section is rendered on every preparation
// from whatever is committed at that moment, so the request, its materials, the
// answers and the plan index the next round sees are never stale.
//
// What it deliberately is NOT: a summary. Every line is a persisted field, read
// back verbatim. The model does not get to author it, and it carries no
// credentials — materials are the request's own recorded material.

import { AgentClarificationDoc, AgentRequestDoc } from "../contracts/documents.ts";
import { openQuestionIds, type ClarificationState } from "../contracts/clarification.ts";
import { MainServiceDoc, type PlanIndexEntry } from "./service-doc.ts";
import type { PromptSection } from "@earendil-works/pi-durable";

/** One question as the restoration text shows it: the words and why they were asked. */
function questionLine(question: ClarificationState["questions"][number]): string {
	const scope = question.blockingScope.length === 0 ? "the whole request" : question.blockingScope.join(", ");
	return `- ${question.questionId}: "${question.question}" (why: ${question.reason}; blocks: ${scope})`;
}

/**
 * The restoration text, or `undefined` when no request is active yet — a
 * conversation that has not been given work has nothing to restore, and an empty
 * section would only be noise in the prompt.
 *
 * Pure with respect to everything except the reads it is handed: the same
 * committed state always renders the same text.
 */
export async function renderRestoration(
	input: Parameters<PromptSection["render"]>[0],
	context: Parameters<PromptSection["render"]>[1],
): Promise<string | undefined> {
	const service = await input.read.snapshot(MainServiceDoc, input.conversationId, context);
	const requestId = service?.activeRequestId;
	if (requestId === undefined) return undefined;

	const request = await input.read.snapshot(AgentRequestDoc, input.conversationId, requestId, context);
	if (request === undefined || request.text === "") return undefined;

	const clarification = await input.read.snapshot(AgentClarificationDoc, input.conversationId, requestId, context);
	const state: ClarificationState =
		clarification ?? { schemaVersion: 1, questions: [], answers: [], resolutions: [] };
	const open = new Set(openQuestionIds(state));

	const lines = [`Request ${requestId} v${request.requestVersion}: ${request.text}`];
	lines.push(
		request.materials.length === 0
			? "Materials: (none recorded)"
			: `Materials:\n${request.materials.map((material) => `- [${material.source}] ${material.content}`).join("\n")}`,
	);

	const answered = state.answers.filter((answer) => !open.has(answer.questionId));
	lines.push(
		answered.length === 0
			? "Answers recorded: (none)"
			: `Answers recorded:\n${answered
					.map((answer) => `- ${answer.questionId}: "${answer.text}"${answer.sufficient ? "" : " (the application did not judge this sufficient)"}`)
					.join("\n")}`,
	);

	const openQuestions = state.questions.filter((question) => open.has(question.questionId));
	lines.push(
		openQuestions.length === 0
			? "Open questions: (none)"
			: `Open questions:\n${openQuestions.map(questionLine).join("\n")}`,
	);

	const plans = ((service?.plans ?? []) as readonly PlanIndexEntry[]).filter((plan) => plan.requestId === requestId);
	lines.push(
		plans.length === 0
			? "Plans saved for this request: (none)"
			: `Plans saved for this request:\n${plans.map((plan) => `- ${plan.planId} v${plan.version}`).join("\n")}`,
	);

	return lines.join("\n");
}

/**
 * The section as the extension installs it. Keyed `main-restoration`; the key is
 * part of the rendered prompt, so it is stable and readable rather than derived.
 */
export const mainRestorationSection: PromptSection = {
	key: "main-restoration",
	render: renderRestoration,
};
