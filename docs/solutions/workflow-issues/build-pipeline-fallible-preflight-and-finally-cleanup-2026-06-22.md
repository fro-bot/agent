---
title: Build pipelines — fallible work is a preflight, cleanup is a finally
date: 2026-06-22
category: workflow-issues
module: packages/harness
problem_type: workflow_issue
component: tooling
severity: low
last_updated: 2026-06-24
applies_when:
  - "A generated artifact is committed to the repo and gated by a CI dist-diff / rebuild check"
  - "A fallible step produces content for that artifact and a destructive mutator (bundler/compiler/codegen) rewrites it"
  - "A cleanup must run on the mutated artifact even when the mutator fails (escape, format, sign, scrub, lint)"
  - "The pipeline relies on shell `&&` or a bundler writeBundle hook to sequence the fallible step and the cleanup"
  - "The artifact is rebuilt on a partial-environment path (Renovate/Dependabot/codegen bot) that may not have a fully-prepared toolchain"
tags:
  - build-pipeline
  - preflight
  - fail-closed
  - finally
  - atomic-write
  - writebundle
  - bundler-hook
  - renovate
---

# Build pipelines — fallible work is a preflight, cleanup is a finally

## Context

The committed `dist/` bundle is escaped of hidden-unicode characters (so Renovate's safety scan doesn't flag it) and ships a `THIRD_PARTY_NOTICES.txt` attribution file. Both invariants were implemented inside the tsdown `licenseCollectorPlugin` / `escapeHiddenUnicodePlugin` `writeBundle` hooks. The license collector ran `getProjectLicenses()` and **threw** (fail-closed, by design) when collection failed.

On Renovate's `postUpgradeTasks` branch builds — where the toolchain is only partially prepared and license collection fails — this aborted the action build *after* the bundler had already rewritten `dist/`, but *before* the escape ran. The committed `dist/` was left with raw hidden-unicode characters **and** a dropped notices file: the exact opposite of what the fail-closed guard intended. The warning survived three earlier fixes because each stayed coupled to the bundler lifecycle.

The fix wasn't "fail-soft instead." It was re-slotting *when* each step runs in the build lifecycle. This is the build-pipeline application of patterns the project already uses at runtime (dual-`finally` cleanup), in security (don't ship a bypassable guard), and in releases (fail-closed, no fallback).

## Guidance

### 1. Fallible work in a late destructive hook is a silent partial-commit

A bundler `writeBundle` hook fires *after* the bundler has cleaned and emitted `dist/`. Hosting fallible work there (license collection, validation, signing) means a throw leaves the artifact half-mutated with no rollback: rewritten chunks, a missing-or-stale notice, and a non-zero exit that arrived too late to prevent the bad state. The hook is downstream of the mutation, so it is the wrong layer for any check whose failure should *prevent* the mutation.

### 2. Three lifecycle slots: preflight → mutator → finally

A reliable build with a destructive mutator and a fail-closed generator has three named slots, and the preflight and finally are *siblings around* the mutator, not links in a `&&` chain:

```ts
// scripts/build-action-dist.ts — runBuildOrchestration
const notice = await preflight()        // (a) fail-closed generation, BEFORE any mutation
const result = await bundle()           // (b) the destructive mutator (tsc + tsdown)
await runEscape()                       // (c) cleanup, runs regardless of (b)'s outcome
if (result.exitCode !== 0) return result.exitCode   // never mask a real failure
await writeNoticeAtomic(notice)         // only on success
return 0
```

### 3. Fail-closed is a policy, not a place

The fail-closed guarantee (a successful build must have a complete, accurate notice; a *total* collection failure must abort) is correct and unchanged. What moved is its *location* — from a late `writeBundle` hook to a preflight that runs before the bundler is invoked. A preflight throw exits before `dist/` is touched, so the committed notice stays intact:

```ts
// preflight throws  →  return 1 BEFORE bundle() runs  →  committed dist/THIRD_PARTY_NOTICES.txt untouched
```

Do not "fix" this by making the policy environment-conditional (fail-soft on Renovate, fail-closed on main). The same commit must produce the same `dist/` in every environment; env-conditional behavior breaks the dist-diff determinism the whole gate relies on.

### 4. Cleanup belongs in a finally so a fail-closed step can't block it

The escape is keyed on *did the mutation happen* (does `dist/` exist?), not *did it succeed* — so a failed bundle's partial output is still escaped, and a fail-closed preflight can't skip it. The orchestrator re-propagates the mutator's exit code so cleanup never masks a real failure:

```ts
const bundleResult = await bundle()      // capture, don't short-circuit
try { await escape() } catch { /* surface only if bundle had succeeded */ }
if (bundleResult.exitCode !== 0) return bundleResult.exitCode  // real failure preserved
```

This is the build-pipeline instance of the project's dual-`finally` cleanup discipline (see the runtime queue and SSE docs in Related).

### 5. A late-hook guard is bypassable — same shape as a security-guard bypass

A `writeBundle` hook that only re-processes re-emitted chunks (or that a code-splitter may skip) *looks* like it enforces the invariant but is silently bypassed on the very path that needs it. That is the build-pipeline form of the security canon: a guard that appears to block something but is bypassable is worse than none, because it produces false confidence. Chain a must-run step through an orchestrator that runs it independent of upstream success — never reach it only via `&&` after a step whose failure is the case the step exists to handle.

### 6. Write the committed artifact atomically

The preflight only *precomputes* the notice content; the single write happens after a successful mutation, via a temp file staged inside the destination directory and renamed (the temp must share a filesystem with the target — a cross-device rename from the OS tmpdir fails with `EXDEV` on some CI mounts), with cleanup of the temp on failure:

```ts
const tmp = join(DIST_DIR, `.THIRD_PARTY_NOTICES_${Date.now()}.tmp`)  // same FS as target
try { await writeFile(tmp, content); await rename(tmp, target) }
catch (e) { await unlink(tmp).catch(() => {}); throw e }              // no leaked .tmp
```

### 7. Classify aggregation by blast radius: per-source soft, total-source hard

When the artifact aggregates from N sources, classify each by blast radius and keep the soft and hard paths at separate return points so a soft path can never swallow a hard one. The license collector pairs a fail-soft pnpm-licenses lookup (a per-dependency gap → `"Unknown"`, warn, continue) with a fail-closed total-collection call (throw with the underlying cause). The same shape recurs at smaller scale: a malformed version segment must not silently compare-equal and let a garbage entry latch over a real one (guard `NaN` in the comparator so a real version always wins).

## Why This Matters

The sharpest, repo-agnostic formulation: **if your cleanup depends on a later failure to be useful, it cannot share a lifecycle with the step whose failure makes it useful.** Coupling them means the failure you guard against is exactly the one that skips the guard.

The same lifecycle shape — fallible generation → destructive mutation → must-run cleanup, over a committed/persisted artifact — appears far outside the dist/license domain: container sign-then-scan, OpenAPI/protobuf codegen-then-format, lockfile-then-SBOM, wasm-opt-then-size-check, any compile-then-sign-then-commit. Partial-environment rebuild paths (Renovate, Dependabot, codegen bots) are the highest-risk surface because they re-run only a subset of the pipeline.

## When to Apply

- A committed generated artifact is gated by a CI dist-diff / rebuild check.
- A fail-closed check and a must-run cleanup currently share a bundler hook or a single `&&` chain.
- A pipeline step's failure is precisely the case a later step exists to handle.
- The artifact is rebuilt on a partial-environment branch (Renovate `postUpgradeTasks`, codegen bot) that may lack a fully-prepared toolchain.

## Examples

**Before** — fail-closed collection + escape both inside `writeBundle`, escape reachable only via `&&`:

```ts
// tsdown.config.ts
plugins: [licenseCollectorPlugin() /* throws in writeBundle */, escapeHiddenUnicodePlugin(), ...]
// package.json
"build": "... && tsdown ... && bun run dist:escape-hidden-unicode"  // escape skipped if tsdown throws
```

A Renovate build where license collection fails: tsdown's `writeBundle` throws after emitting `dist/`, the `&&` short-circuits, the escape never runs, and the notice is dropped.

**After** — preflight before the mutator, escape in the orchestrator's finally, atomic notice:

```ts
// tsdown.config.ts  — no fallible work in a hook
plugins: [defaultVersionInvariantPlugin()]
// apps/action/package.json
"build": "node --experimental-strip-types ../../scripts/build-action-dist.ts"
```

A Renovate build where license collection fails: the preflight throws before tsdown runs, the build exits non-zero, and the committed `dist/` (and its notice) is never touched. A build where *tsdown* fails: the escape still runs over the emitted partial `dist/`, and the real bundle exit code is preserved.

## Related

- [Escape committed dist/ artifacts independently of the bundler lifecycle](durable-dist-hidden-unicode-fix-2026-06-22.md) — the sibling "build command, not bundler hook" lesson (the *where*); this doc is the lifecycle-ordering refinement (the *when*).
- [Committed-bundle attribution and SBOM hygiene](committed-dist-attribution-and-sbom-hygiene-2026-06-21.md) — the fail-closed attribution policy (Rule 3); this doc places that policy as a preflight, not a late hook.
- [Cross-libc build and release safety](../best-practices/cross-libc-build-and-release-safety-2026-06-14.md) — the project's fail-closed canon ("abort on anomaly, no fallback"); this is its build-pipeline application.
- [Atomic serial channel queue handoff](../best-practices/atomic-serial-channel-queue-handoff-2026-06-09.md) and [Authenticated SSE run observation](../best-practices/authenticated-sse-run-observation-2026-06-20.md) — the runtime dual-`finally` cleanup canon this borrows for the build's finally slot.
- [Compose topology egress guard hardening](../best-practices/compose-topology-egress-guard-hardening-2026-06-14.md) — the "a bypassable guard is worse than none" canon; a late-hook fail-closed check is its build-pipeline variant.
- [Gateway Docker runtime-resolution crash-loop](../build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md) — the "build-time invariant + CI self-check" template this refines with lifecycle placement.
- [Migrating a pnpm workspace to Bun](migrate-pnpm-to-bun-monorepo-2026-06-24.md) — the pnpm→Bun migration that kept this preflight→mutator→finally lifecycle unchanged while replacing the package manager.
- Source: PR #991.
