---
title: Read advisory ranges from machine data and bound every version floor
date: 2026-08-10
category: best-practices
module: dependency-management
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - Deciding whether a resolved version is still exposed to a published advisory
  - Reading affected-version information from advisory summary prose
  - Raising a minimum version in an overrides or resolutions block
  - Confirming that a dependency fix actually changed what the resolver picked
tags:
  - osv
  - advisory-ranges
  - semver
  - version-floors
  - supply-chain
  - dependency-triage
---

# Read advisory ranges from machine data and bound every version floor

## Context

Clearing 24 advisories across nine transitive packages produced two mistakes worth keeping, both in the same short stretch of work, and both made twice — once by me and once by a delegated research lane working independently.

The first was reading affected-version information out of advisory prose. Summary text like _affects 8.5.22_ reads as an exact statement about one version. On that basis I excluded three of the 24 advisories as already patched, and reported a smaller number with confidence. The machine-readable data said otherwise:

```bash
curl -s https://api.osv.dev/v1/vulns/GHSA-fxqj-rqcc-2cmp | jq '.affected[0].ranges[0].events'
# [{"introduced":"0"},{"fixed":"8.5.23"}]
```

`introduced: 0` means every version below the fix. The resolved `8.5.21` was inside the range, not below it. All 24 advisories applied.

Two of the three exclusions were `brace-expansion` advisories whose ranges begin at `4.0.0` and end at `5.0.8` and `5.0.9`. The resolved `5.0.6` looked comfortably below a range starting at `5.0.7` in prose, and was in fact inside a range starting at `4.0.0`. Multi-major packages are where prose diverges most from the data, because a single advisory carries a separate range per major line and prose tends to describe only the newest.

The second mistake came while fixing the advisories. Raising a floor to `"nanoid": ">=3.3.17"` resolved to `6.0.1` — nearly three major versions above the `3.3.x` line in use. A bare floor says _at least this_, and the resolver obliges by taking the newest thing that satisfies it. That would have shipped a breaking upgrade inside a change whose stated purpose was a security patch, which is close to the least scrutinized place a major bump can hide.

The behaviour reproduces in isolation, so it costs nothing to confirm before trusting a floor:

```bash
echo '{"name":"t","dependencies":{"nanoid":">=3.3.17"}}' > package.json && bun install
node -e "console.log(require('./node_modules/nanoid/package.json').version)"
# 6.0.1
```

## Guidance

**Query the range events rather than reading the summary.** OSV exposes them per advisory, and they are unambiguous in a way prose is not:

```bash
curl -s https://api.osv.dev/v1/vulns/<GHSA-ID> | jq '.affected[] | {pkg: .package.name, events: .ranges[].events}'
```

Read every `affected[]` entry. One advisory commonly carries several, one per major line, each with its own `introduced`/`fixed` pair. A resolved version is exposed if it sits at or above an `introduced` and below the matching `fixed`.

Better still, let the scanner make the determination. It reads the same data and does not get tired:

```bash
docker run --rm -v "$PWD:/src" -w /src ghcr.io/google/osv-scanner:v2.5.0 --lockfile=/src/bun.lock
```

**Bound a floor to the major line you intend to stay on.** A floor exists to keep a package above a known-bad version, not to opt into whatever ships next:

```json
"nanoid": ">=3.3.17 <4.0.0"
```

Leave the floor open only when crossing majors is genuinely acceptable for that dependency. In the same change, eight of nine packages kept bare floors deliberately and picked up newer patched releases. `nanoid` was the one case where the next major was three releases away and the constraint had to say so.

**Verify what the resolver actually chose.** A floor expresses intent; the lockfile records outcome. They diverge quietly, in both directions — a floor can fail to move anything, or move something much further than intended. Read the resolved versions out of the lockfile after installing, and re-run the scanner to confirm the count actually reached zero rather than assuming the edit was sufficient.

## Why This Matters

Both errors produce a confident, specific, wrong number, which is worse than an uncertain one because it ends the investigation. The prose reading understated exposure by three advisories and would have left them unfixed with a written rationale explaining why they were fine. The bare floor would have passed review as a security fix while carrying a three-major upgrade.

That two independent readers made the identical prose error is the useful part. It is not a lapse in care — advisory summaries are written for humans skimming for relevance, not for deciding whether a specific resolved version is exposed. Treating them as the latter will keep producing the same mistake.

## When to Apply

Whenever a resolved version is being compared against a published advisory, whenever a minimum is raised in `overrides`, `resolutions`, or an equivalent policy block, and whenever a dependency change is about to be described as complete.

## Examples

The bounded floor, alongside the unbounded ones that were correct to leave open:

```json
// package.json
"overrides": {
  "nanoid": ">=3.3.17 <4.0.0",
  "tar": ">=7.5.21",
  "undici": ">=8.9.0"
}
```

The scan output is the acceptance criterion for this kind of change, and it is cheap enough to run before and after:

```
Total 9 packages affected by 24 known vulnerabilities (1 Critical, 13 High, 10 Medium)
```

versus, after raising the floors, no findings at all.

## Related

- [A check reports clean for the part of the world it cannot observe](../workflow-issues/checks-report-clean-for-what-they-cannot-observe-2026-08-10.md) — how these 24 advisories went unnoticed: the dependency graph parsed only direct dependencies, so Dependabot reported zero while the transitive tree went unscanned.
- [Verify the signal before implementing the plan](../workflow-issues/evidence-first-scope-correction-under-incomplete-signals-2026-08-08.md) — the same instinct applied to premises rather than version ranges.
