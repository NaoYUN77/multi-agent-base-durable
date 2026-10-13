// TASK-005.1 src/agent/contracts/clarification.ts
//
// The clarification contract: questions the main agent asks the user, the answers
// that come back, and the resolutions that close a question.
//
// Two authorization rules this file enforces, both as *write boundaries* rather
// than as string labels (contract §"Main Agent 合同"):
//
//   1. **The answer is written by the application, never by the model.**
//      `composeUserAnswer` stamps `source: "application"` from the write call
//      itself; the payload it accepts has no `source` field to claim, so a
//      model-authored JSON that *says* it is the application is refused instead
//      of being believed.
//   2. **A model may only resolve a question against something that already
//      exists** — a recorded answer, or the user's original input — and
//      `resolvedBy` is stamped by the composer, never read from the payload.
//
// A third rule, about meaning rather than authorization: receiving an answer is
// not the same as being satisfied with it. `UserAnswer.sufficient` is the
// application's own judgement, and a question stays open until it is satisfied
// or resolved on the original input. A vague answer ("I am not sure, explain the
// options") therefore keeps the task blocked instead of unblocking it.

import { Violations, readCount, readEnum, readNoUnknownKeys, readObject, readOptionalStableId, readSchemaVersion, readStableId, readString, readStringList } from "./validate.ts";
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
 * A user answer, as the *stored document* holds it. `source` is only ever
 * `"application"`: it is stamped by `composeUserAnswer`, and the validator
 * refuses any other value, so a payload that merely claims the label cannot be
 * persisted in this shape.
 */
export type UserAnswer = {
	readonly questionId: string;
	readonly text: string;
	readonly source: "application";
	/**
	 * The application's judgement that this answer settles the question. Absent
	 * means "not judged yet", so the question still blocks.
	 */
	readonly sufficient: boolean;
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
const ANSWER_FIELDS: readonly string[] = ["questionId", "text", "source", "sufficient", "answeredAt", "inputEntryId"];
const RESOLUTION_FIELDS: readonly string[] = ["questionId", "resolvedAt", "resolvedBy", "basis"];

/** What the application may hand to the answer writer. No `source`, no `actor`. */
export type UserAnswerInput = {
	readonly questionId: string;
	readonly text: string;
	/** The application's judgement, not the model's. */
	readonly sufficient: boolean;
	readonly inputEntryId?: string;
};

/** The application's stamp, carried by the write call. */
export type ApplicationStamp = { readonly at: number };

/** What a model may submit when it marks a question resolved. */
export type ModelResolutionInput = {
	readonly questionId: string;
	readonly basis: ResolutionBasis;
};

function readQuestion(value: unknown, path: string, collect: Violations): ClarificationQuestion | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, QUESTION_FIELDS);
	const questionId = readStableId(holder, "questionId", `${path}.questionId`, collect);
	const question = readString(holder, "question", `${path}.question`, collect);
	const reason = readString(holder, "reason", `${path}.reason`, collect);
	const askedAt = readCount(holder, "askedAt", `${path}.askedAt`, collect);
	const blockingScope = readStringList(holder.blockingScope, `${path}.blockingScope`, collect);
	if (questionId === undefined || question === undefined || reason === undefined || askedAt === undefined) return undefined;
	return { questionId, question, reason, blockingScope, askedAt };
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
	// Absent is "not judged yet" (the default: still blocking), not true.
	const sufficient = holder.sufficient === undefined ? false : readBooleanField(holder, "sufficient", `${path}.sufficient`, collect);
	const answeredAt = readCount(holder, "answeredAt", `${path}.answeredAt`, collect);
	const inputEntryId = readOptionalStableId(holder, "inputEntryId", `${path}.inputEntryId`, collect);
	if (questionId === undefined || text === undefined || source === undefined || sufficient === undefined || answeredAt === undefined) return undefined;
	return {
		questionId,
		text,
		source: "application",
		sufficient,
		answeredAt,
		...(inputEntryId === undefined ? {} : { inputEntryId }),
	};
}

function readBooleanField(holder: Record<string, unknown>, field: string, path: string, collect: Violations): boolean | undefined {
	const value = holder[field];
	if (typeof value !== "boolean") {
		collect.add("type_boolean", path, "must be a boolean");
		return undefined;
	}
	return value;
}

function readBasis(value: unknown, path: string, collect: Violations): ResolutionBasis | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, ["kind", "answerAt", "detail"]);
	const kind = readEnum(holder, "kind", `${path}.kind`, collect, ["answer", "original_input"] as const);
	if (kind === "answer") {
		const answerAt = readCount(holder, "answerAt", `${path}.answerAt`, collect);
		if (answerAt === undefined) return undefined;
		return { kind, answerAt };
	}
	if (kind === "original_input") {
		const detail = readString(holder, "detail", `${path}.detail`, collect);
		if (detail === undefined) return undefined;
		return { kind, detail };
	}
	return undefined;
}

function readResolution(value: unknown, path: string, collect: Violations): QuestionResolution | undefined {
	const holder = readObject(value, path, collect);
	if (holder === undefined) return undefined;
	readNoUnknownKeys(holder, path, collect, RESOLUTION_FIELDS);
	const questionId = readStableId(holder, "questionId", `${path}.questionId`, collect);
	const resolvedAt = readCount(holder, "resolvedAt", `${path}.resolvedAt`, collect);
	const resolvedBy = readEnum(holder, "resolvedBy", `${path}.resolvedBy`, collect, ["application", "model"] as const);
	const basis = readBasis(holder.basis, `${path}.basis`, collect);
	if (questionId === undefined || resolvedAt === undefined || resolvedBy === undefined || basis === undefined) return undefined;
	return { questionId, resolvedAt, resolvedBy, basis };
}

/**
 * Validate a clarification state as a whole, including its cross-references:
 * every answer and every resolution must reference a question that was asked, a
 * resolution of kind `answer` must cite an answer that was recorded, and no
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

/**
 * Compose a user answer for the document. The *application* is the only writer:
 * `source` is stamped here, so the payload it accepts cannot carry one, and a
 * model-crafted JSON that claims to be the application has nowhere to put the
 * claim. Performs no IO; the caller persists the result in its own commit.
 */
export function composeUserAnswer(input: unknown, stamp: ApplicationStamp): ContractValidation<UserAnswer> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as UserAnswer);
	// The write boundary itself: what a model payload is not allowed to carry.
	readNoUnknownKeys(holder, "$", collect, ["questionId", "text", "sufficient", "inputEntryId"]);
	const questionId = readStableId(holder, "questionId", "$.questionId", collect);
	const text = readString(holder, "text", "$.text", collect);
	const sufficient = holder.sufficient === undefined ? false : readBooleanField(holder, "sufficient", "$.sufficient", collect);
	const inputEntryId = readOptionalStableId(holder, "inputEntryId", "$.inputEntryId", collect);
	if (questionId === undefined || text === undefined || sufficient === undefined) return collect.finish(undefined as unknown as UserAnswer);
	return collect.finish({
		questionId,
		text,
		source: "application",
		sufficient,
		answeredAt: stamp.at,
		...(inputEntryId === undefined ? {} : { inputEntryId }),
	});
}

/**
 * Compose a model's resolution attempt. `resolvedBy: "model"` is stamped here, so
 * a model payload cannot claim the application's authority, and the payload type
 * has no `answers` field to smuggle one through. The basis must still name a
 * recorded answer or the original input — `validateClarificationState` is what
 * checks that the named answer actually exists.
 */
export function composeModelResolution(input: unknown, stamp: { readonly at: number }): ContractValidation<QuestionResolution> {
	const collect = new Violations();
	const holder = readObject(input, "$", collect);
	if (holder === undefined) return collect.finish(undefined as unknown as QuestionResolution);
	readNoUnknownKeys(holder, "$", collect, ["questionId", "basis"]);
	const questionId = readStableId(holder, "questionId", "$.questionId", collect);
	const basis = readBasis(holder.basis, "$.basis", collect);
	if (questionId === undefined || basis === undefined) return collect.finish(undefined as unknown as QuestionResolution);
	return collect.finish({ questionId, resolvedBy: "model", resolvedAt: stamp.at, basis });
}

/**
 * Questions that still block work.
 *
 * A question stops blocking when it has a resolution whose basis holds up: a
 * recorded answer the **application marked sufficient**, or a resolution on the
 * user's original input. Merely having *some* answer is not enough — that is the
 * "receiving an answer is not semantic sufficiency" rule made mechanical.
 */
export function openQuestionIds(state: ClarificationState): readonly string[] {
	const answerByQuestion = new Map(state.answers.map((answer) => [answer.questionId, answer]));
	const satisfying = new Map<string, ResolutionBasis>();
	for (const resolution of state.resolutions) satisfying.set(resolution.questionId, resolution.basis);
	return state.questions
		.filter((question) => {
			const basis = satisfying.get(question.questionId);
			if (basis === undefined) return true;
			if (basis.kind === "original_input") return false;
			const answer = answerByQuestion.get(question.questionId);
			return answer === undefined || !answer.sufficient;
		})
		.map((question) => question.questionId);
}
