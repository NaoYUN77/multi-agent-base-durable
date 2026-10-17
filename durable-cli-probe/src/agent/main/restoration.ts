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

import type { Message } from "@earendil-works/pi-ai";
import { AgentClarificationDoc, AgentRequestDoc } from "../contracts/documents.ts";
import { openQuestionIds, type ClarificationState, type UserAnswer } from "../contracts/clarification.ts";
import { MainServiceDoc, type PlanIndexEntry } from "./service-doc.ts";
import type { PromptSection } from "@earendil-works/pi-durable";

/** The section's key. Part of the rendered prompt, so it is stable and readable rather than derived. */
export const RESTORATION_SECTION_KEY = "main-restoration";

/** What the restoration text is made of: committed fields, read back verbatim. */
export type RestorationFacts = {
	readonly requestId: string;
	readonly requestVersion: number;
	readonly text: string;
	readonly materials: readonly { readonly source: string; readonly content: string }[];
	readonly questions: ClarificationState["questions"];
	readonly answers: readonly UserAnswer[];
	/**
	 * The resolutions too, not only the answers: a question is open until it is
	 * satisfied *or* resolved on the original input, and `openQuestionIds` reads
	 * both. Rendering from questions and answers alone would re-open every question
	 * the application had already closed.
	 */
	readonly resolutions: ClarificationState["resolutions"];
	/** Already narrowed to this request by the reader. */
	readonly plans: readonly PlanIndexEntry[];
};

/** One question as the restoration text shows it: the words and why they were asked. */
function questionLine(question: ClarificationState["questions"][number]): string {
	const scope = question.blockingScope.length === 0 ? "the whole request" : question.blockingScope.join(", ");
	return `- ${question.questionId}: "${question.question}" (why: ${question.reason}; blocks: ${scope})`;
}

/**
 * The restoration text from facts already read. Pure: the same facts always
 * render the same text, whichever caller resolved the requirement they belong to.
 */
export function formatRestoration(facts: RestorationFacts): string {
	const state: ClarificationState = {
		schemaVersion: 1,
		questions: [...facts.questions],
		answers: [...facts.answers],
		resolutions: [...facts.resolutions],
	};
	const open = new Set(openQuestionIds(state));

	const lines = [`Request ${facts.requestId} v${facts.requestVersion}: ${facts.text}`];
	lines.push(
		facts.materials.length === 0
			? "Materials: (none recorded)"
			: `Materials:\n${facts.materials.map((material) => `- [${material.source}] ${material.content}`).join("\n")}`,
	);

	const answered = facts.answers.filter((answer) => !open.has(answer.questionId));
	lines.push(
		answered.length === 0
			? "Answers recorded: (none)"
			: `Answers recorded:\n${answered
					.map((answer) => `- ${answer.questionId}: "${answer.text}"${answer.sufficient ? "" : " (the application did not judge this sufficient)"}`)
					.join("\n")}`,
	);

	const openQuestions = facts.questions.filter((question) => open.has(question.questionId));
	lines.push(
		openQuestions.length === 0
			? "Open questions: (none)"
			: `Open questions:\n${openQuestions.map(questionLine).join("\n")}`,
	);

	lines.push(
		facts.plans.length === 0
			? "Plans saved for this request: (none)"
			: `Plans saved for this request:\n${facts.plans.map((plan) => `- ${plan.planId} v${plan.version}`).join("\n")}`,
	);

	return lines.join("\n");
}

/**
 * The section's text exactly as the prompt carries it.
 *
 * The wrapping is not decoration: `renderSections` tags a section this way when
 * the extension installs it (this one has no `tag: false`), so a caller that
 * rewrites the section at request time has to produce byte-identical framing or
 * the model reads the same key in two different forms.
 */
export function restorationSectionText(facts: RestorationFacts): string {
	return `<${RESTORATION_SECTION_KEY}>\n${formatRestoration(facts)}\n</${RESTORATION_SECTION_KEY}>`;
}

/**
 * Replace the restoration section in a request's messages, for that request only.
 *
 * Why this exists rather than a second, appending section: the section is
 * rendered during the attempt's *preparation*, and the requirement a run serves
 * is only settled when its input is consumed — which the Harness does at the
 * round boundary, after preparation. A run admitted for a restatement therefore
 * prepares with the *previous* requirement's facts baked into the message the
 * provider reads first. Appending a correction would leave those facts in the
 * leading prompt, right where providers that honour only a leading system
 * message would render them; rewriting the section already there reaches every
 * provider.
 *
 * `text === null` removes the section — the answer when the run resolves no
 * requirement of its own. Serving on the previous requirement's facts is not a
 * safe default there; showing none is.
 *
 * Returns `undefined` when nothing changed, so a caller can pass the request
 * through untouched.
 */
export function withRestorationSection(
	messages: readonly Message[],
	text: string | null,
	timestamp: () => number,
): readonly Message[] | undefined {
	let found = false;
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "system" || message.sections === undefined) return message;
		if (!(RESTORATION_SECTION_KEY in message.sections)) return message;
		found = true;
		if (message.sections[RESTORATION_SECTION_KEY] === text) return message;
		changed = true;
		return { ...message, sections: { ...message.sections, [RESTORATION_SECTION_KEY]: text } };
	});
	// A rewrite that changes nothing is reported as no rewrite, so an attempt whose
	// requirement the pointer already named is passed through object-for-object and
	// the request the provider sees is the one preparation built.
	if (found) return changed ? next : undefined;
	if (text === null) return undefined;
	// The section is in no message of this attempt — preparation rendered none,
	// because no request was active when it read the pointer. The run resolves one
	// now, so it has to be carried after all, and it goes on the *leading* system
	// message: that is the only placement every provider renders, whereas a
	// trailing system message is an update for some APIs and is dropped by others.
	const leading = messages[0];
	if (leading !== undefined && leading.role === "system") {
		return [
			{ ...leading, sections: { ...(leading.sections ?? {}), [RESTORATION_SECTION_KEY]: text } },
			...messages.slice(1),
		];
	}
	return [
		{ role: "system", content: "", sections: { [RESTORATION_SECTION_KEY]: text }, timestamp: timestamp() },
		...messages,
	];
}

/**
 * The restoration text for the requirement the service's *pointer* names, or
 * `undefined` when no request is active yet — a conversation that has not been
 * given work has nothing to restore, and an empty section would only be noise.
 *
 * This is the section as the extension installs it, so preparation calls this
 * one. A run whose own requirement differs from the pointer's is corrected
 * afterwards by the service, through `withRestorationSection`.
 *
 * The raw text, not the framed one: `renderSections` wraps a tagged section as
 * `<key>\n...\n</key>` itself (`prompt.ts:45`), and the wrapped form is what the
 * harness stores in `message.sections`. Returning the frame here would nest it
 * inside its own copy, so this returns the body and `restorationSectionText` is
 * for the *stored* form the rewrite writes.
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
	return formatRestoration({
		requestId,
		requestVersion: request.requestVersion,
		text: request.text,
		materials: request.materials,
		questions: clarification?.questions ?? [],
		answers: clarification?.answers ?? [],
		resolutions: clarification?.resolutions ?? [],
		plans: ((service?.plans ?? []) as readonly PlanIndexEntry[]).filter((plan) => plan.requestId === requestId),
	});
}

/**
 * The section as the extension installs it. Keyed `main-restoration`; the key is
 * part of the rendered prompt, so it is stable and readable rather than derived.
 */
export const mainRestorationSection: PromptSection = {
	key: RESTORATION_SECTION_KEY,
	render: renderRestoration,
};
