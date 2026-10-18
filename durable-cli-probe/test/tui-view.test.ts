// TASK-005.5 test/tui-view.test.ts
//
// The frame as a function of one pass, without a terminal.
//
// The terminal suite drives the whole app; this one holds the frame to rules
// that do not depend on input: every status has a word and a tone, colour never
// changes a column, a width limit is measured in columns (a CJK title counts
// two), a row shows only numbers the documents hold, and `--no-animation`
// removes the spinner while keeping the elapsed clock.

import { describe, expect, it } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { deriveTaskRow } from "../src/service/analysis.ts";
import type { ClarificationQuestion } from "../src/agent/contracts/clarification.ts";
import type { QueuedInput } from "../src/agent/main/service-doc.ts";
import type { TaskRow, TaskRowStatus, TuiSnapshot } from "../src/service/types.ts";
import { renderView, statusLabel, statusTone } from "../src/service/view.ts";
import { ansiPainter, createTheme, plainPainter } from "../src/tui/theme.ts";

const STATUSES: readonly TaskRowStatus[] = ["planned", "queued", "running", "retry_wait", "awaiting-input", "awaiting-review", "stopping", "accepted", "failed", "cancelled"];

function row(status: TaskRowStatus, overrides: Partial<TaskRow> = {}): TaskRow {
	return {
		taskId: `t-${status}`,
		batchId: "batch-1",
		title: `task ${status}`,
		status,
		statusSource: "ledger",
		round: 1,
		startedAt: 5_000,
		toolInvocations: { used: 1, limit: 3 },
		failedToolCalls: { used: 0, limit: 2 },
		retrying: status === "retry_wait",
		...overrides,
	};
}

function snapshot(rows: readonly TaskRow[], extra: Partial<TuiSnapshot> = {}): TuiSnapshot {
	return {
		takenAt: 0,
		request: { requestVersion: 1, text: "run 测试", openQuestionIds: [], questions: [], answers: [], planCount: 1 },
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
		...extra,
	};
}

function draw(snap: TuiSnapshot, options: { width?: number; height?: number; animate?: boolean; frame?: number; color?: boolean } = {}): string[] {
	const paint = (text: string, style: Parameters<ReturnType<typeof ansiPainter>>[1]) => ansiPainter("truecolor")(text, style);
	const theme = createTheme(options.color === true ? paint : plainPainter());
	return renderView({ state: { snapshot: snap }, now: 10_000, width: options.width ?? 80, height: options.height ?? 24, animate: options.animate ?? false, frame: options.frame ?? 0, transcript: [] }, theme);
}

const plain = (lines: readonly string[]): string => lines.map((line) => stripTerminalSequences(line)).join("\n");

describe("TASK-005.5 frame", () => {
	it("says every status word, and every tone is one the theme draws", () => {
		const rendered = plain(draw(snapshot(STATUSES.map((status) => row(status)))));
		const tones = ["active", "waiting", "attention", "good", "bad", "neutral"];
		for (const status of STATUSES) {
			expect(rendered).toContain(statusLabel(status));
			expect(tones).toContain(statusTone(status));
		}
	});

	it("colour changes no column", () => {
		const snap = snapshot(STATUSES.map((status) => row(status)));
		const monochrome = draw(snap);
		const coloured = draw(snap, { color: true });
		expect(coloured.join("\n")).not.toBe(monochrome.join("\n"));
		expect(plain(coloured)).toBe(plain(monochrome));
	});

	it("shows numbers only where the documents hold them", () => {
		const planned = deriveTaskRow({ taskId: "t-1", batchId: "b-1", title: "t-1", ledger: undefined, task: undefined, quota: undefined });
		expect(planned).toMatchObject({ status: "planned", round: 0 });
		expect(planned.startedAt).toBeUndefined();
		const lines = draw(snapshot([planned]));
		const taskLine = lines.find((line) => stripTerminalSequences(line).includes("t-1")) ?? "";
		// A row that never started shows no clock, and no round it has not begun.
		expect(stripTerminalSequences(taskLine)).toMatch(/^ {2}t-1\s+planned\s+-\s+0\s+0$/);
		expect(plain(lines)).not.toMatch(/\d+%/);
	});

	it("fits the width in columns, counting a CJK title as two", () => {
		const wide = row("running", { taskId: "t-中文标题非常长的一段任务名称", title: "中文标题非常长的一段任务名称用于测试宽度" });
		const question: ClarificationQuestion = { questionId: "q-1", question: "哪一份材料是最终版本并且需要以中文为准？", reason: "scope", blockingScope: ["all"], askedAt: 0 };
		const queued: QueuedInput = { submissionId: "s-1", requestId: "r-1", requestVersion: 1, allocatedVersion: 2, text: "请把这一段很长的中文输入也一并在队列里显示出来看看宽度", queuedAt: 0 };
		const snap = snapshot([wide], { request: { ...snapshot([]).request, openQuestionIds: ["q-1"], questions: [question] }, queue: [queued], mainTasks: [{ name: "generation", state: "running" }] });
		for (const width of [30, 40, 60, 100]) {
			for (const line of draw(snap, { width })) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("the elapsed clock stays and only the spinner goes under --no-animation", () => {
		const snap = snapshot([row("running", { startedAt: 6_000 })]);
		const still = plain(draw(snap));
		expect(still).toMatch(/\b4s\b/);
		expect(still).not.toContain("⠋");
		const animated = draw(snap, { animate: true, frame: 0 });
		const next = draw(snap, { animate: true, frame: 1 });
		expect(plain(animated)).toContain("⠋");
		expect(plain(animated)).not.toBe(still);
		expect(plain(next)).not.toBe(plain(animated));
		expect(plain(next)).toMatch(/\b4s\b/);
	});

	it("shows an open question in the header with its text", () => {
		const question: ClarificationQuestion = { questionId: "q-1", question: "which source wins?", reason: "scope", blockingScope: ["all"], askedAt: 0 };
		const rendered = plain(draw(snapshot([], { request: { ...snapshot([]).request, openQuestionIds: ["q-1"], questions: [question] } })));
		expect(rendered).toContain("main asks q-1: which source wins?");
		expect(rendered).toContain("1 open question(s)");
	});
});
