// TASK-005.2 src/agent/prompts/main.ts
//
// Assembly of the Main agent's instructions. Configuration assembly only: this
// module performs no IO beyond reading its own prompt file, starts no
// conversation, and writes no document. The rendered text is what the
// conversation's agent actually receives, so a test can read it back rather than
// assert that a string was built somewhere.

import { readFileSync } from "node:fs";

/** Where the Main prompt text lives, relative to this module. */
const MAIN_PROMPT_URL = new URL("./main/main.md", import.meta.url);

/**
 * The Main agent's instructions, as installed in the conversation.
 *
 * `extra` is appended verbatim after the base text, so a caller can add
 * deployment-specific guidance without this module knowing about it. Pure apart
 * from reading the prompt file; the result is a plain string.
 */
export function mainInstructions(extra?: string): string {
	const base = readFileSync(MAIN_PROMPT_URL, "utf8");
	if (extra === undefined || extra.trim() === "") return base;
	return `${base}\n\n${extra}`;
}
