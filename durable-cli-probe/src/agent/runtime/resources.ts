// TASK-005.4 src/agent/runtime/resources.ts
//
// Two pure decisions the admission path makes before it writes anything: what an
// item touches, and what one round may spend. Both are functions of declared
// data only, so an admission decision can be reproduced from a document read
// alone — which is what makes it reviewable after a crash.
//
// Nothing here does IO, and nothing here reads a clock: the caller passes `now`,
// so a test can pin the deadline and a replay can recompute the same one.

import type { RunConfig } from "../contracts/run-config.ts";
import type { EffectiveRoundBudget } from "../contracts/round-execution.ts";
import type { TaskBudget } from "../contracts/task-spec.ts";
import { UNKNOWN_WRITE, type ResourceClaim, type ToolEffects } from "../contracts/tool-effects.ts";

/**
 * Union the effects of every tool a task was granted into one claim.
 *
 * Deduplicated and sorted, so the same grant always produces byte-identical
 * claims: the claim is written into a slot document and compared on resume, and
 * a reordering would read as a different claim.
 *
 * Two readings worth stating:
 *   * **A task with no tools claims nothing.** It still runs (it may be pure
 *     reasoning), and it conflicts with nothing, so it shares capacity freely.
 *   * **One unknown write target makes the whole item exclusive.** The item's
 *     own writes are not separable from each other; if any of them cannot be
 *     named, none of the item's work can be promised not to touch something
 *     another item holds.
 */
export function deriveResourceClaim(tools: readonly { readonly effects: ToolEffects }[]): ResourceClaim {
	const reads = new Set<string>();
	const writes = new Set<string>();
	let exclusive = false;
	for (const tool of tools) {
		for (const read of tool.effects.reads) if (read !== UNKNOWN_WRITE) reads.add(read);
		for (const write of tool.effects.writes) {
			if (write === UNKNOWN_WRITE) exclusive = true;
			else writes.add(write);
		}
	}
	return { reads: [...reads].sort(), writes: [...writes].sort(), exclusive };
}

/**
 * True when two claims cannot hold capacity at the same time.
 *
 * read-read is allowed; a write conflicts with any access to the same target.
 * An exclusive claim conflicts with everything, including another exclusive one:
 * an item that cannot name its targets cannot promise to be alone with anything.
 */
export function claimsConflict(a: ResourceClaim, b: ResourceClaim): boolean {
	if (a.exclusive || b.exclusive) return true;
	const written = new Set(a.writes);
	for (const target of b.writes) if (written.has(target)) return true;
	// read-write in the other direction: a writes something b reads.
	const read = new Set(b.reads);
	for (const target of a.writes) if (read.has(target)) return true;
	// write-read: b writes something a reads.
	const otherWritten = new Set(b.writes);
	for (const target of a.reads) if (otherWritten.has(target)) return true;
	return false;
}

/**
 * Reconcile the task contract with the run config into the limits one round
 * actually runs under.
 *
 * The task can only **narrow** the run's policy, never widen it: a spec asking
 * for more tool calls than the run allows gets the run's number. The failure
 * allowance has no task-side field — `TaskSpec` carries no failed-call budget —
 * so the run config's value is the whole answer.
 *
 * The deadline is the earlier of two independent bounds: the run's per-round
 * timeout counted from now, and the task's own timeout counted from when the
 * task first started. Counting the task bound from `now` would let every rework
 * buy a fresh full timeout, so a task could run indefinitely by being revised.
 */
export function effectiveRoundBudget(task: TaskBudget, config: RunConfig, taskStartedAt: number, now: number): EffectiveRoundBudget {
	return {
		maxToolInvocations: Math.min(task.maxToolInvocations, config.maxToolInvocationsPerRound),
		maxFailedToolCalls: config.maxFailedToolCallsPerRound,
		deadlineAt: Math.min(now + config.roundTimeoutMs, taskStartedAt + task.timeoutMs),
		providerRetry: { maxRetries: config.providerRetry.maxRetries, backoffMs: config.providerRetry.backoffMs },
	};
}

/**
 * The canonical text of a run config, for the batch document's fingerprint.
 *
 * Sorted keys and no whitespace, so two configs with the same values always
 * produce the same string regardless of how the object was built. The fingerprint
 * is compared on resume to prove the batch is running under the limits it was
 * admitted with; a hash would work too, but a readable canonical form makes a
 * mismatch diagnosable without a second tool.
 */
export function runConfigFingerprint(config: RunConfig): string {
	return JSON.stringify({
		harnessRetry: { backoffMs: config.harnessRetry.backoffMs, maxRetries: config.harnessRetry.maxRetries },
		maxAttemptsPerOperation: config.maxAttemptsPerOperation,
		maxConcurrentSubAgents: config.maxConcurrentSubAgents,
		maxFailedToolCallsPerRound: config.maxFailedToolCallsPerRound,
		maxSubAgentsPerRequest: config.maxSubAgentsPerRequest,
		maxTechnicalRestarts: config.maxTechnicalRestarts,
		maxToolInvocationsPerRound: config.maxToolInvocationsPerRound,
		providerRetry: { backoffMs: config.providerRetry.backoffMs, maxRetries: config.providerRetry.maxRetries },
		roundTimeoutMs: config.roundTimeoutMs,
		schemaVersion: config.schemaVersion,
	});
}
