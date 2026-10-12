// TASK-003 src/multiagent/child-tools.ts
//
// The child side's tools: small, local, and repeatable, with no external write
// side effects (they never touch Notion or the network). They exist so the
// deterministic tests can produce real multi-tool transcripts and real
// per-tool evidence, and so the real smoke run does the same with a live model.
//
// They are deliberately trivial to *use* and precise to *record*: every result
// carries what was actually computed, so the evidence extraction has something
// honest to extract.

import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** Count characters, lines, words and a marker's occurrences in a text. */
export const textStatsTool = defineTool({
	name: "text_stats",
	description: "Count lines, characters, words, and occurrences of an optional marker in a text.",
	parameters: {
		type: "object",
		properties: {
			text: { type: "string", description: "The text to measure." },
			marker: { type: "string", description: "Optional substring to count." },
		},
		required: ["text"],
	} as never,
	// Idempotent: rerunning computes the same numbers.
	replay: "safe",
	execute: async (args: { text: string; marker?: string }) => {
		const lines = args.text.split("\n").length;
		const chars = args.text.length;
		const words = args.text.split(/\s+/).filter((word) => word !== "").length;
		const markerCount = args.marker === undefined ? 0 : args.text.split(args.marker).length - 1;
		return {
			output: [
				{
					type: "text" as const,
					text: `lines=${lines} chars=${chars} words=${words}` + (args.marker === undefined ? "" : ` marker=${JSON.stringify(args.marker)} count=${markerCount}`),
				},
			],
			structuredOutput: { lines, chars, words, marker: args.marker ?? null, markerCount },
		};
	},
});

/** Check whether a text contains a marker; reports the first match line. */
export const textCheckTool = defineTool({
	name: "text_check",
	description: "Check whether a text contains a marker, and report the first matching line number.",
	parameters: {
		type: "object",
		properties: {
			text: { type: "string" },
			marker: { type: "string" },
		},
		required: ["text", "marker"],
	} as never,
	replay: "safe",
	execute: async (args: { text: string; marker: string }) => {
		const index = args.text.indexOf(args.marker);
		const line = index === -1 ? 0 : args.text.slice(0, index).split("\n").length;
		return {
			output: [{ type: "text" as const, text: index === -1 ? `not found: ${JSON.stringify(args.marker)}` : `found at line ${line}` }],
			structuredOutput: { found: index !== -1, line },
		};
	},
});

/** The child-side extension: only local, side-effect-free tools. */
export const ChildTools = defineExtension({
	name: "multiagent-child-tools",
	tools: [textStatsTool, textCheckTool],
});

/** Tool names the child may be granted. The main model picks a subset per task. */
export const CHILD_TOOL_NAMES: readonly string[] = ["text_stats", "text_check"];
