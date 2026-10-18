// TASK-005.3 src/agent/builder/create-subagent.ts
//
// `createSubAgent`: the side-effecting half of the factory. Given the execution
// right a dispatcher already holds, it persists the configuration snapshot once
// and creates (or finds) exactly one child conversation for the task.
//
// It deliberately does not submit anything. Submitting starts a model round,
// and the round's admission, budget and scheduling belong to the batch runtime
// (TASK-005.4), not to conversation creation. A replay of this function
// therefore cannot start a second round: it only returns the conversation the
// binding already has.
//
// Why one commit: the snapshot, the ledger pointer, the conversation and its
// agent configuration are one decision. A commit that wrote the snapshot but
// not the pointer would leave a reopened process unable to tell whether the
// conversation was configured; a commit that configured a conversation but lost
// the snapshot would make the next call unable to prove it is the same
// instance. The Harness serializes commits, so the check (execution right,
// terminal status, config hash) and the writes cannot be separated.

import type { Context } from "@earendil-works/chord";
import { configure, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { AgentTaskConfigDoc } from "../contracts/documents.ts";
import type { TaskConfigSnapshot } from "../contracts/run-config.ts";
import { isTerminal, TaskLedgerDoc } from "../../multiagent/ledger.ts";
import type { SubAgentConfig } from "./subagent-config.ts";

/** The subset of `ToolExecutionApi` conversation creation needs. */
export type SubAgentCreationApi = {
	/** The Main conversation that owns the ledger and the configuration document. */
	readonly conversationId: ConversationId;
	/** The durable tool task the child conversation will be owned by. */
	readonly taskId: TaskId;
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
};

/** The execution right the caller already holds. */
export type SubAgentClaim = {
	/** Business task id; the ledger document's key. */
	readonly taskId: string;
	/** Operation that holds the right (`ledger.activeOpKey`). */
	readonly opKey: string;
};

/** Why a child could not be created or reused. */
export type SubAgentCreationFailure = {
	readonly code:
		| "config_task_mismatch"
		| "task_not_dispatched"
		| "execution_right_missing"
		| "task_terminal"
		| "config_incompatible"
		| "conversation_unavailable";
	readonly detail: string;
};

export type SubAgentCreationResult =
	| {
			readonly ok: true;
			readonly conversationId: ConversationId;
			readonly snapshot: TaskConfigSnapshot;
			/** True when this call created the conversation; false when it found it. */
			readonly created: boolean;
	  }
	| { readonly ok: false; readonly failure: SubAgentCreationFailure };

/** A short, operator-readable account of what differs from the stored snapshot. */
function describeMismatch(stored: TaskConfigSnapshot, fresh: TaskConfigSnapshot): string {
	const differences: string[] = [];
	if (stored.skillVersion !== fresh.skillVersion) differences.push(`skill version ${stored.skillVersion} -> ${fresh.skillVersion}`);
	if (stored.skillHash !== fresh.skillHash) differences.push("skill instructions changed");
	if (stored.model !== fresh.model) differences.push(`model ${stored.model} -> ${fresh.model}`);
	const storedTools = stored.tools.map((tool) => `${tool.name}@${tool.version}`).join(",");
	const freshTools = fresh.tools.map((tool) => `${tool.name}@${tool.version}`).join(",");
	if (storedTools !== freshTools) differences.push(`tools [${storedTools}] -> [${freshTools}]`);
	if (differences.length === 0) differences.push(`configuration hash ${stored.configHash.slice(0, 12)} -> ${fresh.configHash.slice(0, 12)}`);
	return differences.join("; ");
}

/**
 * Create or find the child conversation of one task.
 *
 * @param api - the Main conversation, the owning durable task, and `commit`.
 * @param context - the host context used for the commit.
 * @param config - the output of `buildSubAgentConfig` for this task.
 * @param claim - the already-held execution right (`activeOpKey`). Creating a
 * conversation does not claim a right; it refuses without one.
 * @returns the conversation, the snapshot that was persisted (or the one that
 * already matched), and whether this call created it.
 *
 * Refusals, each before the writes that would make them harmful:
 * - `config_task_mismatch` — the config was built for a different task;
 * - `task_not_dispatched` — the ledger has no dispatcher record (`createdAt` 0),
 *   so this call would be inventing a task rather than configuring one;
 * - `task_terminal` / `execution_right_missing` — the task may not run now;
 * - `config_incompatible` — the task already runs with a different snapshot;
 * - `conversation_unavailable` — Durable refused the owning task (terminal or
 *   aborted between the dispatcher's claim and this call).
 *
 * Side effects: one commit that may write `AgentTaskConfigDoc` (the snapshot
 * once), the task ledger's child pointer, and the child's `pi.agent`
 * configuration. It creates at most one conversation and never submits a round.
 *
 * Idempotency: calling again with the same binding and the same configuration
 * returns the same conversation and writes nothing. A changed configuration is
 * refused (`config_incompatible`) rather than re-applied: a running instance
 * must keep the skill and tools it started with; recovery reports the
 * incompatibility instead of silently re-generating the prompt.
 */
export async function createSubAgent(
	api: SubAgentCreationApi,
	context: Context,
	config: SubAgentConfig,
	claim: SubAgentClaim,
): Promise<SubAgentCreationResult> {
	// Applying the configuration of task A to the conversation of task B would
	// give B A's instructions and tools. The binding is the caller's to get
	// right; a mismatch is refused before any storage is touched.
	if (config.taskId !== claim.taskId) {
		return {
			ok: false,
			failure: {
				code: "config_task_mismatch",
				detail: `configuration belongs to task ${config.taskId}, not ${claim.taskId}`,
			},
		} as const;
	}
	return await api.commit(async (tx) => {
		const ledger = await tx.doc(TaskLedgerDoc, api.conversationId, claim.taskId, { taskId: claim.taskId, model: config.model });
		if (isTerminal(ledger.status)) {
			return {
				ok: false,
				failure: { code: "task_terminal", detail: `task ${claim.taskId} is ${ledger.status}` },
			} as const;
		}
		// `tx.doc` creates a missing family document from the seed, so a ledger
		// with no dispatcher record would otherwise let this call invent a task.
		// `createdAt` is stamped by the dispatcher; zero means nobody dispatched
		// this task. When the acquisition produced a seed-shaped document (this
		// call created it), retire it in the same commit so the refusal leaves no
		// live `running` ledger behind.
		if (ledger.createdAt === 0) {
			if (
				ledger.activeOpKey === undefined &&
				ledger.version === 0 &&
				ledger.mainConversationId === undefined &&
				ledger.childConversationId === undefined &&
				ledger.rounds.length === 0 &&
				ledger.operations.length === 0
			) {
				await tx.retireDoc(TaskLedgerDoc, api.conversationId, claim.taskId);
			}
			return {
				ok: false,
				failure: { code: "task_not_dispatched", detail: `task ${claim.taskId} has no dispatcher record` },
			} as const;
		}
		if (ledger.activeOpKey !== claim.opKey) {
			return {
				ok: false,
				failure: {
					code: "execution_right_missing",
					detail: `task ${claim.taskId} is held by ${ledger.activeOpKey ?? "no operation"}, not ${claim.opKey}`,
				},
			} as const;
		}

		// The snapshot is written once. A later call compares hashes; it never
		// rewrites the record of what this instance actually runs with.
		const configDoc = await tx.doc(AgentTaskConfigDoc, api.conversationId, claim.taskId, { taskId: claim.taskId });
		const storedSnapshot = configDoc.snapshot;
		if (storedSnapshot !== undefined && storedSnapshot.configHash !== config.snapshot.configHash) {
			return {
				ok: false,
				failure: {
					code: "config_incompatible",
					detail: `task ${claim.taskId} was configured with a different configuration: ${describeMismatch(storedSnapshot, config.snapshot)}`,
				},
			} as const;
		}

		// One conversation per task binding. The ledger pointer is authoritative:
		// adopting "some conversation owned by this durable task" would hand this
		// business task another task's child when one dispatcher task serves
		// several of them. A pointer this code wrote is always committed together
		// with the conversation, so a missing pointer means "not created yet".
		let conversationId = ledger.childConversationId;
		let created = false;
		if (conversationId === undefined) {
			// Durable checks the owner at commit assembly, not when
			// `createConversation` is staged, so a dead owner would reject this
			// whole commit with a raw error after the callback returned. The same
			// check can be made on the transaction's view of the task, turning it
			// into a typed refusal before anything is written.
			const owner = await tx.task(api.taskId);
			if (owner === undefined || owner.state.status === "terminal" || owner.state.status === "completing" || owner.abortRequested) {
				const state = owner === undefined ? "missing" : owner.abortRequested ? "abort-marked" : owner.state.status;
				return {
					ok: false,
					failure: {
						code: "conversation_unavailable",
						detail: `cannot create a child conversation owned by task ${api.taskId}: the owner is ${state}`,
					},
				} as const;
			}
			try {
				const record = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				conversationId = record.id;
				created = true;
			} catch (error) {
				return {
					ok: false,
					failure: {
						code: "conversation_unavailable",
						detail: `cannot create a child conversation owned by task ${api.taskId}: ${(error as Error).message}`,
					},
				} as const;
			}
		}

		// Writes start here: a refusal above must not leave a snapshot or a
		// pointer without the conversation they describe.
		let mustConfigure = created;
		if (storedSnapshot === undefined) {
			configDoc.snapshot = config.snapshot;
			mustConfigure = true;
		}
		if (ledger.mainConversationId === undefined) ledger.mainConversationId = api.conversationId;
		if (ledger.childConversationId === undefined) ledger.childConversationId = conversationId;
		// Only touch the array when it differs: assigning a fresh array on every
		// replay would mark the document dirty and write it again.
		const childTools = config.tools.map((tool) => tool.name);
		const toolsChanged =
			ledger.childTools.length !== childTools.length || ledger.childTools.some((name, index) => name !== childTools[index]);
		if (toolsChanged) ledger.childTools = childTools;

		if (mustConfigure) {
			// Exact sets, not edits: a new task-owned conversation starts as a copy
			// of the Main agent, so leaving `extensions` or `tools` unset would leak
			// the management tools into the child. `cwd` is cleared for the same
			// reason: the child works only on its own materials.
			await configure(tx, conversationId, {
				extensions: config.extensions,
				instructions: config.instructions,
				tools: config.tools,
				modelTools: config.modelTools,
				model: config.model,
				cwd: null,
			});
		}

		return { ok: true, conversationId, snapshot: config.snapshot, created } as const;
	}, context);
}
