import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { context, openProbe, openRoot } from "../src/runtime.ts";
import { ChildTools } from "../src/multiagent/child-tools.ts";
import { createMultiagentExtension } from "../src/multiagent/tools.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

const MAIN = "MAIN-SENTINEL-DBG";
const MAT = "MAT-DBG-1";
const flat = (ms: readonly Message[]) => ms.map((m) => {
  const t = m as { content?: unknown; sections?: Record<string, string | null> };
  const s = Object.values(t.sections ?? {}).filter((v): v is string => typeof v === "string").join("\n");
  const c = t.content;
  if (typeof c === "string") return c + "\n" + s;
  if (!Array.isArray(c)) return s;
  return c.map((p) => (typeof p === "object" && p && "text" in p ? String((p as {text?:string}).text ?? "") : "")).join("\n") + "\n" + s;
}).join("\n");

const router: FauxResponseFactory = (request) => {
  const text = flat(request.messages);
  const last = [...request.messages].reverse().find((m) => m.role !== "system");
  const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  if (!text.includes(MAIN)) {
    if (last?.role !== "toolResult") return fauxAssistantMessage([fauxToolCall("text_stats", { text: MAT, marker: "MAT" }, { id: "c1" })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxText(`CHILD-ANSWER ${MAT}`)]);
  }
  if (last?.role === "toolResult") {
    const toolName = (last as { toolName?: string }).toolName;
    console.log(`  [main sees ${toolName}] ${lastText.slice(0, 150).replace(/\n/g, "|")}`);
    if (toolName === "task_delegate") return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-d", decision: "reject", round: 1, reason: "redo" }, { id: "r1" })], { stopReason: "toolUse" });
    if (toolName === "task_review" && lastText.includes("rejected")) return fauxAssistantMessage([fauxToolCall("task_revise", { taskId: "task-d", task: "ROUND-TWO", feedback: "again" }, { id: "v1" })], { stopReason: "toolUse" });
    if (toolName === "task_revise") return fauxAssistantMessage([fauxToolCall("task_review", { taskId: "task-d", decision: "accept", round: 2 }, { id: "r2" })], { stopReason: "toolUse" });
    return fauxAssistantMessage([fauxText("MAIN-DONE")]);
  }
  return fauxAssistantMessage([fauxToolCall("task_delegate", { taskId: "task-d", task: "count", childTools: ["text_stats"] }, { id: "d1" })], { stopReason: "toolUse" });
};

const dir = mkdtempSync(join(tmpdir(), "dbg-flow-"));
const runtime = await openProbe({ databasePath: join(dir, "x.sqlite"), provider: "faux", fauxRouter: router,
  extensions: [createMultiagentExtension({ model: { provider: "faux", modelId: "faux-1" }, childInstructions: "child" })],
  registryExtensions: [ChildTools] });
const root = await openRoot(runtime);
runtime.harness.resume();
await (await root.submit({ type: "input", content: `GO ${MAIN}` }, context)).wait(context);
await runtime.harness.waitForIdle(context);
const ledger = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-d", context);
console.log("status:", ledger?.status, "round:", ledger?.currentRound, "active:", ledger?.activeOpKey ?? "-");
console.log("rounds:", JSON.stringify(ledger?.rounds.map((r) => ({ n: r.round, settled: r.settledAt !== undefined, sub: r.submissionId ?? null }))));
console.log("reviews:", JSON.stringify(ledger?.reviews.map((r) => `${r.round}:${r.decision}->${r.after}`)));
console.log("events:", JSON.stringify(ledger?.events.map((e) => `${e.from}->${e.to}${e.reason ? ":" + e.reason : ""}`)));
console.log("ops:", JSON.stringify(ledger?.operations.map((o) => `${o.kind}:${o.round}`)));
console.log("failure:", JSON.stringify(ledger?.failure ?? null));
await runtime.close();
