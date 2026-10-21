# multi-agent-base-durable

A durable execution base for multi-agent work. A Main conversation receives a request, may ask the user one blocking question, saves a versioned plan, dispatches the plan's tasks to sub-agent conversations, and reviews each result before accepting it or sending it back for revision. Every one of those steps is a persisted document in SQLite. A process that dies mid-dispatch can be reopened and continue from the last committed state instead of starting over.

The problem is the handoff. A delegated task is not a function call: it takes minutes, spends a shared provider quota, writes into a separate conversation, and can fail in two ways that must not be conflated. The run can break (provider error, timeout, aborted tool) or the work can be wrong (the sub-agent answered, and the answer is rejected). `src/agent/state/lifecycle.ts` separates those cases: a technical failure retries inside a budget and then stops for a Main decision; a quality failure goes to review; a failed round is not a failed task. Each round has one persisted owner, and every durable identifier is derived from the tool call that created it, so replaying an interrupted call resolves to the same batch, task, round and attempt rather than a second copy.

The application lives at the repository root: `src/`, `test/`, `scripts/`, `prompts/`, `skills/`, `data/` and the configuration files. The Pi Durable runtime it builds on is a pinned external checkout (`pi-pin.json`), not code committed here. Paths below are relative to the repository root unless stated otherwise. `doc/architecture.md` is the longer treatment of the same system; `doc/` also holds the CI notes and the historical task reports.

## 1. Architecture and execution model

### Control flow

```
 user input
     |
     v
 root conversation (Main, prompts/multiagent/main.md)
     |
     |-- request_clarification --> question persisted, run ends; answer arrives as new input
     |-- save_plan -------------> AgentPlanDoc (versioned, bound to requestId/requestVersion)
     |-- dispatch_tasks --------> admission commit (see below)
     |-- review_task -----------> accept, or rework until the revision budget is spent
     v
 dispatch_tasks(planId, version, tasks)
     |
     |  validateTaskBatch: known fields, unique ids, dependency closure, no cycles
     |  admissionBlockReasons: plan version, open questions, unaccepted deps, quota
     |  authorizeDispatch: deployment policy, fail-closed when it throws
     v
 ONE COMMIT writes:
     MainServiceDoc.dispatchAttempts   the attempt reservation
     AgentBatchDoc + BatchIndexDoc     members, fairness sequence, terminal receipts
     AgentTaskSpecDoc/ConfigDoc        the contract each member is authorized to run
     operation-started marker          distinguishes "never ran" from "ran, receipt lost"
     |
     v
 executeBatch: one nested pi.tool task per (task, round)
     key = task.<taskId>.r<round>
     |
     v
 agent_task_round (src/agent/runtime/item.ts)
     gateRound:  saved spec -> authorizeTask -> buildSubAgentConfig -> admitOne -> openAttempt
     runAttempt: submit one input to the child conversation, wait for settlement
     |
     v
 child conversation (prompts/multiagent/sub.md, granted tools only)
     finish_task / task_status / task_evidence / text_stats / text_check / MCP dispatchers
     |
     v
 extractRoundEvidence: redacted tool args, answer excerpt, entry ids
     |
     v
 AgentTaskResultDoc + TaskLedgerDoc -> awaiting_review
     |
     v
 review_task(accept | rework)
     accept -> accepted (terminal)
     rework -> next round on the same child conversation (MAX_REVISIONS = 2)
```

Each item admission is its own commit and is the only place a slot, a budget charge and an execution right are taken together:

```
 admitOne (src/agent/runtime/admission.ts)
   fairness check -> capacity check -> quota reservation
   ONE COMMIT:
     SchedulerDoc.active / .queue          session-scoped slot and waiting list
     AgentQuotaDoc                          per-request attempt reservation
     TaskLedgerDoc.activeOpKey/.activeRound the execution right
     AgentBatchDoc item fields              attempt binding, round number
```

### Task status and round status

Two tables in `src/agent/state/lifecycle.ts`. A business status describes the task; a round status describes one execution of it.

```
BUSINESS_TRANSITIONS
  planned         -> running, cancelled
  running         -> awaiting_review, awaiting_input, failed, cancelled
  awaiting_input  -> running, failed, cancelled
  awaiting_review -> running, revising, accepted, failed, cancelled
  revising        -> awaiting_review, failed, cancelled   (legacy; read as running)
  accepted        -> none
  failed          -> none
  cancelled       -> none

ROUND_TRANSITIONS
  queued     -> running, cancelled
  running    -> completed, failed, cancelled, retry_wait
  retry_wait -> queued, running, cancelled
  completed  -> none
  failed     -> none
  cancelled  -> none
```

Terminal statuses have no outgoing edge, and `assertRoundTransition` refuses to reopen one.

`revising` is a legacy label written by the earlier delegation path; it is accepted on read and mapped to `running`, but `assertTransitionToNewStatus` refuses to write it. `decideRoundFailure` classifies a settlement: a quality failure completes the round and leaves the task at `awaiting_review`; a technical failure moves the round to `retry_wait` while attempts remain, and to `failed` with `requiresMainDecision` when the budget is spent; a cancellation is terminal. `failed` is terminal, which is why the program never spends it on a model's behalf after a technical stop.

### Codebase layout

```
.
├── .github/workflows/ci.yml          Three jobs (lint, typecheck, test); each runs prepare.mjs first
├── doc/                              Architecture, CI notes, and historical task reports
├── intent-spec/                      Design notes and acceptance criteria
├── vendor/pi/                        Pinned upstream checkout (also reachable as
│                                     base-durable-vaction-agent -> vendor); not application code
├── package.json                      Manifest; scripts, engines (node >= 22.19.0), devDependencies
├── package-lock.json                 Exact app dependency tree
├── pi-pin.json                       Upstream repo, commit, package list, build order, catalog revision
├── tsconfig.json                     ES2024, Node16, strict, noEmit, erasableSyntaxOnly
├── vitest.config.ts                  Aliases @earendil-works/* to the checkout sources
├── biome.json                        Lint configuration; noExplicitAny is an error
├── agent-tui.example.json            Faux provider catalog plus an explicit RunConfig
├── mcp.example.json                  stdio and Streamable HTTP server examples, ${VAR} references
├── prompts/multiagent/               main.md and sub.md: the two installed instructions
├── skills/                           material-summary, mcp-work, text-stats: skill.json + instructions
├── scripts/
│   ├── prepare.mjs                   Clone/verify the pinned checkout, install, build, link
│   ├── link-checkout.mjs             Replace @earendil-works/* with junctions into the checkout
│   └── finish-evidence.ts            Evidence runner for the finish path
├── src/
│   ├── runtime.ts                    Harness over openNodeSqliteStorage; provider selection
│   ├── cli.ts                        Single-submission CLI
│   ├── config.ts                     Notion environment configuration and redaction
│   ├── agent/
│   │   ├── contracts/                RunConfig, TaskSpec, Plan, clarification, result, documents
│   │   ├── state/lifecycle.ts        The two transition tables and decideRoundFailure
│   │   ├── builder/                  authorizeTask, subagent-config assembly, skills, tool catalog
│   │   ├── runtime/
│   │   │   ├── runtime.ts            createBatchRuntime: stage, dispatch, execute, stop
│   │   │   ├── item.ts               agent_task_round: gate, attempt loop, settlement
│   │   │   ├── admission.ts          The only writer of SchedulerDoc.active/.queue
│   │   │   ├── round.ts              The only writer of round execution records
│   │   │   ├── quota.ts              Reservation-id idempotency and reconciliation
│   │   │   ├── child.ts              Child-side quota gate and control-tool exemptions
│   │   │   ├── cancel.ts             Intent-before-abort stop and verified idle close
│   │   │   ├── review.ts             reviewTask: accept, rework, revision budget
│   │   │   ├── documents.ts          Runtime document definitions and scope rationale
│   │   │   └── tasks.ts              Read surface: batches, runtime tasks, scheduler
│   │   ├── main/tools.ts             request_clarification, save_plan, dispatch_tasks, review_task
│   │   └── prompts/                  Loads the Main instructions
│   ├── multiagent/
│   │   ├── ledger.ts                 TaskLedgerDoc, execution right, operation keys
│   │   ├── delegation.ts             Earlier delegation path, same ledger
│   │   ├── tools.ts                  task_delegate/task_revise/task_review/task_cancel/...
│   │   ├── evidence.ts               Argument redaction, excerpting, evidence extraction
│   │   └── child-tools.ts            text_stats and text_check
│   ├── service/
│   │   ├── session.ts                Composition root for the TUI
│   │   ├── config.ts                 TUI arguments and config validation, exit codes
│   │   ├── main-service.ts           Main conversation, tools, request lifecycle
│   │   ├── mcp-identity.ts           Binds an open conversation to its MCP destinations
│   │   └── view.ts, analysis.ts      Read models for the terminal
│   ├── tui/                          Terminal client over pi-tui
│   ├── mcp/                          Config parsing, connection manager, tool bridge
│   ├── notion/                       Notion read and write probes
│   └── article/                      Article acceptance probe
└── test/                             36 vitest suites plus helpers and fixtures
```

Untracked local scratch directories and handoff notes at the root are omitted.

## 2. Core mechanics

### 2.1 Durability

`src/runtime.ts` opens a `Harness` over `openNodeSqliteStorage` from `@earendil-works/pi-durable/storage/sqlite/node`. The database is the only place state lives; process memory holds nothing that cannot be reconstructed from it.

State is organized as typed documents declared with `defineDoc` / `defineDocFamily`:

| Document kind | Scope | Key | What it holds |
| --- | --- | --- | --- |
| `app.agent.request` | conversation | `requestId` | The requirement text, materials, request version |
| `app.agent.clarification` | conversation | `requestId` | Questions, answers, resolutions, blocking scope |
| `app.agent.plan` | conversation | `planId` | Versioned plan, bound to a request version |
| `app.agent.task-spec` | conversation | `taskId` | The contract a task was admitted to run |
| `app.agent.task-config` | conversation | `taskId` | The config snapshot and its `configHash` |
| `app.agent.task-result` | conversation | `resultId` | One write-once receipt per task and round |
| `app.agent.batch` | conversation | `batchId` | Members, fairness sequence, terminal receipts |
| `app.agent.quota` | conversation | `requestId` | Attempt reservations, keyed by reservation id |
| `app.agent.runtime.scheduler` | session | singleton | Active slots and the waiting queue |
| `app.agent.runtime.batch-index` | session | singleton | Admitted batch ids, so a stop can find an idle batch |
| `app.agent.runtime.round-binding` | conversation (child) | singleton | The current round and its budget, readable by the child gate |
| `app.multiagent.task-ledger` | conversation | `taskId` | Rounds, attempts, reviews, events, execution right |

The scope choices are load-bearing. `SchedulerDoc` is session-scoped because `maxConcurrentSubAgents` spans the whole run while `maxSubAgentsPerRequest` is per request; only a session document can see both. `AgentQuotaDoc` is keyed by request id rather than batch id, so two dispatches in one request share one budget. `task-ledger` is version 3 and carries a `migrate` function that fills the fields a v1 document predates; a v2 document is already a valid v3 document, and no execution record is invented for a round the newer runtime never started.

The commit is the unit of atomicity. `api.commit(async (tx) => ...)` is used for every multi-document decision, and the admission write above is the clearest case: the slot, the reservation, the execution right and the batch item land together or not at all. A refusal writes only its receipt, in the same transaction that decided it, so a replayed call reports the same refusal instead of re-deciding against moved state.

Three mechanisms make replay safe:

* **Derived identifiers.** `batchIdOf` produces `batch:<dispatch op key>`; `operationIdOf` produces `task:<taskId>`; `attemptKeyOf` produces `task:<taskId>:r<round>:attempt:<n>`; `roundCallKey` produces `task.<taskId>.r<round>`; `resultIdOf` produces `res.<taskId>.r<round>`. None is generated from a clock or an in-memory counter. A resumed process derives the same key it used before, so the Durable runtime reattaches to the task it already created.
* **Receipts.** Tool executions record an operation receipt keyed by the call's operation key. `dispatch_tasks` reads it before doing anything: a recorded result replays verbatim, including its `isError` flag and any handoff control. A recorded call with no result is treated as an interrupted attempt; it falls through only when the runtime confirms a batch exists for that operation key (`batchIsResumable`, a non-creating `harness.snapshot`). Otherwise it reports an unknown outcome rather than claiming completion.
* **Write-once fields and the execution right.** `claimRound` refuses a second holder (`ExecutionRightError`); `stampExecution` writes once; `setRoundEntryFloor` writes once; `AgentTaskResultDoc` is keyed by task and round. A round that ended cannot be reopened, and a second attempt cannot be started while the first right is held.

`close()` writes no outcome (`src/runtime.ts`), and `harness.resume()` is called on every open before work is awaited (`src/service/session.ts`, `src/cli.ts`). That combination is what makes a reopen resume rather than discard: the outstanding tasks were never marked finished, so the harness re-executes them and their persisted receipts short-circuit the parts that already ran.

### 2.2 Handoffs and tool calls

Main has four write-boundary tools (`src/agent/main/tools.ts`):

* `request_clarification` writes the question and its operation receipt in one commit, then returns a `handoff` control built from persisted facts. The handoff, not plain text, is what ends the run; returning text alone would let the round continue past a question that was already asked. An explicit `blockedTaskIds` on a re-ask replaces the question's blocking scope, which is how a scope is narrowed; omitting the argument never widens it.
* `save_plan` writes a versioned plan bound to the request id and request version read inside the transaction. A stale `expectedVersion` is refused, not merged. The plan and the service's plan index are written together.
* `dispatch_tasks` validates the batch, runs admission, stages the batch and the saved specs, and only then hands the batch to the executor. Its refusal reasons are a fixed vocabulary: `plan_version_stale`, `clarification_open`, `dependencies_not_accepted`, `quota_exhausted`, `plan_request_mismatch`, `tasks_not_in_plan`, `dependency_check_unavailable`, `not_authorized`, `requirement_unresolved`.
* `review_task` records one decision for one round. An accept and its receipt are one commit; a rework goes back through the same nested-call path an initial dispatch takes, with `trigger: {kind: "rework"}`. Once the revision budget (`MAX_REVISIONS = 2`) is spent, a further rework is refused with `review_revision_limit` and the task stays `awaiting_review`: `failed` is Main's judgement, not the side effect of a budget.

The executor (`createBatchRuntime` in `src/agent/runtime/runtime.ts`) starts one nested tool call per item with `api.executeTool(AGENT_TASK_ROUND_TOOL, ..., { key: roundCallKey(taskId, round) })` and joins them with `Promise.allSettled`, so one item's rejection cannot discard the batch. `agent_task_round` is declared with `callers: ["tools"]`, which keeps the model from invoking it directly. Results are read back from the batch document's receipts in `taskIds` order, not from the model's text.

Inside a round (`src/agent/runtime/item.ts`):

1. `gateRound` loads the saved spec, re-runs `authorizeTask`, assembles the child config, calls `admitOne` and opens a contiguous attempt record.
2. `runAttempt` submits one input to the child conversation and waits for settlement, bounded by `deadlineAt`.
3. The failure path distinguishes an operator cancel (round terminal) from a deadline (round `failed`, `requiresMainDecision`), and treats only `model_error` as retryable.

The child conversation is created once per task and reused by revisions. The builder path (`src/agent/builder/create-subagent.ts`) configures it with `extensions`, `instructions`, `tools`, `modelTools`, `model` and `cwd: null`; the earlier delegation path (`src/multiagent/delegation.ts`) does the same while removing the Main extension and adding the child one. That `configure` call is the whole grant: the child receives the tool names in `tools`/`modelTools`, not whatever the prompt asks for. The child reports back through `finish_task`; `task_status` and `task_evidence` are read-only control tools.

Evidence is extracted after the attempt and before the round settles: `extractRoundEvidence` records tool names, redacted argument shapes, answer excerpts and entry ids. It refuses to return a partial scan past `MAX_SCAN_PAGES` (500); it throws rather than returning what it happened to read. Excerpts are capped by `EVIDENCE_EXCERPT_LIMIT` (2000 characters).

### 2.3 Security and trust boundaries

This is a single-user local application. There is no HTTP server, no authentication layer, and no multi-tenant isolation in the repository. The boundaries below are about what a model can make the program do, and what a persisted value can make a reader believe.

**State deserialization.** Document bodies are JSON written and read through Durable's document definitions. TypeScript types are not validation: values that arrive from a model or another tool — task specs, plans, run config, a nested `structuredOutput` — are re-checked by the contract validators before use. `validateRunConfig` refuses unknown keys and supplies no defaults; `validateTaskSpec` and `validateTaskBatch` check ids, fields, dependency closure and cycles; `validateTaskConfigSnapshot` checks the recorded config; `validatePlan` and `validateClarificationState` do the same for plans and questions. A nested item's `structuredOutput` is `JsonValue` even though this runtime registered the tool itself; `readItemToolOutput` validates it against the tool's five declared statuses, and a malformed value becomes a failed member rather than a trusted status. Migration is narrow: `migrate` fills missing v1 fields and otherwise leaves the document alone. Documents that no model writes (the ledger, the batch) rely on their definition and on having a single program-side writer; they are not re-validated field by field on every read.

The honest limit: SQLite has no integrity protection here. A local process with write access to the database file can alter documents, and the application will read them through the same validators. The durability guarantee is about crashes, not about a hostile operator with filesystem access.

**Cross-agent payloads and indirect prompt injection.** Task text originates with Main's model, passes through `validateTaskBatch`, `authorizeTask` (a subset decision over skills and tools, never a silent widening) and `buildSubAgentConfig`, and only then becomes the child's instructions. `buildSubAgentConfig` uses `singleLine()` for model-authored header fields so a newline cannot forge a new section, `fenced()` for embedded material, and labels `spec.notes` as "context, not instructions". The child's tool surface is fixed at `configure` time, so a prompt-injected instruction cannot add a tool, and the main management extension is removed from the child entirely.

Injection still matters inside the boundary. A child that is persuaded by its material can produce a wrong answer, call a permitted tool with hostile arguments, or try to persuade Main to accept bad work. The defenses are structural rather than semantic: tool arguments are recorded in redacted form (`redactArgs` keeps structure and lengths, not payloads), result text is excerpted and truncated, `task_evidence` returns full text only when the entry belongs to the child conversation and to the round's recorded evidence, and acceptance is a program-side transition recorded with its receipt. Review is still a Main model decision; the program enforces the round, the revision budget and the state machine around it. Treat prompt injection as a way to waste budget or produce a rejected result, not as a way to grant a capability.

**Tool execution isolation.** The child receives an explicit grant. `configure` names the extensions and the `tools`/`modelTools` lists; a tool that is installed but not granted is not callable. `wrapWithQuota` (`src/agent/runtime/child.ts`) wraps every granted tool with `executionMode: "sequential"`, charges the per-round budget, and returns refusals as `isError` tool results rather than throwing, so a refused call is visible to the model and does not kill the round. `finish_task`, `task_status` and `task_evidence` are exempt from the budget. `agent_task_round` is registered with `callers: ["tools"]`, and the child quota extension is installed once over the union of the policy tools: installing it per item would be a last-writer-wins race between concurrent children.

Skills are data, not code. `loadSkillRegistry` reads `skill.json` and an instructions file; it executes nothing. It resolves the skill directory and the entrypoint with `realpath` and requires both to stay under the registry root, then records the entrypoint's SHA-256 so a later change is detectable. The three skills in `skills/` are text only.

MCP servers are a real execution boundary: a stdio server is a child process started from the configured `command`, with configured `env` and `cwd`. `mcp.json` is trusted local configuration; a hostile file is equivalent to running a local command. The manager expands `${VAR}` references from the environment and refuses a missing variable rather than substituting an empty string. `src/service/mcp-identity.ts` records a hash of the dispatcher names and their configuration versions that a conversation ran with, and refuses to open a database whose recorded identity no longer matches while work is still outstanding, instead of re-pointing that work at a changed server. Tools that write externally are registered with `replay: "unsafe"`; the Notion article write and the MCP tool bridge are the concrete cases.

**Credentials.** No key is written to the database, printed, or placed in a prompt. `runtime.ts` reads `DEEPSEEK_API_KEY` and `OPENAI_API_KEY` inside the provider; a custom provider receives an in-memory string. The TUI's config validator refuses any field whose name looks like a credential (`CREDENTIAL_FIELD`) and accepts only `apiKeyEnv`, which names a variable that must already be set. API keys are never accepted as command-line arguments.

## 3. Development and usage

### Prerequisites

* Node.js `>= 22.19.0` (`package.json` engines). CI pins `22.22.2`.
* npm with the committed `package-lock.json`.
* git.
* Network access during preparation: `scripts/prepare.mjs` fetches the pinned Pi checkout, runs `npm ci --ignore-scripts` for the app and the checkout, and downloads the model-catalog revision named by the checkout's `nix/model-catalog.json` (bytes verified by SHA-256). It is not an offline build.

The application uses Node's built-in SQLite through `openNodeSqliteStorage`; there is no native module to compile. The linker uses junctions on Windows, so no Developer Mode setting is required.

### Install

From the repository root:

```sh
node scripts/prepare.mjs
```

`prepare.mjs` is the single setup entry point. In order: parse arguments strictly, read `pi-pin.json`, prepare or verify the checkout at commit `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`, install from the lockfiles, hydrate the model catalog, build the type artifacts in the order chord -> telemetry -> ai (`build:offline`) -> durable -> tui -> mcp, link the five `@earendil-works/*` packages, then verify revision, package identity and link targets. `--clean` drops the generated artifacts first; `--checkout-dir <path>` (or `PI_CHECKOUT`) selects a different checkout. An existing checkout is never rewritten or deleted; a revision mismatch is a hard failure.

`npm run link` runs only the linking step, against an already prepared checkout.

### Environment variables

| Variable | Read by | Purpose |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | `src/runtime.ts` | Required for `--provider deepseek`; base URL `https://api.deepseek.com` |
| `OPENAI_API_KEY` | `src/runtime.ts` | Required for `--provider openai`; fixed `api.openai.com` base URL |
| `PROBE_API_KEY` | `src/cli.ts` | Default variable name for `--provider custom --api-key-env` |
| any name named by config `apiKeyEnv` | `src/service/session.ts` | The TUI reads that variable for a custom endpoint; the config is refused if it is unset |
| `NOTION_TOKEN` | `src/config.ts` | Notion integration token for `notion:*` and `article:probe` |
| `NOTION_PAGE_ID` | `src/config.ts` | Default read target for `notion:read-page` |
| `NOTION_ARTICLE_PARENT_PAGE_ID` | `src/config.ts` | Write target for `article:probe`; deliberately separate from `NOTION_PAGE_ID` |
| `MCP_SERVER_SCRIPT`, `MCP_SERVICE_TOKEN`, `MCP_HTTP_TOKEN` | `mcp.example.json` | Example names referenced as `${VAR}`; any name works, and an unset variable is an error |
| `PI_CHECKOUT` | `scripts/prepare.mjs`, `scripts/link-checkout.mjs` | Checkout location; `--checkout-dir` wins over it |

### Commands

Run from the repository root:

| Command | What it does |
| --- | --- |
| `npm run pi:prepare` | Alias for `node scripts/prepare.mjs` |
| `npm run link` | Links the five Pi packages into `node_modules` |
| `npm run cli -- [flags] <prompt>` | One submission, one durable answer |
| `npm run agent:tui -- --db <path> --config <path>` | Interactive terminal client |
| `npm run multiagent:probe -- --provider <kind> --db <path> --request-id <id>` | Full delegate -> review acceptance run against a real provider |
| `npm run multiagent:inspect -- --db <path> --task-id <id>` | Dumps the persisted ledger for one task |
| `npm test` | All vitest suites |
| `npm run multiagent:test` | The ten multi-agent suites only |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | Biome lint |
| `npm run notion:me`, `notion:search`, `notion:read-page`, `notion:tool` | Notion probes |
| `npm run article:probe` | Article acceptance probe |
| `npm run agent:finish-evidence` | Evidence runner for the finish path |

The TUI exits `0` on a normal close, `1` when the session cannot open, `2` when stdin/stdout is not a TTY, and `3` for invalid arguments or config (`EXIT` in `src/service/config.ts`). `--db :memory:` is refused: a database that cannot be reopened cannot restore the view. Slash commands are `/help`, `/tasks`, `/transcript`, `/quit` (alias `/exit`), `/inspect <id>`, `/cancel <id>` (or `/cancel all`), `/answer <text>` (or `/answer --insufficient <text>`), `/withdraw <id>`, `/mcp` (with `connect <name>` / `disconnect <name>`), and `/model [<id>]`.

### A first run

The offline path needs no credentials. It writes a real SQLite file and prints the committed transcript kinds, which is what proves the answer was persisted rather than echoed:

```sh
npm run cli -- --db ./data/probe.sqlite --provider faux --request-id job-1 "Summarize the plan."
```

Reopening the same `--db` and reusing `--request-id job-1` resolves to the same submission rather than a second one; changing the request id creates a new one.

A real end-to-end delegation uses DeepSeek and the acceptance runner, which drives the `task_delegate` / `task_review` round end to end and then checks the persisted evidence against its own acceptance rule:

```sh
export DEEPSEEK_API_KEY=...
npm run multiagent:probe -- --provider deepseek --db "$PWD/data/multiagent.sqlite" --request-id smoke-1
npm run multiagent:inspect -- --db "$PWD/data/multiagent.sqlite" --task-id task-smoke
```

The TUI runs against the example config, which installs the faux provider and a three-model catalog:

```sh
npm run agent:tui -- --db data/agent-tui.sqlite --config agent-tui.example.json
```

Closing and reopening the same command restores the conversation; `close()` writes no outcome, so `harness.resume()` on the next open continues whatever was in flight.

A programmatic submission uses the same public surface as `src/cli.ts`:

```ts
import { context, openProbe, openRoot } from "./src/runtime.ts";

const probe = await openProbe({
  databasePath: "./data/probe.sqlite",
  provider: "faux",
  fauxResponses: ["done"],
});
try {
  const root = await openRoot(probe);
  probe.harness.resume();
  const submission = await root.submit(
    { type: "input", content: "hello", requestId: "job-1" },
    context,
  );
  const settled = await submission.wait(context);
  console.log(settled.status); // "done" | "unanswered" | ...
} finally {
  await probe.close();
}
```

### Configuration shape

The TUI config names a provider (`faux`, `deepseek`, `openai`, `custom`), an optional model and base URL, and a required `runConfig`. Every limit is explicit; unknown fields and credential-like fields are refused. `agent-tui.example.json` is a complete valid document. `runConfig` requires `harnessRetry.maxRetries === 0`: the batch runtime counts attempts, restarts and provider retries itself, and a second retry layer would make those counters describe something other than what happened.

MCP is configured separately in `mcp.json` (`--mcp-config` overrides the default `./mcp.json`). `mcp.example.json` shows a stdio server and a Streamable HTTP server with `${VAR}` references.

## 4. Testing and verification

The test suite is 36 vitest files under `test/`. No suite requires a provider credential: model-driven suites use the faux provider, and the MCP suites start local stdio and HTTP fixtures.

* **State and contracts** — `agent-state`, `agent-contracts`, `agent-batch`, `agent-budget`, `agent-failure`. These cover legal and illegal transitions, terminal-status refusal, batch validation (unique ids, dependency closure, cycles), budget accounting, and the technical/quality/cancelled classification.
* **Durability and recovery** — `persistence-reopen`, `agent-recovery`, `multiagent-recovery`, `main-review-recovery`, `mcp-recovery`. The process-kill suites (`agent-recovery`, `multiagent-recovery`, `main-review-recovery`) spawn a child process and have it SIGKILL itself at named boundaries; the reopened database must resume the same task, the same child conversation and the same round with no duplicate submission. `multiagent-recovery.test.ts` documents eight boundaries, including a revision round whose intent is committed but whose submission does not exist yet. `mcp-recovery` closes a session while a call is in flight, edits the server list, and checks that the committed call is never sent to the new destination.
* **Main loop** — `main-clarification`, `main-plan`, `main-review`, `main-review-recovery`. Question scope narrowing, plan versioning, accept/rework, revision budget exhaustion, and replay of a recorded decision.
* **Delegation** — `multiagent`, `multiagent-concurrency`, `multiagent-cancel`, `multiagent-cancel-admission`, `multiagent-revision`, `multiagent-evidence`, `multiagent-compaction`, `multiagent-inspect`, `multiagent-prompts`. Isolation of the child prompt and tool set, concurrent admission and fairness, stop-before-abort semantics, evidence redaction and truncation, and revision behavior.
* **Builder and skills** — `subagent-factory`, `skill-registry`. Config assembly, hashing, and filesystem containment (`realpath`, entrypoint inside the skill directory).
* **MCP** — `mcp-config`, `mcp-connect`, `mcp-cwd`, `mcp-recovery`, `mcp-session`, `mcp-tools`. `${VAR}` expansion and refusal, stdio and HTTP transports, identity binding on reopen, and tool bridging.
* **TUI** — `tui-autocomplete`, `tui-config`, `tui-state`, `tui-terminal`, `tui-view`. Argument and config refusal, exit codes, slash-command routing, and terminal restoration.
* **Other probes** — `notion-read` (config errors name the variable, never the value) and `article` (fixture-based, no live write).

CI (`.github/workflows/ci.yml`) has three independent jobs named `lint`, `typecheck` and `test` on `ubuntu-latest` with Node `22.22.2`. Each job prepares the same pinned upstream checkout with `node scripts/prepare.mjs`, then runs `npm run lint`, `npm run typecheck` or `npm test`. The workflow has `permissions: contents: read`, cancels superseded runs on the same ref, and pins every action to a full commit SHA. The test job runs completely without credentials; no real model or Notion call happens in CI.

Boundaries and planned work, as recorded in `doc/ci.md`: a green run proves the pinned environment and the suites, not live model behavior, Notion write fidelity, or Windows path behavior. The same document lists the next candidates: permanent regression tests for `prepare.mjs` (argument refusal, checkout precedence, path-escape fixtures), Windows verification, a decision on lint warnings, a formatter and dependency-audit policy, and explicit, separately triggered live-model runs. Nothing in the repository provides a filesystem or network sandbox for child tools; the GitHub-hosted runner is the CI environment, not a deployment boundary.

## 5. License

Apache License 2.0. The full text is in [`LICENSE`](LICENSE), and `package.json` declares `"license": "Apache-2.0"`. Copyright 2026 NaoYUN77.
