// TASK-003 src/multiagent/evidence.ts
//
// Program-side evidence extraction. Everything the contract requires for
// AC-04 — per-round tool evidence with entry ids, task attribution, call ids,
// error flags, argument summaries and result excerpts — is read from the real
// Entry/Task/Submission records by this module. The model is never asked to
// state ids or to claim a tool succeeded; if the records do not show it, the
// evidence does not claim it either.
//
// Two entry shapes matter here:
//   - `pi.assistant` entries carry the assistant message, whose content parts
//     include toolCalls (id, name, arguments). These supply the argument
//     summary that gets attached to the matching tool result.
//   - `pi.tool-result` entries carry the toolResult message (toolCallId,
//     toolName, isError, content) plus `byTaskId` attribution.

import type { EntryId, EntryRecord, EntryQuery } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { EvidenceReference } from "./ledger.ts";

/** One toolCall found in an assistant entry, used to enrich matching results. */
type CallRecord = {
	readonly id: string;
	readonly name: string;
	readonly argumentsText: string;
};

/** Bound of one round: the entries a submission produced, inclusive. */
export type RoundBounds = {
	readonly conversationId: ConversationId;
	readonly minEntryId?: EntryId;
	readonly maxEntryId?: EntryId;
};

/** Result of extracting one round: the answer plus its evidence references. */
export type RoundExtraction = {
	readonly answerEntryId?: EntryId;
	readonly answerText?: string;
	readonly evidence: readonly EvidenceReference[];
	readonly calls: readonly CallRecord[];
};

/** Scan surface both `Tx` and conversation handles provide. */
export interface EntryScanner {
	scanEntries(query: EntryQuery, limit: number, cursor?: unknown): Promise<{ readonly items: readonly EntryRecord[]; readonly next?: unknown }>;
}

const SCAN_PAGE = 100;

/** Excerpt limits: what the main model sees inline, and the ledger stores. */
export const EVIDENCE_EXCERPT_LIMIT = 2000;
const ARGS_SUMMARY_LIMIT = 400;

function excerptOf(text: string, limit: number): { readonly excerpt: string; readonly truncated: boolean } {
	if (text.length <= limit) return { excerpt: text, truncated: false };
	return { excerpt: `${text.slice(0, limit)}…`, truncated: true };
}

/** Flatten an assistant message content array to its text parts. */
function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const typed = part as { type?: string; text?: string };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("");
}

/** Flatten a toolResult message content array to its text parts. */
function toolResultTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const typed = part as { type?: string; text?: string };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("");
}

/** Collect toolCalls from one entry's model messages. */
function callsOf(entry: EntryRecord): CallRecord[] {
	const calls: CallRecord[] = [];
	for (const message of entry.model ?? []) {
		if (message.role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null) continue;
			const typed = part as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (typed.type !== "toolCall" || typed.id === undefined || typed.name === undefined) continue;
			calls.push({ id: typed.id, name: typed.name, argumentsText: JSON.stringify(typed.arguments ?? {}) });
		}
	}
	return calls;
}

/** Read the toolResult fields of one entry's model messages, if any. */
function toolResultOf(entry: EntryRecord): { toolCallId: string; toolName: string; isError: boolean; text: string } | undefined {
	for (const message of entry.model ?? []) {
		if (message.role !== "toolResult") continue;
		const typed = message as { toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown };
		return {
			toolCallId: typed.toolCallId ?? "",
			toolName: typed.toolName ?? "",
			isError: typed.isError === true,
			text: toolResultTextOf(typed.content),
		};
	}
	return undefined;
}

/**
 * Walk every entry of one round (all pages, bounded by the round), collecting
 * tool calls, tool results, and the final assistant answer.
 */
export async function extractRoundEvidence(scanner: EntryScanner, bounds: RoundBounds): Promise<RoundExtraction> {
	const query: EntryQuery = {
		conversationId: bounds.conversationId,
		...(bounds.minEntryId === undefined ? {} : { minEntryId: bounds.minEntryId }),
		...(bounds.maxEntryId === undefined ? {} : { maxEntryId: bounds.maxEntryId }),
		order: "ascending",
	};

	const entries: EntryRecord[] = [];
	let cursor: unknown;
	for (let pages = 0; pages < 1000; pages++) {
		const page = await scanner.scanEntries(query, SCAN_PAGE, cursor);
		entries.push(...page.items);
		if (page.next === undefined) break;
		cursor = page.next;
	}

	const calls: CallRecord[] = [];
	const callById = new Map<string, CallRecord>();
	const evidence: EvidenceReference[] = [];
	let answerEntryId: EntryId | undefined;
	let answerText: string | undefined;

	for (const entry of entries) {
		for (const call of callsOf(entry)) {
			calls.push(call);
			callById.set(call.id, call);
		}
		const result = toolResultOf(entry);
		if (result !== undefined) {
			const call = callById.get(result.toolCallId);
			const args = excerptOf(call?.argumentsText ?? "{}", ARGS_SUMMARY_LIMIT);
			const output = excerptOf(result.text, EVIDENCE_EXCERPT_LIMIT);
			evidence.push({
				entryId: entry.id,
				kind: entry.kind,
				...(entry.byTaskId === undefined ? {} : { byTaskId: String(entry.byTaskId) }),
				toolCallId: result.toolCallId,
				toolName: result.toolName || (call?.name ?? ""),
				isError: result.isError,
				argsSummary: args.excerpt,
				excerpt: output.excerpt,
				truncated: output.truncated,
			});
			continue;
		}
		// The answer is the youngest assistant entry with text in the round.
		if (entry.kind === "pi.assistant") {
			const text = (entry.model ?? [])
				.map((message) => (message.role === "assistant" ? textOfContent((message as { content?: unknown }).content) : ""))
				.join("\n");
			if (text.trim() !== "") {
				answerEntryId = entry.id;
				answerText = text;
			}
		}
	}

	// The answer is evidence too: the main model must be able to point at it.
	const answerEvidence: EvidenceReference[] =
		answerEntryId === undefined
			? []
			: [
					{
						entryId: answerEntryId,
						kind: "pi.assistant",
						excerpt: excerptOf(answerText ?? "", EVIDENCE_EXCERPT_LIMIT).excerpt,
						truncated: excerptOf(answerText ?? "", EVIDENCE_EXCERPT_LIMIT).truncated,
					},
				];

	return { answerEntryId, answerText, evidence: [...evidence, ...answerEvidence], calls };
}

/**
 * Render one entry's model-facing text, for the retrieval tool. The caller
 * reads the entry through `tx.entry()` and checks ownership first; this
 * function only formats what is actually persisted.
 */
export function entryText(entry: EntryRecord | undefined): string | undefined {
	if (entry === undefined) return undefined;
	const parts: string[] = [];
	for (const message of entry.model ?? []) {
		if (message.role === "toolResult") parts.push(toolResultTextOf((message as { content?: unknown }).content));
		else if (message.role === "assistant") parts.push(textOfContent((message as { content?: unknown }).content));
		else if (message.role === "user") parts.push(textOfContent((message as { content?: unknown }).content));
		else if (message.role === "system") parts.push(textOfContent((message as { content?: unknown }).content));
	}
	return parts.join("\n");
}
