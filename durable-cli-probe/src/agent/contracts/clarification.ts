// TASK-005.1 src/agent/contracts/clarification.ts
//
// The clarification contract: questions the main agent asks the user, the
// answers that come back, and the resolutions that close a question.
//
// The authorization rule this file exists to enforce (contract §"Main Agent
// 合同"): **the answer is written by the application, never by the model**. A
// model may mark a question resolved, but only by pointing at something that
// already exists — either a real recorded answer, or the user's original input,
// with a reason. It cannot invent an answer, and it cannot point at an answer
// that was never given.

import { Violations, readCount, readEnum, readNoUnknownKeys, readObject, readOptionalStableId, readSchemaVersion, readStableId, readString } from "./validate.ts";
import type { ContractValidation } from "./errors.ts";

export const CLARIFICATION_SCHEMA_VERSION = 1;

/** One question the main agent asked. Asking is a tool call; it ends the model round. */
export type ClarificationQuestion = {
	readonly questionId: string;
	readonly question: string;
	/** Why this is being asked, from the model. Kept so a reviewer can judge necessity. */
	readonly reason: string;
	/** What stays blocked while the question is open. */
	readonly blockingScope: string[];
	readonly askedAt: number;
};

/**
 * A user answer. `source: "application"` is not a formality: it is the only
 * value the validator accepts, so an answer copied from model text cannot be
 * persisted in this shape at all.
 */
export type UserAnswer = {
	readonly questionId: string;
	readonly text: string;
	readonly source: "application";
	readonly answeredAt: number;
	/** The entry id of the answer, when it arrived as a new input in the main conversation. */
	readonly inputEntryId?: string;
};

export type ResolutionBasis = { readonly kind: "answer"; readonly answerAt: number } | { readonly kind: "original_input"; readonly detail: string };

/** Who closed a question, and on what basis. */
export type QuestionResolution = {
	readonly questionId: string;
	readonly resolvedAt: number;
	readonly resolvedBy: "application" | "model";
	/** Mandatory for every resolution, whoever made it. */
	readonly basis: ResolutionBasis;
};

export type ClarificationState = {
	readonly schemaVersion: number;
	readonly questions: ClarificationQuestion[];
	readonly answers: UserAnswer[];
	readonly resolutions: QuestionResolution[];
};

const QUESTION_FIELDS: readonly string[] = ["questionId", "question", "reason", "blockingScope", "askedAt"];
const ANSWER_FIELDS: readonly string[] = ["questionId", "text", "source", "answeredAt", "inputEntryId"];
const RESOLUTION_FIELDS: readonly string[] = ["questionId", "resolvedAt", "resolvedBy", "basis"];

function readQuestion(value: unknown, path: string, collect: Violations): ClarificationQuestion | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, QUESTION_FIELDS);
	const questionId = readStableId(holder, "questionId", `${path}.questionId`, collect);
	const question = readString(holder, "question", `${path}.question`, collect);
	const reason = readString(holder, "reason", `${path}.reason`, collect);
	const askedAt = readCount(holder, "askedAt", `${path}.askedAt`, collect);
	if (questionId === undefined || question === undefined || reason === undefined || askedAt === undefined) return undefined;
	return {
		questionId,
		question,
		reason,
		blockingScope: (holder.blockingScope as readonly unknown[] | undefined)?.map(String) ?? [],
		askedAt,
	};
}

function readAnswer(value: unknown, path: string, collect: Violations): UserAnswer | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ANSWER_FIELDS);
	const questionId = readStableId(holder, "questionId", `${path}.questionId`, collect);
	const text = readString(holder, "text", `${path}.text`, collect);
	const source = readString(holder, "source", `${path}.source`, collect);
	// The authorization rule, enforced by refusal rather than by convention.
	if (source !== undefined && source !== "application") {
		collect.add("answer_source_forbidden", `${path}.source`, "an answer may only be recorded by the application");
	}
	const answeredAt = readCount(holder, "answeredAt", `${path}.answeredAt`, collect);
	const inputEntryId = readOptionalStableId(holder, "inputEntryId", `${path}.inputEntryId`, collect);
	if (questionId === undefined || text === undefined || source === undefined || answeredAt === undefined) return undefined;
	return {
		questionId,
		text,
		source: "application",
		answeredAt,
		...(inputEntryId === undefined ? {} : { inputEntryId }),
	};
}

function readResolution(value: unknown, path: string, collect: Violations): QuestionResolution | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, RESOLUTION_FIELDS);
	const questionId = readStableId(holder, "questionId", `${path}.questionId`, collect);
	const resolvedAt = readCount(holder, "resolvedAt", `${path}.resolvedAt`, collect);
	const resolvedBy = readEnum(holder, "resolvedBy", `${path}.resolvedBy`, collect, ["application", "model"] as const);
	const basisHolder = readObject(holder.basis, `${path}.basis`, collect);
	if (basisHolder === undefined) return undefined;
	readNoUnknownKeys(basisHolder, `${path}.basis`, collect, ["kind", "answerAt", "detail"]);
	const kind = readEnum(basisHolder, "kind", `${path}.basis.kind`, collect, ["answer", "original_input"] as const);
	const basis: ResolutionBasis | undefined =
		kind === "answer"
			? { kind, answerAt: readCount(basisHolder, "answerAt", `${path}.basis.answerAt`, collect) ?? -1 }
			: kind === "original_input"
				? { kind, detail: readString(basisHolder, "detail", `${path}.basis.detail`, collect) ?? "" }
				: undefined;
	if (questionId === undefined || resolvedAt === undefined || resolvedBy === undefined || basis === undefined) return undefined;
	return { questionId, resolvedAt, resolvedBy, basis };
}

/**
 * Validate a clarification state as a whole, including its cross-references:
 * every answer and every resolution must reference a question that was asked,
 * a resolution of kind `answer` must cite an answer that was recorded, and no
 * question may be answered or resolved twice.
 */
export function validateClarificationState(input: unknown): ContractValidation<ClarificationState> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as ClarificationState);
	readNoUnknownKeys(holder, "$", collect, ["schemaVersion", "questions", "answers", "resolutions"]);
	const schemaVersion = readSchemaVersion(holder, "$", collect, [CLARIFICATION_SCHEMA_VERSION]);
	const questions: ClarificationQuestion[] = [];
	if (Array.isArray(holder.questions)) {
		holder.questions.forEach((entry, index) => {
			const question = readQuestion(entry, `$.questions[${index}]`, collect);
			if (question !== undefined) questions.push(question);
		});
	} else if (holder.questions !== undefined) collect.add("type_array", "$.questions", "must be an array when present");
	const answers: UserAnswer[] = [];
	if (Array.isArray(holder.answers)) {
		holder.answers.forEach((entry, index) => {
			const answer = readAnswer(entry, `$.answers[${index}]`, collect);
			if (answer !== undefined) answers.push(answer);
		});
	} else if (holder.answers !== undefined) collect.add("type_array", "$.answers", "must be an array when present");
	const resolutions: QuestionResolution[] = [];
	if (Array.isArray(holder.resolutions)) {
		holder.resolutions.forEach((entry, index) => {
			const resolution = readResolution(entry, `$.resolutions[${index}]`, collect);
			if (resolution !== undefined) resolutions.push(resolution);
		});
	} else if (holder.resolutions !== undefined) collect.add("type_array", "$.resolutions", "must be an array when present");

	const questionIds = new Set(questions.map((question) => question.questionId));
	if (questionIds.size !== questions.length) collect.add("question_duplicate_id", "$.questions", "a question id appears more than once");
	const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
	if (answerByQuestion.size !== answers.length) collect.add("answer_duplicate", "$.answers", "a question may only be answered once");
	const resolvedIds = new Set<string>();
	for (const answer of answers) {
		if (!questionIds.has(answer.questionId)) collect.add("answer_unknown_question", "$.answers", `no question ${answer.questionId} was asked`);
	}
	for (const resolution of resolutions) {
		if (!questionIds.has(resolution.questionId)) collect.add("resolution_unknown_question", "$.resolutions", `no question ${resolution.questionId} was asked`);
		if (resolvedIds.has(resolution.questionId)) collect.add("resolution_duplicate", "$.resolutions", `question ${resolution.questionId} is resolved twice`);
		resolvedIds.add(resolution.questionId);
		if (resolution.basis.kind === "answer") {
			const answer = answerByQuestion.get(resolution.questionId);
			if (answer === undefined) {
				collect.add("resolution_answer_missing", "$.resolutions", `question ${resolution.questionId} has no recorded answer to resolve on`);
			} else if (answer.answeredAt !== resolution.basis.answerAt) {
				collect.add("resolution_answer_mismatch", "$.resolutions", `resolution cites answerAt ${resolution.basis.answerAt}, recorded answer is ${answer.answeredAt}`);
			}
		}
	}
	if (schemaVersion === undefined) return collect.finish(undefined as unknown as ClarificationState);
	return collect.finish({ schemaVersion, questions, answers, resolutions });
}

/** Question ids that still block work: unresolved and unanswered. */
export function openQuestionIds(state: ClarificationState): readonly string[] {
	const answered = new Set(state.answers.map((answer) => answer.questionId));
	const resolved = new Set(state.resolutions.map((resolution) => resolution.questionId));
	return state.questions.filter((question) => !answered.has(question.questionId) && !resolved.has(question.questionId)).map((question) => question.questionId);
}
