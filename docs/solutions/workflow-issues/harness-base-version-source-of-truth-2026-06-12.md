---
title: "Duplicate Version Sources Cause Silently-Missed Bumps"
date: 2026-06-12
last_updated: 2026-06-14
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - "A version or config value is declared in more than one file"
  - "Renovate or a custom manager bumps a version literal"
  - "A build reads a value from one location but humans (or automation) edit another"
  - "A tool maintains a 'managed versions' inventory"
  - "You see a hardcoded fallback literal for a value that should come from config"
tags:
  - versioning
  - renovate
  - source-of-truth
  - workflow
  - harness
  - opencode
category: workflow-issues
---

# Duplicate Version Sources Cause Silently-Missed Bumps

## Context

`@fro.bot/harness` base-version bumps to OpenCode kept getting silently missed — a bump would "happen" yet the built binary stayed on the old base. This persisted even though the repo already had a `versioned-tool` skill whose whole job is to prevent version drift.

The failure was multi-factor, and none of the factors produced an error:

- `packages/harness/src/base-version.ts` exported a `HARNESS_BASE_VERSION` constant.
- `packages/harness/harness.config.json` independently held `base_version`.
- The integrate/build pipeline read **only** `harness.config.json` (`integrate-command.ts` → `integrate.ts` → checkout tag `v${base_version}`). The constant had **zero importers** — purely vestigial.
- Renovate's `customManager` was wired to track `base-version.ts` — the dead sentinel — so it bumped a file nothing consumed while the authoritative config went untracked.
- `provenance.ts` carried a third copy as hardcoded fallback literals.
- The `versioned-tool` skill inventory omitted the harness base-version site entirely, so it was never inside the single-source discipline that governed the other version constants.

The drift entered when a base rebase updated the config but left the sentinel behind, and it stayed invisible because **nothing fails when two copies of the same value diverge.**

## Guidance

One source of truth per version/config value. If the build reads `harness.config.json`, then Renovate — and humans — must target that same file. Delete redundant copies rather than trying to detect divergence after the fact.

Three structural rules:

1. **Eliminate the duplicate.** A vestigial constant nothing imports is not a convenience; it is a second source that will drift. Delete it.
2. **Point automation at the consumed source.** A Renovate `customManager` must match the exact file the build reads. Renovate custom managers fail **silently** — a non-matching `managerFilePatterns` or `matchStrings` produces no PR, no error, no log. A wrongly-targeted manager looks healthy while tracking nothing.
3. **Inventory every version site.** If a tool maintains a "managed versions" list, an un-inventoried site is a blind spot that drifts unnoticed. The inventory must be complete, including config-JSON sites that aren't TypeScript constants.

> **Exception (added 2026-06-14): when the consumed source can't be Renovate-tracked.** "Point automation at the consumed source" assumes Renovate *can* order that source. It can't order SemVer **build-metadata** versions like `1.17.3+harness.<sha>` (build metadata has no defined ordering; the SHA suffix is non-monotonic). For the OpenCode harness build the action default (`DEFAULT_OPENCODE_VERSION`) and the workspace `OPENCODE_VERSION` ARG are those un-orderable versions, so they were deliberately moved *off* Renovate onto a release-job coupled bump that writes both files at publish time — guarded by a dual-source idempotency check so a partial failure can't freeze one file. The single-source thesis still holds (one writer owns the value); the *writer* is the release job rather than Renovate. See `docs/solutions/best-practices/cross-libc-build-and-release-safety-2026-06-14.md` §4.

When a fallback is genuinely needed (e.g. config unreadable), use an honest sentinel like `"unknown"` — never a hardcoded version literal, which is just another copy waiting to drift.

Do **not** reach for a "drift-detection test" that asserts the config's shape or that two literals agree. That tests what you think the files should look like, not behavior, and it papers over the real problem. The fix is to remove the duplicate so there is nothing to drift.

## Why This Matters

Duplicate version sources are a *silent* failure mode:

- a human updates one copy,
- Renovate updates another,
- the build consumes a third,
- and nothing necessarily errors.

That is exactly how a bump gets "missed" with no signal. The cost is shipping the wrong base version while believing you shipped the new one — discovered only when something downstream behaves unexpectedly. Because the discovery is indirect, the debugging cost is high relative to the trivial structural fix.

## When to Apply

- A version or config value exists in more than one file.
- Renovate or another custom manager bumps a version literal.
- A build reads config from one location but edits land elsewhere.
- A tool maintains a "managed versions" inventory.
- You spot a hardcoded fallback literal for a value that should be sourced from config.

## Examples

### Renovate: track the consumed source, not a sentinel

```json5
// BEFORE — tracks the vestigial sentinel the build never reads
{
  customManagers: [
    {
      managerFilePatterns: ['/packages\\/harness\\/src\\/base-version\\.ts/'],
      matchStrings: ["HARNESS_BASE_VERSION = '(?<currentValue>\\d+\\.\\d+\\.\\d+)'"],
      datasourceTemplate: 'github-releases',
      depNameTemplate: 'anomalyco/opencode',
    },
  ],
}

// AFTER — tracks harness.config.json, the file the build actually reads
{
  customManagers: [
    {
      managerFilePatterns: ['/packages\\/harness\\/harness\\.config\\.json/'],
      matchStrings: ['"base_version":\\s*"(?<currentValue>\\d+\\.\\d+\\.\\d+)"'],
      datasourceTemplate: 'github-releases',
      depNameTemplate: 'anomalyco/opencode',
    },
  ],
}
```

### Delete the vestigial duplicate

```ts
// DELETED: packages/harness/src/base-version.ts
// No exported HARNESS_BASE_VERSION constant remains. harness.config.json
// base_version is the single source the integrate/build pipeline reads.
```

### Provenance: honest sentinel, not a drift-prone literal

```ts
// BEFORE — a hardcoded literal that silently drifts from the config
const baseVersion = parsed.base_version ?? '1.16.0'
// ...and a second literal on the no-config path:
return {baseVersion: '1.16.0', /* ... */}

// AFTER — config is the only source; the no-config path is honestly 'unknown'
const baseVersion = parsed.base_version ?? 'unknown'
return {baseVersion: 'unknown', /* ... */}
```

### Keep the managed-version inventory complete

The harness base-version site was added to the `versioned-tool` skill inventory alongside the TypeScript constants (`DEFAULT_OPENCODE_VERSION`, etc.), explicitly noting it is a config-JSON site, not a constant — so the one site that wasn't a constant stops being the blind spot.

## Related

- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — the single-source version pattern and Renovate `customManager` wiring for a config-declared plugin. Same prevention discipline (single source, track the consumed value), different root cause (plugin-config wiring vs. a Renovate-tracked dead sentinel). Consider reading both together when touching version management.
- PR #867 — the fix (delete sentinel, retarget Renovate, remove provenance literals, inventory the site).
- PR #866 — the Renovate bump against the soon-deleted sentinel, closed as moot; the concrete symptom of tracking the wrong file.
