// TASK-005.5 src/service/view.ts
//
// The terminal view as a pure function of a snapshot and a clock.
//
// Everything the screen shows is computed here, without a terminal, a clock of
// its own or a session: `renderView` takes the newest `TuiSnapshot`, the
// elapsed-clock base and the terminal width, and returns the lines. The TUI
// component paints those lines; the tests turn them into strings. A renderer
// that decided a status itself would be a second state machine, so it decides
// nothing — every word comes from `deriveTaskRow`.
//
// Time is shown in exactly one way: how long a task has been running, from the
// ledger's round start. Never a percentage: no document counts steps, so a
// percentage would be invented (Issue #20). Queued inputs and batches are shown
// as counts ("1 of 2 batches settled"), which is what the documents say.

import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusTone, Theme } from "../tui/theme.ts";
import type { SubmitOutcome } from "./main-service.ts";
import type { TaskRow, TaskRowStatus, TranscriptLine, TuiSnapshot } from "./types.ts";

/** What the TUI remembers between renders; none of it is business state. */
export type ViewState = {
	/** The newest pass, or `undefined` before the first one finished. */
	readonly snapshot?: TuiSnapshot;
	/** A pass failed with this message; shown until the next pass succeeds. */
	readonly readError?: string;
	/** The last input's outcome (sent, queued, answered, refused). */
	readonly notice?: string;
	/** The last command's answer (`/tasks`, `/help`, `/inspect`, ...), below the table. */
	readonly panel?: { readonly title: string; readonly lines: readonly string[] };
	/** A stop was asked for and its receipt has not arrived yet. */
	readonly stopping?: { readonly what: string; readonly ids: readonly string[]; readonly at: number };
};

export type RenderInput = {
	readonly state: ViewState;
	/** Monotonic milliseconds at render time; the elapsed clock reads against it. */
	readonly now: number;
	readonly width: number;
	readonly height: number;
	/** False for `--no-animation`: no spinner anywhere; durations still show. */
	readonly animate: boolean;
	/** Spinner frame index; advances only when `animate`. */
	readonly frame: number;
	readonly transcript: readonly TranscriptLine[];
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Every word the status column can hold. Written as a `Record` so a status added
 * to `TaskRowStatus` stops the build here, where its word's width is measured.
 */
const STATUS_WORDS: Record<TaskRowStatus, true> = {
	planned: true,
	queued: true,
	running: true,
	retry_wait: true,
	stopping: true,
	"awaiting-review": true,
	"awaiting-input": true,
	accepted: true,
	failed: true,
	cancelled: true,
};

/** Wide enough for the longest status word (`awaiting review`): a column one cell short shifts every later cell. */
const STATUS_WIDTH = Math.max(...(Object.keys(STATUS_WORDS) as TaskRowStatus[]).map((status) => visibleWidth(statusLabel(status))));

const WORKING: ReadonlySet<TaskRowStatus> = new Set(["planned", "queued", "running", "retry_wait", "stopping"]);

const FINISHED: ReadonlySet<TaskRowStatus> = new Set(["accepted", "failed", "cancelled"]);

/** Status words as the screen shows them. Only the separator changes. */
export function statusLabel(status: TaskRowStatus): string {
	switch (status) {
		case "awaiting-review":
			return "awaiting review";
		case "awaiting-input":
			return "awaiting input";
		case "retry_wait":
			return "retry wait";
		default:
			return status;
	}
}

/** The tone a status word is drawn in. Derived from the word alone. */
export function statusTone(status: TaskRowStatus): StatusTone {
	switch (status) {
		case "running":
			return "active";
		case "queued":
		case "planned":
		case "retry_wait":
		case "stopping":
			return "waiting";
		case "awaiting-review":
		case "awaiting-input":
			return "attention";
		case "accepted":
			return "good";
		case "failed":
			return "bad";
		case "cancelled":
			return "neutral";
	}
}

/**
 * Format a duration as a coarse, human reading: `0s`, `12s`, `3m04s`, `2h07m`.
 * Never negative: a clock that went backwards shows zero, not a wrong time.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** `used/limit` when a limit is known, `used` otherwise. */
function counter(used: number, limit: number | undefined): string {
	return limit === undefined ? String(used) : `${used}/${limit}`;
}

/**
 * The elapsed clock of one row: since the current round started, up to the
 * receipt when there is one. Empty for a row that never started.
 */
function elapsedOf(row: TaskRow, now: number): string {
	if (row.startedAt === undefined) return "";
	if (row.settledAt !== undefined) return formatElapsed(row.settledAt - row.startedAt);
	if (FINISHED.has(row.status)) return "";
	return formatElapsed(now - row.startedAt);
}

/** Hard-cut text to a column width, so a long id never wraps a table row. */
function fitColumns(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return `${sliceByColumn(text, 0, Math.max(0, width - 1), true)}…`;
}

/**
 * One drawn line, never two.
 *
 * A purpose, an error message or a quoted refusal can hold a newline: the frame
 * gives each element of a block exactly one line, so the text is folded first.
 */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function pad(text: string, width: number): string {
	const fitted = fitColumns(text, width);
	return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

/**
 * Wrap at column boundaries, keeping every line inside the width.
 *
 * A paragraph with a newline in it is several lines, and the callers budget by
 * the lines they get back: one element that draws three would push the frame
 * past the height it was given.
 */
function wrap(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.replace(/\r/g, "").split("\n")) {
		const total = visibleWidth(paragraph);
		for (let offset = 0; offset < Math.max(1, total); offset += Math.max(1, width)) lines.push(fitColumns(sliceByColumn(paragraph, offset, width, true), width));
	}
	return lines;
}

/**
 * The row's first cell: the id every command takes, then the saved purpose when
 * the documents hold one that says more than the id does.
 */
function taskCell(row: TaskRow): string {
	const title = oneLine(row.title);
	return title === "" || title === row.taskId ? row.taskId : `${row.taskId}  ${title}`;
}

/** The task table: one row per task, in the runtime's admission order. */
export function taskTableLines(rows: readonly TaskRow[], now: number, width: number, animate: boolean, frame: number, theme?: Theme): string[] {
	const fixed = STATUS_WIDTH + 5 + 7 + 7 + 9 + 10;
	const task = { header: "task", width: Math.max(10, Math.min(26, width - fixed)) };
	const status = { header: "status", width: STATUS_WIDTH };
	const round = { header: "round", width: 5 };
	const tools = { header: "tools", width: 7 };
	const failed = { header: "failed", width: 7 };
	const elapsed = { header: "elapsed", width: 9 };
	const columns = [task, status, round, tools, failed, elapsed];
	const heading = columns.map((column) => pad(column.header, column.width)).join("  ").trimEnd();
	const lines = [theme === undefined ? heading : theme.dim(heading)];
	if (rows.length === 0) {
		lines.push("(no tasks yet: send an input and Main plans and dispatches)");
		return lines;
	}
	const spinner = `${SPINNER[frame % SPINNER.length] ?? "⠋"} `;
	for (const row of rows) {
		const working = WORKING.has(row.status);
		const marker = animate && working ? spinner : "  ";
		const word = statusLabel(row.status);
		const painted = theme === undefined ? word : theme.status(word, statusTone(row.status));
		// Pad the plain word first, then paint, so colour never changes a column.
		const statusCell = painted + " ".repeat(Math.max(0, status.width - visibleWidth(word)));
		lines.push(
			[
				pad(marker + taskCell(row), task.width),
				statusCell,
				pad(row.round === 0 ? "-" : `r${row.round}`, round.width),
				pad(counter(row.toolInvocations.used, row.toolInvocations.limit), tools.width),
				pad(counter(row.failedToolCalls.used, row.failedToolCalls.limit), failed.width),
				pad(elapsedOf(row, now), elapsed.width),
			]
				.join("  ")
				.trimEnd(),
		);
	}
	return lines;
}

/** The header: what Main is doing, what it waits on, and the queue and batches. */
function headerLines(snapshot: TuiSnapshot | undefined, input: RenderInput, theme: Theme): string[] {
	const { width, now } = input;
	if (snapshot === undefined) return [theme.title("pi-durable") + theme.dim(" · opening…")];
	const busy = snapshot.mainBusy ? "main busy" : "main idle";
	const live = snapshot.mainTasks.length === 0 ? "" : ` (${snapshot.mainTasks.map((task) => `${task.name} ${task.state}`).join(", ")})`;
	const requestText = snapshot.request.requestId === undefined ? "" : ` · request ${snapshot.request.requestId} v${snapshot.request.requestVersion}`;
	const lines = [fitColumns(`${theme.title("pi-durable")} · ${busy}${live}${requestText}`, width)];
	if (snapshot.openReconciliation.length > 0) lines.push(fitColumns(theme.warning(`reopened: reconciled ${snapshot.openReconciliation.length} batch(es)`), width));
	const open = snapshot.request.openQuestionIds;
	if (open.length > 0) {
		const question = snapshot.request.questions.find((entry) => entry.questionId === open[0]);
		lines.push(fitColumns(theme.warning(oneLine(`main asks ${open.join(", ")}${question === undefined ? "" : `: ${question.question}`}`)), width));
		lines.push(theme.dim("reply with /answer <text>, or /answer --insufficient <text>"));
	}
	if (snapshot.queue.length > 0) {
		const heads = snapshot.queue.slice(0, 3).map((entry) => `#${entry.submissionId} ${entry.text.replace(/\s+/g, " ")}`);
		lines.push(fitColumns(`queued ${snapshot.queue.length}: ${heads.join(" | ")}${snapshot.queue.length > 3 ? " | …" : ""}`, width));
	}
	lines.push(theme.dim(`batches ${snapshot.settledBatches} of ${snapshot.totalBatches} settled · tasks ${snapshot.tasks.length} · read ${formatElapsed(now - snapshot.takenAt)} ago`));
	return lines;
}

/** The conversation tail: the newest entries that fit, oldest first. */
function transcriptLines(input: RenderInput, room: number, theme: Theme): string[] {
	if (room <= 0) return [];
	const lines: string[] = [];
	for (const entry of input.transcript) {
		const head = entry.kind === "user" ? "you  › " : entry.kind === "assistant" ? "main › " : entry.kind === "tool" ? "tool › " : "     ";
		for (const paragraph of entry.text.replace(/\r/g, "").split("\n")) {
			// Long entries are cut here and the table keeps the room; the full text is
			// in the database, and `/transcript` shows more of it.
			const body = fitColumns(paragraph, Math.max(1, input.width - visibleWidth(head)));
			const line = fitColumns(head + body, input.width);
			lines.push(entry.kind === "tool" ? theme.dim(line) : line);
		}
	}
	return lines.slice(-room);
}

/**
 * Render the whole frame.
 *
 * The header, table, notice and status line are always drawn. The command
 * panel comes next; the transcript gets what is left, newest last. On a short
 * terminal the transcript shrinks first, then the panel keeps at most a few
 * lines — nothing the frame needs is ever silently dropped except the
 * transcript tail, which the header's count and `/transcript` make up for.
 */
export function renderView(input: RenderInput, theme: Theme): string[] {
	const { state, now, width, height } = input;
	const snapshot = state.snapshot;
	const head = headerLines(snapshot, input, theme);
	const table = ["", theme.dim("tasks"), ...taskTableLines(snapshot?.tasks ?? [], now, width, input.animate, input.frame, theme)];
	const notice = noticeText(state, now);
	const fixedTail = 3 + (notice === undefined ? 0 : 2) + (state.readError === undefined ? 0 : 1);
	const panelAll = state.panel === undefined ? [] : ["", theme.dim(`── ${state.panel.title} ──`), ...state.panel.lines.flatMap((line) => wrap(line, width))];
	// The transcript block brings a blank line and a heading of its own. A budget
	// that forgot them made the frame one line taller than the height it was given,
	// which pushes the header's first line out of the terminal's viewport.
	const block = 2;
	const panelRoom = Math.max(0, height - head.length - table.length - fixedTail - block);
	const panel = panelAll.slice(0, panelRoom);
	const transcript = transcriptLines(input, Math.max(0, height - head.length - table.length - panel.length - fixedTail - block), theme);
	const out = [...head];
	if (transcript.length > 0) out.push("", theme.dim("conversation (newest last)"), ...transcript);
	out.push(...table, ...panel);
	if (notice !== undefined) out.push("", theme.dim(fitColumns(oneLine(notice), width)));
	if (state.readError !== undefined) out.push(theme.warning(fitColumns(oneLine(`read error: ${state.readError} (showing the last good pass)`), width)));
	out.push(theme.frame("─".repeat(Math.max(1, width))));
	out.push(statusLine(snapshot, state, input));
	return out.map((line) => fitColumns(line, width));
}

function noticeText(state: ViewState, now: number): string | undefined {
	if (state.stopping !== undefined) return `stopping ${state.stopping.what}, asked ${formatElapsed(now - state.stopping.at)} ago — the table shows the receipt when it lands`;
	return state.notice;
}

/** One line: what is happening now, and the keys that matter. */
export function statusLine(snapshot: TuiSnapshot | undefined, state: ViewState, input: RenderInput): string {
	const parts: string[] = [input.animate ? (SPINNER[input.frame % SPINNER.length] ?? "⠋") : "·"];
	const rows = snapshot?.tasks ?? [];
	const working = rows.filter((row) => WORKING.has(row.status) && row.status !== "planned").length;
	if (working > 0) parts.push(`${working} active`);
	const asking = snapshot?.request.openQuestionIds.length ?? 0;
	if (asking > 0) parts.push(`${asking} open question(s)`);
	if (snapshot !== undefined && working === 0 && asking === 0) parts.push("idle");
	if (state.stopping !== undefined) parts.push(`stopping ${state.stopping.what}`);
	parts.push("enter sends · /help · ctrl+c quits");
	return fitColumns(parts.join(" · "), input.width);
}

/** How a submission outcome reads in the notice line. */
export function outcomeNotice(outcome: SubmitOutcome): string {
	switch (outcome.kind) {
		case "request":
			return `sent as request ${outcome.requestId} v${outcome.requestVersion}`;
		case "answer":
			return `answered ${outcome.questionId}`;
		case "queued":
			return `queued: ${outcome.reason}`;
		case "refused":
			return `refused: ${outcome.reason}`;
	}
}
