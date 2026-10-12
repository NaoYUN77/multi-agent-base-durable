import { createRequire } from "node:module";
import { apply } from "@earendil-works/chord/delta";
import { context, openProbe } from "../src/runtime.ts";
import { TaskLedgerDoc } from "../src/multiagent/ledger.ts";

const require = createRequire(import.meta.url);
const dbPath = "C:/Users/l/.workbuddy-ai/issue9-work/multiagent-smoke3.sqlite";
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const db = new DatabaseSync(dbPath, { readOnly: true });
const doc = db.prepare("SELECT id FROM documents WHERE kind LIKE ?").get("%multiagent.task-ledger%") as { id: number };
const revs = db.prepare("SELECT seq, kind, content FROM document_revisions WHERE document_id = ? ORDER BY seq").all(doc.id) as { seq: number; kind: string; content: string }[];
console.log("revisions:", revs.map((r) => `${r.seq}:${r.kind}`).join(", "));
let value: unknown = undefined;
for (const r of revs) {
  const content = JSON.parse(r.content) as unknown;
  if (r.kind === "base") value = content;
  else value = apply(value as never, content as never);
}
const rebuilt = value as { taskId?: string; status?: string; version?: number; rounds?: unknown[]; operations?: unknown[] };
console.log("rebuilt:", JSON.stringify({ taskId: rebuilt.taskId, status: rebuilt.status, version: rebuilt.version, rounds: rebuilt.rounds?.length, ops: rebuilt.operations?.length }));
db.close();

const runtime = await openProbe({ databasePath: dbPath, provider: "faux" });
const root = await runtime.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const snapshot = await runtime.harness.snapshot(TaskLedgerDoc, root.id, "task-smoke", context);
console.log("snapshot:", JSON.stringify({ taskId: snapshot?.taskId, status: snapshot?.status, version: snapshot?.version, rounds: snapshot?.rounds.length, ops: snapshot?.operations.length }));
console.log("EQUAL:", JSON.stringify(snapshot) === JSON.stringify(rebuilt));
await runtime.close();
