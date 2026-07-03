---
title: LLM-narrated release notes for the multi-part release flow
date: 2026-06-07
status: ready-for-planning
tier: standard
---

# LLM-narrated release notes

## Problem

Releases publish with the default `@semantic-release/release-notes-generator` body — a flat
list of conventional-commit lines (`fix(deploy): ...`, `feat(gateway): ...`). It is accurate
but not readable: it doesn't tell a human what actually changed or why it matters. Systematic
solved this with an LLM narration step that, after a release publishes, rewrites the release
body into a prose "What's new" narrative by dispatching its agent against the just-published tag.

We want the same capability for `fro-bot/agent`, adapted to this repo's multi-part release flow
and its TypeScript-scripts convention.

## Goal

After a release is published, dispatch `fro-bot.yaml` to rewrite the GitHub Release body into a
readable narrative, waiting for and classifying the outcome so that:

- a successful narration replaces the release body in place;
- narrative-quality failures (agent timeout, model error, already-applied) are **non-fatal** —
  the release itself is never blocked or rolled back;
- security-relevant anomalies (off-target release edits, auth failures, policy blocks) **fail
  the step loudly** so they are not silently ignored.

## Source being ported

Systematic's `scripts/dispatch-release-notes.sh` (a `@semantic-release/exec` `successCmd`) plus
its `tests/integration/release-notes-ci.test.ts` (19 structural scenarios). The behavioral
contract — validate → dispatch → poll → watch → classify — is the thing of value; it is ported
to TypeScript and re-integrated, not copied verbatim.

## How this repo differs from Systematic (the integration deltas)

These are verified against source and drive the requirements below.

| Aspect | Systematic | fro-bot/agent |
| --- | --- | --- |
| Where `semantic-release` runs | `main` push | `auto-release.yaml` `perform-release` job, fired by the `next → release` PR merge (`pull_request.closed` on `release`) |
| `@semantic-release/exec` hook | `successCmd` present | only `verifyReleaseCmd` configured — **no `successCmd` yet** (`.releaserc.yaml:9-10`) |
| Release-job auth | a PAT | GitHub App installation token from `actions/create-github-app-token`, workflow `permissions: contents: read` (`auto-release.yaml:9-10,26-32`) |
| `fro-bot.yaml` dispatch input | has `correlation-id` | has `prompt` (+ `use-schedule/wiki-prompt`); **no `correlation-id`** |
| Scripts runtime | bash + `bun:test` | TypeScript via `node --experimental-strip-types`, Vitest (`scripts/release/preview.ts` + `preview.test.ts`) |
| Bun in release job | n/a | **not available** — Node + pnpm only |
| The narration skill | `.agents/skills/release-notes-narrative/SKILL.md` exists | **does not exist** in this repo or in the bundled `@fro.bot/systematic` plugin |

## Decisions

### D1 — Runtime and placement (confirmed)

Port to `scripts/release/dispatch-release-notes.ts` (pure, testable logic) plus a thin CLI entry
(`scripts/release/dispatch-release-notes-cli.ts` or an exported `main`), mirroring the existing
`preview.ts` / `preview-next-release.ts` split. Run via `node --experimental-strip-types`. No Bun,
no bash. Tests are Vitest, ported from the 19 structural scenarios.

### D2 — Hook point (confirmed)

Add a `successCmd` to the existing `@semantic-release/exec` plugin in `.releaserc.yaml`, invoking
the CLI with `${nextRelease.gitTag}`. `successCmd` runs only after a release actually publishes,
inside the `perform-release` job, so `gh` and the App token are already in scope. The existing
`verifyReleaseCmd` is preserved.

### D3 — Run identification (confirmed)

Add a `correlation-id` input to `fro-bot.yaml`'s `workflow_dispatch` (audit anchor, forwarded
verbatim). Primary run identification stays **timestamp-based** (newest `workflow_dispatch` run on
the dispatch branch created strictly after the pre-dispatch epoch), exactly as Systematic does —
this is robust against the agent's multi-minute boot time, which defeated log-scanning.

### D4 — Outcome classification (ported as-is)

Preserve the security-vs-narrative precedence:

- **Hard fail (exit 1, `::error::`):** off-target release edit (a `release edit vX.Y.Z` for a tag
  other than the target), auth-failure keywords (`HTTP 401/403`, `Bad credentials`,
  `Resource not accessible`, `permission denied`), `action_required`, `skipped` (policy/branch
  protection), `success` but body shorter than the integrity floor, and any unexpected
  `gh run watch` exit code.
- **Soft warn (exit 0, `::warning::`):** dispatch sent but run never confirmed within the poll
  budget, watch timeout (124), `cancelled`, generic `failure`, unknown conclusion.
- **Clean exit 0:** `success` with a substantive body; `neutral` (idempotent short-circuit).

The release must never fail because of a narration problem; it must fail when narration shows a
security signal.

### D5 — The narration procedure / skill (needs a planning decision)

Systematic's prompt tells the agent to "load `.agents/skills/release-notes-narrative/SKILL.md`
and execute its 13-step procedure." **We have no such skill.** Two options for planning to resolve:

- **D5a — Inline the procedure into the dispatch prompt.** The TS script renders a self-contained
  prompt describing the narration steps (fetch tag body, idempotency check on a `## What's new`
  heading, rewrite into prose, apply via `gh release edit`, scope constraints). No new skill file.
  Simplest; keeps the whole contract in one place; prompt is longer.
- **D5b — Port/author a `release-notes-narrative` skill** into `.agents/skills/` and have the
  prompt load it. Mirrors Systematic; reusable; but adds a skill artifact and its own
  maintenance, and the skill must be present in the checked-out release branch at dispatch time.

Recommendation to carry into planning: **D5a (inline)** for v1 — fewer moving parts, nothing new
to keep in sync across branches, and the prompt is the natural home for the contract. Revisit a
skill if the procedure grows.

### D6 — Auth / permissions (must be verified during planning)

`gh workflow run fro-bot.yaml` requires `actions: write`. The release job's App token carries the
`fro-bot-agent` App's **full installation permissions** (no explicit `permissions:` input on
`get-app-token`), so whether the dispatch is authorized depends on the App's configured scopes —
**not verifiable from the repo.** Planning must:

1. Confirm the App grants `actions: write` (and the dispatched narration run has the `contents`/
   release-edit scope it needs to `gh release edit`), or add the needed scope.
2. Because authorization is uncertain, the dispatch failure path is **fail-soft** (warn, exit 0):
   a missing permission degrades to "no narrative this release," never a broken release.

### D7 — Idempotency

The narration is safe to re-run: the agent first checks whether the release body already starts
with `## What's new` and short-circuits (`neutral`) if so. This protects against re-dispatch and
manual re-runs.

## Requirements

- **R1** — A `scripts/release/dispatch-release-notes.ts` module with pure, unit-testable logic for
  tag validation, prompt construction, run selection (timestamp-after-epoch, newest-wins), and
  outcome classification.
- **R2** — A thin CLI entry runnable via `node --experimental-strip-types`, taking the target tag
  as its argument, mirroring `preview-next-release.ts`.
- **R3** — A Vitest test port of the structural scenarios (validation, classification precedence,
  run selection, prompt construction, idempotent short-circuit). Prose/skill-specific assertions
  from the Systematic test are dropped; security and control-flow assertions are kept. Uses the
  mock-`gh`-on-PATH strategy adapted to Vitest + `node`.
- **R4** — A `successCmd` in `.releaserc.yaml`'s `@semantic-release/exec`, invoking the CLI with
  `${nextRelease.gitTag}`, preserving the existing `verifyReleaseCmd`.
- **R5** — A `correlation-id` `workflow_dispatch` input on `fro-bot.yaml` (audit anchor).
- **R6** — A self-contained narration prompt (D5a) carrying the idempotency check, the rewrite
  instruction, the `gh release edit` application step, and explicit scope constraints
  (edit only the target release; no PR/issue/discussion comments; no file changes; no
  branches/tags/commits).
- **R7** — The release step is never failed by a narrative-quality outcome and is always failed by
  a security-relevant outcome, per D4.
- **R8** — Test wiring: ensure the new Vitest tests are actually executed in CI (the root `test`
  script and `vitest.config.ts` cover `scripts/` today; confirm the new files are picked up).
- **R9** — Documentation: a short note on the narration step in the release docs / AGENTS.md so the
  behavior and its fail-soft/fail-hard contract are discoverable.

## Non-goals

- No change to *which* releases are cut or to the conventional-commit / version logic.
- No rollback or re-publish behavior — narration only edits the already-published release body.
- No narration of pre-1.0 historical releases (forward-only from adoption).
- No new general-purpose skill unless planning chooses D5b.

## Success criteria

- After a real release publishes, the GitHub Release body is rewritten into a `## What's new`
  narrative within the watch budget, with the commit list preserved or summarized faithfully.
- A forced re-dispatch on an already-narrated release short-circuits (`neutral`) and changes
  nothing.
- An induced narration failure (e.g. agent error) leaves the release published with its default
  body and surfaces a `::warning::`, not a failed release.
- An induced off-target edit or auth failure fails the step with `::error::`.

## Open questions for planning

- **Q1 (D5):** inline prompt vs ported skill — recommendation is inline (D5a).
- **Q2 (D6):** confirm/grant `actions: write` on the App and the dispatched run's release-edit
  scope; define the exact fail-soft behavior when the permission is absent.
- **Q3:** the dispatch `--ref` — Systematic dispatches `fro-bot.yaml` on `main`; our release job is
  checked out on `release`. Decide which ref the narration run should target (likely `main` so it
  uses the current agent config, narrating the `release`-tag artifact). Verify the timestamp run
  selection uses the matching `--branch`.
- **Q4:** body integrity floor (Systematic uses 200 chars) — confirm a sensible minimum for our
  releases.
