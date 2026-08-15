---
title: A stale dependency clone can invalidate an upstream diagnosis
date: 2026-08-14
category: best-practices
module: dependency-management
problem_type: best_practice
component: documentation
severity: medium
applies_when:
  - About to conclude that a bug is unreported or unfixed upstream
  - Searching pinned clones under `.slim/clonedeps/repos/` for upstream behavior
  - Attributing a root cause that implies writing a patch rather than bumping a pin
related_components:
  - harness-release
  - documentation
tags:
  - clonedeps
  - upstream-drift
  - pinned-dependency
  - diagnosis
  - evidence-of-absence
---

## Context

This repo keeps read-only dependency clones under `.slim/clonedeps/repos/`, pinned to `base_version` in `packages/harness/harness.config.json`. During the [OpenCode ID-space wrap investigation](../logic-errors/opencode-id-space-wrap-silently-froze-sessions-2026-08-14.md), the clone sat at `v1.18.14`. Searching it — and searching upstream by symptom text — turned up no report and no fix, which was reported as "this is unreported, we are first to the diagnosis."

That was wrong. Upstream had diagnosed and fixed it a week earlier, before the bug ever triggered in the wild.

## Guidance

Treat a pinned clone as authoritative for exactly one thing: what the currently pinned base ships. It says nothing about what upstream has since fixed.

`AGENTS.md` already carries the rule:

> Both are pinned to the `base_version` in `packages/harness/harness.config.json`, so what you read is what the harness ships. Re-pin them when that base moves — a source check against a stale clone can be confidently wrong.

Before concluding that upstream has not addressed something, check upstream's commit log on its actual default branch. For `anomalyco/opencode` that is `dev`, not `main` — a `main`-oriented check sees nothing even when the fix has landed.

## Why This Matters

Three independent factors lined up to make the search return clean when the fix already existed:

1. **The clone predated the fix.** It was pinned two days before the fixing commits landed.
2. **No issue was ever filed.** The fix arrived as bot-authored commits (`opencode-agent[bot]`), so searching by symptom text — the natural way to look for a bug report — returns nothing regardless of how well-phrased the query is.
3. **The default branch is not `main`.** Fixes land on `dev`.

The cost of getting this wrong is not just an inaccurate claim. It changes the proposed remedy: "nobody has fixed this" leads toward writing and filing a patch, while "already fixed in a later tag" leads to a one-line version bump. Work was drafted against the first conclusion before the second turned out to be true.

Absence of search results is not evidence of absence. It is evidence that the query did not match — which is a much weaker statement.

## When to Apply

Any time a conclusion depends on upstream *not* having something: no fix, no report, no prior art. The asymmetry matters — confirming that upstream has a fix is cheap and reliable, while confirming it does not requires ruling out every way a search can miss.

## Examples

Weak, and how it fails:

```sh
# Symptom-text search across issues. Returns nothing when the fix
# landed as a bot-authored commit with no issue behind it.
gh search issues --repo anomalyco/opencode "session not responding"
```

Direct, against the branch that actually receives fixes:

```sh
git -C <clone> log --oneline origin/dev -- packages/opencode/src/session/
git merge-base --is-ancestor <commit> <tag> && echo "contained in tag"
```

The second form answers the question that actually matters — is the fix in the tag we ship — and cannot be defeated by missing issue text or a wrong default branch.
