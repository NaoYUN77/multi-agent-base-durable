// TASK-005.5 test/tui-terminal.test.ts
//
// The screen over a recorded terminal: the real `ControllerApp` and the real
// `TuiMainScreen`, mounted with the same calls `runScreen` makes.
//
// The terminal is a fake rather than a real pseudo-terminal, because the facts
// this suite proves are about input and lifecycle, not about escape rendering:
//
//   * what the frame says (header, table, conversation, status line) once a pass finished;
//   * ctrl+c asks before anything closes, and "n" keeps the session open;
//   * "y" closes the session once and leaves, and leaves without cancelling;
//   * `/cancel all` reaches the Main service's cancel request;
//   * `--no-animation` keeps the elapsed clock and drops the spinner.
//
// A human still runs the real terminal checklist in the README (AC-06): raw
// mode restore and Windows Terminal behaviour cannot be proven by a fake.

import { afterEach, describe, expect, it } from "vitest";
import { stripTerminalSequences, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { AgentSession, TaskRow, TuiSnapshot } from "../src/service/types.ts";
import { ControllerApp, QuitPrompt } from "../src/tui/app.ts";
import { Controller } from "../src/tui/controller.ts";
import { createTheme, plainPainter } from "../src/tui/theme.ts";

class FakeTerminal implements Terminal {
	written = "";
	started = false;
	input: ((data: string) => void) | undefined;
	resize: (() => void) | undefined;
	readonly columns = 100;
	readonly rows = 30;
	readonly kittyProtocolActive = false;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.started = true;
		this.input = onInput;
		this.resize = onResize;
	}

	stop(): void {
		this.started = false;
		this.input = undefined;
		this.resize = undefined;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.written += data;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}

	type(data: string): void {
		this.input?.(data);
	}
}

function row(taskId: string, status: TaskRow["status"]): TaskRow {
	return { taskId, batchId: "batch-1", title: `do ${taskId}`, status, statusSource: "ledger", round: 1, startedAt: Date.now() - 5_000, toolInvocations: { used: 1, limit: 3 }, failedToolCalls: { used: 0, limit: 2 }, retrying: false };
}

function snapshot(rows: readonly TaskRow[]): TuiSnapshot {
	return {
		takenAt: Date.now(),
		request: { requestVersion: 1, text: "run things", openQuestionIds: [], questions: [], answers: [], planCount: 1 },
		queue: [],
		mainBusy: false,
		tasks: rows,
		settledBatches: 1,
		totalBatches: 1,
		watchedTasks: rows.map((entry) => entry.taskId),
		watchedRequests: [],
		watchedBatches: ["batch-1"],
		openReconciliation: [],
		mainTasks: [],
	};
}

type Calls = { closed: number; cancelledAll: string[]; cancelled: string[]; failClose?: boolean; snapshots: number; snapshotDelayMs: number };

/** A session double: every call the controller can make is recorded. */
function fakeSession(latest: () => TuiSnapshot, calls: Calls): AgentSession {
	const unused = (): never => {
		throw new Error("not used by the terminal suite");
	};
	return {
		main: {
			withdrawQueued: async () => ({ withdrawn: false, reason: "not used" }),
			submitUserInput: async () => ({ kind: "refused", reason: "not used" }),
		} as unknown as AgentSession["main"],
		conversationId: 1 as AgentSession["conversationId"],
		context: unused as never,
		snapshot: async () => {
			calls.snapshots += 1;
			if (calls.snapshotDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, calls.snapshotDelayMs));
			return latest();
		},
		watch: async () => ({ mark: () => {}, flush: async () => {}, stop: async () => {} }),
		transcript: async () => [
			{ entryId: "1", kind: "user", text: "run things" },
			{ entryId: "2", kind: "assistant", text: "started" },
		],
		inspectTask: async () => undefined,
		cancelTask: async (taskId) => {
			calls.cancelled.push(taskId);
			return { taskId, outcome: "unknown-task", detail: "nothing" };
		},
		cancelAll: async (reason) => {
			calls.cancelledAll.push(reason ?? "");
			return { requested: true, reason: reason ?? "" };
		},
		close: async () => {
			calls.closed += 1;
			if (calls.failClose === true) throw new Error("storage refused the close");
		},
	};
}

const settle = async (): Promise<void> => {
	for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

/** The frame as the screen draws it, without escape sequences. */
function frame(app: ControllerApp, needle = ""): string {
	return app
		.render(100)
		.filter((line) => line.includes(needle))
		.map((line) => stripTerminalSequences(line))
		.join("\n")
		.trimEnd();
}

async function mount(latest: () => TuiSnapshot, animate = false) {
	const terminal = new FakeTerminal();
	const tui = new TuiMainScreen(terminal);
	const calls: Calls = { closed: 0, cancelledAll: [], cancelled: [], snapshots: 0, snapshotDelayMs: 0 };
	const session = fakeSession(latest, calls);
	let leave: (() => void) | undefined;
	const left = new Promise<void>((resolve) => {
		leave = resolve;
	});
	let app: ControllerApp | undefined;
	const controller = new Controller({
		session,
		animate,
		transcriptLimit: 50,
		host: {
			requestRender: () => tui.requestRender(),
			askQuit: () => app?.showQuit(),
			dismissQuit: () => app?.hideQuit(),
			leave: () => {
				tui.stop();
				leave?.();
			},
		},
	});
	app = new ControllerApp({ controller, tui, theme: createTheme(plainPainter()) });
	tui.addChild(app);
	tui.setFocus(app.editor());
	tui.start();
	await controller.start();
	// The first pass arrives through the change feed after the screen started;
	// a terminal draws its next frame once it has, which is what this forces.
	await settle();
	tui.renderNow(true);
	await settle();
	return { terminal, tui, app, controller, calls, left };
}

describe("TASK-005.5 terminal screen", { timeout: 30_000 }, () => {
	let mounted: Awaited<ReturnType<typeof mount>> | undefined;
	afterEach(() => {
		mounted?.tui.stop();
		mounted = undefined;
	});

	it("renders the table, the conversation and the status line from one pass", async () => {
		mounted = await mount(() => snapshot([row("t-alpha", "running"), row("t-beta", "queued")]));
		const text = frame(mounted.app);
		expect(text).toContain("pi-durable");
		expect(text).not.toContain("opening");
		expect(text).toContain("tasks");
		expect(text).toContain("t-alpha");
		expect(text).toContain("running");
		expect(text).toContain("t-beta");
		expect(text).toContain("queued");
		expect(text).toContain("main › started");
		expect(text).toContain("2 active");
		expect(text).toContain("ctrl+c quits");
	});

	it("ctrl+c asks first; n keeps the session open; y closes it once and leaves", async () => {
		mounted = await mount(() => snapshot([row("t-alpha", "running")]), false);
		const app = mounted.app;
		// The overlay is drawn on top of the frame, not inside it, so the
		// confirmation is read back from the program's own component.
		const shown = (): boolean => mounted?.tui.hasOverlay() === true;
		expect(shown()).toBe(false);

		mounted.terminal.type("\x03");
		await settle();
		expect(shown()).toBe(true);
		expect(mounted.calls.closed).toBe(0);

		mounted.terminal.type("n");
		await settle();
		expect(shown()).toBe(false);
		expect(mounted.calls.closed).toBe(0);
		expect(app.render(60).join("\n")).toContain("ctrl+c quits");

		mounted.terminal.type("\x03");
		await settle();
		expect(shown()).toBe(true);
		mounted.terminal.type("y");
		await mounted.left;
		await settle();
		expect(mounted.calls.closed).toBe(1);
		expect(mounted.calls.cancelledAll).toEqual([]);
		expect(mounted.calls.cancelled).toEqual([]);
		expect(mounted.terminal.started).toBe(false);
	});

	it("lets `/cancel all` reach the service and says what it asked for", async () => {
		let latest = snapshot([row("t-alpha", "running")]);
		mounted = await mount(() => latest);
		await mounted.controller.submit("/cancel all");
		const stopping = mounted.controller.view().state.stopping;
		expect(mounted.calls.cancelledAll).toEqual(["cancelled_by_user"]);
		latest = snapshot([row("t-alpha", "stopping")]);
		await mounted.controller.refresh();
		// The stop is shown until it settles: the row says `stopping`, and the stop
		// is remembered with what was asked for and when.
		expect(mounted.controller.view().state.stopping).toEqual(stopping);
		await settle();
		mounted.tui.renderNow(true);
		const text = frame(mounted.app);
		expect(text).toContain("cancel requested");
		expect(text).toContain("stopping        r1");

		// Once the receipt lands the quiet notice returns and the stop clears.
		latest = snapshot([row("t-alpha", "cancelled")]);
		await mounted.controller.refresh();
		expect(mounted.controller.view().state.stopping).toBeUndefined();
	});

	it("leaves even when closing the session throws", async () => {
		// The terminal is restored by leave(); a storage failure at close must not
		// keep the user in raw mode. Nothing is cancelled on the way out either.
		mounted = await mount(() => snapshot([row("t-alpha", "running")]), false);
		mounted.calls.failClose = true;
		await mounted.controller.confirmQuit();
		await mounted.left;
		expect(mounted.calls.closed).toBe(1);
		expect(mounted.terminal.started).toBe(false);
		expect(mounted.calls.cancelledAll).toEqual([]);
	});

	it("coalesces a burst of notifications into one follow-up pass", async () => {
		// A busy child commits many frames a second. The feed asks for a pass per
		// notification; a slow pass must absorb the burst rather than start one read
		// per frame.
		mounted = await mount(() => snapshot([row("t-alpha", "running")]), false);
		mounted.calls.snapshotDelayMs = 40;
		mounted.calls.snapshots = 0;
		const controller = mounted.controller as unknown as { refresh(): Promise<void> };
		const running = Promise.all([controller.refresh(), controller.refresh(), controller.refresh(), controller.refresh()]);
		await running;
		// One pass is running, one follows it; the four callers share them.
		expect(mounted.calls.snapshots).toBeLessThanOrEqual(2);
		expect(mounted.calls.snapshots).toBeGreaterThan(0);
	});

	it("draws the quit confirmation with its promise and its keys, and answers it by key", () => {
		const lines = new QuitPrompt(createTheme(plainPainter()), () => {}, () => {})
			.render(60)
			.map((line) => stripTerminalSequences(line));
		expect(lines.join("\n")).toContain("Quit?");
		expect(lines.join("\n")).toContain("Running tasks are not cancelled");
		expect(lines.join("\n")).toContain("[y / enter] quit");
		expect(lines.every((line) => [...line].length <= 60)).toBe(true);

		const answers: string[] = [];
		const prompt = new QuitPrompt(createTheme(plainPainter()), () => answers.push("yes"), () => answers.push("no"));
		prompt.handleInput("y");
		prompt.handleInput("n");
		prompt.handleInput("\x1b");
		prompt.handleInput("\x03");
		prompt.handleInput("\x04");
		prompt.handleInput("\r");
		expect(answers).toEqual(["yes", "no", "no", "no", "no", "yes"]);
	});

	it("under --no-animation the spinner is static and the elapsed clock still shows", async () => {
		mounted = await mount(() => snapshot([row("t-alpha", "running")]), false);
		const before = frame(mounted.app, "t-alpha");
		mounted.controller.tick();
		const after = frame(mounted.app, "t-alpha");
		expect(after).toBe(before);
		expect(after).not.toContain("⠋");
		expect(after).toMatch(/\d+s$/);
	});
});
