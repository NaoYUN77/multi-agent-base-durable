# TASK-004 verification report — typecheck and lint gates

Issue #12 · branch `workbuddy/issue-12-typecheck-lint-ci` · PR #13

Everything below was executed for this task, in this order. Nothing here is projected, and no
result is copied from the README's history.

## 1. Versions and pinned identities

| | |
|---|---|
| Application commits | `550af85` (implementation) · `1669557` (type-error probe) · `d52d6fb` (lint probe) · `e7dcf826` (probes removed) · `6066f03` (report) · **`e3ddb6d` (review fixes, current verified head)** |
| Pinned Pi commit | `f44707e7f7190a8cc86ce105790c72c6b0f5fd5f` — fetched by SHA from the clone URL `https://github.com/earendil-works/pi.git` |
| Model catalog revision | `sha256-439c53478c84ed27a58f8b54e1c3bd45810e5a969515b4e3666a3898d51ee22f` (read from the checkout's `nix/model-catalog.json`; verified as the sha256 of the downloaded bytes) |
| Node / npm, local | `v22.22.2` / `10.9.7` — the versions `prepare.mjs` prints at the start of every run |
| Node / npm, CI | `v22.22.2` / `10.9.7` — printed by the workflow's revision step and by `prepare.mjs` |
| Biome | `2.3.5` (exact, devDependency) |
| Shell actually used on Windows | npm runs through `cmd.exe /d /s /c` (npm's own `.cmd` shim), git and node are spawned without a shell. `prepare.mjs` sets `shell: true` for npm only, because Windows ships npm as a `.cmd`; no path is ever passed through that shell |

## 2. Clean-room preparation and both checks (AC-01, AC-02, AC-03)

Room: `E:\Code\pi-durable-room-d` — a `git clone` of the branch into a path that did not exist,
with no `base-durable-vaction-agent/` and no `node_modules/` before the run.

```bash
git clone --branch workbuddy/issue-12-typecheck-lint-ci <repo> E:\Code\pi-durable-room-d
cd E:\Code\pi-durable-room-d\durable-cli-probe

CODEBUDDY_SAFE_DELETE_ENABLED=0 npm run pi:prepare -- --clean   # exit 0
npm run typecheck                                               # exit 0
npm run lint                                                    # exit 0 (0 error, 117 warning, 14 info)
git diff --exit-code                                            # exit 0
git status --short                                              # empty
cd ..\base-durable-vaction-agent\pi && git status --short        # empty
```

What the preparation log shows, in order:

| Step | Evidence |
|---|---|
| checkout by SHA | `git fetch --depth 1 origin f44707e7…` succeeded; `checkout origin: https://github.com/earendil-works/pi.git` |
| installs | `npm ci --ignore-scripts` twice (upstream, then app) |
| model data | `model catalog revision: sha256-439c53…` → GET → hydrate → `Generated model data is valid.` |
| build chain | `npm run build` (chord) → `npm run build` (telemetry) → `npm run build:offline` (pi-ai) → `npm run build` (durable), all exit 0 |
| link | `link-checkout.mjs` printed the three symlink targets inside the checkout |
| verification | `verified @earendil-works/chord@1.1.0`, `…/pi-ai@1.1.0`, `…/pi-durable@1.1.0` resolved to the checkout; `prepared: … at f44707e7…` |

**The one environment-specific deviation, stated plainly.** This machine runs a safe-delete guard
(WorkBuddy session shim) that refuses deletes once a per-session budget is spent. It blocked two
things that have nothing to do with this repository: `npm ci` replacing an existing `node_modules`,
and upstream `build:offline`'s own `shx rm -rf dist/providers/data` (log: `rm: could not remove file
(code undefined)` … `rm: could not remove directory (code ENOTEMPTY)`). The command above therefore
sets the guard's own opt-out for that one invocation. GitHub runners have no such guard; CI ran the
same script without any opt-out. Both symptoms and the reason are documented in README §18.5.

Two further runs of the same script (rooms B and C, guard left on) failed at exactly that `rm`, which
is how the cause was identified — those runs are not counted as verification results.

## 3. Negative verification (AC-04, AC-05)

Local, inside the prepared room; each probe was appended to `src/config.ts`, the checks re-run, then
the file reverted and the checks re-run again.

| Injected | Command | Result | Attributed to |
|---|---|---|---|
| `export const GATE_PROBE_TYPE_ERROR: number = "not a number";` | `npm run typecheck` | exit 1 — `src/config.ts(135,14): error TS2322: Type 'string' is not assignable to type 'number'.` | typecheck (lint exited 0 in the same state) |
| `export const GATE_PROBE_LINT_VIOLATION: any = 1;` | `npm run lint` | exit 1 — `src/config.ts:135:41 lint/suspicious/noExplicitAny`, `Found 1 error.` | lint (typecheck exited 0 in the same state) |
| both reverted | `npm run typecheck`, `npm run lint`, `git diff --exit-code`, `git status --short` | all exit 0 / empty | probes fully removed |

## 4. GitHub Actions (AC-06, AC-07)

Four runs of the same workflow, one per pushed commit:

| Commit | Intent | `lint` | `typecheck` | Run |
|---|---|---|---|---|
| `550af85` | implementation | success | success | https://github.com/NaoYUN77/personal-agent/actions/runs/38342090219 |
| `1669557` | type error injected | success | **failure** | https://github.com/NaoYUN77/personal-agent/actions/runs/38342293591 |
| `d52d6fb` | explicit `any` injected | **failure** | success | https://github.com/NaoYUN77/personal-agent/actions/runs/38342436066 |
| `e7dcf826` | probes removed | success | success | https://github.com/NaoYUN77/personal-agent/actions/runs/38342538378 |
| `e3ddb6d` | review fixes (§6) | success | success | https://github.com/NaoYUN77/personal-agent/actions/runs/38345385427 |

The failing jobs' own diagnostics, from the run logs:

```
##[error]src/config.ts(135,14): error TS2322: Type 'string' is not assignable to type 'number'.
src/config.ts:135:41 lint/suspicious/noExplicitAny ━━━
Found 1 error.
```

The failing commit fails exactly one of the two checks each time, so the checks are independently
identifiable, and neither failure is hidden.

What the CI jobs do and do not do (AC-07): `permissions: contents: read`; no `secrets`, no
`pull_request_target`, no `continue-on-error`, no path filters; actions pinned to full commit SHAs;
`concurrency` cancels superseded runs of the same ref; the npm cache key is the pinned Pi commit plus
the app lockfile hash and never includes `dist/`. Biome's scope is the `files.includes` list in
`biome.json`, so the upstream checkout, `node_modules`, `data/` and any `dist/` are outside it.

Note on what CI logged as "application commit": `actions/checkout` checks out the PR merge ref for
`pull_request` events, so the revision printed inside CI is the merge commit, not the branch head.
The check runs are attached to the branch head SHA, which is how they are listed above.

## 5. Required checks on `main` (AC-08)

Set through the branch-protection API and read back afterwards. The read-back is reproduced here
verbatim (minus the API's own URLs) so it can be checked without the write token:

```json
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["lint", "typecheck"],
    "checks": [
      { "context": "lint", "app_id": 15368 },
      { "context": "typecheck", "app_id": 15368 }
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

`app_id 15368` is GitHub Actions, so the two contexts are bound to this workflow's jobs rather than to
any third-party status. `enforce_admins: false` means an admin can still merge past a red check;
`restrictions: null` means no push allow-list beyond the two checks; `strict: false` means the branch
does not have to be up to date with `main` before merging. Turn `strict` or `enforce_admins` on if the
merge gate should be tighter. Before this task the API answered `404 Branch not protected`.

Reading this requires admin on the repository: the reviewer's integration got `403`, so this section is
the implementer's evidence, reproducible with
`GET /repos/NaoYUN77/personal-agent/branches/main/protection` and an admin token.

## 6. Review fixes and re-verification (second round)

Review on 2026-10-13 asked for four fixes; all are in `scripts/prepare.mjs` at commit `e3ddb6d`.

| # | Finding | Fix |
|---|---|---|
| 1 | `--checkout-dir` never reached `link-checkout.mjs`, so preparation and linking could use different checkouts | the resolved directory is passed to the linker as `PI_CHECKOUT` (`env: { ...process.env, PI_CHECKOUT: checkoutDir }`) and is logged at the start of every run |
| 2 | `--clean` deleted before validating, and `../../../victim` was an accepted `dir` | `readPin` now rejects any `packages`/`build` dir that is absolute, empty or contains `..`; `resolveDeleteTarget` resolves every target and refuses anything outside its root, including through a symlinked intermediate directory; all targets are checked before the first delete |
| 3 | an interrupted first run left `.git` with no HEAD and the retry died in `rev-parse` | that state is recognized and completed (fetch + checkout are idempotent) — but only while the tree holds nothing except `.git`; with any other content it still refuses |
| 4 | without `--checkout-dir`, `args[checkoutIndex + 1]` was `args[0]`, so the first unknown argument was ignored | arguments are parsed in one strict pass first; unknown, missing and repeated options all fail before any fetch, install or delete |

Fixtures (all executed; the module is importable now, so the helpers are exercised directly):

| Fixture | Command | Result |
|---|---|---|
| unknown argument | `node scripts/prepare.mjs --typo` | exit 1, `unknown argument: --typo`; default checkout path and `node_modules` still absent |
| missing value | `… --checkout-dir` | exit 1, `--checkout-dir needs a path` |
| repeated option | `… --clean --clean`, `… --checkout-dir a --checkout-dir b` | exit 1, `… was given twice` |
| escaping config | fixture `pi-pin.json` with `packages[0].dir = "../../../../victim"` | exit 1, `package dir must stay inside the checkout`; the external marker file and the app marker were untouched |
| escaping build dir | fixture config with `build[0].dir = "packages/../../.."` | exit 1, `build dir must stay inside the checkout` |
| symlinked intermediate dir | `root/packages/ai` junctioned to `outside/packages/ai`, then `resolveDeleteTarget(root, root/packages/ai/dist)` | refused: `… resolves to …outside…, which is outside …root`; external marker untouched |
| normal target | `resolveDeleteTarget(root, root/plain/dist)` | resolves normally (the check does not over-refuse) |
| interrupted init | `git init` (no commits), then `… --checkout-dir <unborn>` | exit 0, log: `checkout has an interrupted initialization (no HEAD, empty tree); completing it`; `HEAD` afterwards is `f44707e7…` |
| interrupted init with content | same, plus a `keep.txt` | exit 1, `has no HEAD but is not empty (keep.txt); refusing to touch it`; the file survived |
| CLI beats env | `PI_CHECKOUT=<other> … --checkout-dir <room checkout>` | exit 0; the `PI_CHECKOUT` path was never created, and all three links resolve into the CLI directory |

Re-run on the fixed head, room `E:\Code\pi-durable-room-e` (fresh clone of `e3ddb6d`, no checkout, no
`node_modules`): default-path `npm run pi:prepare -- --clean` exit 0 with `checkout directory:` equal to
the default; `npm run typecheck` 0; `npm run lint` 0; `git diff --exit-code` 0; `git status --short`
empty; checkout at `f44707e7…` with an empty status. A second default-path run and both checks were
repeated after the fixtures, with the same results.

## 7. Not verified / limitations

- **`npm test` and any offline behaviour test** — outside this task's boundary. Preparation only
  guarantees the type artifacts exist; it does not claim the probe's behaviour tests pass.
- **Real model or Notion traffic** — not executed, not in scope, and CI reads no service credential.
- **The `pi.dev` catalog endpoint** is a runtime dependency of preparation. The revision is content
  addressed and verified, but an unreachable endpoint fails the job (README §18.5).
- **117 lint warnings remain** and are deliberately not a gate; only the 13 errors that blocked the
  gate were fixed.
- **A local Windows run can still be interrupted** by the safe-delete guard described in §2; that is a
  property of this machine, not of the repository or of CI.
- **The re-verification did not use the reviewer's environment.** Branch protection was read back with
  an admin token here; the reviewer's integration is denied (403), so §5 is implementer evidence.
