// TASK-005.2 src/agent/main/request-id.ts
//
// Stable identifier derivation for the Main service. Pure, no IO.
//
// Two rules the contract asks for and this file makes mechanical:
//
//   1. **Ids the program generates are replay-safe.** A `requestId` containing
//      `Date.now()` or a random value would make the same logical submission a
//      *different* submission on a retry after an interruption, which is exactly
//      what the Harness's submission dedup key exists to prevent. Every id here
//      is a pure function of what the caller already knows.
//   2. **An id that can collide is a lost message, not a saved request.** The
//      Harness deduplicates submissions by `requestId` within one conversation
//      and settles the duplicate as a replay — so if two *different* logical
//      inputs derive the same key, the second one is silently dropped and the
//      model never sees it. Every key below therefore carries the full identity
//      of the thing it submits: the request it belongs to, the version of that
//      request, and the specific question or revision. Identity that is not in
//      the key is identity that gets lost.

/**
 * The submission id of one version of the user's request.
 *
 * The version is part of the key: the Harness dedups by `requestId` per
 * conversation, so keying on the request id alone would make a *restatement*
 * settle as a replay of the first input and never reach the model.
 */
export function requestInputId(requestId: string, requestVersion: number): string {
	return `req-input:${requestId}:v${requestVersion}`;
}

/**
 * The submission id of a user's answer to one question.
 *
 * Both the request and the question are in the key, and both are load-bearing:
 * a question id is only unique *within* a request (two requests may ask the same
 * words), and one question may legitimately be answered more than once when the
 * first answer was not sufficient. `revision` counts those answers, so a repeat
 * of the *same* logical answer dedups while a genuine follow-up does not.
 */
export function answerInputId(requestId: string, questionId: string, revision: number): string {
	return `answer-input:${requestId}:${questionId}:r${revision}`;
}

/**
 * The submission id of one queued input.
 *
 * The key is the input's own *logical* identity: the request it belongs to, that
 * request's version, and a slug of what was said. All three are load-bearing:
 *
 *   * The request and its version keep two different requests that happen to say
 *     the same words from collapsing into one — the bug that keying on the text
 *     alone produced.
 *   * The text keeps two genuinely different inputs to the *same* request from
 *     collapsing into one.
 *   * Nothing else — in particular not a clock. An earlier version included
 *     `queuedAt`, which made the same logical input a *different* submission on a
 *     retry: exactly the replay the Harness's dedup key exists to catch.
 */
export function queuedInputId(requestId: string, requestVersion: number, text: string): string {
	return `queued:${requestId}:v${requestVersion}:${stableSlug(text)}`;
}

/**
 * A question id, derived from the request it belongs to and the round it was
 * asked in. The program owns the id: the same question asked under two different
 * requests is two questions, and two requests that ask the same words must not
 * share one.
 *
 * The separator is a dot, not a colon: a question id is persisted in the
 * clarification document, and the shared contract's stable-id rule is
 * `^[a-z0-9][a-z0-9._-]{0,127}$` — a colon would make the id invalid and the whole
 * state unreadable.
 */
export function deriveQuestionId(requestId: string, round: number, question: string): string {
	return `q.${requestId}.r${round}.${stableSlug(question)}`;
}

/**
 * The request id when the caller did not name one.
 *
 * Derived from the requirement's own words, never from the clock. A
 * clock-derived id (the shape this replaced) makes the same logical submission a
 * *different* submission when it is retried after an interruption — so a retry
 * whose reply was lost becomes a second requirement with its own document and
 * its own plan index, instead of settling as the replay the Harness's dedup key
 * exists to catch (rule 1).
 *
 * The trade-off is explicit and is the caller's to manage: with no `requestId`
 * given, two *different* requirements told in exactly the same words are one
 * requirement — the second submission restates it at the next version. Naming
 * the two is what a caller does when they are two.
 */
export function derivedRequestId(text: string): string {
	return `req-${stableSlug(text)}`;
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
