// Issue #3 src/article/submission-results.ts
//
// Deciding which tool results belong to *this* submission.
//
// The bug this exists to prevent: a conversation's transcript accumulates. If the
// CLI collects every `pi.tool-result` in the root conversation and calls the run
// successful when any of them is not an error, then a later run that does nothing
// at all will "succeed" by borrowing an earlier run's result. The same mistake
// makes an earlier failure poison a later success.
//
// The fix is to use the submission's own boundaries. `SubmissionRecord` carries
// `entry` (the user input it was placed with) and `answer` (the entry it settled
// on), so the entries belonging to a submission are exactly the ones between them.
// That range is stable across a replay too: replaying a completed `requestId`
// returns the *same* record, so the original results are still located.
//
// Comparison is by position in the transcript, not by raw id ordering, so this
// stays correct whatever an `EntryId` happens to be.

/** The fields this module needs from a settled submission. */
export interface SubmissionBoundary {
	readonly status: string;
	readonly entry: unknown;
	readonly answer?: unknown;
}

/** The fields this module needs from a transcript entry. */
export interface ScopedEntry {
	readonly id: unknown;
	readonly kind: string;
}

/** Why a submission's tool results could not be located. */
export type ScopeProblem =
	| { readonly reason: "not_done"; readonly status: string }
	| { readonly reason: "entry_missing" }
	| { readonly reason: "answer_missing" };

/**
 * The entries committed between a submission's input and its answer.
 *
 * Returns a problem instead of guessing when the boundaries cannot be found: a
 * wrong range would either hide a real tool call or adopt someone else's.
 */
export function entriesOfSubmission<T extends ScopedEntry>(
	entries: readonly T[],
	boundary: SubmissionBoundary,
): { readonly entries: readonly T[] } | { readonly problem: ScopeProblem } {
	if (boundary.status !== "done") {
		return { problem: { reason: "not_done", status: boundary.status } };
	}

	const from = entries.findIndex((entry) => entry.id === boundary.entry);
	if (from === -1) return { problem: { reason: "entry_missing" } };

	if (boundary.answer === undefined) return { problem: { reason: "answer_missing" } };
	const to = entries.findIndex((entry) => entry.id === boundary.answer);
	if (to === -1 || to < from) return { problem: { reason: "answer_missing" } };

	// Exclusive of both ends: `entry` is the user input, `answer` the final reply.
	// Tool results sit strictly between them.
	return { entries: entries.slice(from + 1, to) };
}

/**
 * The tool results of one submission.
 *
 * An empty array means the model never called a tool during this submission —
 * which is a failure, not a reason to look at older entries.
 */
export function toolResultsOfSubmission<T extends ScopedEntry>(
	entries: readonly T[],
	boundary: SubmissionBoundary,
): { readonly results: readonly T[] } | { readonly problem: ScopeProblem } {
	const scoped = entriesOfSubmission(entries, boundary);
	if ("problem" in scoped) return scoped;
	return { results: scoped.entries.filter((entry) => entry.kind === "pi.tool-result") };
}

/** A short, operator-readable explanation of a scope problem. */
export function describeScopeProblem(problem: ScopeProblem): string {
	switch (problem.reason) {
		case "not_done":
			return `submission settled as "${problem.status}", not "done"`;
		case "entry_missing":
			return "the submission's input entry is not in the transcript";
		case "answer_missing":
			return "the submission's answer entry is not in the transcript";
	}
}
