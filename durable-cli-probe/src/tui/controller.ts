// TASK-005.5 src/tui/controller.ts
//
// The terminal entry's behaviour, separate from its drawing.
//
// `Controller` owns everything between a submitted line and the screen: it
// asks the session to read, interprets a line with `routeLine`, calls the one
// service method the route names, and keeps the small view state the screen
// shows (`notice`, `panel`, `stopping`). It draws nothing itself; `app.ts`
// renders it over pi-tui and `view.ts` formats the frame, so the pieces the
// tests drive are the pieces that ship.
//
// What the controller never does:
//
//   * It never cancels anything on quit. `confirmQuit()` stops the watches and
//     calls `session.close()`, which says so in its own header: work that was
//     running pauses at its last durable point and the next open replays it.
//   * It never treats Ctrl+C as "cancel". The app shows the quit confirmation;
//     only `confirmQuit()` quits.
//   * It never re-implements a service rule. An answer without a judgement, a
//     queued input, a refused restatement: each is the service's answer to
//     report, not the controller's decision to make.

import { HELP_LINES, routeLine } from "../service/router.ts";
import type { AgentSession, SessionWatch, TaskDetail, TaskRow, TranscriptLine, TuiSnapshot } from "../service/types.ts";
import { outcomeNotice, type ViewState } from "../service/view.ts";

/** Everything the controller needs from the terminal. */
export type ControllerHost = {
	/** Request a redraw. */
	readonly requestRender: () => void;
	/** Show the quit confirmation; `confirmQuit` and `cancelQuit` answer it. */
	readonly askQuit: () => void;
	/** Close the quit confirmation and restore the editor. */
	readonly dismissQuit: () => void;
	/** Restore the terminal and finish; called once, after the session is closed. */
	readonly leave: () => void;
};

/** The part of the session the controller uses. */
export type ControllerSession = Pick<AgentSession, "main" | "snapshot" | "watch" | "transcript" | "inspectTask" | "cancelTask" | "cancelAll" | "close">;

export type ControllerOptions = {
	readonly session: ControllerSession;
	readonly host: ControllerHost;
	readonly animate: boolean;
	readonly transcriptLimit: number;
	readonly now?: () => number;
};

/** What the screen renders. */
export type ControllerView = {
	readonly state: ViewState;
	readonly now: number;
	readonly transcript: readonly TranscriptLine[];
	readonly animate: boolean;
};

export class Controller {
	private readonly session: ControllerSession;
	private readonly host: ControllerHost;
	private readonly animate: boolean;
	private readonly transcriptLimit: number;
	private readonly now: () => number;
	private state: ViewState = {};
	private transcript: readonly TranscriptLine[] = [];
	private watch: SessionWatch | undefined;
	private refreshing = false;
	private readonly waiting: (() => void)[] = [];
	private quitting = false;
	private started = false;

	constructor(options: ControllerOptions) {
		this.session = options.session;
		this.host = options.host;
		this.animate = options.animate;
		this.transcriptLimit = options.transcriptLimit;
		this.now = options.now ?? Date.now;
	}

	/** Subscribe to passes and run the first one. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.watch = await this.session.watch(() => {
			void this.refresh();
		});
		await this.reloadTranscript();
		// The first pass is taken here rather than waited for through the feed:
		// nothing is watching yet, so a flush that only resolves after a watched
		// change has nothing to wait for.
		await this.refresh();
	}

	view(): ControllerView {
		return { state: this.state, now: this.now(), transcript: this.transcript, animate: this.animate };
	}

	/** Ask for the next spinner frame; a no-op under `--no-animation`. */
	tick(): void {
		if (!this.animate) return;
		this.host.requestRender();
	}

	/**
	 * One read pass, requested now (a command may need it before acting).
	 *
	 * Coalesced and single-flight: a change that arrives while a pass runs joins
	 * one follow-up pass instead of starting a second read, and every caller
	 * resolves only after a pass that began after its call finished. Without this,
	 * a busy child commits many frames a second and each notification would start
	 * its own read of every document.
	 */
	async refresh(): Promise<void> {
		if (this.quitting) return;
		const settled = new Promise<void>((resolve) => {
			this.waiting.push(resolve);
		});
		if (this.refreshing) return settled;
		this.refreshing = true;
		try {
			while (this.waiting.length > 0 && !this.quitting) {
				const batch = this.waiting.splice(0);
				await this.readOnce();
				for (const resolve of batch) resolve();
			}
		} finally {
			this.refreshing = false;
			for (const resolve of this.waiting.splice(0)) resolve();
		}
		return settled;
	}

	/** One pass: read, keep the stop until it settles, request a redraw. */
	private async readOnce(): Promise<void> {
		if (this.quitting) return;
		try {
			const snapshot = await this.session.snapshot(this.now());
			if (this.quitting) return;
			const { readError: _stale, ...rest } = this.state;
			const stopping = rest.stopping;
			const settled = stopping === undefined || this.stopSettled(snapshot, stopping.ids);
			this.state = { ...rest, snapshot, ...(stopping === undefined || settled ? { stopping: undefined } : {}) };
			this.host.requestRender();
		} catch (error) {
			this.state = { ...this.state, readError: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * Whether every task a stop was asked for has left `stopping`: the table now
	 * shows the receipt, and the notice has said its piece.
	 */
	private stopSettled(snapshot: TuiSnapshot, ids: readonly string[]): boolean {
		if (ids.length === 0) return !snapshot.mainBusy && snapshot.tasks.every((row) => row.status !== "stopping");
		return ids.every((id) => {
			const row = snapshot.tasks.find((entry) => entry.taskId === id);
			return row === undefined || row.status !== "stopping";
		});
	}

	/** The editor submitted a line. */
	async submit(line: string): Promise<void> {
		// A command is read against the newest pass. Before the first one finished,
		// read now: `/answer` and `/cancel` must see the question and the ids.
		if (this.state.snapshot === undefined) await this.refresh();
		const route = routeLine(line, this.state.snapshot);
		switch (route.kind) {
			case "noop":
				this.notice(route.notice);
				return;
			case "quit":
				this.host.askQuit();
				return;
			case "help":
				this.panel("help", HELP_LINES);
				return;
			case "tasks":
				this.panel("tasks", this.taskPanelLines(this.state.snapshot));
				return;
			case "transcript":
				await this.reloadTranscript();
				this.panel(
					"transcript",
					this.transcript.slice(-20).flatMap((entry) => [`${entry.kind} ${entry.entryId}`, ...entry.text.split("\n").map((part) => `  ${part}`)]),
				);
				return;
			case "inspect":
				await this.inspect(route.taskId);
				return;
			case "cancel":
				await this.cancel(route.taskId);
				return;
			case "cancel-all":
				await this.cancelAll(route.reason);
				return;
			case "withdraw": {
				const outcome = await this.session.main.withdrawQueued(route.submissionId);
				this.notice(outcome.withdrawn ? `withdrew ${route.submissionId}` : `not withdrawn: ${outcome.reason}`);
				await this.refresh();
				return;
			}
			case "panel":
				this.panel(route.title, route.lines);
				return;
			case "send": {
				const outcome = await this.session.main.submitUserInput({
					text: route.text,
					...(route.answerTo === undefined ? {} : { answerTo: route.answerTo }),
					...(route.sufficient === undefined ? {} : { sufficient: route.sufficient }),
				});
				this.notice(outcomeNotice(outcome));
				await this.refresh();
				await this.reloadTranscript();
				return;
			}
		}
	}

	/** The quit confirmation was answered yes: stop reading, close, leave. */
	async confirmQuit(): Promise<void> {
		if (this.quitting) return;
		this.quitting = true;
		this.host.dismissQuit();
		// The watches stop first so no pass starts against a closing session; the
		// session's own close stops its feed for the same reason. A close that
		// throws must still end in `leave()`: the terminal is restored by it, and
		// leaving the user in raw mode because storage refused is the worse failure.
		// Nothing is left to report the error to once the screen is gone; the next
		// open meets the same storage state and reports it there.
		try {
			await this.watch?.stop();
			await this.session.close();
		} catch {
			// See above.
		} finally {
			this.host.leave();
		}
	}

	cancelQuit(): void {
		this.host.dismissQuit();
		this.host.requestRender();
	}

	/** The newest pass, for a host that needs one before its first render. */
	async ready(): Promise<TuiSnapshot | undefined> {
		return this.state.snapshot;
	}

	private async inspect(taskId: string): Promise<void> {
		const detail = await this.session.inspectTask(taskId, this.now());
		if (detail === undefined) {
			this.notice(`no task ${taskId} in any admitted batch or ledger`);
			await this.refresh();
			return;
		}
		this.panel(`task ${taskId}`, detailLines(detail));
	}

	private async cancel(taskId: string): Promise<void> {
		const result = await this.session.cancelTask(taskId);
		this.notice(
			result.outcome === "cancelled"
				? `${taskId}: cancelled (the receipt proves it)`
				: result.outcome === "stopping"
					? `${taskId}: stopping — ${result.detail}`
					: result.outcome === "already-terminal"
						? `${taskId}: already finished (${result.detail}); nothing changed`
						: result.outcome === "settled"
							? `${taskId}: its batch had already settled (${result.detail})`
							: `${taskId}: not found (${result.detail}); nothing changed`,
		);
		if (result.outcome === "stopping") this.state = { ...this.state, stopping: { what: taskId, ids: [taskId], at: this.now() } };
		await this.refresh();
	}

	private async cancelAll(reason: string): Promise<void> {
		await this.session.cancelAll(reason);
		this.state = { ...this.state, stopping: { what: "all batches", ids: [], at: this.now() } };
		this.notice("cancel requested: every batch is stopping and Main is aborted; the table shows each receipt");
		await this.refresh();
	}

	private taskPanelLines(snapshot: TuiSnapshot | undefined): readonly string[] {
		if (snapshot === undefined) return ["no pass has finished yet"];
		if (snapshot.tasks.length === 0) return ["no tasks yet"];
		return snapshot.tasks.map(rowLine);
	}

	private panel(title: string, lines: readonly string[]): void {
		this.state = { ...this.state, panel: { title, lines } };
		this.host.requestRender();
	}

	private notice(text: string): void {
		this.state = { ...this.state, notice: text };
		this.host.requestRender();
	}

	private async reloadTranscript(): Promise<void> {
		try {
			// Reloaded in the background after a send: a transcript read is not a pass,
			// and the screen must not wait for it.
			const transcript = await this.session.transcript(this.transcriptLimit);
			if (this.quitting) return;
			this.transcript = transcript;
		} catch (error) {
			this.state = { ...this.state, readError: error instanceof Error ? error.message : String(error) };
		}
		this.host.requestRender();
	}
}

function rowLine(row: TaskRow): string {
	return `${row.taskId}  ${row.status} (${row.statusSource})  round ${row.round}  batch ${row.batchId}${row.queuePosition === undefined ? "" : `  queue #${row.queuePosition}`}`;
}

/** The detail pane: the contract, the rounds with their counters, and how it ended. */
export function detailLines(detail: TaskDetail): string[] {
	const { row } = detail;
	const lines: string[] = [
		`${row.taskId}  ${row.status} (from ${row.statusSource})  round ${row.round}${row.roundStatus === undefined ? "" : ` (${row.roundStatus})`}  batch ${row.batchId}`,
	];
	if (detail.purpose !== undefined) lines.push(`purpose: ${detail.purpose}`);
	if (detail.stopRequested !== undefined) lines.push(`stop recorded: ${detail.stopRequested.kind} at ${new Date(detail.stopRequested.at).toISOString()} (${detail.stopRequested.reason})`);
	if (detail.failure !== undefined) lines.push(`failure: ${detail.failure.reason}${detail.failure.detail === undefined ? "" : ` — ${detail.failure.detail}`}`);
	if (detail.constraints.length > 0) lines.push("constraints:", ...detail.constraints.map((entry) => `  - ${entry}`));
	if (detail.acceptance.length > 0) lines.push("acceptance:", ...detail.acceptance.map((entry) => `  - ${entry}`));
	for (const round of detail.rounds) {
		const tools = `tools ${round.toolInvocations.used}${round.toolInvocations.limit === undefined ? "" : `/${round.toolInvocations.limit}`}`;
		const failed = `failed ${round.failedToolCalls.used}${round.failedToolCalls.limit === undefined ? "" : `/${round.failedToolCalls.limit}`}`;
		const elapsed = round.settledAt === undefined ? "open" : `${Math.max(0, Math.round((round.settledAt - round.startedAt) / 1000))}s`;
		lines.push(`round ${round.round} (${round.kind}) ${round.status ?? "no execution"} · ${elapsed} · ${tools} · ${failed} · evidence ${round.evidenceCount}`);
		if (round.resultSummary !== undefined) lines.push(`  result: ${round.resultSummary.replace(/\s+/g, " ")}`);
	}
	if (detail.evidence.length > 0) {
		lines.push(`evidence (${detail.evidence.length}):`);
		for (const entry of detail.evidence.slice(0, 20)) lines.push(`  r${entry.round} ${entry.entryId}`);
		if (detail.evidence.length > 20) lines.push(`  … ${detail.evidence.length - 20} more`);
	}
	if (detail.attemptsUsed !== undefined) lines.push(`attempts used: ${detail.attemptsUsed}`);
	return lines;
}
