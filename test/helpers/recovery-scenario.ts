// TASK-005.4 test/helpers/recovery-scenario.ts
//
// The one fixture both halves of a crash-recovery test share: the child process
// that gets killed writes the state, and the test that reopens the database
// finishes it. They have to agree on the plan, the task contract, the run
// configuration, the Main script and the child's answers — otherwise a passing
// recovery would only prove that two different systems each did something.
//
// Every number is stated here. Nothing in this file is a product default.

import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { BatchSystem, ChildRouter, MainStep } from "./batch-system.ts";
import {
	childAnswer,
	flattenRequest,
	openBatchSystem,
	runConfigOf,
	submittedTaskId,
	taskSpecOf,
	transcriptRouter,
} from "./batch-system.ts";

export const RECOVERY_PLAN_ID = "plan-recovery";
export const RECOVERY_TASK_ID = "task-recovery";
export const RECOVERY_MATERIAL = "MATERIAL-R: alpha beta alpha";
export const RECOVERY_ANSWER = "the material holds three words: alpha twice and beta once";
/** The Main request id, which is also the request quota document's key. */
export const RECOVERY_REQUEST_ID = "req-batch";
/** The text Main is given; it is asserted back in the transcript so a resumed run is the same run. */
export const RECOVERY_INPUT = "run the recovery scenario";

/** The canonical submission id of the task's first round. */
export const RECOVERY_ROUND_REQUEST = `multiagent-round:${RECOVERY_TASK_ID}:1`;
/** The result document the round must write exactly once. */
export const RECOVERY_RESULT_ID = `res.${RECOVERY_TASK_ID}.r1`;

/**
 * The four states AC-06 names. Each is a committed state of one round:
 *
 * - `claim-not-submitted` — the round holds its slot and its attempt is open,
 *   but the child conversation does not exist yet;
 * - `created-not-input` — the child conversation exists and is configured, but
 *   the round's input has not been submitted;
 * - `result-not-returned` — the child answered (the submission is `done`) but
 *   no result document exists yet, so the outcome is not back with Main;
 * - `retry-wait` — the round is parked between a retryable provider failure and
 *   its retry, with the retry already charged.
 */
export type RecoveryBoundary = "claim-not-submitted" | "created-not-input" | "result-not-returned" | "retry-wait";

export const RECOVERY_BOUNDARIES: readonly RecoveryBoundary[] = [
	"claim-not-submitted",
	"created-not-input",
	"result-not-returned",
	"retry-wait",
];

/**
 * The four review boundaries of TASK-005.7 (AC-04). They live in this fixture
 * because they reuse the same plan, task and run configuration; what differs is
 * the Main script and the child, which are chosen by the runner's `--review`.
 *
 * `review-pending` is the kill *before* the review commit: the round has settled
 * at `awaiting_review` and no decision exists yet. The reopening test is the one
 * that decides a task that had none.
 */
export type ReviewBoundary = "review-pending" | "review-accepted" | "rework-decided" | "rework-settled";

export const REVIEW_BOUNDARIES: readonly ReviewBoundary[] = [
	"review-pending",
	"review-accepted",
	"rework-decided",
	"rework-settled",
];

/** The feedback the review fixture sends back, and the child's marker for it. */
export const REVIEW_FEEDBACK = "name the second count as well";
/** The child's round-2 answer, which is what proves the rework ran in the same task. */
export const REVIEW_REWORK_ANSWER = "the material holds three words: alpha twice and beta once, counted twice";

/**
 * The run configuration every recovery run uses.
 *
 * The values are the fixture's: two concurrent sub-agents, two attempts per
 * operation, one technical restart, one provider retry. `providerRetry.backoffMs`
 * is deliberately long — it is what makes `retry-wait` a state a process can be
 * killed *in* rather than merely pass through, since the round parks in a real
 * timer for that long.
 */
export function recoveryRunConfig() {
	return runConfigOf({
		schemaVersion: 1,
		maxConcurrentSubAgents: 2,
		maxSubAgentsPerRequest: 4,
		maxToolInvocationsPerRound: 4,
		maxFailedToolCallsPerRound: 2,
		maxAttemptsPerOperation: 2,
		maxTechnicalRestarts: 1,
		roundTimeoutMs: 10_000,
		providerRetry: { maxRetries: 1, backoffMs: 2_000 },
		harnessRetry: { maxRetries: 0, backoffMs: 0 },
	});
}

/** The saved contract the round is authorized against. */
export function recoverySpec() {
	return taskSpecOf({
		id: RECOVERY_TASK_ID,
		skillId: "material-summary",
		requestedTools: ["text_stats"],
		materials: [{ id: "material-1", content: RECOVERY_MATERIAL, source: "user note" }],
		budget: { maxToolInvocations: 3, maxAttempts: 2, maxTechnicalRestarts: 1, timeoutMs: 8_000 },
	});
}

/**
 * Main saves the plan, dispatches the one task, and then answers.
 *
 * The decision is read from the *transcript*, not from a turn counter. A reopened
 * process starts its router again from the beginning, so a counter-based script
 * would see the resumed transcript as turn 0 and dispatch a second batch on top
 * of the one being recovered — a second execution and a second instance, which is
 * exactly what AC-06 forbids. The two markers below are the tools' own result
 * text, which the transcript carries once each call has settled.
 */
export function recoveryScript(flat: string): MainStep {
	if (flat.includes(`dispatched plan ${RECOVERY_PLAN_ID}`)) return [];
	if (flat.includes(`saved plan ${RECOVERY_PLAN_ID}`)) {
		return [{ name: "dispatch_tasks", arguments: { planId: RECOVERY_PLAN_ID, version: 1, tasks: [recoverySpec()] } }];
	}
	return [{ name: "save_plan", arguments: { planId: RECOVERY_PLAN_ID, goals: ["run the recovery scenario"], taskIds: [RECOVERY_TASK_ID] } }];
}

/**
 * The child's model.
 *
 * With `failFirst`, its first call is a retryable provider failure (429), which
 * is what parks the round in `retry_wait`. The killed process passes `true`; the
 * reopening test passes `false`, because the provider being flaky once is the
 * device that produced the state, not a property the recovery has to survive —
 * the resumed round's retry is a fresh request and is expected to succeed.
 *
 * @param options.failFirst - answer the first request with a 429 instead of work.
 * @returns a router for requests whose transcript carries a `# Task` line.
 * @throws when the router is handed a Main request, which would mean the wiring
 *   is wrong rather than the child misbehaving.
 */
export function recoveryChildRouter(options: { readonly failFirst: boolean }): ChildRouter {
	let calls = 0;
	return (request) => {
		const flat = flattenRequest(request.messages);
		if (submittedTaskId(flat) !== RECOVERY_TASK_ID) throw new Error("recovery child router saw a request that is not the recovery task");
		calls += 1;
		if (options.failFirst && calls === 1) {
			return fauxAssistantMessage([fauxText("busy")], { stopReason: "error", errorMessage: "429 too many requests" });
		}
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: RECOVERY_MATERIAL, marker: "R" }, { id: "recovery-stats" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(childAnswer(RECOVERY_ANSWER))]);
	};
}

/**
 * Open the whole stack over a database that may already hold an interrupted run.
 *
 * `openBatchSystem` resumes interrupted tasks after the batch runtime and the
 * Main service are installed, so the returned system is already recovering:
 * callers that reopen a killed database wait for the outcome rather than
 * driving Main again.
 *
 * @param options.databasePath - the file the killed process left behind.
 * @param options.failFirst - see `recoveryChildRouter`; defaults to `false`.
 * @returns the opened system, with recovery running.
 */
export async function openRecoverySystem(options: {
	readonly databasePath: string;
	readonly failFirst?: boolean;
	readonly review?: ReviewBoundary;
	/**
	 * Whether this process makes the review decision once the round has settled.
	 *
	 * The process killed at `review-pending` must not decide: its whole point is
	 * that the decision has not been committed when it dies. Every other process —
	 * and every reopening one — does decide.
	 */
	readonly decide?: boolean;
}): Promise<BatchSystem> {
	const decide = options.decide ?? true;
	return await openBatchSystem({
		databasePath: options.databasePath,
		router: transcriptRouter(
			(flat) => (options.review === undefined ? recoveryScript(flat) : reviewScript(flat, options.review, decide)),
			options.review === undefined ? recoveryChildRouter({ failFirst: options.failFirst ?? false }) : reviewChildRouter(),
		),
		runConfig: recoveryRunConfig(),
	});
}

/**
 * Main's script for the review boundaries: dispatch, then decide.
 *
 * Read from the transcript, like `recoveryScript`, and for the same reason — a
 * reopened process must not re-dispatch or re-decide. The decision is issued only
 * once the dispatch's own result line is in the transcript, and only once, because
 * the tool's result text is what carries the decision back.
 *
 * @param flat - the flattened transcript of this provider request.
 * @param boundary - which decision the fixture makes: `review-accepted` accepts,
 *   the two rework boundaries reject with `REVIEW_FEEDBACK`.
 * @param decide - when `false`, this process stops after the dispatch, so the
 *   review decision is left for the process that reopens the database.
 * @returns the tool calls this request should make; `[]` is the final answer.
 */
export function reviewScript(flat: string, boundary: ReviewBoundary, decide = true): MainStep {
	if (flat.includes(`dispatched plan ${RECOVERY_PLAN_ID}`)) {
		if (!decide) return [];
		if (flat.includes("reworked task ")) return [];
		if (flat.includes("accepted task ")) return [];
		const decision = boundary === "review-accepted" || boundary === "review-pending" ? "accept" : "rework";
		return [
			{
				name: "review_task",
				arguments: {
					taskId: RECOVERY_TASK_ID,
					round: 1,
					decision,
					...(decision === "rework" ? { feedback: REVIEW_FEEDBACK } : {}),
				},
			},
		];
	}
	if (flat.includes(`saved plan ${RECOVERY_PLAN_ID}`)) {
		return [{ name: "dispatch_tasks", arguments: { planId: RECOVERY_PLAN_ID, version: 1, tasks: [recoverySpec()] } }];
	}
	return [{ name: "save_plan", arguments: { planId: RECOVERY_PLAN_ID, goals: ["run and review the recovery scenario"], taskIds: [RECOVERY_TASK_ID] } }];
}

/**
 * The child for the review boundaries: the same answer, but round 2 is a rework
 * and must be recognisable in the transcript.
 *
 * A rework's submission carries the reviewer's feedback, so the router branches on
 * that text rather than on a counter — the answer a recovered round gives has to be
 * the answer that round is supposed to give, whether or not this process ran round 1.
 */
export function reviewChildRouter(): ChildRouter {
	return (request) => {
		const flat = flattenRequest(request.messages);
		if (submittedTaskId(flat) !== RECOVERY_TASK_ID) throw new Error("review child router saw a request that is not the recovery task");
		const last = [...request.messages].reverse().find((message) => message.role !== "system");
		if (last?.role !== "toolResult") {
			return fauxAssistantMessage([fauxToolCall("text_stats", { text: RECOVERY_MATERIAL, marker: "R" }, { id: "review-stats" })], {
				stopReason: "toolUse",
			});
		}
		return fauxAssistantMessage([fauxText(childAnswer(flat.includes(REVIEW_FEEDBACK) ? REVIEW_REWORK_ANSWER : RECOVERY_ANSWER))]);
	};
}
