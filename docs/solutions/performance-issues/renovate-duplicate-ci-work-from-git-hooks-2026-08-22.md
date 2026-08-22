---
title: Renovate CI duplicated work through installed git hooks
date: 2026-08-22
category: performance-issues
module: ci-workflows
problem_type: performance_issue
component: tooling
symptoms:
  - Renovate workflow_run scans took roughly 24 minutes while push and workflow_dispatch scans finished in under a minute
  - Each update branch showed an unexplained ~124s gap between the commit log line and the next branch reset
  - Lint and build ran a second time during the branch push, immediately after postUpgradeTasks had run them
root_cause: config_error
resolution_type: config_change
severity: medium
related_components:
  - development_workflow
  - testing_framework
tags:
  - renovate
  - github-actions
  - ci-performance
  - git-hooks
  - bun
  - postinstall
  - dependency-updates
---

# Renovate CI duplicated work through installed git hooks

## Problem

Renovate `workflow_run` scans took roughly 24 minutes, while `push` and `workflow_dispatch` scans finished in under a minute. Only the full-repo scan that actually updates branches was slow, and it was slow because it ran the same lint and build work twice on every branch.

## Symptoms

Run `32543077755` showed a repeating ~124s gap sitting between the `git commit` log line and the next branch's `resetToCommit`, with nothing else in it, once per branch. Combined with ~129s of `postUpgradeTasks`, that produced roughly four minutes per branch across about six branches.

The second execution came from the repository's own postinstall:

```json
"postinstall": "simple-git-hooks",
"simple-git-hooks": {
  "pre-push": "bun run lint && bun run build"
}
```

Renovate's `postUpgradeTasks` ran `bun install`, which fired that postinstall and wrote `.git/hooks/pre-push` into Renovate's container. The push that followed then re-ran `lint && build` — exactly the work `postUpgradeTasks` had just completed.

The `bun install` itself is not removable. `skipArtifactsUpdate: true` is set for the bun and npm managers, so Renovate does not update `bun.lock` itself; that install is what regenerates it.

## What Didn't Work

**Consolidating the four sequential ESLint invocations.** The root `fix` script chains four filtered runs, each spawning its own `bunx eslint --fix`. The hypothesis was that four process startups and four flat-config loads dominated the cost. Measured: 62s for the existing four-way sequential run against 55s for a single equivalent invocation over the same directories — about 11%. The cost is the linting itself, not startup. Rejected.

**Passing arguments to scope the work.** Not possible. The `allowedCommands` allowlist in `bfra-me/renovate-action` is anchored regex admitting only bare script names from a fixed list:

```
^(?:bun|npm|pnpm|yarn)(?:\srun)?\s(?:bootstrap|build(-release)?|check|clean|fix|format|generate|lint|postupgrade|typecheck|update-snapshots)$
```

So `bun run fix --filter '*'` is rejected, and a new script name such as `fix:changed` is rejected. `postupgrade` is on that list and is the intended escape hatch for a custom command. A whole-repo `bunx eslint --fix .` is separately allowlisted but would be slower, not faster.

## Solution

Two changes, either sufficient on its own, shipped together:

```diff
-commands: ['bun install', 'bun run fix', 'bun run build'],
+commands: ['bun install --ignore-scripts', 'bun run build'],
```

```json5
platformCommit: 'enabled',
```

`--ignore-scripts` means the hook is never installed. `platformCommit` makes Renovate commit through the GitHub Contents API rather than the git CLI, which cannot run hooks at all regardless of what installed them, and attributes commits to the App.

A follow-up removed the remaining dominant cost. After the first fix, `bun run fix` at ~95s per branch was the largest step, and it is autofix-only. Update branches contain nothing ESLint reads — checking three open update PRs found only manifests, `bun.lock`, generated third-party notices, and workflow YAML. So `fix` now runs only for the tooling that can actually move lint output:

```json5
{
  matchPackageNames: [
    'eslint',
    'prettier',
    '@bfra.me/eslint-config',
    '@bfra.me/prettier-config',
    'eslint-config-prettier',
    'eslint-plugin-prettier',
    '@vitest/eslint-plugin',
  ],
  // This object replaces the top-level postUpgradeTasks rather than merging
  // with it, so the full command list is repeated here on purpose.
  postUpgradeTasks: {
    commands: ['bun install --ignore-scripts', 'bun run fix', 'bun run build'],
    executionMode: 'branch',
  },
},
```

`bun run build` stays unconditional — it regenerates the committed `dist/`, and a dependency bump does change bundled output.

## Why This Works

`bun install --ignore-scripts` still resolves dependencies and regenerates `bun.lock`, because lockfile resolution does not depend on lifecycle scripts. The only workspace postinstalls are the root `simple-git-hooks` and the harness's `node dist/postinstall.mjs || true`, which fetches a platform binary and is already failure-tolerant. Neither is needed by `fix` or `build`.

Scans went from 22 minutes to 13 at comparable branch counts — six to five, so not a lighter workload — and per-branch time from roughly four minutes to 2m18s. The post-commit gap is gone. With `platformCommit` active the `Committing files to branch` log line no longer appears at all, confirming the API path. `bun install --ignore-scripts` now completes in 0.2s, logging `No updated lock file`, which means essentially all of that step's former cost was the postinstall.

Two mechanics are worth knowing before editing this config. Renovate's `postUpgradeTasks` is not mergeable, so a matching `packageRules` entry replaces the top-level one wholesale rather than concatenating — which is why the lint-tooling rule repeats the full command list. And mixed groups fail safe: if a lint-tooling package is ever grouped with a non-tooling one, the lint rule wins for the whole branch under `executionMode: 'branch'`, so `fix` runs. The failure direction is "runs unnecessarily," never "skipped when needed."

## Prevention

- Use `--ignore-scripts` in any automation that installs dependencies and then commits, unless a lifecycle script is genuinely required. A repo whose postinstall installs git hooks will silently double the work of any such tool. This is not Renovate-specific.
- Prefer API-based commits when automation must be immune to repository-local hooks.
- Scope expensive autofix steps to the dependency updates that can actually change linted source.
- Treat `postUpgradeTasks` in a `packageRules` entry as a replacement, not an addition, and repeat the full command list deliberately.
- When a CI job is slow, measure where the time sits before restructuring how commands are invoked. Here the gap between the commit line and the next branch reset identified the duplicate immediately, while the plausible-sounding startup-overhead theory measured at 11% and was wrong.

## Related Issues

- [#1459](https://github.com/fro-bot/agent/pull/1459) — the `--ignore-scripts` and `platformCommit` fix
- [#1462](https://github.com/fro-bot/agent/pull/1462) — scoping autofix to lint tooling
- [Build pipelines: fallible work is a preflight, cleanup is a finally](../workflow-issues/build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md) — adjacent pipeline-sequencing guidance
- [Tool binary caching on ephemeral runners](./tool-binary-caching-ephemeral-runners.md) — related CI overhead reduction
- [Migrating a pnpm workspace to Bun](../workflow-issues/migrate-pnpm-to-bun-monorepo-2026-06-24.md) — Bun and Renovate interaction background
