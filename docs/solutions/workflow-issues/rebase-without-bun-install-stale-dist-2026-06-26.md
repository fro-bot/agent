---
title: 'Re-run bun install after rebasing onto dependency changes before rebuilding dist/'
date: 2026-06-26
category: workflow-issues
module: dist-bundle-pipeline
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - 'A branch is rebased onto main after dependency or lockfile changes landed'
  - 'dist/ is committed and CI verifies rebuilt artifacts match the tree'
  - 'Local node_modules was installed against an older lockfile than the current branch carries'
  - 'A freshly built dist/ differs from CI even though the source change is unrelated to bundling'
tags:
  - rebase
  - bun-install
  - dist
  - build-pipeline
  - committed-bundle
  - lockfile
  - force-with-lease
---

# Re-run bun install after rebasing onto dependency changes before rebuilding dist/

## Context

`dist/` is committed in this repo and CI verifies that a clean build does not change it. After a branch is rebased onto `main`, any dependency or lockfile change on `main` means the branch now carries a newer dependency graph than the local `node_modules` may contain. Running `bun run build` against stale installed packages can produce a local `dist/` bundle that differs from CI's clean checkout.

This surfaced on PR #1038 after rebasing onto `main`: the local build produced one hashed artifact while CI rebuilt a different tree and failed the dist comparison.

## Guidance

After rebasing or merging `main` into a branch that commits `dist/`:

```bash
bun install
bun run build
git add dist/ bun.lock package.json
git commit --amend
git push --force-with-lease
```

Only stage files that actually changed. The important ordering is `bun install` before `bun run build`; rebuilding without reinstalling keeps the stale local dependency graph in charge of the bundle.

If the branch was already pushed before the rebuild fix, use `--force-with-lease`, not plain `--force`.

## Why This Matters

`dist/` is derived from source plus the installed dependency graph. A rebase can update the source tree and lockfile without updating `node_modules`. CI starts from a clean checkout and install, so it builds from the new graph. The local machine builds from whatever is installed. Those two inputs diverge silently until the dist-diff gate catches them.

The dist-diff failure is the useful signal. Do not weaken the gate; resync the install and rebuild the committed artifact.

## When to Apply

- Before pushing a branch after rebasing onto `main` when `bun.lock`, `package.json`, or workspace manifests changed upstream.
- Before amending committed `dist/` after dependency Renovate PRs merge.
- Any time CI reports a clean-build `dist/` diff that local status did not predict.

## Examples

Bad sequence:

```bash
git rebase origin/main
bun run build
git add dist/
git commit --amend
```

Correct sequence:

```bash
git rebase origin/main
bun install
bun run build
git add dist/ bun.lock package.json
git commit --amend
git push --force-with-lease
```

## Related

- [Committed-bundle attribution and SBOM hygiene](committed-dist-attribution-and-sbom-hygiene-2026-06-21.md) — why committed generated artifacts stay under the dist-sync gate.
- [Migrating a pnpm workspace to Bun](migrate-pnpm-to-bun-monorepo-2026-06-24.md) — Bun lockfile/install semantics and the migration context.
- [Durable dist hidden Unicode fix](durable-dist-hidden-unicode-fix-2026-06-22.md) — another dist lifecycle guard; different mechanism, same committed-artifact discipline.
- PR #1038 — live failure mode that required `bun install` + rebuild after rebase.
