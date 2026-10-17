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
	readonly code: "execution_right_missing" | "task_terminal" | "config_incompatible";
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
	return await api.commit(async (tx) => {
		const ledger = await tx.doc(TaskLedgerDoc, api.conversationId, claim.taskId, { taskId: claim.taskId, model: config.model });
		if (isTerminal(ledger.status)) {
			return {
				ok: false,
				failure: { code: "task_terminal", detail: `task ${claim.taskId} is ${ledger.status}` },
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
		let mustConfigure = false;
		if (configDoc.snapshot === undefined) {
			configDoc.snapshot = config.snapshot;
			mustConfigure = true;
		} else if (configDoc.snapshot.configHash !== config.snapshot.configHash) {
			return {
				ok: false,
				failure: {
					code: "config_incompatible",
					detail: `task ${claim.taskId} was configured with a different configuration: ${describeMismatch(configDoc.snapshot, config.snapshot)}`,
				},
			} as const;
		}

		// One conversation per task binding. The ledger pointer is authoritative;
		// a scan is the recovery path for a ledger that lost the pointer (an older
		// document shape), and it is scoped to this durable tool task so a
		// different task can never adopt this one's child.
		let conversationId = ledger.childConversationId;
		let created = false;
		if (conversationId === undefined) {
			const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
			const record = existing ?? (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }));
			conversationId = record.id;
			created = existing === undefined;
			if (created) mustConfigure = true;
		}

		if (ledger.mainConversationId === undefined) ledger.mainConversationId = api.conversationId;
		ledger.childConversationId = conversationId;
		ledger.childTools = config.tools.map((tool) => tool.name);

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
