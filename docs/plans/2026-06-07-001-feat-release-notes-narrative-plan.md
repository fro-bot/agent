---
title: 'feat: LLM-narrated release notes for the multi-part release flow'
type: feat
status: active
date: 2026-06-07
deepened: 2026-06-07
origin: docs/brainstorms/2026-06-07-release-notes-narrative-requirements.md
---

# LLM-narrated release notes

## Overview

After a release publishes, dispatch `fro-bot.yaml` to rewrite the GitHub Release body into a
readable `## What's new` narrative. The dispatch logic is ported from Systematic's
`scripts/dispatch-release-notes.sh` to TypeScript under `scripts/release/`, hooked via a new
`successCmd` in `@semantic-release/exec`. Narrative-quality failures never block the release;
security-relevant anomalies fail the step loudly.

## Problem Frame

Releases publish with the flat conventional-commit list from
`@semantic-release/release-notes-generator`. It is accurate but not readable. We want the
Systematic-style LLM narration adapted to this repo's multi-part release flow (`next → release`
PR merge → `auto-release.yaml`) and its TypeScript-scripts convention
(see origin: `docs/brainstorms/2026-06-07-release-notes-narrative-requirements.md`).

## Requirements Trace

- R1. Pure, unit-testable TS logic for tag validation, prompt construction, run selection, and
  outcome classification (`scripts/release/release-notes.ts`).
- R2. A thin CLI entry runnable via `node --experimental-strip-types`, taking the target tag as an
  argument (`scripts/release/dispatch-release-notes.ts`).
- R3. A Vitest test port of the structural scenarios — validation, classification precedence, run
  selection, prompt construction, idempotent short-circuit — exercising the pure logic directly.
- R4. A `successCmd` in `.releaserc.yaml`'s `@semantic-release/exec`, invoking the CLI with
  `${nextRelease.gitTag}`, preserving the existing `verifyReleaseCmd`.
- R5. A `correlation-id` `workflow_dispatch` input on `fro-bot.yaml`.
- R6. A self-contained narration prompt carrying idempotency check, rewrite instruction,
  `gh release edit` application, and explicit scope constraints.
- R7. Release never failed by a narrative-quality outcome; always failed by a security-relevant
  outcome.
- R8. New Vitest tests are executed in CI (confirm `scripts/` coverage).
- R9. A short docs note on the narration step and its fail-soft/fail-hard contract.

## Scope Boundaries

- No change to which releases are cut, or to version/commit-analysis logic.
- No rollback or re-publish — narration only edits the already-published release body.
- No narration of historical releases (forward-only from adoption).

### Deferred to Separate Tasks

- A reusable `release-notes-narrative` skill (D5b): deferred. v1 inlines the procedure into the
  prompt (D5a). Revisit only if the procedure grows.

## Context & Research

### Relevant Code and Patterns

- `scripts/release/preview.ts` + `scripts/release/preview-next-release.ts` — the canonical
  pure-logic + thin-CLI split to mirror. CLI uses `#!/usr/bin/env node`, imports the logic module
  with a `.ts` extension (strip-types runtime), parses argv, writes `GITHUB_OUTPUT` via
  `appendFileSync`.
- `scripts/release/preview.test.ts` — Vitest convention: imports the logic module with a `.js`
  extension (bundler resolution), `// #given/#when/#then` BDD comments, tests pure functions
  directly (no subprocess spawning).
- `scripts/tsconfig.json` — `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`.
- Invocation precedent:
  `node --experimental-strip-types --experimental-transform-types scripts/release/<cli>.ts ...`
  (`.github/workflows/prepare-release-pr.yaml:95`, `.github/workflows/ci.yaml:666`).
- `.releaserc.yaml:4-20` — plugin list; `@semantic-release/exec` already present with only
  `verifyReleaseCmd`.
- `.github/workflows/auto-release.yaml:26-77` — `perform-release` job: App token (full
  installation perms, no explicit `permissions:` input), `gh` available, Node+pnpm (no Bun),
  the `pnpm semantic-release --ci false` step.
- `.github/workflows/fro-bot.yaml:16-50` — dispatch/call inputs (`prompt`, `use-schedule/wiki-prompt`,
  `model`, `response-mode`); no `correlation-id`.

### Institutional Learnings

- No `docs/solutions/` entry covers release-notes narration directly (verified). This is new
  ground; the Systematic script + its tests are the reference design.

### External References

- Systematic `scripts/dispatch-release-notes.sh` and `tests/integration/release-notes-ci.test.ts`
  at ref `836f92d` — the behavioral contract being ported.

## Key Technical Decisions

- **Pure-logic-first port.** Unlike the bash source (whose tests spawn the script with a mock-`gh`
  on PATH), structure the port so validation, prompt construction, run selection, and outcome
  classification are pure functions in `release-notes.ts`, with all `gh` calls isolated in the
  thin CLI. Tests exercise the pure functions directly, matching `preview.test.ts`. This is
  cleaner than porting the subprocess-mock harness and fits our convention.
- **Classification precedence preserved (D4).** Hard-fail (exit 1, `::error::`): off-target release
  edit, auth-failure keywords, `action_required`, `skipped`, `success`-but-short-body, unexpected
  watch exit. Soft-warn (exit 0, `::warning::`): run-not-confirmed, watch timeout (124),
  `cancelled`, generic `failure`, unknown conclusion. Clean exit 0: substantive `success`,
  `neutral`.
- **Timestamp-based run selection.** Newest `workflow_dispatch` run on the dispatch branch created
  strictly after the pre-dispatch epoch — robust against agent boot time. `correlation-id` is an
  audit anchor, not the matcher.
- **Inline narration prompt (D5a).** No new skill; the prompt is self-contained.
- **Dispatch ref = `main`.** Dispatch `fro-bot.yaml --ref main` (current agent config) to narrate
  the `release`-tag artifact; run selection filters `--branch main`. (Q3 resolved.)
- **Body integrity floor = 200 chars** (Systematic's value). (Q4 resolved.)
- **Narration model = `anthropic/claude-haiku-4-5`.** The successCmd passes
  `-f model=anthropic/claude-haiku-4-5`; this requires adding a `model` input to
  `fro-bot.yaml`'s `workflow_dispatch` block (today it exists only on `workflow_call`).
  `fro-bot.yaml:225` already reads `inputs.model || vars.FRO_BOT_MODEL`, so once the dispatch input
  is declared the model flows through.
- **Dispatch auth = `FRO_BOT_PAT`, NOT the App token (Q2 resolved).** Deepening verified the
  `fro-bot-agent` App is **`contents: read` only** (`docs/github-app.md`), so the App token cannot
  `gh workflow run`. But `FRO_BOT_PAT` is the same PAT Systematic uses for this exact dispatch and
  already carries `actions: write`. The successCmd therefore dispatches using `FRO_BOT_PAT`, leaving
  the App's read-only posture unchanged. Mechanics: the semantic-release step keeps
  `GITHUB_TOKEN = <App token>` (which `@semantic-release/github` needs for the release itself), and
  additionally exposes `RELEASE_NOTES_DISPATCH_TOKEN = ${{ secrets.FRO_BOT_PAT }}`; the CLI runs
  `gh workflow run` with `GH_TOKEN` set to that PAT for the dispatch subprocess only. `FRO_BOT_PAT`
  is **not currently referenced in `auto-release.yaml`** and must be added to that step's env
  (Unit 4). No App-permission change is needed.
- **Narration run's release-edit power also comes from `FRO_BOT_PAT`.** `fro-bot.yaml` auths the
  action with `github-token: ${{ secrets.FRO_BOT_PAT }}` (`fro-bot.yaml:224`), so the narration
  agent's `gh release edit` uses the PAT's `contents: write` — consistent with the dispatch token.
- **Fail-soft on dispatch failure.** Any `gh workflow run` failure warns and exits 0 — never a
  broken release.
- **Idempotency marker = HTML comment, not the heading.** Use `<!-- fro-bot-narration-v1 -->`
  immediately after `## What's new` as the re-run short-circuit, rather than matching the heading
  text alone (robust against heading collision and future format changes).
- **Body application via `--notes-file`.** The narration agent writes the rewritten body to a temp
  file and runs `gh release edit <tag> --notes-file <file>` (never `--notes <string>`) — avoids
  shell-escaping and multi-line-markdown breakage.

## Open Questions

### Resolved During Planning

- Q1 (skill vs inline): inline (D5a).
- Q3 (dispatch ref): `main`, run selection `--branch main`.
- Q4 (body floor): 200 chars.
- Q2 (auth scope) — RESOLVED: dispatch with `FRO_BOT_PAT` (same PAT Systematic uses, already has
  `actions: write`), not the read-only App token. No App-permission change. `FRO_BOT_PAT` is added
  to the semantic-release step env (Unit 4); the CLI uses it as `GH_TOKEN` for the dispatch only.
- Model: `anthropic/claude-haiku-4-5`, added as a `workflow_dispatch` input on `fro-bot.yaml`.
- Idempotency marker: `<!-- fro-bot-narration-v1 -->` HTML comment.
- Body application: `gh release edit <tag> --notes-file <file>`.

### Deferred to Implementation

- Whether `FRO_BOT_PAT` actually carries `contents: write` is external secret config not visible in
  the repo; the first real narration run is the live confirmation. (High confidence — the PAT
  already performs branch/PR mutations.)

## Implementation Units

- [ ] **Unit 1: Pure narration logic module**

**Goal:** Tag validation, prompt construction, run selection, and outcome classification as pure
functions.

**Requirements:** R1, R6, R7

**Dependencies:** None

**Files:**
- Create: `scripts/release/release-notes.ts`
- Test: `scripts/release/release-notes.test.ts`

**Approach:**
- `validateTag(tag)` → ok/err on the `^v\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$` shape.
- `buildNarrationPrompt({tag, repo, correlationId})` → the self-contained prompt string. Design
  (from deepening research):
  - **Idempotency check first:** if the release body contains `<!-- fro-bot-narration-v1 -->`,
    log already-applied and stop (conclusion `neutral`).
  - **Rewrite instruction:** produce a `## What's new` narrative grouped by impact
    (Features / Fixes / Security / Performance / Breaking), each 2-4 human-readable bullets linking
    PR numbers; lead with a 1-2 sentence summary; preserve the original conventional-commit list
    below under a collapsed `<details><summary>Full changelog</summary>` block. Emit the
    `<!-- fro-bot-narration-v1 -->` marker immediately after the `## What's new` heading.
  - **Application:** write the body to a temp file and run
    `gh release edit <tag> --notes-file <file>` (never `--notes`).
  - **Scope constraints (forbidden-actions framing):** the ONLY mutating operation is
    `gh release edit <tag>`; do NOT comment on any PR/issue/discussion, open/close issues, edit any
    other release, modify files, or create branches/tags/commits. Report tag, chars-before/after,
    and the release URL.
- `selectDispatchedRun(runs, dispatchEpoch)` → newest run with `createdAt` epoch strictly greater
  than `dispatchEpoch`, or null.
- `classifyOutcome({watchExit, conclusion, log, bodyLen, targetTag})` → a discriminated result
  `{level: 'ok'|'warn'|'error', message, exitCode}` encoding the D4 precedence (off-target edit
  detection scans the ANSI-stripped log for `release edit vX.Y.Z` lines not equal to the target;
  auth-failure keyword scan; body floor 200).

**Patterns to follow:** `scripts/release/preview.ts` (pure functions, no side effects, exported for
direct unit testing).

**Test scenarios:**
- Happy path: valid tag (incl. pre-release `v1.2.3-rc.1`) passes; classify `success` + body≥200 →
  `ok` exit 0; `neutral` → `ok` exit 0.
- Edge case: invalid tag shape → err (no dispatch). Run selection: empty list → null; all runs
  pre-date epoch → null; two post-epoch runs → newest selected.
- Error path: off-target `release edit v9.9.9` (ANSI-colored) → `error` exit 1; auth keywords
  (`HTTP 401`, `HTTP 403`+`permission denied`, `Resource not accessible`) → `error`; `success` but
  body<200 → `error`; `action_required`/`skipped` → `error`; unexpected `watchExit=137` → `error`.
- Edge case: `watchExit=124` → `warn` exit 0; `cancelled` → `warn`; generic `failure` → `warn`;
  unknown conclusion → `warn`.
- Prompt construction: includes target tag, repo, `correlation=<id>`, the
  `<!-- fro-bot-narration-v1 -->` idempotency-marker instruction, the grouped-narrative +
  collapsed-changelog structure, the `gh release edit <tag> --notes-file` application step, and the
  forbidden-actions scope lines.

**Verification:** All classification branches and selection cases covered; `release-notes.test.ts`
passes under Vitest.

- [ ] **Unit 2: CLI entry (dispatch + poll + watch)**

**Goal:** Thin executable that wires the pure logic to `gh`.

**Requirements:** R2, R6, R7

**Dependencies:** Unit 1

**Files:**
- Create: `scripts/release/dispatch-release-notes.ts`

**Approach:**
- `#!/usr/bin/env node`; import `./release-notes.ts` (`.ts` extension, strip-types).
- Read target tag from argv; `validateTag` → on err print `::error::` + exit 1.
- Generate correlation id (uuid via `node:crypto` `randomUUID`; test escape hatch env var as in
  the source). Capture dispatch epoch (`Date.now()/1000`).
- `gh workflow run --ref main fro-bot.yaml -f prompt=<built> -f correlation-id=<id>
  -f model=anthropic/claude-haiku-4-5` via `execFileSync`, with the subprocess env's `GH_TOKEN`
  set to `RELEASE_NOTES_DISPATCH_TOKEN` (the `FRO_BOT_PAT`) so the dispatch uses the PAT, not the
  inherited App token. On non-zero → `::warning::` + exit 0 (fail-soft). The poll/watch `gh` calls
  also use the PAT env.
- Poll loop (budget/interval env-overridable for tests): `gh run list --workflow fro-bot.yaml
  --branch main --event workflow_dispatch --json databaseId,createdAt` → `selectDispatchedRun`.
  Not found in budget → `::warning::` + exit 0.
- `gh run watch <id> --exit-status` under a hard `timeout`; capture exit. Fetch `conclusion`, the
  ANSI-stripped `--log`, and (on success) the release body length. Call `classifyOutcome` → emit
  its message at its level and exit with its code.

**Patterns to follow:** `scripts/release/preview-next-release.ts` (shebang, `execFileSync`, argv
parse, env-overridable knobs).

**Test scenarios:** `Test expectation: none` for the thin I/O shell — all decision logic lives in
Unit 1 and is unit-tested there. (The CLI is exercised end-to-end by the real release; a mock-`gh`
subprocess test is explicitly out of scope given the pure-logic-first decision.)

**Verification:** `node --experimental-strip-types --experimental-transform-types
scripts/release/dispatch-release-notes.ts vX.Y.Z` runs the full flow; invalid tag exits 1 before
any dispatch; a simulated `gh workflow run` failure exits 0 with a warning.

- [ ] **Unit 3: Test port to Vitest**

**Goal:** Port the 19 structural scenarios as direct unit tests of Unit 1's pure functions.

**Requirements:** R3, R8

**Dependencies:** Unit 1

**Files:**
- Test: `scripts/release/release-notes.test.ts` (same file as Unit 1's tests; this unit ensures the
  full structural-scenario coverage and CI execution)

**Approach:**
- Map each Systematic scenario to a pure-function assertion: validation (1,2), classification
  (3-5,5b,9-18), run selection (6,7,8), prompt construction (19). Drop scenario assertions that
  only exist because the source spawned a subprocess (PATH/mock-gh wiring) — keep the behavioral
  intent.
- Confirm `vitest.config.ts` includes `scripts/**` (it does — only `node_modules`, `dist`,
  `cypress`, `.slim`, `deploy/**` excluded) so `pnpm test` / CI runs these.

**Patterns to follow:** `scripts/release/preview.test.ts` (Vitest, `.js` import, `#given/#when/#then`).

**Test scenarios:** This unit *is* the test coverage; it must assert every classification branch,
every selection case, validation accept/reject, and prompt-content expectations enumerated in
Unit 1.

**Verification:** `pnpm test` (or the runtime-scoped vitest invocation) runs and passes the new
file in CI; coverage spans all D4 branches.

- [ ] **Unit 4: Wire successCmd + fro-bot.yaml inputs (correlation-id, model)**

**Goal:** Integrate into the release flow and add the dispatch inputs.

**Requirements:** R4, R5

**Dependencies:** Units 1-2

**Files:**
- Modify: `.releaserc.yaml` (add `successCmd` to the existing `@semantic-release/exec` entry,
  preserving `verifyReleaseCmd`)
- Modify: `.github/workflows/auto-release.yaml` (add
  `RELEASE_NOTES_DISPATCH_TOKEN: ${{ secrets.FRO_BOT_PAT }}` to the semantic-release step's env)
- Modify: `.github/workflows/fro-bot.yaml` (add `correlation-id` and `model` to
  `workflow_dispatch.inputs`)

**Approach:**
- `successCmd: 'node --experimental-strip-types --experimental-transform-types
  scripts/release/dispatch-release-notes.ts "${nextRelease.gitTag}"'` alongside the existing
  `verifyReleaseCmd` in the same `@semantic-release/exec` config.
- Add `RELEASE_NOTES_DISPATCH_TOKEN: ${{ secrets.FRO_BOT_PAT }}` to the `Semantic Release` step's
  `env:` block (`auto-release.yaml:62-68`), alongside the existing `GITHUB_TOKEN` (App token, kept
  for `@semantic-release/github`). The CLI reads this for the dispatch `gh` subprocess.
- Add `correlation-id` (string, not required) to `fro-bot.yaml` `workflow_dispatch.inputs` (audit
  anchor).
- Add `model` (string, not required) to `fro-bot.yaml` `workflow_dispatch.inputs`.
  `fro-bot.yaml:225` already reads `inputs.model || vars.FRO_BOT_MODEL`, so declaring the dispatch
  input is sufficient for `-f model=anthropic/claude-haiku-4-5` to take effect.
- The successCmd passes `-f model=anthropic/claude-haiku-4-5` (Unit 2).

**Patterns to follow:** existing `@semantic-release/exec` `verifyReleaseCmd` shape in `.releaserc.yaml`;
the existing `model` input on `fro-bot.yaml`'s `workflow_call` block (mirror its shape on
`workflow_dispatch`); the existing `secrets.FRO_BOT_PAT` usage in `fro-bot.yaml:224`.

**Test scenarios:** `Test expectation: none` — config wiring. Validated by YAML lint (existing CI)
and the real release.

**Verification:** `.releaserc.yaml` parses; `verifyReleaseCmd` still present;
`RELEASE_NOTES_DISPATCH_TOKEN` is set on the semantic-release step; `fro-bot.yaml` accepts
`-f correlation-id=` and `-f model=` on dispatch (workflow lints clean).

- [ ] **Unit 5: Documentation**

**Goal:** Make the narration step and its contract discoverable.

**Requirements:** R9

**Dependencies:** Units 1-4

**Files:**
- Modify: `AGENTS.md` (or the release docs section) — short note on the narration step.

**Approach:**
- Document: what it does (post-release body rewrite via `fro-bot.yaml` on `main`, model
  `anthropic/claude-haiku-4-5`, dispatched with `FRO_BOT_PAT`), the fail-soft/fail-hard contract,
  idempotency (HTML marker), and the dispatch choice. Public-facing voice, no session/plan taxonomy.

**Test scenarios:** `Test expectation: none` — docs.

**Verification:** The note accurately reflects the shipped behavior and the auth requirement.

## System-Wide Impact

- **Interaction graph:** `successCmd` fires inside `perform-release` after publish; dispatches
  `fro-bot.yaml` on `main`. No effect on version/commit logic or the `next → release` flow.
- **Error propagation:** narrative failures → `::warning::`/exit 0 (release unaffected); security
  signals → `::error::`/exit 1 (release step fails, surfacing the anomaly).
- **State lifecycle risks:** re-dispatch is idempotent (the `## What's new` short-circuit); no
  partial-write risk on the release body beyond what `gh release edit` does atomically.
- **API surface parity:** the new `correlation-id` input is additive and optional; no existing
  caller breaks.
- **Unchanged invariants:** `.releaserc.yaml` version/branch/tag behavior, `auto-release.yaml`
  trigger and App-token setup, and `fro-bot.yaml`'s existing inputs are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Dispatch token lacks `actions: write` | Resolved: dispatch uses `FRO_BOT_PAT` (same PAT Systematic uses for this dispatch; confirmed to carry the scope), not the read-only App token. Fail-soft still protects the release. |
| `FRO_BOT_PAT` not wired into the release job | Unit 4 adds `RELEASE_NOTES_DISPATCH_TOKEN: ${{ secrets.FRO_BOT_PAT }}` to the semantic-release step; the secret already exists in the repo. |
| Narration agent edits the wrong release | Off-target detection hard-fails the step (`::error::`). |
| Narration agent does forbidden side-effects (comments, file changes) | Forbidden-actions framing in the prompt; harness Response Protocol; the run's only intended mutation is `gh release edit <tag>`. |
| Agent boot time exceeds poll budget | Run-not-confirmed warns (exit 0); narration still runs async; observability gap only. |
| New tests not picked up by CI | Unit 3 confirms `vitest.config.ts` covers `scripts/**`. |
| `successCmd` runs on every publish, including backport tags | Idempotency (HTML marker) + tag validation; narration is per-published-tag by design. |
| Haiku model unavailable / model input rejected | `fro-bot.yaml:225` falls back to `vars.FRO_BOT_MODEL`; narration still runs on the default model. |

## Documentation / Operational Notes

- Unit 5 adds the release-docs note. Operationally: first real release after merge is the live
  verification; watch for `::warning::`/`::error::` annotations in the `perform-release` log.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-06-07-release-notes-narrative-requirements.md`
- Source being ported: Systematic `scripts/dispatch-release-notes.sh`,
  `tests/integration/release-notes-ci.test.ts`, `.releaserc.yaml` (ref `836f92d`).
- Our pipeline: `.releaserc.yaml`, `.github/workflows/auto-release.yaml`,
  `.github/workflows/prepare-release-pr.yaml`, `.github/workflows/fro-bot.yaml`,
  `scripts/release/preview*.ts`.
