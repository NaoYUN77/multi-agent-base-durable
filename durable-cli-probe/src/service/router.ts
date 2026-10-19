// TASK-005.5 src/service/router.ts
//
// The editor's line, as a command or as input. Pure, and the only place a typed
// line is interpreted.
//
// Two rules it makes mechanical:
//
//   * **An answer goes to the question that is open.** `/answer <text>` names
//     the open question itself (the first one, the one the header shows), so a
//     reply typed while a question is open can never land on nothing or on a
//     different request: without a question it is refused, and with one it is
//     submitted through `answerTo`. A plain line while a question is open is
//     refused here rather than sent as a new task — the same rule the service
//     enforces, applied early so nothing is written.
//   * **A task is named, never guessed.** `/inspect`, `/cancel` and `/withdraw`
//     take the id the table shows. `/cancel` also accepts a unique prefix; an
//     ambiguous prefix is refused and the candidates listed.

import type { TuiSnapshot } from "./types.ts";

export type Route =
	/** Send as input: an ordinary request, or an answer to `answerTo`. */
	| { readonly kind: "send"; readonly text: string; readonly answerTo?: string; readonly sufficient?: boolean }
	| { readonly kind: "noop"; readonly notice: string }
	| { readonly kind: "help" }
	| { readonly kind: "tasks" }
	| { readonly kind: "inspect"; readonly taskId: string }
	| { readonly kind: "cancel"; readonly taskId: string }
	| { readonly kind: "cancel-all"; readonly reason: string }
	| { readonly kind: "withdraw"; readonly submissionId: string }
	| { readonly kind: "transcript" }
	| { readonly kind: "quit" }
	| { readonly kind: "panel"; readonly title: string; readonly lines: readonly string[] };

export const HELP_LINES: readonly string[] = [
	"enter              send the line as input (queued if Main is busy; refused if a question is open)",
	"/tasks             list tasks with their status words",
	"/inspect <id>      one task: rounds, limits, evidence count, failure",
	"/cancel <id>       stop one task's batch (the rest of Main keeps running)",
	"/cancel all        stop every batch and cancel the request",
	"/answer <text>     answer the open question (sufficient)",
	"/answer --insufficient <text>   reply that is not yet an answer",
	"/withdraw <id>     withdraw a queued input (its submission id from the header)",
	"/transcript        the latest conversation lines",
	"/help              this list",
	"/quit              leave (ctrl+c asks to confirm first)",
];

/** Resolve a task id argument: exact first, then a unique prefix. */
export function resolveTaskId(argument: string, snapshot: TuiSnapshot | undefined): { ok: true; taskId: string } | { ok: false; notice: string } {
	const ids = [...new Set((snapshot?.tasks ?? []).map((row) => row.taskId))];
	if (ids.includes(argument)) return { ok: true, taskId: argument };
	const matches = ids.filter((id) => id.startsWith(argument));
	if (matches.length === 1) return { ok: true, taskId: matches[0] as string };
	if (matches.length === 0) return { ok: false, notice: `no task matches ${argument}${ids.length === 0 ? " (no tasks yet)" : ` (known: ${ids.join(", ")})`}` };
	return { ok: false, notice: `${argument} is ambiguous: ${matches.join(", ")}` };
}

/**
 * Interpret one submitted line.
 *
 * @param line - the editor's text.
 * @param snapshot - the newest pass, which decides the open question and the task ids.
 */
export function routeLine(line: string, snapshot: TuiSnapshot | undefined): Route {
	const text = line.trim();
	if (text === "") return { kind: "noop", notice: "nothing to send" };
	if (!text.startsWith("/")) {
		const open = snapshot?.request.openQuestionIds ?? [];
		if (open.length > 0) {
			return { kind: "noop", notice: `a question is open (${open[0]}); answer it with /answer <text>, or /answer --insufficient <text> if it is not yet an answer` };
		}
		return { kind: "send", text };
	}
	const space = text.search(/\s/);
	const command = (space < 0 ? text : text.slice(0, space)).toLowerCase();
	const rest = space < 0 ? "" : text.slice(space + 1).trim();
	switch (command) {
		case "/help":
			return { kind: "help" };
		case "/tasks":
			return { kind: "tasks" };
		case "/transcript":
			return { kind: "transcript" };
		case "/quit":
		case "/exit":
			return { kind: "quit" };
		case "/inspect": {
			if (rest === "") return { kind: "noop", notice: "/inspect needs a task id" };
			const resolved = resolveTaskId(rest, snapshot);
			return resolved.ok ? { kind: "inspect", taskId: resolved.taskId } : { kind: "noop", notice: resolved.notice };
		}
		case "/cancel": {
			if (rest === "") return { kind: "noop", notice: "/cancel needs a task id or `all`" };
			if (rest === "all") return { kind: "cancel-all", reason: "cancelled_by_user" };
			const resolved = resolveTaskId(rest, snapshot);
			return resolved.ok ? { kind: "cancel", taskId: resolved.taskId } : { kind: "noop", notice: resolved.notice };
		}
		case "/answer": {
			const open = snapshot?.request.openQuestionIds ?? [];
			const questionId = open[0];
			if (questionId === undefined) return { kind: "noop", notice: "no question is open; nothing to answer" };
			const insufficient = rest === "--insufficient" || rest.startsWith("--insufficient ");
			const answer = insufficient ? rest.replace(/^--insufficient\s*/, "").trim() : rest;
			if (answer === "") return { kind: "noop", notice: "/answer needs the reply text" };
			// The judgement is the application's, and it is explicit: a plain answer is
			// judged sufficient; `--insufficient` says it is not, and the question stays open.
			return { kind: "send", text: answer, answerTo: questionId, sufficient: !insufficient };
		}
		case "/withdraw": {
			if (rest === "") return { kind: "noop", notice: "/withdraw needs a submission id (shown in the queued line)" };
			return { kind: "withdraw", submissionId: rest };
		}
		default:
			return { kind: "noop", notice: `unknown command ${command}; /help lists the commands` };
	}
}
