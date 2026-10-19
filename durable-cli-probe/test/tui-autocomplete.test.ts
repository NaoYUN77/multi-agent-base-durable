// TASK-005.5 test/tui-autocomplete.test.ts
//
// What the editor completes, and what `/help` lists.
//
// The two are one table (`SLASH_COMMANDS`), and these tests hold them together:
// a command the panel lists is a command the completion offers, and every
// completion is a value `routeLine` accepts — a completion that the router then
// refuses as unknown would be worse than no completion at all.

import { describe, expect, it } from "vitest";
import { HELP_LINES, routeLine, SLASH_COMMANDS } from "../src/service/router.ts";
import type { TuiSnapshot } from "../src/service/types.ts";
import { createAutocompleteProvider } from "../src/tui/autocomplete.ts";

const snapshot: TuiSnapshot = {
	takenAt: 1,
	request: { requestVersion: 1, text: "run things", openQuestionIds: [], questions: [], answers: [], planCount: 1 },
	queue: [{ submissionId: "sub-9", requestId: "req-2", requestVersion: 1, allocatedVersion: 2, text: "a queued line", queuedAt: 1 }],
	mainBusy: true,
	tasks: [
		{ taskId: "t-alpha", batchId: "batch-1", title: "do alpha", status: "running", statusSource: "ledger", round: 1, toolInvocations: { used: 1, limit: 3 }, failedToolCalls: { used: 0, limit: 2 }, retrying: false },
		{ taskId: "t-beta", batchId: "batch-1", title: "do beta", status: "awaiting-review", statusSource: "ledger", round: 1, toolInvocations: { used: 2, limit: 3 }, failedToolCalls: { used: 0, limit: 2 }, retrying: false },
	],
	settledBatches: 0,
	totalBatches: 1,
	watchedTasks: ["t-alpha", "t-beta"],
	watchedRequests: [],
	watchedBatches: ["batch-1"],
	openReconciliation: [],
	mainTasks: [],
	model: {
		current: { provider: "faux", modelId: "faux-1" },
		available: [
			{ provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 128_000 },
			{ provider: "faux", modelId: "faux-2", name: "Faux Two", contextWindow: 64_000 },
		],
	},
};

function provider(state: TuiSnapshot | undefined = snapshot, servers: readonly string[] = ["local"]) {
	return createAutocompleteProvider({ snapshot: () => state, mcpServers: () => servers });
}

/** The provider with no pass behind it, as the editor has one before the first read finishes. */
function earlyProvider() {
	return createAutocompleteProvider({ snapshot: () => undefined, mcpServers: () => [] });
}

async function suggest(line: string, state: TuiSnapshot | undefined = snapshot, servers: readonly string[] = ["local"]) {
	const result = await provider(state, servers).getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	return result;
}

/** The same question of a provider that has read nothing. */
async function suggestEarly(line: string) {
	return await earlyProvider().getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

describe("TASK-005.5 slash command completion", () => {
	it("offers the commands a typed prefix matches, each with its description", async () => {
		const all = await suggest("/");
		expect(all?.prefix).toBe("/");
		expect(all?.items.map((item) => item.label)).toEqual(SLASH_COMMANDS.map((command) => command.usage.split(" ")[0]));

		const m = await suggest("/m");
		expect(m?.items.map((item) => item.value)).toEqual(["model", "mcp"]);
		// The description is what the user reads in the list.
		expect(m?.items.find((item) => item.value === "model")?.description).toContain("model in use");

		const mod = await suggest("/mod");
		expect(mod?.items.map((item) => item.value)).toEqual(["model"]);
		expect(mod?.prefix).toBe("/mod");
	});

	it("completes a command name to the spelling the router accepts", async () => {
		const suggestion = await suggest("/mod");
		const applied = provider().applyCompletion(["/mod"], 0, 4, suggestion?.items[0] ?? { value: "model", label: "/model" }, suggestion?.prefix ?? "/mod");
		expect(applied.lines).toEqual(["/model "]);
		expect(applied.cursorCol).toBe(7);
		expect(routeLine(applied.lines[0] ?? "", snapshot).kind).toBe("models");
	});

	it("offers only names the router knows, aliases included", async () => {
		// `/exit` is an accepted spelling of `/quit` and is completed, but the list
		// shows the canonical command rather than a second entry.
		const exit = await suggest("/ex");
		expect(exit?.items.map((item) => item.value)).toEqual(["quit"]);
		// A bare name may need an argument (`/inspect`, `/cancel`, `/answer`,
		// `/withdraw`); that refusal is about the argument, not the command, so the
		// table check is that none of them is reported as unknown.
		for (const command of SLASH_COMMANDS) {
			for (const name of [command.name, ...(command.aliases ?? [])]) {
				const route = routeLine(`/${name}`, snapshot);
				expect(route.kind === "noop" ? route.notice : "").not.toContain("unknown command");
			}
		}
		// Nothing else: a prefix that matches no command yields no list at all.
		expect(await suggest("/zzz")).toBeNull();
	});

	it("completes each command's argument from the pass that was read", async () => {
		const models = await suggest("/model ");
		expect(models?.items.map((item) => item.value)).toEqual(["faux/faux-1", "faux/faux-2"]);
		expect(models?.items[0]?.description).toContain("Faux One");
		expect(models?.items[0]?.description).toContain("in use");

		// The completed argument is a line the router resolves to a model switch.
		const applied = provider().applyCompletion(["/model f"], 0, 8, models?.items[1] ?? { value: "faux/faux-2", label: "" }, "f");
		expect(applied.lines).toEqual(["/model faux/faux-2"]);
		expect(routeLine(applied.lines[0] ?? "", snapshot)).toEqual({ kind: "set-model", provider: "faux", modelId: "faux-2" });

		const inspect = await suggest("/inspect t-");
		expect(inspect?.items.map((item) => item.value)).toEqual(["t-alpha", "t-beta"]);
		expect(routeLine("/inspect t-beta", snapshot)).toEqual({ kind: "inspect", taskId: "t-beta" });

		const cancel = await suggest("/cancel ");
		expect(cancel?.items.map((item) => item.value)).toEqual(["t-alpha", "t-beta", "all"]);
		expect(routeLine("/cancel all", snapshot)).toEqual({ kind: "cancel-all", reason: "cancelled_by_user" });

		const withdraw = await suggest("/withdraw ");
		expect(withdraw?.items.map((item) => item.value)).toEqual(["sub-9"]);
		expect(routeLine("/withdraw sub-9", snapshot)).toEqual({ kind: "withdraw", submissionId: "sub-9" });

		const mcp = await suggest("/mcp ");
		expect(mcp?.items.map((item) => item.value)).toEqual(["connect", "disconnect"]);
		const server = await suggest("/mcp connect ");
		expect(server?.items.map((item) => item.value)).toEqual(["local"]);
		expect(routeLine("/mcp connect local", snapshot)).toEqual({ kind: "connect-mcp", name: "local" });
	});

	it("answers nothing outside a slash command on the first line", async () => {
		expect(await suggest("summarize the material")).toBeNull();
		expect(await suggest("/model")).not.toBeNull();
		// A second line is a task body, not a command line.
		const multi = await provider().getSuggestions(["first", "/mod"], 1, 4, { signal: new AbortController().signal });
		expect(multi).toBeNull();
	});

	it("stays quiet before the first pass instead of inventing a catalog", async () => {
		const early = await suggestEarly("/model ");
		expect(early).toBeNull();
		// The command names do not depend on a pass, so they still complete.
		expect((await suggestEarly("/mod"))?.items.map((item) => item.value)).toEqual(["model"]);
	});
});

describe("TASK-005.5 help is the same table", () => {
	it("lists every command and its variant, descriptions aligned", () => {
		// The panel's first line is not a command; it is the bare enter key.
		const usages = ["enter", ...SLASH_COMMANDS.flatMap((command) => [command.usage, ...(command.variants ?? [])])];
		for (const usage of usages) expect(HELP_LINES.some((line) => line.startsWith(`${usage} `))).toBe(true);
		// A usage short enough for the column is padded to it, so every description
		// in the panel starts on the same character; a longer one gets one space.
		for (const line of HELP_LINES) {
			// The longest spelling wins: `/mcp connect <name>` also starts with `/mcp`.
			const usage = usages.filter((candidate) => line.startsWith(`${candidate} `)).sort((left, right) => right.length - left.length)[0];
			expect(usage).toBeDefined();
			const short = (usage ?? "").length < 19;
			const start = short ? 19 : (usage ?? "").length + 1;
			expect(line[start - 1]).toBe(" ");
			expect(line[start]).not.toBe(" ");
			if (short) expect(line.slice((usage ?? "").length, 19)).toBe(" ".repeat(19 - (usage ?? "").length));
		}
	});

	it("keeps every listed command routable", () => {
		for (const command of SLASH_COMMANDS) {
			for (const name of [command.name, ...(command.aliases ?? [])]) {
				const route = routeLine(`/${name}`, snapshot);
				// A bare name may still need an argument; what it may not be is unknown.
				expect(route.kind === "noop" ? route.notice : "").not.toContain("unknown command");
			}
		}
		expect(HELP_LINES.join("\n")).toContain("/mcp");
	});
});
