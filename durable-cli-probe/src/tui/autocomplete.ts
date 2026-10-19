// TASK-005.5 src/tui/autocomplete.ts
//
// What the editor completes while a line is typed: the slash commands, and the
// arguments each one takes.
//
// The editor (pi-tui's `Editor`) owns the trigger and the dropdown; this file
// only answers two questions — what matches the text before the cursor, and
// what the line becomes when one item is chosen. Two rules shape the answers:
//
//   * **The list is the router's list.** Commands come from `SLASH_COMMANDS`,
//     the same table `/help` prints and `routeLine` switches on, so nothing can
//     be completed that would then be refused as an unknown command.
//   * **Arguments are read, never guessed.** `/model` completes the catalog the
//     newest pass read, `/inspect` and `/cancel` complete the task ids in it,
//     `/withdraw` the queued submission ids, and `/mcp` the configured server
//     names. A completion is therefore a value the router will accept.
//
// File-path completion is deliberately absent: the line is a request or a
// command, not a shell, and an unexpected list of files while typing a task
// would be noise rather than help.

import { type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions, fuzzyFilter } from "@earendil-works/pi-tui";
import { commandLabel, SLASH_COMMANDS } from "../service/router.ts";
import type { TuiSnapshot } from "../service/types.ts";

/** What the provider reads: the newest pass, and the configured MCP server names. */
export type CompletionSource = {
	readonly snapshot: () => TuiSnapshot | undefined;
	readonly mcpServers: () => readonly string[];
};

type CommandItem = {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly aliases: readonly string[];
};

/** The router's table, shaped for the list: the label is the spelling, never an argument. */
const COMMANDS: readonly CommandItem[] = SLASH_COMMANDS.map((command) => ({
	name: command.name,
	label: commandLabel(command),
	description: command.description,
	aliases: command.aliases ?? [],
}));

/** `/mcp`'s actions, in the order the router accepts them. */
const MCP_ACTIONS = ["connect", "disconnect"] as const;

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

/**
 * Command-name suggestions for the text after the slash.
 *
 * Fuzzy, so `/mod` and `/m` both find `/model`; a command's aliases are matched
 * too, so `/ex` finds `/quit` without giving `exit` a line of its own.
 */
function commandItems(query: string): AutocompleteItem[] {
	const byName = fuzzyFilter([...COMMANDS], query, (item) => item.name);
	const aliasHits = COMMANDS.filter((item) => !byName.includes(item) && item.aliases.some((alias) => alias.startsWith(query.toLowerCase())));
	return [...byName, ...aliasHits].map((item) => ({
		value: item.name,
		label: item.label,
		description: item.description,
	}));
}

/** The models the newest pass read, in the `provider/modelId` spelling `/model` accepts. */
function modelItems(snapshot: TuiSnapshot | undefined, query: string): AutocompleteItem[] {
	const model = snapshot?.model;
	if (model === undefined) return [];
	const items = model.available.map((option) => {
		const value = `${option.provider}/${option.modelId}`;
		const inUse = option.provider === model.current?.provider && option.modelId === model.current?.modelId;
		return {
			value,
			label: value,
			description: `${option.name} · ${Math.round(option.contextWindow / 1000)}k context${inUse ? " · in use" : ""}`,
		};
	});
	return fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`);
}

function taskItems(snapshot: TuiSnapshot | undefined, query: string, includeAll: boolean): AutocompleteItem[] {
	const items: AutocompleteItem[] = (snapshot?.tasks ?? []).map((row) => ({
		value: row.taskId,
		label: row.taskId,
		description: `${row.status} · ${row.title}`,
	}));
	if (includeAll) items.push({ value: "all", label: "all", description: "stop every batch and cancel the request" });
	return fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`);
}

function withdrawItems(snapshot: TuiSnapshot | undefined, query: string): AutocompleteItem[] {
	const items: AutocompleteItem[] = (snapshot?.queue ?? []).map((entry) => ({
		value: entry.submissionId,
		label: entry.submissionId,
		description: entry.text.replace(/\s+/g, " ").slice(0, 60),
	}));
	return fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`);
}

function mcpItems(source: CompletionSource, argumentText: string, query: string): AutocompleteItem[] {
	const trimmed = argumentText.trimStart();
	// Past the action word the argument is a server name; before it, the action.
	if (trimmed.includes(" ")) {
		const servers = unique(source.mcpServers()).map((name) => ({ value: name, label: name, description: "configured MCP server" }));
		return fuzzyFilter(servers, query, (item) => item.value);
	}
	const actions = MCP_ACTIONS.map((action) => ({
		value: action,
		label: action,
		description: action === "connect" ? "connect one configured MCP server" : "disconnect one; a later tool call may reconnect",
	}));
	return fuzzyFilter(actions, query, (item) => item.value);
}

/** Suggestions for the argument of `commandName`, or none when it takes no completion. */
function argumentItems(commandName: string, argumentText: string, query: string, source: CompletionSource): AutocompleteItem[] {
	const snapshot = source.snapshot();
	switch (commandName) {
		case "model":
			return modelItems(snapshot, query);
		case "inspect":
			return taskItems(snapshot, query, false);
		case "cancel":
			return taskItems(snapshot, query, true);
		case "withdraw":
			return withdrawItems(snapshot, query);
		case "mcp":
			return mcpItems(source, argumentText, query);
		default:
			return [];
	}
}

/**
 * The editor's completion provider.
 *
 * `getSuggestions` answers only for the first line and only once it starts with
 * a slash — the editor already restricts itself to that line, and answering
 * elsewhere would put a list under an ordinary task description.
 */
export function createAutocompleteProvider(source: CompletionSource): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			if (options.signal.aborted || cursorLine !== 0) return null;
			const line = lines[cursorLine] ?? "";
			const trimmed = line.slice(0, cursorCol).trimStart();
			if (!trimmed.startsWith("/")) return null;

			const space = trimmed.search(/\s/);
			if (space < 0) {
				// Still typing the command name: the prefix is the whole line so far,
				// including the slash, which is what `applyCompletion` replaces.
				const items = commandItems(trimmed.slice(1));
				return items.length === 0 ? null : { items, prefix: trimmed };
			}

			const commandName = trimmed.slice(1, space).toLowerCase();
			const argumentText = trimmed.slice(space + 1);
			// Only the token under the cursor is replaced, so the prefix is the text
			// after the last space — never the whole argument.
			const prefix = argumentText.slice(argumentText.lastIndexOf(" ") + 1);
			const items = argumentItems(commandName, argumentText, prefix, source);
			return items.length === 0 ? null : { items, prefix };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, Math.max(0, cursorCol - prefix.length));
			const after = line.slice(cursorCol);
			// A command name gets a trailing space so the next keystroke starts its
			// argument; an argument is inserted as it is.
			const inserted = prefix.startsWith("/") && !/\s/.test(prefix) ? `/${item.value} ` : item.value;
			const next = [...lines];
			next[cursorLine] = before + inserted + after;
			return { lines: next, cursorLine, cursorCol: before.length + inserted.length };
		},

		// Tab in argument position should ask this provider; Tab elsewhere has
		// nothing to complete, because this editor has no file attachments.
		shouldTriggerFileCompletion(_lines, cursorLine, _cursorCol) {
			return cursorLine === 0;
		},
	};
}
