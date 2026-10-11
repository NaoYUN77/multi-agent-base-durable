# durable-cli-probe

TASK-001: a standalone probe that verifies the **minimal Pi Durable run chain** without touching the Durable core or
the Vacation demo.

It is deliberately the smallest thing that can prove five claims at once:

1. a minimal model call chain (submit → generate → answer),
2. SQLite storage persistence,
3. conversation recovery across a close/reopen,
4. `requestId` idempotency,
5. `Task` / `Harness` lifecycle (open → resume → close).

It implements **no agent loop, no tool, no task, and no sub-agent**. The built-in `pi.generation` task does all the work;
this probe only drives the public API.

---

## 1. Dependency provenance

The three packages are **not** taken from the npm registry. They are the local checkout, linked by symlink so there is
exactly one identity for each package: the checkout's real directory.

| package | source |
| --- | --- |
| `@earendil-works/pi-durable` | `<checkout>/packages/durable` |
| `@earendil-works/pi-ai` | `<checkout>/packages/ai` |
| `@earendil-works/chord` | `<checkout>/packages/chord` |

Default checkout path: `../base-durable-vaction-agent/pi`. Override with `PI_CHECKOUT`.

Checked-out revision at the time of writing:

```
$ git rev-parse HEAD
f44707e7f7190a8cc86ce105790c72c6b0f5fd5f
$ git status --short      # no output
```

Verified identity (`node_modules` symlink resolves to the checkout, not a copy):

```
resolved: E:\Code\pi-durable\base-durable-vaction-agent\pi\packages\durable\dist\index.js
real   : E:\Code\pi-durable\base-durable-vaction-agent\pi\packages\durable\dist\index.js
```

### Why symlinks instead of `file:` dependencies

A `file:` dependency makes npm copy the package and re-resolve that package's own nested dependencies against the
registry, which would substitute a same-named registry package for the checkout. `scripts/link-checkout.mjs` instead
symlinks all three names into `node_modules` **after** `npm install`, and never writes inside the checkout.

A second reason the links are top-level only: creating `node_modules/` symlinks *inside* the checkout packages makes
npm's arborist recurse on the next install (`#loadPeerSet` → `Cannot read properties of null (reading 'edgesOut')`).

---

## 2. Layout

```
durable-cli-probe/
├── package.json                     # scripts + dev tooling; no registry Pi packages
├── tsconfig.json                    # Node16 ESM, no paths override (one package identity)
├── vitest.config.ts                 # resolves the checkout with the `source` condition
├── scripts/
│   └── link-checkout.mjs            # symlinks the three packages into node_modules
├── src/
│   ├── runtime.ts                   # context, Models, provider, Registry, SQLite, Harness.open, close
│   └── cli.ts                       # args -> root -> submit -> wait -> print -> close
├── test/
│   └── persistence-reopen.test.ts   # faux provider + temp SQLite file
├── data/
│   ├── .gitkeep
│   └── .gitignore                   # SQLite files are never committed
└── README.md
```

---

## 3. Setup and run

```bash
cd E:/Code/pi-durable/durable-cli-probe

# 1. Install dev tooling (vitest, typescript, @types/node).
npm install --ignore-scripts

# 2. Symlink the checkout packages into node_modules.
npm run link

# 3. Run the CLI (offline faux provider by default).
npm run cli -- "Say hello in one short sentence."

# 4. Run the tests.
npm test

# 5. Typecheck.
npm run typecheck
```

> **Environment note.** The managed npm in this session (10.9.7, shipped with node 22.22.2) fails on *any*
> `npm install` — including a trivial empty package — with `Cannot read properties of null (reading 'edgesOut')`
> inside arborist's `#loadPeerSet`. This is a pre-existing defect of that npm build, not of this project.
> The installs recorded below were run with the system npm 11.17.0 at `C:/nvm4w/nodejs/npm.cmd`. Node used for all
> runs: **v22.22.2** (satisfies the checkout's `>=22.19.0`).

### Environment variables

| variable | meaning |
| --- | --- |
| `PI_CHECKOUT` | checkout root for `npm run link` (default `../base-durable-vaction-agent/pi`) |
| `DEEPSEEK_API_KEY` | only read when `--provider deepseek`; read **inside** the built-in provider; never printed, logged, or written to SQLite |
| `OPENAI_API_KEY` | only read when `--provider openai`; read **inside** the built-in provider; never printed, logged, or written to SQLite |
| `PROBE_API_KEY` (name is configurable) | only read when `--provider custom`; read from the env var named by `--api-key-env`; never printed, logged, or written to SQLite |
| `NOTION_TOKEN` | Notion credential for every `notion:*` command; a Personal Access Token or an internal connection token. Never printed, logged, or written to SQLite |
| `NOTION_PAGE_ID` | default page id for `notion:read-page` and `notion:tool`; a positional argument overrides it |
| `NOTION_PIN_IP` | **optional escape hatch.** Forces the transport to connect `api.notion.com` to this IPv4 while keeping SNI/Host correct. Unset means normal DNS. See §15 |

### CLI flags

| flag | default | meaning |
| --- | --- | --- |
| `--db <path>` | `./data/probe.sqlite` | SQLite file |
| `--provider <kind>` | `faux` | `faux` (offline) · `deepseek` (built-in) · `openai` (built-in) · `custom` (explicit base_url) |
| `--model <id>` | `deepseek-flash` for deepseek | model id; **required** for `custom` |
| `--request-id <id>` | `job-1` | submission idempotency key |
| `--base-url <url>` | — | base URL for `custom` only |
| `--api-key-env <NAME>` | `PROBE_API_KEY` | env var holding the key for `custom` |

### Running a real model (smoke test)

The API key is read **from an environment variable, never from argv**, so it does not appear in your shell history
or in a process listing, and this program never prints or stores it.

```bash
# ── DeepSeek (the probe's real-model default) ──────────────────────────────
# base_url is https://api.deepseek.com and is built into deepseekProvider();
# you do not pass --base-url.
export DEEPSEEK_API_KEY='sk-...'

node --conditions=source --experimental-strip-types src/cli.ts \
  --provider deepseek "Say hello in one short sentence."

node --conditions=source --experimental-strip-types src/cli.ts \
  --provider deepseek --model deepseek-v4-pro "Say hello in one short sentence."

# ── OpenAI ─────────────────────────────────────────────────────────────────
export OPENAI_API_KEY='sk-...'
node --conditions=source --experimental-strip-types src/cli.ts \
  --provider openai --model gpt-4o-mini "Say hello in one short sentence."

# ── Any other OpenAI-compatible endpoint (gateway, self-hosted, …) ─────────
export PROBE_API_KEY='your-key'
node --conditions=source --experimental-strip-types src/cli.ts \
  --provider custom --base-url https://your-gateway/v1 --model your-model "Say hello."
```

Or through the npm script (`npm run cli -- <flags>`); the key still comes from the environment.

**DeepSeek model ids.** The probe's default is `deepseek-flash`. The checkout's generated catalog
(`packages/ai/src/providers/data/deepseek.json`) lists exactly two chat models:

| id | name | context | max output |
| --- | --- | --- | --- |
| `deepseek-flash` | DeepSeek V4.1 Flash | 1,000,000 | 384,000 |
| `deepseek-v4-pro` | DeepSeek V4 Pro | 1,000,000 | 384,000 |

Note there is **no `deepseek-chat` / `deepseek-reasoner`** entry in this checkout's catalog, even though those are the
names the public DeepSeek API documents. Passing one would fail model resolution. If you need such an id, use
`--provider custom` with `--base-url https://api.deepseek.com` and that exact `--model`.

**Keeping the key out of shell history** (the flag form above puts it in `~/.bash_history`):

```bash
read -rs DEEPSEEK_API_KEY && export DEEPSEEK_API_KEY   # paste at the prompt, no echo
```

**Why `custom` exists.** pi-ai's built-in providers hard-code their base URLs (`deepseekProvider()` →
`https://api.deepseek.com`, `openaiProvider()` → `https://api.openai.com/v1`, …) and none accepts an override.
`custom` goes through pi-ai's own `createProvider({ id, baseUrl, auth, models, api })` using the OpenAI **Chat
Completions** API — the widest common denominator for compatible servers. It is wired in
`src/runtime.ts::buildCustomProvider`.

### Guard behavior and a real-network check

All of the following were executed:

```
# Guard: no key
$ ... --provider deepseek "hi"
Error: DEEPSEEK_API_KEY is not set; export it or use the faux provider.

# Guard: custom without a key
$ ... --provider custom --base-url https://example.invalid/v1 --model x "hi"
Error: --provider custom requires the key in env var PROBE_API_KEY

# Guard: custom without a base URL
$ PROBE_API_KEY=dummy ... --provider custom --model x "hi"
Error: provider custom requires baseUrl

# Real network path, deliberately fake key: the request really goes out and the
# error comes back as a handled outcome rather than a crash.
$ DEEPSEEK_API_KEY=sk-fake-for-guard-test ... --provider deepseek "Reply with: pong"
[probe] db=./data/ds.sqlite provider=deepseek model=deepseek-flash
[probe] root conversation id=1
[probe] submission=job-1 status=unanswered
[probe] reason=model_error
[probe] transcript kinds: pi.user, pi.assistant
```

The last run is the strongest evidence short of a valid key: the DeepSeek provider loaded, the request left for
`api.deepseek.com`, and the failure surfaced as `unanswered / model_error` — a handled outcome, not a thrown error.
**A successful answer from a real key was not executed** (none was available), so no success result is claimed.

---

## 4. Acceptance results

All results below are from commands that were actually executed in this session. Nothing here is projected.

### 4.1 Model call chain + SQLite persistence

```
$ node --conditions=source --experimental-strip-types src/cli.ts --db ./data/readme.sqlite --request-id demo-1 "Say hello."
[probe] db=./data/readme.sqlite provider=faux model=faux-1
[probe] root conversation id=1
[probe] submission=demo-1 status=done
[probe] answer: Hello from durable.
[probe] transcript kinds: pi.user, pi.assistant
```

The answer text is read back through a commit (`tx.entry(AssistantEntry, …)`), so what is printed is the committed
transcript, not an in-memory echo. `transcript kinds` is read back through `entries()`, proving the rows landed in
SQLite.

### 4.2 `requestId` idempotency (same DB, same key, second process)

```
$ node --conditions=source --experimental-strip-types src/cli.ts --db ./data/readme.sqlite --request-id demo-1 "Say hello."
[probe] db=./data/readme.sqlite provider=faux model=faux-1
[probe] root conversation id=1
[probe] submission=demo-1 status=done
[probe] answer: Hello from durable.
[probe] transcript kinds: pi.user, pi.assistant
```

The transcript is **still exactly two entries**. A repeated `requestId` returns the existing submission and appends
nothing — matching the source:

> `submissions.ts:155` — "A known request ID returns its existing submission without writing."

### 4.3 Different keys accumulate (persistence across process restarts)

```
$ ... --request-id job-A "First"     -> transcript kinds: pi.user, pi.assistant
$ ... --request-id job-B "Second"    -> transcript kinds: pi.user, pi.assistant, pi.user, pi.assistant
```

Four entries after the second process, so the earlier two survived the first process exiting.

### 4.4 Test suite

```
$ npm test
 RUN  v4.1.11 E:/Code/pi-durable/durable-cli-probe
 ✓ test/persistence-reopen.test.ts (2 tests) 2351ms
     ✓ persists the root conversation, its entries, and requestId idempotency across a reopen  1565ms
     ✓ starts a brand-new conversation file with root id 1 and a single user entry  784ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

The reopen test asserts, in order: root id survives; entry ids and count are unchanged; replaying `job-1` returns the
same `answer` entry id; the user-entry count stays 1; and the second run's queued faux response is never consumed
(which would be required if the replay had triggered a new model call).

### 4.5 Typecheck

```
$ npm run typecheck
tsc exit: 0
```

`tsconfig.json` resolves the checkout through the `node_modules` symlinks (dist types, one identity). The runtime uses
`--conditions=source` so it reads the checkout's TypeScript sources. Both point at the same checkout.

### 4.6 Checkout left unmodified

```
$ cd <checkout> && git status --short
                       # no output
$ git rev-parse HEAD
f44707e7f7190a8cc86ce105790c72c6b0f5fd5f
```

No changes under `packages/durable`, none under `packages/coding-agent/src/experimental/vacation`, and no nested
`node_modules` created inside any checkout package.

---

## 5. API surface used

Only public exports; nothing internal is imported.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
```

Lifecycle as wired in `src/runtime.ts`:

```ts
const models = createModels();            // models.setProvider(...) installs the provider
const registry = createRegistry();        // seeds the built-in tasks Harness.open requires
const storage = await openNodeSqliteStorage(path);
const harness = await Harness.open(storage, { models, registry, onReport }, context);
const root = await harness.root(context, { agent: { model } });
harness.resume();                          // enable scheduling / continue recovered work
const submission = await root.submit({ type: "input", content, requestId }, context);
const settled = await submission.wait(context);
await harness.close(context);              // writes no outcome, so a reopen continues rather than sees it done
```

**No `env` is passed.** This probe has no tool that touches a file system or a shell, so the optional execution
environment is simply absent — the same choice the Vacation demo makes (`vacation/runtime.ts`).

---

## 6. Limitations

- **`resume()` / `waitForTask()` / `submit()` are the only things that enable scheduling.** A Harness opened and never
  resumed will not run recovered tasks. The probe calls `resume()` explicitly.
- **Recovery is proven for persistence and idempotency, not for a mid-generate crash.** `test/persistence-reopen.test.ts`
  closes between runs; it does not kill a process inside a generation. The `faux` provider answers immediately, so
  there is no window to interrupt. Interrupting a live turn is the Vacation demo's territory.
- **No successful real-model answer was produced.** The DeepSeek path was exercised only with a deliberately fake key,
  which reached `api.deepseek.com` and returned `unanswered / model_error`. The `openai` and `custom` paths were not run
  at all. No success result is claimed for any real provider; export a valid `DEEPSEEK_API_KEY` and run the §3 command
  to get one.
- **`custom` uses the Chat Completions API only.** Providers that require a different wire protocol (Anthropic
  Messages, Google, Bedrock) need their own `api`, not this one.
- **`custom`'s model is hand-built** with a minimal `Model` object (`reasoning: false`, zero cost, no prompt-cache
  hints). It does not come from pi-ai's generated model catalog, so cost accounting and thinking levels are not
  meaningful for it.
- **Node's SQLite is experimental** — every run prints `ExperimentalWarning: SQLite is an experimental feature`.
  Expected, not an error.
- **`npm install` must go around the broken managed npm** (see the environment note in §3).
- No sub-agents, memory, RAG, MCP, Telegram, Feishu, Notion, or web UI are involved, per the task constraints.
- No git commit was made.

---

# TASK-002 — Notion API, read-only, through Durable

A minimal **read-only** Notion integration, built the same way as TASK-001: isolated in this probe, installing an
extension into a Durable registry, never touching the checkout's packages.

## 7. What was built

```
src/config.ts               NOTION_TOKEN / NOTION_PAGE_ID, Notion-Version 2026-03-11, token redaction
src/notion/types.ts         narrow JSON projections (what may enter a transcript)
src/notion/client.ts        the SDK client, error normalization, 429 Retry-After
src/notion/read.ts          users.me · search · pages.retrieve · blocks.children.list, paginated
src/notion/tool.ts          the `notion_read` tool + the `notion-read` extension
src/notion/runtime.ts       shared CLI plumbing (client, banner, exit codes)
src/notion/cli-me.ts        npm run notion:me
src/notion/cli-search.ts    npm run notion:search -- "<query>"
src/notion/cli-read-page.ts npm run notion:read-page -- "<page_id>"
src/notion/cli-tool.ts      npm run notion:tool   (the Durable end-to-end path)
test/notion-read.test.ts    26 offline tests over the read/format/error layer
```

`src/runtime.ts` gained one optional field, `extensions`, so a run can install extra extensions. Nothing else in
TASK-001's code changed except that same file's `openRoot()`, which now also selects those extensions.

## 8. Pinned dependency

| | |
|---|---|
| Package | `@notionhq/client` |
| Version | **5.27.0** (exact, not `^`/`latest`) |
| Integrity | `sha512-JnkLtAzSDrEnvtZ8dQ5L4KO+xyL5g01xK5qmKTmhJ5KFY8LWsMyFG033vHCj0mFcsz9thAMjfcAQz/SWxiexag==` |
| Node engine | `>=18` (probe requires `>=22.19.0`; Node here is v22.22.2) |
| Why 5.27.0 | latest on 2026-09-29; `>=5.12.0` is the SDK line that supports `Notion-Version: 2026-03-11` |

It is a `devDependency` because this probe is not published. The checkout packages stay symlinks, not registry
installs: `grep -c 'registry.npmjs.org/@earendil-works' package-lock.json` is **0**.

## 9. Notion API version and endpoints

`Notion-Version: 2026-03-11` (Notion's current version) is set once, on the client, so no call site can omit it.

Version 2026-03-11 renamed `archived` → `in_trash` and the append `after` → `position`. This probe reads only, and
reads neither field except `in_trash`-free responses, so the renames do not affect it — but the version is still pinned
so a future read of `archived` cannot silently return nothing.

| Command | Method + endpoint |
|---|---|
| `notion:me` | `GET /v1/users/me` |
| `notion:search` | `POST /v1/search` |
| `notion:read-page` | `GET /v1/pages/{page_id}` **and** `GET /v1/blocks/{block_id}/children` |
| `notion:tool` | the same three reads, reached through the Durable `notion_read` tool |

Base URL: `https://api.notion.com` (the SDK default; never overridden in a normal run).

## 10. Setup

```bash
# Token: paste at the prompt, no echo, no shell history.
read -rs NOTION_TOKEN && export NOTION_TOKEN

# The page id is only needed by the page-scoped commands.
export NOTION_PAGE_ID='<32-hex page id>'
```

The token is handed to `new Client({ auth })` as an in-memory string. It is never written to source, SQLite, the
transcript, or a log; `normalizeNotionError()` even rewrites `secret_…`/`ntn_…` shapes out of an error message it
passes on.

## 11. Acceptance results

Environment: Node `v22.22.2`, managed npm `10.9.7` (its `install` is broken here — see §3), system npm `11.17.0` used
to install. Reference checkout at `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f`, `git status --short` empty before and
after.

```
$ npm run typecheck
tsc exit: 0

$ npm test
 ✓ test/notion-read.test.ts    (26 tests)
 ✓ test/persistence-reopen.test.ts (2 tests)
 Test Files  2 passed (2)
      Tests  28 passed (28)
```

```
$ npm run cli -- --provider faux --request-id notion-tool-test-1 "读取 Notion 页面并总结"
[probe] db=./data/probe.sqlite provider=faux model=faux-1
[probe] root conversation id=1
[probe] submission=notion-tool-test-1 status=done
[probe] answer: Hello from durable.
[probe] transcript kinds: pi.user, pi.assistant
```

### 11.1 Real network: token rejected (no valid token available)

With a deliberately fake token, the request leaves the probe, reaches Notion, and comes back handled:

```
$ NOTION_TOKEN='ntn_fake_token_for_probe' node --conditions=source --experimental-strip-types src/notion/cli-me.ts
[notion] target=users.me version=2026-03-11 base_url=https://api.notion.com
[notion] error code=unauthorized status=401 request_id=ab7db75f-0907-4e87-9160-08cbde9ddd60
[notion] API token is invalid.
exit: 1
```

That is the **strongest evidence available without a valid token**: the version header, the base URL, the auth header,
and the error path are all live. `code=unauthorized` (not `object_not_found`) is exactly right for an invalid token —
see §13 for why the distinction matters.

A later attempt in the same session hit `ECONNRESET` and reported `code=transport_error`. That was the sandbox's
network egress, not the probe — see §15 for the diagnosis and the `NOTION_PIN_IP` escape hatch it prompted. The
condition cleared; every command below was re-run successfully against the live API afterwards.

With a real credential, `notion:me` returns an identity instead of an error:

```
$ NOTION_TOKEN='<redacted>' npm run notion:me
[notion] target=users.me version=2026-03-11 base_url=https://api.notion.com
[notion] bot id=3f6b0f7a-39e1-8134-a5ea-00274599291a
[notion] name=personal-agent-access-token
[notion] type=bot
[notion] workspace=Dennys ronny的工作空间
[notion] owner=user
[notion] token is valid
exit: 0
```

The full set of live results is in §15.

### 11.2 Durable tool path, with scripted tool calls

`notion:tool` scripts the faux model to call `notion_read` twice (`read_page`, then `read_blocks`), so the real
`pi.tool` task runs and a real `pi.tool-result` lands in the transcript:

```
$ NOTION_TOKEN='ntn_fake' NOTION_PAGE_ID='00000000-0000-0000-0000-000000000000' npm run notion:tool
[notion] selected extensions: notion-read
[notion] offered tools: notion_read
[notion] submission=notion-tool-test-1 status=done
[notion] transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant, pi.tool-result, pi.assistant
[notion] tool-result entry: 13
[notion] reopened root conversation id=1 (first open: 1)
[notion] reopened transcript kinds: pi.user, pi.system, pi.assistant, pi.tool-result, pi.assistant, pi.tool-result, pi.assistant
[notion] transcript survived restart: true
[notion] tool-result recovered: id=13 chars=126
[notion] replay status=done entries=7 (was 7)
[notion] requestId idempotent: true
```

Reading it:

- **Tool → registry**: the `notion-read` extension was selected and `notion_read` was offered to the model.
- **Tool result → transcript**: two `pi.tool-result` entries, one per call.
- **Restart**: reopening the same SQLite file returned conversation id **1** and the same 7 entry kinds; the
  tool-result at entry **13** was re-read through a commit (126 chars), so it is durable, not an in-memory echo.
- **Idempotency**: replaying `notion-tool-test-1` left the entry count at 7.

The two tool results carry the probe's handled failure (`Notion error: … — fetch failed`) because the token was fake
and egress later reset. What matters for TASK-002 is the **shape**: a failing tool produces a committed, recoverable
`pi.tool-result` with `isError` and a diagnostic, not a crash.

### 11.3 Output kinds observed

| Where | `kind` |
|---|---|
| transcript | `pi.user`, `pi.system`, `pi.assistant`, `pi.tool-result` |

`pi.tool-result` is the one that matters: it is written by the built-in `pi.tool` task when a model-issued call
settles (`harness/tool.ts:609`, `appendToolResult`).

## 12. Connection visibility, properties vs body, pagination

**Visible pages.** `npm run notion:search` with no query lists everything shared with the connection and prints
`results=`, `pages=`, `data_sources=`. With a fake token this is `0` results and an `unauthorized` error — the count is
only meaningful with a real token, and no count is claimed here.

**Properties vs block children.** These are different endpoints answering different questions, and the probe keeps them
apart:

| | `pages.retrieve` | `blocks.children.list` |
|---|---|---|
| Returns | the row's **columns** (title, select, relation, …) | the page's **body** (paragraphs, headings, lists) |
| For a database row | populated | usually just the page title, if anything |
| For a plain page | only `title` | the entire content |
| Shown by | `notion_read {action:"read_page"}` | `notion_read {action:"read_blocks"}` |

`read_page`'s output ends with `note: properties are not the page body; use action=read_blocks for its content` so the
model does not mistake an empty property list for an empty page.

**Pagination.** Both endpoints return `has_more` + `next_cursor`. `search()` and `blockChildren()` follow the cursor
up to a bound and report two different flags:

- `hasMore` — Notion still has more pages.
- `truncated` — the probe stopped at its own limit (`maxPages`, `limit`, or Notion's `page_size` cap of 100).

The distinction is deliberate: "Notion has more" and "I stopped early" lead to different follow-ups, and collapsing
them would hide when a result is incomplete.

## 13. Error handling: 401 vs 404 vs 429

The probe branches on Notion's API `code`, not the HTTP status, because Notion uses the same status for very different
causes:

| `code` | Status | What it means here | What to do |
|---|---|---|---|
| `unauthorized` | 401 | the token itself is invalid | re-issue the token |
| `restricted_resource` | 403 | token valid, capability missing (no read-content) | check the connection's capabilities |
| `object_not_found` | 404 | token valid, **the page was never shared with the connection** | share the page with the connection |
| `rate_limited` | 429 | too many requests | respect `Retry-After` |
| `validation_error` | 400 | a malformed id or body | fix the request |

`unauthorized` and `object_not_found` are the pair operators confuse most, so `normalizeNotionError()` preserves the
code and `NotionRequestError` prints it.

**429 handling** is the SDK's: `createNotionClient()` sets `retry: { maxRetries: 3 }`, so the SDK backs off using the
server's `Retry-After` and retries. `normalizeNotionError` additionally surfaces `retryAfterSeconds` when a 429/529
does reach the probe, and `describeNotionError` prints `retry_after=Ns`. A single retry cap keeps one read bounded.

## 14. The Durable integration, precisely

**How the tool enters the registry.** `defineTool()` types it; `defineExtension()` names the bundle;
`registry.install(extension)` publishes it. `Harness.open` requires `createRegistry()`'s built-in tasks
(`pi.generation`, `pi.tool`, `pi.compaction`) and installs any extra extension on top. The extension is process code,
never persisted — only its *name* is stored in the conversation's agent state.

**How a call becomes a `pi.tool-result`.** The model emits a `toolCall` block with `stopReason: "toolUse"`; the built-in
`pi.generation` task creates a `pi.tool` task per call (`generation.ts:586`); the tool task resolves the tool by name
among the conversation's tools, validates the arguments, runs `execute()`, and commits the result with
`appendToolResult` (`tool.ts:609`), which is what writes the `pi.tool-result` entry.

**Why `replay: "safe"`.** Every action is a GET. A crash mid-call may rerun the tool, and for a read that is both
harmless and correct — the rerun reattaches to the committed result rather than leaving a gap.

**Bounded output.** `outputLimits: { maxBytes: 24_000, maxLines: 600 }` and a rendered-text cap keep a single read from
flooding the transcript. `output` is what the model reads *and* what is committed, so this is a durability decision,
not just a display one.

**What never enters the transcript.** Raw responses. `src/notion/types.ts` is the whole allow-list, and the test
`projections (raw response never reaches the model)` asserts the projected key set explicitly.

## 15. Live verification (2026-10-11)

TASK-002 originally shipped with no valid credential, so every live run stopped at "Notion answered with a real
`unauthorized`". That gap is now closed: the probe was exercised against the real API with a real Notion credential
(a **Personal Access Token**, not an internal connection token).

| Command | Result |
|---|---|
| `notion:me` | `token is valid` — `type=bot`, `owner=user`, workspace reported |
| `notion:search` | `results=35 pages=30 data_sources=5 has_more=false truncated=false` |
| `notion:read-page -- <id>` | `page title="Student Planner"`, `blocks=14 lines=7 nested=true` |
| `notion:tool` | 7 entries incl. **2 × `pi.tool-result`**; survived restart; re-read entry 13 (260 chars); requestId idempotent |

Two facts worth recording from that run:

- **A PAT reads pages without `Add connections`.** The search returned real pages the token's creator could see, with
  no page ever shared with a bot. That confirms the credential path documented in the PAT guide, and it is why
  `setCapabilities` / page-sharing steps are absent from this probe.
- **`/v1/users/me` returns the credential, not the human.** With a PAT, `type=bot` and `owner.type=user`; the `name`
  is the token's own name. A reader expecting a person's name here would misread the output.

### The `NOTION_PIN_IP` escape hatch

Mid-session, `api.notion.com` began resetting the TLS handshake (`ECONNRESET`) on every request, while `www.notion.so`,
`api.github.com`, and the npm registry stayed reachable. Direct probes showed the hostname resolves to several
addresses and that one of them (`208.103.161.1`) refused connections while the others answered. The condition later
cleared on its own — eight consecutive un-pinned runs then all succeeded.

`NOTION_PIN_IP` was added for exactly this shape of failure: it forces the transport to one address while keeping the
TLS SNI and `Host` header correct, so a pinned run is still a real, certificate-validated call to the real API. It is
**off by default** and is an operator escape hatch, not a workaround baked into the request path. Set it only if a
hostname-resolved address is being blocked in your environment:

```bash
export NOTION_PIN_IP=208.103.161.2   # optional; omit for normal DNS
```

## 16. TASK-002 limitations

- ~~No successful authenticated read.~~ **Closed 2026-10-11** — see §15. The projections, pagination, and rendering
  are now also confirmed against live responses, not only the 26 offline tests.
- **No real 429 was triggered.** The retry path is the SDK's, configured and unit-tested via a normalized error, but
  no live rate limit was hit. Notion's limits are per-connection and short bursts are hard to provoke deliberately.
- **`truncated` vs `hasMore` on a real large page is still untested.** The live search returned everything in one page
  (`has_more=false`), so the boundary branch remains covered by fixtures only.
- **No write path exists.** Not by omission — `notion_read` has three actions and all three are GETs. Adding one
  requires editing `tool.ts` and the constraint that permits it.
- **Nested blocks are not recursed.** `blockChildren()` reads one level and sets `hasNestedChildren`; a toggle's or
  column list's children need a second call. Bounded on purpose.
- **The `meeting_notes`/`transcription` rename is only half-handled.** `TEXT_BLOCK_TYPES` accepts both spellings so an
  older page still reads, but nothing asserts which API version produced a given block.
- **`notion:tool` uses the faux provider for the model call.** Its tool traffic is real; its model turn is scripted.
  That is what makes the run deterministic and free.
- No sub-agents, RAG, MCP, OAuth, Telegram/Feishu, Notion UI automation, or write operations, per the task.
- No git commit was made.

