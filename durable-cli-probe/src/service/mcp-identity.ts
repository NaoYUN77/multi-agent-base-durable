// The durable half of `/mcp`: which capability set a conversation was opened
// with, checked before a recovered run is allowed to continue.
//
// Why this exists. A Main conversation commits a tool call *before* it runs it,
// so a process that dies mid-call leaves a call the next process will run. The
// dispatcher's name is stable across restarts by design — that is what makes a
// child's configuration snapshot comparable — and the identity used to compare
// it (`mcpConfigIdentity`) hashes the destinations behind those names. A tool
// call that was committed therefore knows which destination it was committed
// to, and this check refuses to open a database whose recorded identity no
// longer matches while work is still outstanding.
//
// What it does not do: it does not repair, rewrite or retarget the outstanding
// work, and it does not connect to anything. Refusing is the whole behaviour —
// a queued call can only be bound to the destination it was written for, and
// nothing here knows how to rewrite a committed call's arguments.
//
// The identity is a hash of names and versions. It records no URL, no argument,
// no header and no credential: the hash is of values that are already public to
// the model, so a document that leaks only says "these dispatchers, at these
// versions" and never what they connect to.

import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import type { AuthorizedTool } from "../agent/builder/authorization.ts";

export const MAIN_MCP_CONFIG_SCHEMA_VERSION = 1;

/** What a conversation remembers about the MCP capability set it ran with. */
export type MainMcpConfigState = {
	readonly schemaVersion: number;
	/**
	 * The identity last opened with. Absent means none was ever recorded: a
	 * database written before `/mcp` existed, or one opened with no servers.
	 */
	readonly identity?: string;
};

/**
 * The identity of the MCP capability set: the dispatcher names and the versions
 * of the destinations behind them, order-independent.
 *
 * An empty set is the empty string, which is deliberately *not* the same as
 * "no identity recorded": the first says this deployment has no MCP servers,
 * the second says nobody has looked yet.
 */
export const MainMcpConfigDoc = defineDoc<MainMcpConfigState>({
	kind: "app.mcp.main-config",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ schemaVersion: MAIN_MCP_CONFIG_SCHEMA_VERSION }),
});

export function mcpConfigIdentity(tools: readonly AuthorizedTool[]): string {
	if (tools.length === 0) return "";
	const capabilities = tools.map((tool) => `${tool.name}@${tool.version}`).sort();
	return createHash("sha256").update(capabilities.join("\n")).digest("hex");
}

/** The outcome of the check: either the recorded identity is usable, or why not. */
export type McpIdentityCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * Live work that a changed identity would mislead, counted over the whole
 * database.
 *
 * Deliberately not filtered to the Main conversation: a child conversation's
 * task can hold a granted MCP dispatcher, and a recovered child is exactly as
 * capable of sending a committed call to whatever the dispatcher now resolves
 * to. One Main conversation owns each database, so "everything" and "this
 * deployment's work" are the same set.
 */
async function outstanding(harness: Harness, context: Context): Promise<number> {
	const inspection = await harness.inspect(context);
	const tasks = inspection.tasks.length;
	const pending = inspection.submissions.filter((submission) => submission.status === "queued" || submission.status === "placed").length;
	return tasks + pending;
}

/**
 * Bind this conversation to the given identity, or refuse.
 *
 * @param identity - from `mcpConfigIdentity` over the tools this open built.
 * @returns `ok` when the conversation may continue, otherwise a detail naming
 *   the situation and what an operator can do — never anything from the
 *   configuration itself.
 *
 * An unchanged identity is accepted without reading live work. A changed one is
 * accepted only when the database has no unfinished task and no unsettled
 * submission; while it has any, the open fails rather than letting a recovered
 * call reach a destination it was not written for. A database that has no
 * recorded identity is treated the same way, so a database opened before this
 * check existed cannot be silently re-pointed while it holds work either.
 */
export async function ensureMainMcpIdentity(options: {
	readonly harness: Harness;
	readonly conversationId: ConversationId;
	readonly identity: string;
	readonly context: Context;
}): Promise<McpIdentityCheck> {
	const handle = await options.harness.conversation(options.conversationId, options.context);
	if (handle === undefined) throw new Error("mcp identity: the Main conversation vanished while the session opened");
	const recorded = await handle.commit(async (tx) => (await tx.doc(MainMcpConfigDoc, options.conversationId)).identity, options.context);
	if (recorded === options.identity) return { ok: true };
	// A database from before this check, with no MCP servers configured then or
	// now: there is no call that could have been written for a dispatcher, so
	// recording the empty identity hides nothing.
	if (recorded === undefined && options.identity === "") return { ok: true };
	if ((await outstanding(options.harness, options.context)) > 0) {
		return {
			ok: false,
			detail:
				"the MCP server configuration changed, and this database still has unfinished work that may call an MCP tool: " +
				"a recovered call would run against a different server than the one it was committed to. " +
				"Restore the previous MCP configuration and reopen, or finish and cancel the outstanding work first.",
		};
	}
	await handle.commit(async (tx) => {
		(await tx.doc(MainMcpConfigDoc, options.conversationId)).identity = options.identity;
	}, options.context);
	return { ok: true };
}
