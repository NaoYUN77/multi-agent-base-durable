// TASK-005.5 src/tui/app.ts
//
// The screen: the frame above, one editor below, one modal for quitting.
//
// pi-tui draws the TUI's children top to bottom, so the frame comes first and
// the editor last: the editor stays on the bottom line and everything the
// session shows scrolls above it.
//
// The quit confirmation is an overlay, so nothing under it moves. While it is
// visible pi-tui focuses it and every key reaches it; while it is not, the input
// listener intercepts ctrl+c before the editor sees it, because the editor
// deliberately passes ctrl+c through (a copy gesture nothing here uses) and a
// quit that depended on the editor's cursor state would be unreliable.

import { type Component, Editor, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderView } from "../service/view.ts";
import type { Controller } from "./controller.ts";
import type { Theme } from "./theme.ts";

/** How often the spinner advances. */
export const TICK_MS = 1000;

export type ControllerAppOptions = {
	readonly controller: Controller;
	readonly tui: TUI;
	readonly theme: Theme;
};

export class ControllerApp implements Component {
	private readonly controller: Controller;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly input: Editor;
	private quitVisible = false;
	private quitHandle: { hide: () => void } | undefined;
	private timer: NodeJS.Timeout | undefined;
	private removeListener: (() => void) | undefined;
	private readonly leaveHandlers: (() => void)[] = [];
	private ticks = 0;

	constructor(options: ControllerAppOptions) {
		this.controller = options.controller;
		this.tui = options.tui;
		this.theme = options.theme;
		this.input = new Editor(this.tui, options.theme.editor, { paddingX: 1, autocompleteMaxVisible: 5 });
		this.input.onSubmit = (text: string) => {
			this.input.setText("");
			void this.controller.submit(text);
		};
		this.removeListener = this.tui.addInputListener((data: string) => {
			if (this.quitVisible) return undefined;
			// ctrl+c and ctrl+d: ask to quit. Leaving is the confirmation's job.
			if (data === "\x03" || data === "\x04") {
				this.showQuit();
				return { consume: true };
			}
			return undefined;
		});
		if (this.controller.view().animate) {
			this.timer = setInterval(() => {
				this.ticks += 1;
				this.controller.tick();
			}, TICK_MS);
			// Node keeps the process alive for a timer; the session's work must not be
			// outlived by a redraw clock.
			this.timer.unref?.();
		}
	}

	editor(): Editor {
		return this.input;
	}

	onLeave(handler: () => void): void {
		this.leaveHandlers.push(handler);
	}

	showQuit(): void {
		if (this.quitVisible) return;
		this.quitVisible = true;
		this.quitHandle = this.tui.showOverlay(new QuitPrompt(this.theme, () => this.confirm(), () => this.cancelQuit()), {
			width: Math.min(70, Math.max(40, this.tui.terminal.columns - 8)),
			margin: 1,
		});
		this.tui.requestRender();
	}

	hideQuit(): void {
		if (!this.quitVisible) return;
		this.quitVisible = false;
		this.quitHandle?.hide();
		this.quitHandle = undefined;
		this.tui.setFocus(this.input);
		this.tui.requestRender();
	}

	private confirm(): void {
		this.hideQuit();
		void this.controller.confirmQuit().then(() => this.leave());
	}

	private cancelQuit(): void {
		this.hideQuit();
	}

	private leave(): void {
		this.dispose();
		for (const handler of this.leaveHandlers.splice(0)) handler();
	}

	/** Stop the timer and the input listener; called once, on the way out. */
	dispose(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.removeListener?.();
		this.removeListener = undefined;
	}

	render(width: number): string[] {
		const terminal = this.tui.terminal;
		// Two rows go to the editor (border and text) and one to the blank line above it.
		const rows = terminal.rows > 6 ? terminal.rows - 3 : 24;
		// The spinner frame advances on this component's own timer, not on a pass:
		// a pass only happens when a document changed, and the spinner must move
		// while a long round writes nothing.
		const view = this.controller.view();
		return renderView(
			{ state: view.state, now: view.now, width: Math.max(20, width), height: rows, animate: view.animate, frame: Math.floor(this.ticks / 2), transcript: view.transcript },
			this.theme,
		);
	}

	invalidate(): void {
		// The frame is computed from the newest pass on every render; nothing is cached.
	}
}

/**
 * Mount the frame and its editor on a TUI, in that order.
 *
 * The editor must be a *child*, not merely the focused component. pi-tui renders
 * its children and routes input to whatever is focused, and the two are separate
 * lists: an editor that is focused but unmounted takes every keystroke and draws
 * none of them, so a submitted line appears only after `enter`. Both the real
 * entry and the terminal suite go through here, because they had drifted once and
 * the drift was exactly this omission.
 */
export function mountApp(tui: TUI, controller: Controller, theme: Theme): ControllerApp {
	const app = new ControllerApp({ controller, tui, theme });
	tui.addChild(app);
	tui.addChild(app.editor());
	tui.setFocus(app.editor());
	return app;
}

/** The confirmation overlay: two choices, each bound to its keys. */
export class QuitPrompt implements Component {
	private readonly theme: Theme;
	private readonly confirm: () => void;
	private readonly cancel: () => void;

	constructor(theme: Theme, confirm: () => void, cancel: () => void) {
		this.theme = theme;
		this.confirm = confirm;
		this.cancel = cancel;
	}

	handleInput(data: string): void {
		if (data === "y" || data === "Y" || data === "\r" || data === "\n") this.confirm();
		else if (data === "n" || data === "N" || data === "\x1b" || data === "\x03" || data === "\x04") this.cancel();
	}

	render(width: number): string[] {
		const inner = Math.max(20, width - 4);
		const lines = [
			"Quit?",
			"",
			"Running tasks are not cancelled. They pause at their last durable",
			"point and continue the next time this session is opened.",
			"",
			"[y / enter] quit    [n / esc] stay",
		];
		const frame = (line: string): string => {
			const fitted = truncateToWidth(line, inner, "…", true);
			return this.theme.frame(`│ ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} │`);
		};
		return [
			this.theme.frame(`╭${"─".repeat(inner + 2)}╮`),
			...lines.map(frame),
			this.theme.frame(`╰${"─".repeat(inner + 2)}╯`),
		].map((line) => (visibleWidth(line) < width ? line + " ".repeat(width - visibleWidth(line)) : line));
	}

	invalidate(): void {
		// Static content.
	}
}
