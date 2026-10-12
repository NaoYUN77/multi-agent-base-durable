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
//     toolName, isError, content) plus `byTaskId` attribution and, in `data`,
//     the harness's structured diagnostics.
//
// The final answer is the entry the submission actually settled on
// (`settled.answer`), never "the last non-empty assistant text in range": an
// empty final answer is a failure, not a silent substitution.

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
	/** The answer the submission settled on; the round's authoritative answer. */
	readonly answerEntryId: EntryId;
};

/** Result of extracting one round: the answer plus its evidence references. */
export type RoundExtraction = {
	readonly answerEntryId: EntryId;
	readonly answerText: string;
	readonly evidence: readonly EvidenceReference[];
	readonly calls: readonly CallRecord[];
};

/** Scan surface both `Tx` and conversation handles provide. */
export interface EntryScanner {
	scanEntries(query: EntryQuery, limit: number, cursor?: unknown): Promise<{ readonly items: readonly EntryRecord[]; readonly next?: unknown }>;
}

const SCAN_PAGE = 100;
/** Safety rail: a round with more pages than this fails loudly instead of silently returning a partial evidence set. */
const MAX_SCAN_PAGES = 500;

/** Excerpt limits: what the main model sees inline, and the ledger stores. */
export const EVIDENCE_EXCERPT_LIMIT = 2000;
const ARGS_SUMMARY_LIMIT = 400;

function excerptOf(text: string, limit: number): { readonly excerpt: string; readonly truncated: boolean } {
	if (text.length <= limit) return { excerpt: text, truncated: false };
	return { excerpt: `${text.slice(0, limit)}…`, truncated: true };
}

/**
 * A safe, defined summary of one tool call's arguments: structure and lengths
 * are kept, values are not echoed beyond a short threshold. This is what the
 * ledger and the main model see; the full arguments stay in the transcript.
 */
export function redactArgs(args: unknown): string {
	const describe = (value: unknown, depth: number): string => {
		if (depth > 4) return "…";
		if (typeof value === "string") return value.length > 40 ? `<string:${value.length}>` : JSON.stringify(value);
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (value === null) return "null";
		if (Array.isArray(value)) return `[${value.map((item) => describe(item, depth + 1)).join(",")}]`;
		if (typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}:${describe(item, depth + 1)}`);
			return `{${entries.join(",")}}`;
		}
		return String(value);
	};
	return excerptOf(describe(args, 0), ARGS_SUMMARY_LIMIT).excerpt;
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

/** The harness's structured diagnostics recorded on a tool-result entry. */
function diagnosticsOf(entry: EntryRecord): string[] {
	const data = entry.data as { diagnostics?: { severity?: string; message?: string }[] } | undefined;
	const diagnostics = data?.diagnostics;
	if (!Array.isArray(diagnostics)) return [];
	return diagnostics.map((diagnostic) => `[${diagnostic.severity ?? "info"}] ${diagnostic.message ?? ""}`);
}

/**
 * Walk every entry of one round (all pages, bounded by the round), collecting
 * tool calls, tool results, and the final answer the submission settled on.
 * Throws when the scan would silently truncate: partial evidence is a lie.
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
	for (let pages = 0; ; pages++) {
		if (pages >= MAX_SCAN_PAGES) {
			throw new Error(`evidence scan exceeded ${MAX_SCAN_PAGES} pages; refusing to return partial evidence`);
		}
		const page = await scanner.scanEntries(query, SCAN_PAGE, cursor);
		entries.push(...page.items);
		if (page.next === undefined) break;
		cursor = page.next;
	}

	const calls: CallRecord[] = [];
	const callById = new Map<string, CallRecord>();
	const evidence: EvidenceReference[] = [];

	for (const entry of entries) {
		for (const call of callsOf(entry)) {
			calls.push(call);
			callById.set(call.id, call);
		}
		const result = toolResultOf(entry);
		if (result === undefined) continue;
		const call = callById.get(result.toolCallId);
		const output = excerptOf(result.text, EVIDENCE_EXCERPT_LIMIT);
		const diagnostics = diagnosticsOf(entry);
		let parsedArgs: unknown = {};
		if (call?.argumentsText !== undefined) {
			try {
				parsedArgs = JSON.parse(call.argumentsText) as unknown;
			} catch {
				parsedArgs = {};
			}
		}
		evidence.push({
			entryId: entry.id,
			kind: entry.kind,
			...(entry.byTaskId === undefined ? {} : { byTaskId: String(entry.byTaskId) }),
			toolCallId: result.toolCallId,
			toolName: result.toolName || (call?.name ?? ""),
			isError: result.isError,
			argsSummary: redactArgs(parsedArgs),
			excerpt: output.excerpt,
			truncated: output.truncated,
			...(diagnostics.length === 0 ? {} : { diagnostics }),
		});
	}

	// The authoritative answer: the entry the submission settled on, read for
	// its text; missing is a failure to record, never a substitution from the
	// round's history.
	const answerEntry = entries.find((entry) => entry.id === bounds.answerEntryId);
	if (answerEntry === undefined) {
		throw new Error(`answer entry ${bounds.answerEntryId} is not within the round's entry range`);
	}
	const answerText = (answerEntry.model ?? [])
		.map((message) => (message.role === "assistant" ? textOfContent((message as { content?: unknown }).content) : ""))
		.join("\n");

	return {
		answerEntryId: bounds.answerEntryId,
		answerText,
		evidence: [
			...evidence,
			{
				entryId: bounds.answerEntryId,
				kind: answerEntry.kind,
				excerpt: excerptOf(answerText, EVIDENCE_EXCERPT_LIMIT).excerpt,
				truncated: excerptOf(answerText, EVIDENCE_EXCERPT_LIMIT).truncated,
			},
		],
		calls,
	};
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
