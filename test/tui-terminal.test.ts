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

import { afterEach, describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { AgentSession, TaskRow, TuiSnapshot } from "../src/service/types.ts";
import type { McpServerStatus } from "../src/mcp/manager.ts";
import { HELP_LINES, routeLine } from "../src/service/router.ts";
import { type ControllerApp, mountApp, QuitPrompt } from "../src/tui/app.ts";
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

const MODELS: TuiSnapshot["model"] = {
	current: { provider: "faux", modelId: "faux-1" },
	available: [
		{ provider: "faux", modelId: "faux-1", name: "Faux One", contextWindow: 128_000 },
		{ provider: "faux", modelId: "faux-2", name: "Faux Two", contextWindow: 64_000 },
	],
};

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
		model: MODELS,
	};
}

type Calls = { closed: number; cancelledAll: string[]; cancelled: string[]; models: [string, string][]; failClose?: boolean; failCancelAll?: boolean; snapshots: number; snapshotDelayMs: number };

/** A session double: every call the controller can make is recorded. */
function fakeSession(latest: () => TuiSnapshot, calls: Calls): AgentSession {
	const unused = (): never => {
		throw new Error("not used by the terminal suite");
	};
	return {
		mcpStatus: () => [],
		connectMcp: unused,
		disconnectMcp: unused,
		setModel: async (provider, modelId) => {
			calls.models.push([provider, modelId]);
			// The service's own rule, mirrored: an id the provider does not offer is
			// refused, and nothing is written.
			const option = latest().model.available.find((entry) => entry.provider === provider && entry.modelId === modelId);
			return option === undefined
				? { provider, modelId, outcome: "unavailable", detail: "the installed provider does not offer it" }
				: { provider, modelId, outcome: "set", detail: option.name };
		},
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
			if (calls.failCancelAll === true) throw new Error("the storage refused the cancel");
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
	const calls: Calls = { closed: 0, cancelledAll: [], cancelled: [], models: [], snapshots: 0, snapshotDelayMs: 0 };
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
	// The same mount the real entry uses, so the editor this suite drives is the
	// editor `runScreen` draws.
	app = mountApp(tui, controller, createTheme(plainPainter()));
	tui.start();
	await controller.start();
	// The first pass arrives through the change feed after the screen started;
	// a terminal draws its next frame once it has, which is what this forces.
	await settle();
	tui.renderNow(true);
	await settle();
	return { terminal, tui, app, controller, session, calls, left };
}

describe("TASK-005.5 terminal screen", { timeout: 30_000 }, () => {
	let mounted: Awaited<ReturnType<typeof mount>> | undefined;
	afterEach(() => {
		// An animated mount runs a frame timer. Leaving it running would tick a
		// stopped screen for the rest of the suite.
		mounted?.app.dispose();
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

	it("routes MCP commands strictly and includes them in help", () => {
		expect(routeLine("/mcp", undefined)).toEqual({ kind: "mcp" });
		expect(routeLine("/mcp connect local", undefined)).toEqual({ kind: "connect-mcp", name: "local" });
		expect(routeLine("/mcp disconnect local", undefined)).toEqual({ kind: "disconnect-mcp", name: "local" });
		for (const line of ["/mcp connect", "/mcp disconnect", "/mcp list", "/mcp connect local extra", "/mcp disconnect local extra"]) {
			expect(routeLine(line, undefined)).toMatchObject({ kind: "noop", notice: expect.stringContaining("/mcp") });
		}
		expect(HELP_LINES.join("\n")).toContain("/mcp");
	});

	it("lists MCP status, connects and disconnects by name without exposing server text", async () => {
		mounted = await mount(() => snapshot([]));
		const session = mounted.session;
		const secret = "secret-from-server";
		let state: McpServerStatus["state"] = "idle";
		const status = (): McpServerStatus => ({
			name: "local", transport: "stdio", target: "node", state,
			tools: ["echo"], resources: [`https://example.invalid/?token=${secret}`],
			instructions: secret, error: secret,
		});
		const connected: string[] = [];
		const disconnected: string[] = [];
		vi.spyOn(session, "mcpStatus").mockImplementation(() => [status()]);
		vi.spyOn(session, "connectMcp").mockImplementation(async (name) => {
			connected.push(name);
			state = "connected";
			return status();
		});
		vi.spyOn(session, "disconnectMcp").mockImplementation(async (name) => {
			disconnected.push(name);
			state = "idle";
		});
		await mounted.controller.submit("/mcp");
		expect(frame(mounted.app)).toContain("local  idle  stdio  node");
		expect(frame(mounted.app)).toContain("tools 1");
		expect(frame(mounted.app)).toContain("resources 1");
		expect(frame(mounted.app)).not.toContain(secret);
		await mounted.controller.submit("/mcp connect local");
		expect(connected).toEqual(["local"]);
		expect(frame(mounted.app)).toContain("local  connected");
		await mounted.controller.submit("/mcp disconnect local");
		expect(disconnected).toEqual(["local"]);
		expect(frame(mounted.app)).toContain("local  idle");
		state = "failed";
		await mounted.controller.submit("/mcp");
		expect(frame(mounted.app)).toContain("connection failed");
		expect(frame(mounted.app)).not.toContain(secret);
	});

	it("reports empty MCP config and contains operation failures without secret values", async () => {
		mounted = await mount(() => snapshot([]));
		const session = mounted.session;
		await mounted.controller.submit("/mcp");
		expect(frame(mounted.app)).toContain("no MCP servers configured");
		const secret = "sk-mcp-must-not-appear";
		vi.spyOn(session, "connectMcp").mockRejectedValue(new Error(secret));
		vi.spyOn(session, "disconnectMcp").mockRejectedValue(new Error(secret));
		for (const action of ["connect", "disconnect"]) {
			await expect(mounted.controller.submit(`/mcp ${action} missing`)).resolves.toBeUndefined();
			expect(mounted.controller.view().state.notice).toContain("MCP");
			expect(mounted.controller.view().state.notice).not.toContain(secret);
		}
	});

	it("draws what is being typed, before it is sent", async () => {
		// The editor has to be a child of the TUI, not merely the focused component:
		// pi-tui renders its children and routes input to whatever is focused, and an
		// editor that was only focused took every keystroke while drawing none of
		// them, so a line became visible only after `enter` had already sent it.
		mounted = await mount(() => snapshot([]), false);
		const editor = mounted.app.editor();
		expect(mounted.tui.getFocusedComponent()).toBe(editor);
		mounted.terminal.written = "";
		for (const key of ["z", "z", "q", "x"]) mounted.terminal.type(key);
		await settle();
		mounted.tui.renderNow(true);
		await settle();
		expect(editor.getText()).toBe("zzqx");
		expect(stripTerminalSequences(mounted.terminal.written)).toContain("zzqx");
		// Nothing was sent: the line is still in the editor, and no notice was posted.
		expect(mounted.controller.view().state.notice).toBeUndefined();
		expect(mounted.calls.snapshots).toBeGreaterThan(0);
	});

	it("opens the command list as soon as a slash is typed, and narrows it per letter", async () => {
		// The completion is installed on the editor `runScreen` mounts, so this is
		// the same path a user takes: type `/`, then `m`, and read the drawn list
		// back from the terminal. Each read starts from an empty stream, so a line
		// of the previous frame cannot answer for the current one.
		mounted = await mount(() => snapshot([]), false);
		const screen = mounted;
		const redraw = async (): Promise<string> => {
			screen.terminal.written = "";
			screen.tui.renderNow(true);
			await settle();
			return stripTerminalSequences(screen.terminal.written);
		};

		mounted.terminal.type("/");
		await settle();
		let drawn = await redraw();
		// The list is drawn under the editor, five visible at a time with a count.
		expect(drawn).toContain("/tasks");
		expect(drawn).toContain("(1/");

		mounted.terminal.type("m");
		await settle();
		drawn = await redraw();
		expect(drawn).toContain("/model");
		expect(drawn).toContain("model in use");
		expect(drawn).toContain("/mcp");
		expect(drawn).not.toContain("/tasks");

		mounted.terminal.type("o");
		await settle();
		drawn = await redraw();
		expect(drawn).toContain("/model");
		expect(drawn).not.toContain("/mcp");

		// Tab takes the selected command and leaves a space for its argument; the
		// same keystroke then lists the models the pass read, and takes one.
		mounted.terminal.type("\t");
		await settle();
		expect(mounted.app.editor().getText()).toBe("/model ");
		mounted.terminal.type("\t");
		await settle();
		drawn = await redraw();
		expect(drawn).toContain("faux/faux-1");
		expect(drawn).toContain("Faux Two");
		mounted.terminal.type("\t");
		await settle();
		expect(mounted.app.editor().getText()).toBe("/model faux/faux-1");
		// Nothing was sent by completing: the line is still in the editor.
		expect(mounted.controller.view().state.notice).toBeUndefined();
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
		// The status cell is as wide as its longest word (`awaiting review`), so
		// `stopping` is padded by 7 and the two cells are joined by two more.
		expect(text).toMatch(/stopping {9}r1/);

		// Once the receipt lands the quiet notice returns and the stop clears.
		latest = snapshot([row("t-alpha", "cancelled")]);
		await mounted.controller.refresh();
		expect(mounted.controller.view().state.stopping).toBeUndefined();
	});

	it("lists the model in use and the ones offered, and switches to the one named", async () => {
		mounted = await mount(() => snapshot([]));
		await mounted.controller.submit("/model");
		const panel = frame(mounted.app);
		expect(panel).toContain("current: faux/faux-1");
		expect(panel).toContain("faux/faux-2");
		expect(panel).toContain("Faux Two");
		// Listing writes nothing.
		expect(mounted.calls.models).toEqual([]);

		// A line naming no offered model is refused before the service is called: an
		// id the provider does not offer would fail every later request.
		await mounted.controller.submit("/model gpt-9");
		expect(mounted.calls.models).toEqual([]);
		expect(mounted.controller.view().state.notice).toContain("no model matches gpt-9");
		expect(mounted.controller.view().state.notice).toContain("faux/faux-1");

		await mounted.controller.submit("/model faux-2");
		expect(mounted.calls.models).toEqual([["faux", "faux-2"]]);
		expect(mounted.controller.view().state.notice).toContain("faux/faux-2");
		// The notice names whose request changes. `/model` writes the Main agent's
		// configuration; a delegated task is configured with the session's opening
		// model, which is part of the task's own config snapshot.
		expect(mounted.controller.view().state.notice).toContain("Main's next request");
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

	it("survives a redraw that throws", async () => {
		// The app starts `submit()` without awaiting it. A redraw that throws would
		// otherwise reject that promise unhandled, which ends the process in Node.
		const calls: Calls = { closed: 0, cancelledAll: [], cancelled: [], models: [], snapshots: 0, snapshotDelayMs: 0 };
		const controller = new Controller({
			session: fakeSession(() => snapshot([]), calls),
			animate: false,
			transcriptLimit: 50,
			host: {
				requestRender: () => {
					throw new Error("the screen is gone");
				},
				askQuit: () => {},
				dismissQuit: () => {},
				leave: () => {},
			},
		});
		await expect(controller.refresh()).resolves.toBeUndefined();
		expect(calls.snapshots).toBe(1);
	});

	it("reports a command that throws instead of rejecting an unawaited submit", async () => {
		// The app starts `submit()` without awaiting it. A service call that throws
		// would otherwise reject that promise unhandled, which ends the process with
		// the terminal still in raw mode and nothing left to restore it.
		const calls: Calls = { closed: 0, cancelledAll: [], cancelled: [], models: [], snapshots: 0, snapshotDelayMs: 0, failCancelAll: true };
		const controller = new Controller({
			session: fakeSession(() => snapshot([row("t-alpha", "running")]), calls),
			animate: false,
			transcriptLimit: 50,
			host: { requestRender: () => {}, askQuit: () => {}, dismissQuit: () => {}, leave: () => {} },
		});
		await controller.refresh();
		await expect(controller.submit("/cancel all")).resolves.toBeUndefined();
		expect(controller.view().state.notice).toContain("could not run /cancel");
		expect(controller.view().state.notice).toContain("the storage refused the cancel");

		// The same holds when the redraw is what throws, for a line that only asks
		// for a redraw (a refusal is reported, not sent).
		const gone = new Controller({
			session: fakeSession(() => snapshot([]), calls),
			animate: false,
			transcriptLimit: 50,
			host: {
				requestRender: () => {
					throw new Error("the screen is gone");
				},
				askQuit: () => {},
				dismissQuit: () => {},
				leave: () => {},
			},
		});
		await gone.refresh();
		await expect(gone.submit("a line with no question open")).resolves.toBeUndefined();
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

	it("advances the spinner while nothing else changes", async () => {
		// The spinner runs on the app's own clock, because a pass only happens when
		// a document changed. That clock ticked once a second and took every second
		// tick, so a frame advanced every two seconds — a full turn in twenty, which
		// reads as a stuck frame rather than a spinner.
		mounted = await mount(() => snapshot([row("t-alpha", "running")]), true);
		const app = mounted.app;
		const glyph = (): string => {
			const status = stripTerminalSequences(frame(app)).split("\n").at(-1) ?? "";
			return status.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)?.[0] ?? "";
		};
		const seen = new Set<string>();
		const deadline = Date.now() + 1_000;
		while (Date.now() < deadline && seen.size < 2) {
			seen.add(glyph());
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		// A frame every 80 ms gives twelve in a second; the old clock gave none.
		expect(seen.size).toBeGreaterThan(1);
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
