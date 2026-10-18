// TASK-005.5 src/tui/theme.ts
//
// Colours for the frame, derived from one `paint` function so a test can render
// the same lines without escape sequences.
//
// The palette is deliberately small and every colour mirrors something the
// status word already says; colour never carries a meaning the text lacks.

import { type Color, type TerminalColorMode, parseColor, styleText } from "@earendil-works/pi-tui";

export type Painter = (text: string, style: { readonly fg?: Color; readonly bold?: boolean; readonly dim?: boolean }) => string;

/** A painter that adds no escape sequences. */
export function plainPainter(): Painter {
	return (text) => text;
}

export function ansiPainter(mode: TerminalColorMode): Painter {
	return (text, style) => styleText(text, style, mode);
}

export type Theme = {
	readonly paint: Painter;
	/** The editor's border and completion list. */
	readonly editor: { readonly borderColor: (text: string) => string; readonly selectList: { readonly selectedPrefix: (text: string) => string; readonly selectedText: (text: string) => string; readonly description: (text: string) => string; readonly scrollInfo: (text: string) => string; readonly noMatch: (text: string) => string } };
	readonly title: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly frame: (text: string) => string;
	readonly warning: (text: string) => string;
	/** A task status word, coloured by its meaning. */
	readonly status: (word: string, tone: StatusTone) => string;
};

export type StatusTone = "active" | "waiting" | "attention" | "good" | "bad" | "neutral";

export function createTheme(paint: Painter): Theme {
	// `parseColor` takes only numbers and colour strings, so the palette is the
	// ANSI 256-colour indexes that every terminal pi-tui supports renders.
	const fg = (index: number) => (text: string) => paint(text, { fg: parseColor(index) });
	const dim = (text: string) => paint(text, { dim: true });
	return {
		paint,
		editor: {
			borderColor: dim,
			selectList: { selectedPrefix: dim, selectedText: (text) => paint(text, { bold: true }), description: dim, scrollInfo: dim, noMatch: dim },
		},
		title: (text) => paint(text, { bold: true }),
		dim,
		frame: fg(6),
		warning: fg(3),
		status: (word, tone) => {
			switch (tone) {
				case "active":
					return fg(6)(word);
				case "waiting":
					return fg(3)(word);
				case "attention":
					return paint(word, { fg: parseColor(13), bold: true });
				case "good":
					return fg(2)(word);
				case "bad":
					return fg(1)(word);
				case "neutral":
					return dim(word);
			}
		},
	};
}
