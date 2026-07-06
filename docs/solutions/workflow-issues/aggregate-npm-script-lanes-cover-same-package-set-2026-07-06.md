---
title: Monorepo aggregate npm-script lanes must cover the same package set
date: 2026-07-06
category: workflow-issues
module: root-package-json
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Maintaining root aggregate scripts that chain per-package Bun `--filter` calls
  - Adding a new workspace package to the monorepo
  - A package has only a smoke/build CI job and no always-run unit/lint/type gate
  - Investigating how a package regression shipped on green CI
related_components:
  - package.json
  - github-actions
  - gateway
tags:
  - monorepo
  - ci-coverage
  - aggregate-scripts
  - bun-workspaces
  - drift
  - lane-parity
---

# Monorepo aggregate npm-script lanes must cover the same package set

## Context

The root `package.json` defines aggregate scripts that fan out across workspace packages with `bun run --filter <pkg> <script>` — `test`, `lint`, `check-types`, `build`, `fix` each chain the packages manually with `&&`. Because the chains are hand-maintained, they drifted: `@fro-bot/gateway` — the largest package, owning the approval gate, redaction, and operator auth — was in **none** of the aggregate lanes.

Gateway's only CI signal was a path-gated `gateway-smoke` job (`.github/workflows/ci.yaml`): `tsc --noEmit` + `tsdown` + a Docker boot smoke. That job runs **no unit tests**, runs **no lint**, and fires **only** when gateway paths change. So a gateway unit-test failure, an ESLint error, or a shared-type regression from a `@fro-bot/runtime` change could ship **green**, because the always-run root `test` / `lint` / `build` lanes never touched gateway.

The root CI jobs run the root aggregates — `Lint` → `bun run lint`, `Build` → `bun run build`, `Test` → `bun run test` — so whatever the root aggregate omits is invisible to the always-run gate. (`check-types` / `fix` are dev-local, but the same parity principle applies.)

## Guidance

Every aggregate lane should cover the **same** workspace package set. Adding a package to one lane (e.g. `test`) but not the others leaves the omitted lanes blind.

The fix (PR #1132) appends the missing package to every root lane:

```jsonc
{
  "scripts": {
    "test":        "... && bun run --filter @fro.bot/harness test && bun run --filter @fro-bot/gateway test",
    "check-types": "... && bun run --filter @fro.bot/harness check-types && bun run --filter @fro-bot/gateway check-types",
    "fix":         "... && bun run --filter @fro.bot/harness fix && bun run --filter @fro-bot/gateway fix",
    "lint":        "... && bun run --filter @fro.bot/harness lint && bun run --filter @fro-bot/gateway lint && bun run dist:check-hidden-unicode && bun run check:md-links",
    "build":       "... && bun run --filter @fro.bot/harness build && bun run --filter @fro-bot/gateway build && bun run dist:escape-hidden-unicode"
  }
}
```

Rules that matter:

- **Exact package names.** `@fro-bot/gateway` is hyphenated; `@fro.bot/harness` is dotted. A typo silently no-ops the filter (Bun runs nothing and exits 0).
- **Tail-step ordering.** Package lanes go *before* repo-tail steps: gateway `lint` before `dist:check-hidden-unicode` / `check:md-links`; gateway `build` before `dist:escape-hidden-unicode` (which scrubs the committed **root** `dist/` — gateway's `dist/` is gitignored, so no committed-dist churn).

### Enabling a never-run gate surfaces accumulated debt

A lane that has never run accumulates latent failures. Enabling gateway `lint` for the first time surfaced **4 pre-existing `prettier/prettier` errors** (multiline type-union layout) — not caused by the wiring, just previously invisible. Turning on a quality gate over existing code needs the debt cleared first, or the newly-enabled lane turns CI red on its first run:

```bash
# clear the blocking errors BEFORE wiring the lane into the aggregate
bun run --filter @fro-bot/gateway fix    # pure prettier reformat, near-zero risk
bun run --filter @fro-bot/gateway lint   # confirm exit 0 before adding to root `lint`
```

Distinguish **blocking errors** (must clear) from **non-failing warnings**: 8 `no-non-null-assertion` warnings in gateway test files were left in place — `eslint src` without `--max-warnings 0` does not fail on warnings. Latent trap: if the config later adopts `--max-warnings 0`, those warnings become blockers.

## Why This Matters

A path-gated smoke/build job is **not** equivalent to always-run unit/lint/type coverage. It can pass while the package's real tests would fail, and it may not run at all for a cross-package change (a `@fro-bot/runtime` edit that breaks gateway touches no gateway path). Hand-maintained fan-out lanes drift silently — adding a workspace package doesn't add it to the lanes, and nothing enforces parity. The failure mode is the worst kind: green CI over broken code, invisible until someone notices by hand.

## When to Apply

- Any monorepo with hand-maintained aggregate scripts that fan out per-package.
- Whenever adding a new workspace package — add it to **all** aggregate lanes, not just one.
- When a package has only a smoke/build job and no always-run unit/lint/type gate.
- When reviewing why a package's regression shipped green.

## Examples

Before — gateway missing from every root lane (only the path-gated smoke job covered it):

```jsonc
"test": "bun run --filter @fro-bot/runtime test && bun run --filter @fro-bot/action test && bun run --filter @fro.bot/harness test",
"lint": "bun run --filter @fro-bot/runtime lint && bun run --filter @fro-bot/action lint && bun run --filter @fro.bot/harness lint && bun run dist:check-hidden-unicode && bun run check:md-links",
```

After — same package set in every lane (see the Guidance block above for the full set).

Enable-a-never-run-gate sequence: (1) run the lane's `fix`, (2) clear real errors, (3) confirm the standalone lane exits 0, (4) wire it into the root aggregate, (5) re-run root `lint` / `test` / `build`.

Prevention ideas:

- A parity check that enumerates workspace packages and asserts each appears in every aggregate lane (a tiny script, or a review checklist item on "did you add the new package to all lanes?").
- Where the tool supports it, a workspace-wide filter (`bun run --filter './packages/*' <script>`) auto-includes new packages — tradeoff: you lose explicit ordering and per-package tail steps like the committed-dist scrub, so the repo keeps explicit chains here deliberately.

## Related

- [Durable dist hidden-Unicode fix](durable-dist-hidden-unicode-fix-2026-06-22.md) — the sibling "coverage gap ships green" lesson, but for the CI **paths-filter** (routing/selection) rather than npm aggregate-lane parity; also covers `bun run build` as the command boundary and the check-vs-fix lane distinction.
- [Migrating a pnpm workspace to Bun](migrate-pnpm-to-bun-monorepo-2026-06-24.md) — Bun workspace `--filter` semantics and filtered install/build behavior these aggregate lanes rely on.
- PR #1132 (this change); follow-up #1134 (a `MaxListenersExceededWarning` the newly-enabled gateway suite surfaced — pre-existing, now visible).
