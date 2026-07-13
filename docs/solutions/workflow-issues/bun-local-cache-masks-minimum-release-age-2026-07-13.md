---
title: Bun's local cache can mask the minimumReleaseAge gate
date: 2026-07-13
category: workflow-issues
module: tooling
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - "A dependency bump is validated with a local bun install while CI runs with a cold cache"
  - "A package version is near the bunfig minimumReleaseAge boundary"
  - "Deciding whether a minimumReleaseAgeExcludes fast-track entry is removable"
tags: [bun, minimum-release-age, supply-chain, cache, verify-before-act]
---

# Bun's local cache can mask the minimumReleaseAge gate

## Context

A bump of `@opencode-ai/sdk` to `1.17.18` passed a local `bun install --frozen-lockfile` and was pushed as verified. CI then failed with "blocked by minimum-release-age". The version was 2.5 days old against the 3-day gate (published `2026-07-09T18:50Z`, checked from CI around `2026-07-12T06:50Z`).

## Guidance

Bun does not re-apply `minimumReleaseAge` to versions already present in the local package cache — a warm cache silently satisfies an install that a cold cache would reject. Local success is not evidence the gate passes.

The authoritative pre-push check is publish-timestamp arithmetic, not a local install:

```bash
npm view @opencode-ai/sdk@1.17.18 time --json
```

Compare the published timestamp against the gate window in `bunfig.toml`:

```toml
[install]
# Supply-chain age gate: refuse dependency versions published within this window.
minimumReleaseAge = 259200

# Temporary fast-track: @opencode-ai/sdk 1.17.18 pairs with the released
# harness base (1.17.18+harness.4ec05a47) and clears the 3-day window at
# 2026-07-12T18:50Z. Remove this exclusion after that.
minimumReleaseAgeExcludes = ["@opencode-ai/sdk"]
```

If the gate hasn't cleared and the bump can't wait, add a temporary `minimumReleaseAgeExcludes` entry with the clearing timestamp noted in a comment, and track its removal once the window passes.

To locally reproduce what CI sees, clear the bun cache before the frozen install:

```bash
rm -rf ~/.bun/install/cache
bun install --frozen-lockfile
```

## Why This Matters

The gate exists to delay adoption of fresh publishes so a supply-chain compromise has a window to surface before the package lands. A warm-cache local pass is a false verification signal that defeats the check exactly when it matters — a fresh publish is the case the gate is meant to catch.

## When to Apply

- Validating any dependency bump before push, especially near a `minimumReleaseAge` boundary.
- Deciding whether a `minimumReleaseAgeExcludes` entry is safe to remove.
- Diagnosing a CI-only "blocked by minimum-release-age" failure that didn't reproduce locally.

## Examples

Before (misleading local pass):
```
$ bun install --frozen-lockfile   # warm cache, package already downloaded → succeeds
$ git push                        # CI: cold cache → "blocked by minimum-release-age"
```

After (timestamp arithmetic before push):
```
$ npm view @opencode-ai/sdk@1.17.18 time --json
{ "1.17.18": "2026-07-09T18:50:00.000Z" }
$ node -e 'const pub=new Date("2026-07-09T18:50:00.000Z").getTime();
const ageMs=Date.now()-pub; console.log({ageDays:(ageMs/86400000).toFixed(2), cleared: ageMs>=259200000});'
{ ageDays: '2.50', cleared: false }
```

## Related

- [A time-gated "ready" signal can fire before the real boundary](./time-gated-smart-note-surfaced-ready-early-2026-07-04.md) — same verify-the-timestamp-not-the-date discipline, applied to smart-note readiness rather than install caching.
- [Migrating a pnpm workspace to Bun](./migrate-pnpm-to-bun-monorepo-2026-06-24.md) — where the `minimumReleaseAge` gate configuration lives.
