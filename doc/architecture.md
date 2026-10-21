# Architecture

This document describes how the application in this repository is built. It is
the longer treatment of the system summarized in [`../README.md`](../README.md):
the README explains what the program does and how to run it, and this file
explains how the durable state, the admission path and the recovery rules are
actually arranged in the source. `probe-notes.md` and `reports/` are historical
records from the work that produced this code; they are not a specification.

Every claim below names the file it comes from. Where the code contains a limit
or a refusal that a reader might otherwise assume away, the constant is quoted.

## 1. Shape of the system

### 1.1 Layers

The source is organized so that the durable contracts sit at the bottom and the
terminal sits at the top. The dependency direction is mostly downward, with one
deliberate type-only join described at the end of this section.

| Layer | Directory | Responsibility |
| --- | --- | --- |
| Contracts | `src/agent/contracts/` | Validators and value types for anything that crosses a trust boundary: `RunConfig`, `TaskSpec`, `Plan`, clarification state, `TaskResult`, document definitions |
| State | `src/agent/state/` | Pure decisions: the two transition tables, failure classification, field ownership, quota accounting, the completion boundary |
| Builder | `src/agent/builder/` | `authorizeTask`, child configuration assembly, skill loading, the tool catalog |
| Ledger | `src/multiagent/ledger.ts` | `TaskLedgerDoc`: rounds, attempts, reviews, events, the execution right |
| Runtime | `src/agent/runtime/` | The batch runtime: admission, the nested round tool, quota, cancellation, review, document definitions |
| Main | `src/agent/main/` | Main's four tools, the service document, request and answer identity, restoration |
| Service | `src/service/` | The composition root, the shared Main service, the read model, routing, the change feed |
| Terminal | `src/tui/` | The pi-tui screen, the editor, the controller |
| Probes | `src/notion/`, `src/article/`, `src/mcp/` | Notion read/write, article acceptance, MCP configuration and bridging |

`src/runtime.ts` and `src/cli.ts` sit beside the layers: the first opens the
Harness and selects a provider, the second is a one-submission entry point.

Two files are lower than their directory suggests. `src/agent/contracts/round-execution.ts`
exists because both the ledger and the runtime need the round execution record
and neither may import the other; `src/agent/contracts/tool-effects.ts` is
imported by the catalog and the runtime for the same reason. The batch runtime
(`src/agent/runtime/runtime.ts`) imports four types from `src/agent/main/tools.ts`
(`BatchHost`, `BatchStageRequest`, `DispatchResult`, `MainToolHost`) because the
runtime implements those interfaces; that is a type-only dependency on the
interface, not a control dependency. The service and the tools are what call into
the runtime, never the reverse.

### 1.2 Processes and entry points

There are three entry points that open the Harness, all over the same kind of
SQLite file:

- `src/cli.ts` — one submission, one answer. Used for the durability probe.
- `src/tui/main.ts` — the interactive terminal, through `openAgentSession`.
- `src/multiagent/cli-multiagent.ts` — a headless delegate/review run against a
  real provider.

`openAgentSession` (`src/service/session.ts`) is the production composition
root. Its ordering is part of the architecture, not an implementation detail:

```
openProbe            Harness + provider + registry
openRoot             the Main conversation
mcp identity check   refuse a changed MCP configuration over unfinished work
skill registry       what a child may be granted
createBatchRuntime   the batch runtime, its extension installed
openMainService      Main's control surface, with open reconciliation
harness.resume()     last
```

`resume()` is last because recovery immediately re-executes the interrupted tool
call, and a replayed `dispatch_tasks` needs the runtime and the Main service
already installed. Closing is also deliberate: `close()` stops the watches and
closes the Harness; it never cancels. Work in flight pauses at its last durable
point and the next open replays it (`src/service/session.ts`).

## 2. State: the document model

### 2.1 Why documents rather than objects

All durable state is a typed document declared with `defineDoc` or
`defineDocFamily`. A document has a kind, a schema version, a scope, and a key
(or a family of keys). The store is Node's built-in SQLite, opened through
`openNodeSqliteStorage` in `src/runtime.ts`.

The point of the document shape is that every decision can be expressed as a
read and a write in one transaction, and the transaction is the only unit of
atomicity the program has. There is no in-memory state that survives a commit and
cannot be reconstructed; the admission path in particular is written so that a
slot, a reservation and an execution right land together or not at all.

### 2.2 The documents

| Kind | Version | Scope | Key | Definition | Holds |
| --- | --- | --- | --- | --- | --- |
| `app.agent.request` | 1 | conversation | `requestId` | `src/agent/contracts/documents.ts` | Requirement text, materials, request version |
| `app.agent.clarification` | 1 | conversation | `requestId` | `src/agent/contracts/documents.ts` | Questions, answers, resolutions |
| `app.agent.plan` | 1 | conversation | `planId` | `src/agent/contracts/documents.ts` | Versioned plan, bound to a request and request version |
| `app.agent.task-spec` | 1 | conversation | `taskId` | `src/agent/contracts/documents.ts` | The task body saved at dispatch admission |
| `app.agent.task-config` | 1 | conversation | `taskId` | `src/agent/contracts/documents.ts` | The configuration snapshot a child actually ran with |
| `app.agent.task-result` | 2 | conversation | `resultId` | `src/agent/contracts/documents.ts` | The settled result of one round |
| `app.agent.batch` | 1 | conversation | `batchId` | `src/agent/runtime/documents.ts` | Members, fairness sequence, receipts, stop intent |
| `app.agent.quota` | 1 | conversation | `requestId` | `src/agent/runtime/documents.ts` | Instance and attempt reservations for one request |
| `app.agent.runtime.scheduler` | 1 | session | singleton | `src/agent/runtime/documents.ts` | Active slots and the waiting queue |
| `app.agent.runtime.batch-index` | 1 | session | singleton | `src/agent/runtime/documents.ts` | Admitted batch ids, so a stop can discover work |
| `app.agent.runtime.round-binding` | 1 | conversation (child) | singleton | `src/agent/runtime/documents.ts` | The round a child is running and what it may spend |
| `app.agent.main-service` | 1 | conversation | singleton | `src/agent/main/service-doc.ts` | Request pointer, plan index, queued inputs, receipts |
| `app.multiagent.task-ledger` | 3 | conversation | `taskId` | `src/multiagent/ledger.ts` | Rounds, attempts, reviews, events, execution right |
| `app.mcp.main-config` | 1 | conversation | singleton | `src/service/mcp-identity.ts` | Hash of the MCP capability set a conversation ran with |

### 2.3 Scope and key choices

The scopes are load-bearing, and each one has a stated reason in its definition:

- **Session scope for the scheduler and the batch index.** `maxConcurrentSubAgents`
  is a limit over the whole run, while `maxSubAgentsPerRequest` is per request.
  Only a session document sees both at once. The batch index is session-scoped
  because a session is what a reopen restores.
- **Conversation scope for the quota, keyed by request id.** Two dispatches in
  one request share one budget, so the key cannot be the batch. The limit is
  stated in the definition of `AgentQuotaDoc`.
- **Conversation scope for results, keyed by `resultId`.** A rework writes a
  second receipt rather than overwriting the first, and a result survives the
  business task reaching a terminal state.
- **Ledger keyed by `taskId`.** Each task is its own document, so one long
  conversation does not accumulate a single ever-growing object, and inspection
  is one read.
- **Round binding as a child-conversation singleton.** One child runs one round
  at a time. A family would allow a stale key to be read by mistake.

Every conversation-scoped document declares `history: "latest"` and
`fork: "initial"`: the previous version of a document is not part of any
decision, and a fork starts from the document's initial state rather than
inheriting a parent's. The two session-scoped documents (`SchedulerDoc`,
`BatchIndexDoc`) declare neither.

### 2.4 Schema versions and migration

Each document carries a `schemaVersion` field, and the document definition
carries the version the runtime expects. `migrate` is used only where an older
shape exists in the field:

- `TaskLedgerDoc` (version 3) fills the fields a version-1 document predates:
  `events`, `operations`, and the `version` counter. A version-2 document is
  already a valid version-3 document; the only addition is the optional
  `RoundRecord.execution`, and inventing an execution record for a round the
  newer runtime never started would claim it did (`src/multiagent/ledger.ts`).
- `AgentTaskResultDoc` (version 2) was re-keyed from `taskId` to `resultId`.
  Version 1 had no production writer, so there is nothing to migrate; a version-1
  document would sit at an address version 2 never reads.

No other document defines a migration. The rule is that a migration either fills
a field that provably could not exist or is not written at all.

### 2.5 Commits

`api.commit(async (tx) => ...)` is used for every multi-document decision. The
important consequence is not that writes are fast; it is that a refusal and its
receipt are written by the same transaction that decided it. A replayed call
therefore reports the refusal it already made instead of re-deciding against
state that has moved since. This pattern appears in `dispatch_tasks`
(`src/agent/main/tools.ts`), `gateRound` and `writeSettlement`
(`src/agent/runtime/item.ts`), `admitOne` (`src/agent/runtime/admission.ts`), and
`reviewTask` (`src/agent/runtime/review.ts`).

## 3. Control flow

### 3.1 Overview

```
 user input
     |
     v
 Main conversation
   request_clarification --> question persisted, run ends
   save_plan -------------> AgentPlanDoc (versioned, bound to request/requestVersion)
   dispatch_tasks --------> dispatch admission commit
   review_task -----------> accept | rework
     |
     v
 dispatch_tasks
   validateTaskBatch        fields, unique ids, dependency closure, cycles
   admissionBlockReasons    plan version, open questions, unaccepted deps, quota
   authorizeDispatch        deployment policy; a throw is a refusal
   ONE COMMIT
     MainServiceDoc.dispatchAttempts
     AgentBatchDoc + BatchIndexDoc
     AgentTaskSpecDoc (one per member)
     operation-started marker
     |
     v
 executeBatch: one nested tool call per (task, round), joined with allSettled
   key = task.<taskId>.r<round>
     |
     v
 agent_task_round
   loop: gateRound (commit) -> runAttempt -> retry wait
     |
     v
 child conversation, one round at a time
   finish_task / task_status / task_evidence + granted tools
     |
     v
 settlement commit: result document, round record, business status, batch receipt,
                    slot release, queue removal
     |
     v
 review_task(accept | rework)
```

### 3.2 Main's four write boundaries

`createMainExtension` (`src/agent/main/tools.ts`) installs exactly four tools.
`MAIN_TOOL_NAMES` is the exported list and is what the conversation is granted.

**`request_clarification`.** Writes the question and its operation receipt in
one commit, then returns a `handoff` control built from persisted facts. The
handoff ends the run; returning text alone would let the round continue past a
question that was already asked. On a re-ask, an explicit `blockedTaskIds`
replaces the question's blocking scope; omitting the argument never widens it
(`blockingQuestionIdsFor`).

**`save_plan`.** Writes a versioned plan bound to the request id and request
version read inside the transaction. A stale `expectedVersion` is refused rather
than merged, following the `assertPlanVersion` rule. The plan and the service's
plan index are written together.

**`dispatch_tasks`.** Validates the batch, runs admission, stages the batch and
the saved specs, and only then hands the batch to the executor. Refusal reasons
are a fixed vocabulary (`admissionBlockReasons` plus the tool's own checks):
`plan_version_stale`, `clarification_open`, `dependencies_not_accepted`,
`quota_exhausted`, `plan_request_mismatch`, `tasks_not_in_plan`,
`dependency_check_unavailable`, `not_authorized`, `requirement_unresolved`.

**`review_task`.** Records one decision for one round. An accept and its receipt
are one commit. A rework re-enters the same nested-call path an initial dispatch
uses, with `trigger: { kind: "rework" }`.

### 3.3 Dispatch admission

The admission commit is the `api.commit` inside `dispatch_tasks`
(`src/agent/main/tools.ts`); its `stage` hook is `stageBatch`
(`src/agent/runtime/runtime.ts`). One transaction writes the service document,
the batch, the batch index and the saved specs. The order inside the commit
matters:

1. Read the plan, the request and the service document.
2. Refuse if the plan version or the request identity does not match.
3. Reserve the dispatch-operation budget (`MainServiceDoc.dispatchAttempts`),
   keyed by the call's `opKey`.
4. Stage the batch (`stageBatch`) and the item specs (`saveSpecs`).
5. Write the operation-started marker (`host.beginOperation`).

A refusal is recorded in the same transaction, so a replay of the same call
reports the same refusal rather than attempting the dispatch again. The marker
is what distinguishes "this call never ran" from "this call ran and its receipt
was lost": without it, a lost receipt would be indistinguishable from a crash
before the commit.

After the commit, `dispatch_tasks` hands the batch to the runtime's `dispatch`
hook; `dispatchBatch` (`src/agent/runtime/runtime.ts`) is the post-admission
executor, and it renders its result lines from the batch receipt.

The batch id is `batch:dispatch:<toolTaskId>:<callId>` (`batchIdOf` over the
dispatch operation key). It is derived, not minted.

### 3.4 Batch load

`loadBatch` (`src/agent/runtime/runtime.ts`) runs before any item starts and
refuses the whole batch if it cannot be resumed. Its checks, in order:

1. The named task set: non-empty, no duplicates, and a rework names exactly the
   task its trigger names (`task_not_in_batch`).
2. The saved plan: it exists, its version matches the caller's, and it names a
   requirement (`plan_version_stale`, `plan_request_mismatch`).
3. The batch: admitted, admitted for this plan version and this request, under
   the same run-config fingerprint (`batch_contract_changed`,
   `plan_request_mismatch`, `run_config_missing_or_invalid`), and not being
   cancelled (`cancel_pending`).
4. Each member: it is in the plan and the batch, its saved spec exists, validates
   and belongs to this plan and request (`saved_spec_invalid`); the task is not
   terminal (`task_terminal`); a rework is only for a task `awaiting_review` with
   revision budget left (`task_not_ready_for_rework`); the round's execution
   right is free (`execution_right_held`); no task-level cancel intent
   (`cancel_pending`).
5. Dependencies outside the batch are accepted (`dependency_not_accepted`),
   checked last because a dependency the batch itself contains is the batch's own
   DAG rule.

A refusal throws `BatchNotResumable` with a `RefusalCode` and a detail
(`src/agent/runtime/contracts.ts`). The alternative, a partially started batch
that discovers a stale contract halfway through, spends budget on work that
cannot be accepted.

### 3.5 Execution

`executeBatch` starts one nested call per item:

```
api.executeTool(AGENT_TASK_ROUND_TOOL, { batchId, taskId, round, mode, feedback? },
                context, { key: roundCallKey(taskId, round) })
```

and joins them with `Promise.allSettled`, so one item's rejection cannot discard
the batch. `agent_task_round` is declared with `callers: ["tools"]` and is never
visible to a model. Results are read back from the batch document's receipts in
`taskIds` order, not from model text; `readItemToolOutput` validates the nested
`structuredOutput` against the tool's five declared statuses (`completed`,
`failed`, `cancelled`, `queued`, `refused`) and turns a malformed value into a
failed member rather than a trusted status.

A refusal at load time is materialized as a write-once receipt by
`recordRefusals`, so a later replay reports the refusal instead of re-reading
state.

### 3.6 A round

`runItemRound` (`src/agent/runtime/item.ts`) is a loop:

```
gateRound (inside a commit)
  receipt replay check (an item receipt for this round or a later one answers)
  recorded stop intent (settles the item as cancelled)
  saved spec -> authorizeTask -> buildSubAgentConfig -> admitOne -> openAttempt
  admission may defer (queued) or refuse

runAttempt
  write AgentRoundBindingDoc into the child conversation
  setRoundEntryFloor
  submit one input to the child
  wait for settlement, bounded by the round deadline
  stopChild persists the stop intent before aborting

classifyFailure
  operator cancel   -> round terminal
  deadline          -> round failed, requiresMainDecision
  provider retry    -> only model_error, while the provider budget lasts
  technical         -> retry while the attempt budget lasts, else failed
  quality           -> round completed, task stays awaiting_review

settlement (one commit)
  AgentTaskResultDoc (write-once)
  round record (settleRoundRecord)
  business transition (decideRoundFailure + applyBusiness)
  batch receipt
  releaseSlot + dequeue
```

`admitOne` (`src/agent/runtime/admission.ts`) is the only function that reserves
anything. Its ordering is fairness first, then capacity, then resource conflict,
then quota. A held execution right answered from the existing admission is
returned before anything is re-decided. The two quota reservations are taken in
one `try`: a refusal of the second restores the first, and a refused admission
charges nothing.

### 3.7 Review

`reviewTask` (`src/agent/runtime/review.ts`) writes a decision and its receipt in
one commit. The refusal vocabulary is `ReviewRefusalCode` (12 codes), and the
revision budget is `MAX_REVISIONS = 2` (`src/multiagent/ledger.ts`).

Two behaviours are worth stating explicitly:

- Once the budget is spent, a further rework is refused with
  `review_revision_limit` and the task stays `awaiting_review`. `failed` is
  Main's judgement, not the side effect of a budget.
- A prior rework whose execution failed before any later round existed does not
  count as a decision (`neverStarted`), so the task can still be reviewed rather
  than being locked by an error that decided nothing.

## 4. Identifiers and replay safety

### 4.1 Derived identifiers

`src/agent/runtime/contracts.ts` and `src/agent/main/request-id.ts` derive every
identifier from data the caller already has.

| Function | Result | Why |
| --- | --- | --- |
| `batchIdOf(opKey)` | `batch:<dispatch op key>` | A replay of the dispatch call finds the batch it already wrote |
| `operationIdOf(taskId)` | `task:<taskId>` | One operation per business task, across rounds |
| `attemptKeyOf(taskId, round, n)` | `task:<id>:r<round>:attempt:<n>` | A retry pays for exactly one attempt |
| `attemptRequestId(taskId, round, n)` | `multiagent-round:<id>:<round>` for attempt 1, `:a<n>` after | The Harness dedups submissions by request id, so the first attempt keeps the legacy id |
| `roundCallKey(taskId, round)` | `task.<taskId>.r<round>` | The nested tool call's key |
| `resultIdOf(taskId, round)` | `res.<taskId>.r<round>` | A rework gets a new receipt instead of overwriting |
| `requestInputId(requestId, version)` | `req-input:<id>:v<version>` | A restatement is not a replay of the first input |
| `answerInputId(requestId, questionId, revision)` | `answer-input:<id>:<qid>:r<n>` | A repeated answer dedups; a genuine follow-up does not |

None of these reads a clock or an in-memory counter. The module headers state
the failure mode of the alternative: an id that collides is a lost message,
because the Harness settles a duplicate submission as a replay and the model
never sees the second input.

### 4.2 Receipts

A tool execution records an operation receipt keyed by the call's operation key.
`dispatch_tasks` reads the receipt before doing anything: a recorded result
replays verbatim, including its `isError` flag and any handoff control. A
recorded call with no result is treated as an interrupted attempt. It falls
through only when the runtime confirms that a batch exists for that operation key
(`batchIsResumable`, a non-creating `harness.snapshot`). Otherwise it reports an
unknown outcome rather than claiming completion.

### 4.3 Write-once fields and the execution right

- `claimRound` refuses a second holder (`ExecutionRightError`); `releaseRound`
  is the only release.
- `stampExecution` writes once; `setRoundEntryFloor` writes once.
- `AgentTaskResultDoc` is keyed by task and round.
- `AgentBatchDoc` item receipts are written once.
- A terminal round has no outgoing edge (`assertRoundTransition`).

The ledger's `activeOpKey`, `activeRound` and `activeToolTaskId` are the single
record of which operation may currently run a round. A terminal holder of that
right is detectable (`clearStaleRight`), which is what lets a reopened process
release a right left behind by a finished durable task without pretending the
round completed.

### 4.4 What a reopen replays

`harness.resume()` re-executes the interrupted tool call. Because the call's
receipt is durable, the replay short-circuits at whatever the first process had
committed:

- before the dispatch commit: the call runs normally;
- after the dispatch commit, before the item start: the item's gate reads the
  batch and receipt;
- after `openAttempt`, before settlement: the attempt record has no `settledAt`,
  so `nextAttemptNo` recomputes the same number and `gateRound` reuses the
  recorded attempt and its request id;
- after settlement: the item receipt answers the nested call.

The recovery suites (`test/agent-recovery.test.ts`,
`test/multiagent-recovery.test.ts`, `test/main-review-recovery.test.ts`,
`test/mcp-recovery.test.ts`) kill a child process at named boundaries and assert
this behaviour from the reopened database.

## 5. State machines

### 5.1 Two tables

`src/agent/state/lifecycle.ts` defines two tables. A business status describes
the task; a round status describes one execution of it.

```
BUSINESS_TRANSITIONS
  planned         -> running, cancelled
  running         -> awaiting_review, awaiting_input, failed, cancelled
  awaiting_input  -> running, failed, cancelled
  awaiting_review -> running, revising, accepted, failed, cancelled
  revising        -> awaiting_review, failed, cancelled
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

`revising` is a legacy label accepted on read and mapped to `running`; the write
path refuses it (`assertTransitionToNewStatus`). This is why the business table
still lists it and the round table does not.

### 5.2 Failure classification

`decideRoundFailure` maps a settlement to a round status and, when the business
status must move with it, a business status. The deadline case is decided in
`classifyFailure` before the shared table is consulted, because the table's
budget is about restarts, not about time.

| Kind | Round | Business | `requiresMainDecision` |
| --- | --- | --- | --- |
| `cancelled` | `cancelled` | `cancelled` | no |
| `quality` | `completed` | unchanged | no |
| `technical`, attempts remain | `retry_wait` | unchanged | no |
| `technical`, budget spent | `failed` | unchanged | yes |
| deadline (handled before the table) | `failed` | unchanged | yes |

A task already `cancelled` when the round fails settles as round `failed` with
the business status kept at `cancelled` and the settlement marked terminal.

The distinction is the core of the design. A failed round is not a failed task;
the task's terminal `failed` is a decision for Main, not something a retry budget
can spend on the model's behalf.

`admissionBlockReasons` is the refusal vocabulary used before a batch starts:
`plan_version_stale`, `clarification_open`, `dependencies_not_accepted`,
`quota_exhausted`. `mayTerminateAfterCancel` and `mayResumeAfterAnswer` are the
two other pure decisions in the same file.

## 6. Capacity, fairness and budget

### 6.1 Admission

`admitOne(tx, input)` (`src/agent/runtime/admission.ts`) makes four decisions in
a fixed order:

1. **Fairness.** An item that is waiting behind another one is deferred with
   `concurrency_full` even when a slot is free, so the freed slot goes to the
   head of the queue. The queue is ordered by `enqueuedAt`, with the enqueue
   ordinal as tie-breaker (`serviceOrder`). An item that has never been queued
   is unaffected.
2. **Capacity.** `maxConcurrentSubAgents` over the session, then
   `maxSubAgentsPerRequest` over the request. A `retry_wait` round keeps its slot:
   its durable task is still alive and about to submit again.
3. **Resource conflict.** `claimsConflict` over the item's derived claim. A task
   with no tools claims nothing and conflicts with nothing. One unknown write
   target makes the whole item exclusive (`UNKNOWN_WRITE` = `"*"`). A conflict
   defers the item to the queue; it is not a refusal.
4. **Quota.** `consumeOnce` reserves an instance and an attempt keyed by
   reservation id, so a replay of the same admission is answered rather than
   charged twice (`src/agent/runtime/quota.ts`).

The resulting write is one commit covering `SchedulerDoc.active`/`.queue`,
`AgentQuotaDoc`, `TaskLedgerDoc` (claim, `createdAt`, `activeToolTaskId`) and the
batch item fields (`attemptKey`, `round`, `nestedTaskId`). The two quota
reservations are taken in one `try`: a refusal of the second restores what the
first wrote. The round record is opened only after both fit, so a refused round
leaves no trace — including no empty round entry and no reset of the operation's
provider-retry counter.

### 6.2 Resource claims

`deriveResourceClaim` (`src/agent/runtime/resources.ts`) unions the declared
effects of every tool an item was granted. The effects are declared by the
catalog (`AuthorizedTool.effects`), never inferred from tool names or arguments:
a task's arguments are supplied by the model, and the runtime cannot establish
before the call what the call will touch. A tool whose write target cannot be
named declares `UNKNOWN_WRITE`, which makes the item exclusive — the opposite of
declaring nothing, which would let it run concurrently with everything.

### 6.3 Child-side quota

`wrapWithQuota` (`src/agent/runtime/child.ts`) wraps every granted tool with
`executionMode: "sequential"`, charges the per-round budget, and returns a
refusal as an `isError` tool result rather than throwing. A refused call is
therefore visible to the model and does not kill the round. `finish_task`,
`task_status` and `task_evidence` (`CONTROL_TOOL_NAMES`) are exempt. The
extension is installed once over the union of the policy tools; installing it per
item would be a last-writer-wins race between concurrent children.

`consumeOnce` is the only accounting primitive. `reconcileRoundFromEntries`
charges pre-execution refusals (`invalid_arguments`, `blocked`,
`tool_unavailable`) from the entry records when the round is reconciled, because
those calls failed before a tool could charge them.

## 7. Cancellation, deadlines and recovery

### 7.1 Cancel doctrine

`src/agent/runtime/cancel.ts` implements one order:

```
persist the intent  ->  abort the child  ->  verify the child is idle
                    ->  `cancelled` only when the right is free
```

A stop that cannot verify an idle child reports `stopping` and is resumed by
`reconcile`, rather than reporting a status it cannot prove. The distinction
between the two stop kinds is preserved end to end:

- An **operator cancel** ends the task: round `cancelled`, business `cancelled`,
  receipt `cancelled`.
- A **deadline** ends the round only: round `failed`, business status unchanged,
  `requiresMainDecision` set.

The item observes a recorded stop intent at the next `gateRound` and settles
itself (`stopFailure`). That is what makes a batch stop able to complete even
when the item's own task is the only thing that could write its receipt.

### 7.2 Recovery

`reconcileBatches` (`src/agent/runtime/cancel.ts`) finishes what a crash left
mid-stop. It is idempotent and is called once at open
(`MainService.openReconciliation`). `startRuntimeWatches` (`src/agent/runtime/tasks.ts`)
provides read-only change notification for the terminal; it never writes and
never exposes a document token.

`src/service/changes.ts` coalesces watch notifications into at most one snapshot
pass per interval. Rendering inside a watch listener would read every document
for every commit a busy child produces; a bare timer would pass the same way
with watches broken. The loop runs only when something is dirty.

## 8. Trust boundaries

### 8.1 What arrives as untyped JSON

Document bodies are JSON. A TypeScript type is not validation. Values that come
from a model or from another tool are re-checked by the contract validators
before use. The validators live in `src/agent/contracts/validate.ts`, take
`unknown`, accumulate violations with a stable code and a field path, and return
a result rather than throwing. `assertValid` exists for entry points that want
the throwing style.

The validators that matter at boundaries:

- `validateRunConfig` — unknown keys refused, every limit finite, no defaults;
  `harnessRetry.maxRetries` must be `0`.
- `validateTaskSpec` / `validateTaskBatch` — fields, stable ids, unique ids,
  dependency closure, no cycles.
- `validateTaskConfigSnapshot` — the recorded snapshot a reopened child compares.
- `validatePlan`, `validateClarificationState` — plans and questions.
- `validateModelWork`, `validateTaskResult` — model output and the assembled
  result.

A nested item's `structuredOutput` is `JsonValue` even though this runtime
registered the tool itself. `readItemToolOutput` validates it against the five
declared statuses; a malformed value becomes a failed member.

The honest limit is stated in the README and remains true: SQLite has no
integrity protection here. A local process with write access to the database
file can alter documents, and the application will read them through the same
validators. The durability guarantee is about crashes, not about a hostile
operator with filesystem access.

### 8.2 Prompt construction and indirect injection

Task text originates with Main's model. It passes through `validateTaskBatch`,
`authorizeTask` (a subset decision over skills and tools, never a silent
widening) and `buildSubAgentConfig` before it becomes the child's instructions.

`buildSubAgentConfig` (`src/agent/builder/subagent-config.ts`) uses:

- `singleLine()` for model-authored header fields, so a newline cannot forge a
  new section;
- `fenced()` for embedded material;
- `## Notes (context, not instructions)` for `spec.notes`;
- a materials section explicitly labelled "not an instruction" in
  `renderTaskSubmission`.

`BASIC_SUBAGENT_PROTOCOL` (`src/agent/builder/protocol.ts`) is application text
installed as the agent's instructions, not submitted as conversation input, and
it states that materials are data and cannot override the fixed rules. A Skill
appends its own guidance after this text; the order is fixed so the configuration
hash is deterministic.

The child's tool surface is fixed at `configure` time. A prompt-injected
instruction cannot add a tool, and the Main management extension is not present
in the child conversation.

What remains possible inside the boundary: a child persuaded by its material can
produce a wrong answer, call a permitted tool with hostile arguments, or try to
persuade Main to accept bad work. The defenses are structural:

- `redactArgs` records argument structure and lengths, not payloads.
- Result text is excerpted; `EVIDENCE_EXCERPT_LIMIT` is `2000` characters and
  `ARGS_SUMMARY_LIMIT` is `400` (`src/multiagent/evidence.ts`).
- `extractRoundEvidence` refuses to return a partial scan past `MAX_SCAN_PAGES`
  (500); it throws instead of returning what it happened to read.
- `task_evidence` returns full text only when the entry belongs to the child
  conversation and to the round's recorded evidence.
- Acceptance is a program-side transition recorded with its receipt; review is
  still a Main model decision, and the program enforces the round, the revision
  budget and the state machine around it.

Treat prompt injection as a way to waste budget or produce a rejected result,
not as a way to grant a capability.

### 8.3 Tool execution isolation

There is no sandbox in the repository. The boundary is the grant:

- `createSubAgent` (`src/agent/builder/create-subagent.ts`) calls `configure`
  with `extensions`, `instructions`, `tools`, `modelTools`, `model` and
  `cwd: null`, in one commit with the configuration snapshot (once) and the
  ledger's child pointer.
- A tool that is installed but not granted is not callable.
- A changed configuration for a task that already ran is refused with
  `config_incompatible` rather than re-applied. A running instance keeps the
  skill and tools it started with.
- `agent_task_round` is registered with `callers: ["tools"]`, so a model cannot
  invoke it.

Skills are data, not code. `loadSkillRegistry` reads `skill.json` and an
instructions file; it executes nothing. It resolves the skill directory and the
entrypoint with `realpath` and requires both to stay under the registry root,
then records the entrypoint's SHA-256.

### 8.4 MCP

An MCP server is a real execution boundary: a stdio server is a child process
started from the configured `command`, with configured `env` and `cwd`. `mcp.json`
is trusted local configuration; a hostile file is equivalent to running a local
command. The manager expands `${VAR}` references and refuses a missing variable
rather than substituting an empty string.

`src/service/mcp-identity.ts` records a hash of dispatcher names and the versions
of the destinations behind them. The hash contains no URL, argument, header or
credential. On open, a conversation that still has outstanding work refuses a
database whose recorded identity no longer matches, instead of re-pointing that
work at a changed server. A rotated token is the same destination and does not
change the identity.

Tools that write externally are registered with `replay: "unsafe"`. The Notion
article write and the MCP tool bridge are the concrete cases.

### 8.5 Credentials

No key is written to the database, printed, or placed in a prompt.

- `src/runtime.ts` reads `DEEPSEEK_API_KEY` and `OPENAI_API_KEY` inside the
  provider; a custom provider receives an in-memory string.
- `src/cli.ts` reads the custom key from an environment variable named by
  `--api-key-env`, never from argv.
- The TUI's config validator refuses any field whose name looks like a
  credential (`CREDENTIAL_FIELD`) and accepts only `apiKeyEnv`, which names a
  variable that must already be set.
- `src/config.ts` names the Notion variable, never its value, in errors.

## 9. The terminal layer

The TUI is split so that what the tests drive is what ships:

- `src/service/analysis.ts` performs the one read pass and decides each task's
  status word. Every field of `TuiSnapshot` is read from a document or from the
  Main service; the model list comes from the provider.
- `src/service/view.ts` is a pure function of a snapshot and a clock. It decides
  nothing; it formats. Time is shown as elapsed since the ledger's round start,
  never as a percentage, because no document counts steps.
- `src/service/router.ts` interprets one typed line. `SLASH_COMMANDS` is both
  what `/help` prints and what the editor completes, so the two cannot drift. An
  answer goes to the open question; a task is named, never guessed; a model is
  resolved against the catalog the newest pass read.
- `src/tui/controller.ts` owns the behaviour between a submitted line and the
  screen. It never cancels on quit, never treats Ctrl+C as "cancel", and never
  re-implements a service rule.
- `src/tui/app.ts` paints the frame and the editor. The quit confirmation is an
  overlay, so nothing under it moves.

Closing is not cancelling. `confirmQuit()` stops the watches and closes the
session; the next open replays whatever was in flight.

## 10. Extension points

### 10.1 A new tool a child may be granted

1. Register it with `defineTool` and give it an `AuthorizedTool` entry in
   `src/agent/builder/tool-catalog.ts`, including its `effects` (or
   `UNKNOWN_WRITE` when the target cannot be named before the call).
2. Add its name to the policy's allowed list at the composition root
   (`src/service/session.ts`).
3. If it must not be charged by the child-side quota, add it to
   `CONTROL_TOOL_NAMES`; otherwise it is wrapped automatically.

### 10.2 A new skill

Add `skills/<name>/skill.json` and `skills/<name>/instructions.md`, then add the
name to `ALLOWED_SKILLS` in `src/service/session.ts`. The registry is loaded from
`REPOSITORY_SKILLS`, which is addressed relative to the source file
(`new URL("../../skills", import.meta.url)`), not the process cwd. A skill is
text and a manifest; it is never executed.

### 10.3 A new document

Declare it with `defineDoc` or `defineDocFamily` beside the feature that owns
it. Choose `scope` from who must see it at once, not from where it is written.
Choose the key from the identity a replay will have. Add a `schemaVersion` and a
`migrate` only if a real older shape exists.

### 10.4 A new provider

The three built-in kinds (`faux`, `deepseek`, `openai`) and `custom` are in
`src/runtime.ts`. A new provider is a new branch there that returns a `Provider`;
it must not read a key from anywhere except an environment variable or an
in-memory value supplied by the caller.

## 11. Invariants to preserve

Changing this code without breaking one of these is the intended constraint:

1. **One writer per decision.** Scheduler slots have one writer (`admission.ts`),
   round records one (`round.ts`), receipts one (the runtime), the answer one
   (the service). A second writer is a second state machine.
2. **The commit is the decision.** A refusal and its receipt are written
   together. Never refuse in one transaction and record it in another.
3. **Derived, never minted.** A durable id comes from the call that caused it.
   A clock or a counter in an id makes replay create a second copy.
4. **Write-once.** A receipt, an execution stamp and an entry floor are written
   once. A rework writes a new key rather than overwriting the old one.
5. **Terminal means terminal.** No transition table has an edge out of a terminal
   status, and no recovery path invents one.
6. **A failed round is not a failed task.** Only Main may decide that a task
   failed; the runtime stops at `awaiting_review` or `requiresMainDecision`.
7. **The model cannot grant itself a capability.** Tools and skills come from
   `configure` and `authorizeTask`; a prompt is data.
8. **A stop is persisted before it is acted on.** The intent lands first; the
   status that claims the stop worked is written only after an idle child is
   verified.
9. **Validate at the boundary, not on every read.** Model output and nested tool
   output are re-validated; program-written documents rely on their definition
   and their single writer.
10. **The harness does not retry underneath the runtime.** `harnessRetry.maxRetries`
    is `0`, and `createBatchRuntime` refuses a config that says otherwise.

## 12. Reading map

| Question | File |
| --- | --- |
| What is a task allowed to be? | `src/agent/contracts/task-spec.ts` |
| What limits are in force? | `src/agent/contracts/run-config.ts` |
| Who may write this field? | `src/agent/state/authorization.ts` |
| Is this transition legal? | `src/agent/state/lifecycle.ts` |
| What counts as a finished answer? | `src/agent/state/finish.ts` |
| How is a batch admitted? | `src/agent/runtime/admission.ts`, `src/agent/runtime/runtime.ts` |
| What happens inside one round? | `src/agent/runtime/item.ts` |
| How is a round recorded? | `src/agent/runtime/round.ts` |
| How is budget charged? | `src/agent/runtime/quota.ts`, `src/agent/state/quota.ts` |
| How is work stopped? | `src/agent/runtime/cancel.ts` |
| How is work reviewed? | `src/agent/runtime/review.ts` |
| What do the tools see? | `src/agent/main/tools.ts` |
| How does the terminal read state? | `src/service/analysis.ts`, `src/agent/runtime/tasks.ts` |
| How is everything opened? | `src/service/session.ts` |

The test suite under `test/` is the executable form of most of this document.
The names that matter most are `agent-state` (the tables), `agent-contracts`
(the validators), `agent-batch` and `agent-budget` (admission and charging),
`agent-failure` (classification), `agent-recovery` and `multiagent-recovery`
(replay), `main-review` and `main-review-recovery` (review), and
`multiagent-cancel` and `multiagent-cancel-admission` (stop semantics).
