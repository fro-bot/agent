---
title: A dependency major can pass every check and still break the release
date: 2026-08-22
category: best-practices
module: dependency-management
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - Upgrading a dependency used by release, deploy, or other tooling that CI does not execute
  - Upgrading a type package that can describe a newer runtime than the one actually deployed
  - A plugin's transitive dependency imposes a compatibility floor its own manifest does not express
  - Configuration-driven tooling renames a field or changes a default between majors
tags:
  - dependency-majors
  - semantic-release
  - conventional-changelog
  - renovate
  - release-pipeline
  - types-runtime-mismatch
  - verification
---

# A dependency major can pass every check and still break the release

## Context

Two dependency majors arrived together and both looked safe. Every check was green on both. Both were unsafe, for structurally different reasons, and in neither case could CI have caught it.

That is the point worth keeping: these were not gaps in test coverage that more tests would close. In one case the affected code never runs in CI at all; in the other, the check succeeds *by construction* regardless of whether the code would work.

## Guidance

Treat dependency-major safety as a compatibility claim to be established, not a CI result to be observed. Before accepting one, answer four questions:

**Where is this dependency actually exercised?** CI may never execute release-only, deploy-only, or operator-only paths. If the dependency's job happens on a branch or in a job that pull-request CI does not run, green tells you nothing about it.

**What does it require from its neighbors?** A package can declare a compatible range while another package in the installed graph supplies an incompatible implementation. Peer and transitive constraints are where this hides.

**Do the types describe the runtime you deploy?** Type packages must track the runtime actually in use, not the newest available. Type-checking against newer declarations succeeds by construction.

**Did configuration semantics change?** Renamed fields, changed defaults, and boolean-to-enum conversions can keep a config syntactically valid while silently changing behavior.

When CI cannot exercise the boundary, build a probe. It is cheaper than it sounds:

1. Install the candidate dependency set.
2. Import the real production plugins — not reimplementations of them.
3. Feed representative inputs covering every configured type, rule, and scope.
4. Capture both success/failure and the rendered output.
5. Run the identical probe against the known-good baseline.
6. Diff the results.

The baseline run is the part people skip, and it is the part that makes the probe meaningful. "The new version produced output" is not a result. "The new version produced output identical to the baseline across all twelve cases" is.

## Why This Matters

**Case 1: the release pipeline.** `conventional-changelog-conventionalcommits` v10 requires `conventional-changelog-writer@>=9`. `@semantic-release/release-notes-generator@14.1.1` pins `^8.0.0`, and its `15.0.0-beta.1` still pins `^8.0.0`, so there is no upstream fix available. Note generation fails outright:

```text
Missing helper: "conventional-changelog-conventionalcommits requires
conventional-changelog-writer@9 or newer (conventional-changelog@8 or newer).
Your changelog tooling loaded an older writer which cannot render this preset.
Update the tooling or use an older major version of the preset."
```

`semantic-release` runs only on the `release` branch, so the update PR was green on every check and would have failed at release time. Upstream tracks this as [release-notes-generator#1027](https://github.com/semantic-release/release-notes-generator/issues/1027) and [#992](https://github.com/semantic-release/release-notes-generator/issues/992) — and #992's title, "produces empty release notes," indicates some version pairings fail *silently*, which is worse than the loud error.

v10 also replaced the `hidden` commit-type property and the `bumpStrict` preset option with `effect`, a string enum of `'bump' | 'changelog' | 'hidden'` that defaults to `'bump'` when omitted. It is not a boolean, so the mechanical translation of `hidden: true` is `effect: hidden`, not `effect: false`.

The probe made the difference concrete by driving the real `analyzeCommits()` and `generateNotes()` with the repository's actual `presetConfig` and `releaseRules` across twelve representative commits:

| configuration | result |
| --- | --- |
| v10, writer 8 | hard failure at `generateNotes` |
| v10 + writer 9, stale `hidden: true` | renders, but `skip:` commits appear under **⚠ BREAKING CHANGES** |
| v10 + writer 9 + `effect: hidden` | identical to the v9 baseline |

The middle row is the one that argues for a probe rather than a smoke test. A run that merely completes looks like success; only the baseline comparison reveals that suppressed commits were being promoted to the most alarming section in the changelog.

**Case 2: the type/runtime split.** `@types/node` v26 against a Node 24 runtime is the inverse failure. Every runtime surface here is Node 24 — `using: node24` in `action.yaml`, `node:24.19.0-alpine` in both deploy Dockerfiles, `node-version: '24'` in the harness release workflow, `24.19.0` in `.node-version`. Newer types describe a standard library none of them ship. A Node 26-only API would type-check cleanly and fail on the runner, and no amount of type-checking can detect that, because type-checking against newer types succeeding is the expected behavior.

## When to Apply

Apply this to majors involving release tooling, deployment tooling, and code generators; plugins whose peer or transitive dependencies impose undocumented compatibility floors; configuration-driven tools where a renamed field can silently alter output; and type packages or platform declarations that can outrun the deployed runtime.

Where a compatibility boundary is deliberate, encode it as a version cap so the update stops being re-raised and re-analyzed. Record the reason inline — a bare cap invites removal by whoever finds it next.

## Examples

The changelog fix required both a dependency override and a config migration; neither alone is sufficient:

```json
{
  "overrides": {
    "conventional-changelog-writer": ">=9"
  }
}
```

```yaml
presetConfig:
  types:
    - type: skip
      effect: hidden
```

The types case was resolved by holding the update and capping it, alongside the existing OpenCode and Bun caps in the same file:

```json5
{
  matchPackageNames: ['@types/node'],
  allowedVersions: '<25',
}
```

The cap tracks the runtime major rather than the version being rejected: `<25` keeps types on 24.x, where the runtime is. `<26` would admit v25 and reintroduce the same mismatch one major lower. Raise it only when every runtime surface has moved, not ahead of it.

The probe pattern generalizes to any dependency whose behavior CI does not exercise. Drive the real plugins with the real configuration, once on the baseline and once on the candidate, and compare:

```js
const analysis = await analyzeCommits(
  {preset, presetConfig, releaseRules},
  {commits: representativeCommits, logger, cwd},
)

const notes = await generateNotes(
  {preset, presetConfig},
  {commits: representativeCommits, lastRelease, nextRelease, options, cwd},
)
```

A green install, build, and unit-test suite is not evidence when the probe is the first thing to actually execute the affected boundary.

## Related

- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — the general form of this failure
- [A gate that cannot fail manufactures confidence](../workflow-issues/non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — why a check that cannot fail is worse than none
- [#1420](https://github.com/fro-bot/agent/pull/1420) — the changelog preset major and its migration
- [#1461](https://github.com/fro-bot/agent/pull/1461) — the `@types/node` cap
