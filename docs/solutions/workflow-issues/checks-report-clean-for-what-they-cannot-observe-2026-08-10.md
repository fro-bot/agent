---
title: A check reports clean for the part of the world it cannot observe
date: 2026-08-10
category: workflow-issues
module: development-workflow
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - A scanner, report, or gate summarizes a population it does not fully enumerate
  - A green result is trusted without knowing what the check was able to look at
  - Two implementations of the same concern exist and only one is fixed
  - A validation compares an artifact against values derived from that same artifact
  - An absent API response is read as evidence that a feature is off
tags:
  - observable-scope
  - false-confidence
  - dependency-scanning
  - partial-coverage
  - verification
---

# A check reports clean for the part of the world it cannot observe

## Context

Several unrelated defects surfaced in a single session, and they shared one shape: a check working correctly, reporting honestly, and covering less than anyone believed.

None of these were broken gates. Each one ran, passed, and reported a result that was true about its own inputs and false about the thing people were relying on it for.

**Dependency scanning covered about six percent of the tree.** GitHub's dependency graph parses only the direct dependencies of `bun.lock`. At commit `48d09adda`, `gh api repos/OWNER/REPO/dependency-graph/sbom` returned 65 packages while osv-scanner reading the same lockfile reported 1169. Dependabot's open-alert count was zero and had been printed as a daily green tick. That zero was accurate for the 65 packages it could see. Every one of the nine vulnerable packages was transitive and absent from the graph — the only one that appeared, `js-yaml`, was there because it happens to be a direct devDependency.

The tell was available the whole time: `state=fixed` returned 78. The pipeline was alive and had resolved dozens of alerts. It simply had no view of the rest of the tree.

**A report counted only findings that had a file.** The daily maintenance report's instruction said `security alerts if accessible` and nothing more. Left to define that, the agent settled on alerts with a file location. Four repository-level Scorecard findings carry `location.path: "no file associated with this alert"`, so they fell out of the count — and their absence was then narrated as _these alerts have cleared_. Five open reported against nine actually open.

**A redaction fix landed on one of two identical loggers.** `makeLogger` in `packages/gateway/src/program.ts` spread caller context straight into `JSON.stringify`. It was fixed. `CONSOLE_GATEWAY_LOGGER` in `packages/gateway/src/discord/client.ts` had the same defect and was initially dismissed as an incidental console call, though it is reachable in production through the ping command. Review caught it. Half a fix would have left one logger redacting beside a twin that did not, which is worse than neither — it makes the whole package look handled.

**A baseline validated itself against a copy of itself.** `evals/baselines/u1.test.ts` compared the committed baseline JSON against hardcoded constants that had been copied out of that same JSON. It stayed green while all six prompt hashes drifted.

One more instance came from reading an API response rather than a codebase. `gh api repos/OWNER/REPO/vulnerability-alerts` returns 404 when the calling token lacks admin, not 403. That 404 was read — by me, and independently by a delegated research lane — as _the feature is disabled_, and a wrong root cause was reported with confidence. Alerts had been enabled the entire time.

## Guidance

Before trusting a clean result, establish what the check was able to look at and which interface the production consumer actually reads through. A check can pass on artifacts written by one interface while the real consumer reads through a different path, in which case the artifacts prove only that a write happened. That is a separate question from whether it passed, and it is almost never reported alongside the pass.

**Compare the check's population against an independent count of the same population.** For dependency scanning the two numbers are one command apart:

```bash
gh api repos/OWNER/REPO/dependency-graph/sbom --jq '.sbom.packages | length'
docker run --rm -v "$PWD:/src" -w /src ghcr.io/google/osv-scanner:v2.5.0 --lockfile=/src/bun.lock
```

Sixty-five against 1169 is not a subtle discrepancy. Nobody had put the two numbers next to each other.

**Key status off the field that carries it, not off an incidental property.** An alert's `state` says whether it is open. Whether it has a file path says where it was found. The maintenance report's prompt now states this outright, because leaving it to inference is what produced the wrong count:

```text
The `state` field is the only authority on whether an alert is open. Report an
alert as resolved only when its own state says so — never because it is missing
from a narrower view.
```

**When fixing a class of defect, enumerate every implementation of that class before scoping the fix.** Search for the shape, not the symptom. Two `GatewayLogger` implementations existed; only one was found by looking at where the reported problem was.

**Make a validation derive its expected value from a source independent of the artifact under test.** If the expectation and the artifact share an origin, the test asserts that a value equals itself.

**Distinguish "no" from "you cannot see."** Before concluding a feature is off, prove the caller could observe it if it were on:

```bash
gh api repos/OWNER/REPO --jq '.permissions'
```

GitHub hides several endpoints behind 404 rather than 403 for tokens without admin, so absence has at least two causes and the response does not tell you which.

## Why This Matters

A broken check announces itself. A blind one accumulates trust while the uncovered region grows.

The dependency case had been reporting zero long enough for the number to become background reassurance, and the daily report reinforced it. Twenty-four advisories — one critical, thirteen high — sat in the ninety-four percent nobody was looking at. The fix took a scanner that reads the lockfile directly and a set of version-floor bumps; finding the problem took noticing that two tools disagreed and asking why rather than trusting the friendlier answer.

The twin-logger case is the same failure in miniature and shows why partial fixes are dangerous beyond the code they leave unfixed: the package now _looked_ audited.

## When to Apply

Any time a green result covers a population rather than a single assertion — dependency and vulnerability scanning, alert and compliance summaries, coverage reports, lint or policy sweeps, and any validation whose expected values are generated rather than stated.

Also when a fix targets a defect class that could plausibly exist in more than one place, and when an API's absence is about to become a root cause.

## Examples

Both gateway loggers now route context through the shared redactor, and `withLogContext` needs no change of its own because it delegates rather than writing to the console:

```ts
// packages/gateway/src/discord/client.ts
warn: (ctx: Record<string, unknown>, msg: string) =>
  console.warn(JSON.stringify({level: 'warn', ...redactSensitiveFields(ctx), msg})),
```

The eval baseline guard now recomputes provenance from the live scenario registry rather than comparing the committed artifact against constants copied out of it. The hardcoded expectation table was deleted outright — deriving it from the same source would have reproduced the original defect in a less obvious form.

Measured at `48d09adda`, an independent lockfile scan showed the population Dependabot could not see:

```text
Scanned /src/bun.lock file and found 1169 packages
Total 9 packages affected by 24 known vulnerabilities (1 Critical, 13 High, 10 Medium)
```

## Related

- [A gate that cannot fail manufactures confidence](non-failing-gates-are-worse-than-no-gates-2026-08-07.md) — the adjacent failure mode. That doc covers gates where _no reachable input can turn them red_; this one covers gates that can fail but observe a narrower population than they appear to. A gate can be perfectly capable of failing and still be blind.
- [A present signal is not evidence of the effect it implies](verify-behavior-not-signal-2026-08-23.md) — the mirror image. This doc covers checks that saw too little; that one covers cases where the thing was fully observed and the wrong property of it was read — a present request field, a correct path string, a symbol count — taken as proof of an effect none of them establish.
- [Verify the signal before implementing the plan](evidence-first-scope-correction-under-incomplete-signals-2026-08-08.md) — verifying a premise before building on it.
- [Trustworthy agent eval corpus design](../best-practices/deterministic-agent-outcome-eval-corpus-2026-08-09.md) — where the self-referential baseline was fixed.
- [Machine-readable advisory data over prose](../best-practices/machine-checked-advisory-ranges-and-version-floors-2026-08-10.md) — the dependency triage that followed from this coverage gap.
