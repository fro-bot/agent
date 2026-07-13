---
title: 'A time-gated "ready" signal can fire before the real boundary — verify the timestamp, not the date'
date: 2026-07-04
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: assistant
severity: medium
last_updated: 2026-07-13
applies_when:
  - A smart note, reminder, or CI gate is conditioned on an age window, embargo, or release-timing rule
  - A background checker marks something "ready" on or near the boundary date
  - Acting early would remove a temporary workaround or fast-track before its precondition actually holds
tags:
  - smart-notes
  - time-gate
  - minimum-release-age
  - bunfig
  - date-granularity
  - verify-before-act
---

# A time-gated "ready" signal can fire before the real boundary

## Context

A magic-context smart note said: *remove the temporary `minimumReleaseAgeExcludes = ["@opencode-ai/sdk"]` fast-track from `bunfig.toml` once `@opencode-ai/sdk@1.17.13` clears the 3-day `minimumReleaseAge` window.* The background checker surfaced it **ready** on 2026-07-04. Acting on it would have been wrong.

`bunfig.toml` gates installs on package age:

```toml
[install]
# Supply-chain age gate: refuse dependency versions published within this window (3 days).
minimumReleaseAge = 259200
# Temporary fast-track for the deliberate 1.17.13 SDK bump; remove once it clears the window.
minimumReleaseAgeExcludes = ["@opencode-ai/sdk"]
```

The empirical check showed the version was still **inside** the window when the note surfaced:

```
$ npm view @opencode-ai/sdk@1.17.13 time --json   # → "1.17.13": "2026-07-01T15:17:43.240Z"
published: 2026-07-01T15:17:43Z
age(days): 2.77
window(days): 3
cleared: false          # clears at ~15:17Z on 2026-07-04, ~5h after the note surfaced
```

Removing the exclusion with the package still in-window makes `bun install` refuse the pinned version — breaking the frozen-lockfile install in CI — for no reason.

## Guidance

Before acting on any time/age-gated "ready" signal, compute the boundary from the authoritative timestamp rather than trusting the flag's date resolution:

```bash
npm view <pkg>@<ver> time --json
```

```bash
node -e 'const pub=new Date("2026-07-01T15:17:43.240Z").getTime();
const ageMs=Date.now()-pub; const cleared=ageMs>=259200000;
console.log({ageDays:(ageMs/86400000).toFixed(2), cleared});'
```

If `cleared` is false, the precondition does not hold — leave the note pending and pivot to other work rather than idle-waiting; it will still be valid after the true boundary.

## Why This Matters

A readiness signal whose condition is evaluated at **calendar-date** granularity can fire up to a day before the real **timestamp** boundary. For an age gate, "the date matches" is not "the window cleared." Acting on the early flag removes a workaround while its precondition is still false — here, breaking the CI install. The flag answers "is it roughly time?"; the timestamp answers "is it actually time?" — and only the second one is safe to act on.

## When to Apply

- Removing any `minimumReleaseAge` / supply-chain age-gate exclusion or fast-track.
- Any smart note, reminder, or automation whose surface condition is time-, age-, or deadline-based.
- Any "the embargo has lifted / the window has passed" claim — verify the exact boundary before the irreversible step.

## Examples

Before (trusting the ready flag):
```
note: "ready" → remove minimumReleaseAgeExcludes → bun install refuses in-window version → CI breaks
```

After (verify-then-act):
```
note: "ready" → npm view <pkg>@<ver> time → age 2.77d < 3d window → NOT cleared → hold the note, pivot
```

Rule: verify-then-act on any time-gated condition; a "ready" flag is a prompt to check the clock, not permission to act.

## Related

- [Migrating a pnpm workspace to Bun](migrate-pnpm-to-bun-monorepo-2026-06-24.md) — where `minimumReleaseAge` moved into `bunfig.toml` (§3c); this is the operational hazard of acting on that gate too early.
- [Bun's local cache can mask the minimumReleaseAge gate](./bun-local-cache-masks-minimum-release-age-2026-07-13.md) — the same verify-the-timestamp discipline applied to install-cache freshness rather than smart-note readiness.
