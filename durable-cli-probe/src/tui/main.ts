// TASK-005.5 src/tui/main.ts
//
// The terminal entry: arguments, terminal, session, screen.
//
// The order is the contract's:
//
//   arguments   parsed strictly; a bad argument exits 3 before anything opens
//   terminal    stdin and stdout must be a TTY; a pipe exits 2 with a clear
//               refusal instead of a frame of escape sequences
//   config      read and validated; a bad config exits 3 without touching --db
//   session     `openAgentSession`; a failure (locked file, missing provider key)
//               exits 1 with the message on stderr and the database untouched
//   screen      pi-tui over the real terminal; exit 0 when it closes
//
// Closing is not cancelling. Ctrl+C asks; a confirmed quit stops the TUI and
// closes the session, and the next open replays whatever was in flight (the
// runtime's recovery). Nothing here calls `requestCancel`.

import { EXIT, parseTuiArgs, readAgentConfig, usageText } from "../service/config.ts";
import { openAgentSession, TRANSCRIPT_LIMIT } from "../service/session.ts";
import type { AgentSession } from "../service/types.ts";
import { Controller } from "./controller.ts";
import { pathToFileURL } from "node:url";

export type EntryIo = {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
};

/**
 * The whole entry, up to the screen. Pure with respect to `io`: everything it
 * decides (exit codes, messages) is observable from a test.
 *
 * @returns a function that mounts the screen and resolves with the exit code,
 *   or `undefined` when the run stopped before a session existed.
 */
export async function prepare(argv: readonly string[], io: EntryIo): Promise<{ readonly exit: number } | { readonly session: AgentSession; readonly animate: boolean }> {
	const args = parseTuiArgs(argv);
	if (!args.ok) {
		for (const error of args.errors) io.stderr(`error: ${error}\n`);
		io.stderr(`${usageText()}\n`);
		return { exit: EXIT.invalidConfig };
	}
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		io.stderr("error: the TUI needs an interactive terminal (stdin and stdout must be a TTY)\n");
		return { exit: EXIT.notATerminal };
	}
	const config = await readAgentConfig(args.value.configPath);
	if (!config.ok) {
		for (const error of config.errors) io.stderr(`error: ${error}\n`);
		return { exit: EXIT.invalidConfig };
	}
	const databasePath = args.value.databasePath;
	try {
		return { session: await openAgentSession({ ...config.value, databasePath }), animate: args.value.animate };
	} catch (error) {
		io.stderr(`error: could not open the session: ${error instanceof Error ? error.message : String(error)}\n`);
		return { exit: EXIT.openFailed };
	}
}

/**
 * Mount the screen over the real terminal.
 *
 * Resolves with the exit code once the session closed. `leave` also drains
 * stdin (slow SSH connections otherwise leak kitty key-release events into the
 * parent shell) before the process ends.
 */
export async function runScreen(session: AgentSession, animate: boolean): Promise<number> {
	const { ProcessTerminal, TuiMainScreen, getTerminalColorMode } = await import("@earendil-works/pi-tui");
	const { mountApp } = await import("./app.ts");
	const { ansiPainter, createTheme } = await import("./theme.ts");
	const theme = createTheme(ansiPainter(getTerminalColorMode()));
	const terminal = new ProcessTerminal();
	const tui = new TuiMainScreen(terminal, false);
	let app: ReturnType<typeof mountApp> | undefined;
	let exiting: ((code: number) => void) | undefined;
	// One way out, whatever the reason: a confirmed quit, a failed pass, or a
	// rejected start. The terminal must be restored on every path, or a thrown
	// error leaves the user in raw mode with the cursor hidden.
	let restored = false;
	const restore = (): Promise<void> => {
		if (restored) return Promise.resolve();
		restored = true;
		app?.dispose();
		tui.stop();
		return terminal.drainInput(500, 50).then(
			() => undefined,
			() => undefined,
		);
	};
	const controller = new Controller({
		session,
		animate,
		transcriptLimit: TRANSCRIPT_LIMIT,
		host: {
			requestRender: () => tui.requestRender(),
			askQuit: () => app?.showQuit(),
			dismissQuit: () => app?.hideQuit(),
			leave: () => {
				void restore().then(() => exiting?.(EXIT.ok));
			},
		},
	});
	const done = new Promise<number>((resolve) => {
		exiting = resolve;
	});
	app = mountApp(tui, controller, theme);
	try {
		tui.start();
		await controller.start();
	} catch (error) {
		await session.close().catch(() => {});
		await restore();
		throw error;
	}
	return await done;
}

/** The executable entry. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
	const io = { stdout: (text: string) => process.stdout.write(text), stderr: (text: string) => process.stderr.write(text) };
	const prepared = await prepare(argv, io);
	if ("exit" in prepared) {
		process.exitCode = prepared.exit;
		return;
	}
	const code = await runScreen(prepared.session, prepared.animate);
	process.exitCode = code;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main().catch((error: unknown) => {
		process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = EXIT.openFailed;
	});
}
