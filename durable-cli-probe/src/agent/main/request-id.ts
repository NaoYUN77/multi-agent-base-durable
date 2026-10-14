// TASK-005.2 src/agent/main/request-id.ts
//
// Stable identifier derivation for the Main service. Pure, no IO.
//
// Two rules the contract asks for and this file makes mechanical:
//
//   1. **Ids the program generates are replay-safe.** A `requestId` that
//      contains `Date.now()` or a random value would make the same logical
//      submission a *different* submission on a retry after an interruption,
//      which is exactly what the Harness's submission dedup key exists to
//      prevent. Every id here is a pure function of what the caller already
//      knows (the request, the round, the plan version).
//   2. **The model does not name its own operation.** `clarificationOperationId`
//      is derived from the question the program persisted, never from anything
//      the model returns, so a model cannot re-enter a spent operation by
//      repeating an id it chose.

/**
 * The submission id of one version of the user's request. Pure.
 *
 * The version is part of the key, and it has to be: the Harness deduplicates
 * submissions by `requestId` within a conversation, so keying on the request id
 * alone would make a *restatement* — the user saying the same thing differently —
 * settle as a replay of the first input and never reach the model at all. The
 * version makes each restatement its own submission while keeping a replay of the
 * same version idempotent, which is what the dedup key is for.
 */
export function requestInputId(requestId: string, requestVersion: number): string {
	return `req-input:${requestId}:v${requestVersion}`;
}

/**
 * The request id of a clarification answer the application records for
 * `questionId`. Derived from the question, so answering the same question twice
 * is the *same* submission and is deduplicated by the Harness rather than
 * answered twice.
 */
export function answerInputId(questionId: string): string {
	return `answer-input:${questionId}`;
}

/**
 * The operation key of one clarification question. Stable per question, so a
 * replay of the tool call that asked it resumes the same operation instead of
 * asking a second time.
 */
export function clarificationOperationId(questionId: string): string {
	return `clarify:${questionId}`;
}

/**
 * The question id derived from the model's proposed question text and the round
 * it was asked in. The program owns the id: two identical questions asked in
 * different rounds are different questions, and the same question asked twice
 * within a round is one question.
 *
 * `round` is the caller's own round counter, not a timestamp, so the id is
 * reproducible after a restart.
 */
export function deriveQuestionId(round: number, question: string): string {
	return `q-r${round}-${stableSlug(question)}`;
}

/**
 * A short, collision-resistant slug of `text`: enough of the text to read in a
 * ledger, plus a 32-bit FNV-1a hash so two long questions with the same opening
 * words stay distinct. Deterministic across processes and platforms.
 */
export function stableSlug(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		// FNV-1a's 32-bit prime multiply, kept in unsigned range.
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	const readable = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	return `${readable === "" ? "q" : readable}-${hash.toString(16).padStart(8, "0")}`;
}
