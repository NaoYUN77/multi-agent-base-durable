// TASK-005.4 src/agent/runtime/child.ts
//
// The child-side budget gate: a wrapper applied to every granted business tool,
// and the extension that installs it.
//
// Why a wrapper is not enough on its own, traced to the pinned Durable source:
//
//   * Arguments are validated **before** `execute()` (`harness/tool.ts:230-252`),
//     so a schema refusal settles a result the wrapper never sees.
//   * Every call of a parallel round is admitted in **one commit**
//     (`generation.ts:574-589`), so no per-call gate can stop a sibling that was
//     admitted at the same moment.
//   * `terminate` fires only when *every* slot of the round asks
//     (`generation.ts:621-624`), which a round containing an `invalid_arguments`
//     result can never satisfy — so it is not a budget remedy.
//
// The one mechanism that makes a per-call gate meaningful without changing Pi
// core is `ToolRegistration.executionMode: "sequential"`: one sequential tool
// makes its whole round sequential (`generation.ts:562-567`), and the tools phase
// starts the next call only after the previous one settles
// (`generation.ts:235-251`). The wrapper therefore forces it, so every call is
// validated and settled before the next is admitted and the wrapper can read
// what the round has already spent.
//
// The cost, stated rather than hidden: tool calls inside one child round run one
// at a time. The parallelism issue #19 asks for is across tasks (sub-agents),
// which this does not touch.
//
// A refusal is returned as an error result, never thrown: Durable renders an
// `isError` result into the transcript, so the model sees why its call did not
// run and can answer anyway. A throw would end the run and lose the child's
// ability to report what it has.

import type { Context } from "@earendil-works/chord";
import type {
	ConversationId,
	EntryId,
	EntryRecord,
	Extension,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
	Tx,
} from "@earendil-works/pi-durable";
import type { RunConfig } from "../contracts/run-config.ts";
import type { AttemptKey } from "./contracts.ts";
import { AgentQuotaDoc, AgentRoundBindingDoc, type OperationSpend, type RequestQuotaState, type RoundBindingState } from "./documents.ts";
import { consumeOnce, reconcileRoundFromEntries, roundStopReason, QuotaRefusal } from "./quota.ts";

/**
 * Tool names the budget never gates.
 *
 * These are the child's reporting channel: a round that has spent its business
 * allowance must still be able to finish, ask or report. The child's final answer
 * is not a tool call at all, so it is never gated either — which is the point:
 * a budget may stop work, never the ability to say what happened.
 */
export const CONTROL_TOOL_NAMES: readonly string[] = ["finish_task", "task_status", "task_evidence"] as const;

/** True when the tool is part of the control channel. */
export function isControlTool(name: string): boolean {
	return CONTROL_TOOL_NAMES.includes(name);
}

/**
 * The binding fields this wrapper uses, copied out of the committed view.
 *
 * `RoundBindingState` is the document's shape; this is the subset a read-only
 * consumer needs, deliberately without `budget` and `attemptNo` — the wrapper
 * enforces the run config it was constructed with, not a second copy of it.
 */
type BindingView = Pick<RoundBindingState, "mainConversationId" | "requestId" | "operationId" | "taskId" | "round"> & {
	readonly attemptKey: AttemptKey;
	readonly startEntryId?: EntryId;
	readonly stop?: { readonly kind: "cancel" | "deadline"; readonly at: number };
};

/** The diagnostic code a refusal carries, so a caller can branch without parsing text. */
export type ChildRefusalCode =
	| "no_round_binding"
	| "round_stopped"
	| "quota_failed_tool_calls_exhausted"
	| "quota_tool_invocations_exhausted"
	| "quota_attempts_exhausted"
	| "quota_unavailable";

/**
 * Wrap one granted child tool so every business call is admitted against the
 * round's budget before it runs.
 *
 * @param tool - the tool as the catalog registered it. Its `execute` is called
 * only after the gate admits the call.
 * @param runConfig - the run limits in force, read from the process that built
 * the child. Copied into the binding at round start, so the wrapper and the item
 * task agree on the same numbers.
 *
 * The wrap is installed through the child extension's `wraps`, so it applies
 * wherever the extension is selected and the model cannot opt out of it. It is
 * pure in the Durable sense — the same tool in produces a tool that behaves the
 * same way — and adds no model-visible tool.
 */
export function wrapWithQuota(tool: ToolRegistration, runConfig: RunConfig): ToolRegistration {
	if (isControlTool(tool.name)) return tool;
	return {
		...tool,
		// Forced, not inherited: the round must be sequential for the gate to see
		// the calls before it that it is meant to count. A parallel round would be
		// admitted wholesale, and this wrapper would then refuse calls whose
		// siblings had already started.
		executionMode: "sequential",
		execute: async (args, api, context) => {
			// The binding is read in a commit of its own, and its *values* are copied
			// out of it here. A transaction's document is a live overlay view: once the
			// commit settles, reading a field from it throws "Cannot use a settled
			// overlay" (chord `delta/tracker.ts:516`), so a draft returned from the
			// commit callback cannot be used by the two commits below.
			const binding: BindingView = await api.commit(async (tx): Promise<BindingView> => {
				const doc = await tx.doc(AgentRoundBindingDoc, api.conversationId);
				return {
					mainConversationId: doc.mainConversationId,
					requestId: doc.requestId,
					operationId: doc.operationId,
					taskId: doc.taskId,
					round: doc.round,
					attemptKey: doc.attemptKey,
					...(doc.startEntryId === undefined ? {} : { startEntryId: doc.startEntryId }),
					...(doc.stop === undefined ? {} : { stop: { kind: doc.stop.kind, at: doc.stop.at } }),
				};
			}, context);
			if (binding.round === 0 || binding.attemptKey === "" || binding.mainConversationId === 0) {
				return refusal("no_round_binding", `tool ${tool.name} was called outside a runtime round; no budget can be enforced`, context);
			}
			if (binding.stop !== undefined) {
				return refusal("round_stopped", `round ${binding.round} was stopped (${binding.stop.kind}); the call did not run`, context);
			}
			// One commit: reconcile what the round already left behind, check the
			// allowance, and reserve this call. A separate check and reserve would let
			// two sequential calls interleave with a settlement between them.
			const decision = await api.commit(async (tx) => {
				const quota = await tx.doc(AgentQuotaDoc, binding.mainConversationId, binding.requestId, { requestId: binding.requestId });
				const operation = operationOf(quota, binding.operationId, binding.taskId);
				const entries = await scanRoundEntries(tx, api.conversationId, binding.startEntryId);
				try {
					reconcileRoundFromEntries(operation, binding.round, entries, runConfig);
				} catch (error) {
					if (error instanceof QuotaRefusal) return { kind: "refused" as const, code: "quota_failed_tool_calls_exhausted" as const, detail: error.message };
					throw error;
				}
				const stop = roundStopReason(operation, binding.round, runConfig);
				if (stop !== undefined) {
					return { kind: "refused" as const, code: refusalCodeOf(stop), detail: `round ${binding.round}: ${stop}` };
				}
				try {
					consumeOnce(quota, operation, `tool:${api.callId}`, { kind: "tool_call", round: binding.round, callId: api.callId }, runConfig);
				} catch (error) {
					if (error instanceof QuotaRefusal) return { kind: "refused" as const, code: refusalCodeOf(error.code), detail: error.message };
					throw error;
				}
				return { kind: "admitted" as const };
			}, context);
			if (decision.kind === "refused") return refusal(decision.code, decision.detail, context);

			// The call is admitted: run it. A tool that reports an error or throws has
			// still spent a call, and its failure is charged exactly once — by this
			// wrapper, because it is the only place that saw the call run.
			let result: ToolExecutionResult;
			try {
				result = await tool.execute(args, api, context);
			} catch (error) {
				await chargeFailure(api, binding, runConfig, context);
				throw error;
			}
			if (result.isError === true) await chargeFailure(api, binding, runConfig, context);
			return result;
		},
	};
}

/**
 * The child extension that installs the wrapper.
 *
 * It carries no tools: it exists so the child's selected extensions include the
 * enforcement, and so the configuration snapshot's `contractRevision` can name
 * the behaviour a reopened run is running under.
 */
export function childQuotaExtension(tools: readonly ToolRegistration[], runConfig: RunConfig): Extension {
	const wrapped = tools.filter((tool) => !isControlTool(tool.name));
	return {
		name: "runtime-quota-gate",
		wraps: wrapped.map((tool) => ({ tool: tool.name, wrap: (current: ToolRegistration) => wrapWithQuota(current, runConfig) })),
	};
}

/** Charge one failed call, once. */
async function chargeFailure(
	api: ToolExecutionApi,
	binding: BindingView,
	runConfig: RunConfig,
	context: Context,
): Promise<void> {
	await api.commit(async (tx) => {
		const quota = await tx.doc(AgentQuotaDoc, binding.mainConversationId, binding.requestId, { requestId: binding.requestId });
		const operation = operationOf(quota, binding.operationId, binding.taskId);
		try {
			consumeOnce(quota, operation, `failed:${api.callId}`, { kind: "failed_tool_call", round: binding.round, callId: api.callId }, runConfig);
		} catch (error) {
			// The allowance is already gone. The failure is recorded as far as it can
			// be: the round's stop reason is what the next call reads, and the item
			// task settles on it. Swallowing a second refusal here is deliberate —
			// throwing would replace the tool's own error with a budget error.
			if (!(error instanceof QuotaRefusal)) throw error;
		}
	}, context);
}

/** The entries a round produced, oldest first, from the binding's start. */
async function scanRoundEntries(tx: Tx, conversationId: ConversationId, startEntryId: EntryId | undefined): Promise<readonly EntryRecord[]> {
	const page = await tx.scanEntries(
		{ conversationId, ...(startEntryId === undefined ? {} : { minEntryId: startEntryId }), order: "ascending" },
		500,
	);
	return page.items;
}

/** The spend record of one operation, creating it if the binding predates it. */
function operationOf(quota: RequestQuotaState, operationId: string, taskId: string): OperationSpend {
	const existing = quota.operations.find((entry) => entry.operationId === operationId);
	if (existing !== undefined) return existing;
	const created: OperationSpend = {
		operationId: operationId as OperationSpend["operationId"],
		taskId,
		attemptsUsed: 0,
		technicalRestartsUsed: 0,
		providerRetriesUsed: 0,
		rounds: [],
		chargedAttempts: [],
	};
	quota.operations = [...quota.operations, created];
	return created;
}

/** Map a stop reason or quota code to the refusal code the model sees. */
function refusalCodeOf(reason: string): ChildRefusalCode {
	if (reason === "failed_tool_calls_exhausted" || reason === "quota_failed_tool_calls_exhausted") return "quota_failed_tool_calls_exhausted";
	if (reason === "tool_invocations_exhausted" || reason === "quota_tool_invocations_exhausted") return "quota_tool_invocations_exhausted";
	if (reason === "attempts_exhausted" || reason === "quota_attempts_exhausted") return "quota_attempts_exhausted";
	return "quota_unavailable";
}

/** An error result carrying the refusal code as its diagnostic. */
function refusal(code: ChildRefusalCode, detail: string, _context: unknown) {
	return {
		output: [{ type: "text" as const, text: `[${code}] ${detail}` }],
		isError: true,
		diagnostics: [{ severity: "error" as const, code, message: detail }],
	};
}
