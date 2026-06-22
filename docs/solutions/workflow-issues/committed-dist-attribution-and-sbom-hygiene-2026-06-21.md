---
title: 'Committed-bundle attribution and SBOM hygiene'
date: 2026-06-21
last_updated: 2026-06-22
problem_type: workflow_issue
component: tooling
severity: medium
applies_when:
  - 'A GitHub Action (or any tool) commits its bundled dist/ directory and redistributes third-party dependencies'
  - 'A generated license-notice file is perpetually untracked or oscillates in and out of the tree'
  - 'CI has a branch-specific carve-out that exempts a generated file from the dist-sync check'
  - 'You need both committed legal attribution and a machine-readable SBOM'
tags:
  - sbom
  - license-notices
  - dist
  - renovate
  - github-actions
  - fail-closed
---

# Committed-bundle attribution and SBOM hygiene

## Context

A GitHub Action whose bundled `dist/` is committed and CI-verified-in-sync redistributes its ~214 production dependencies. The build emitted an 800KB concatenation of their license texts (`dist/licenses.txt`) on every run, but the file sat in half-tracked limbo: the release pipeline committed it, Renovate dependency-bump commits deleted it, the CI dist-diff check excluded it for `renovate/*` branches (a carve-out band-aid), and `.gitignore` never covered it. The result was a generated file that was neither reliably tracked nor ignored — it perpetually showed as `??` untracked and was a recurring source of developer friction.

The underlying driver is legal, not cosmetic: a committed bundle **is** a redistribution of the bundled dependencies, and MIT/BSD/Apache licenses require preserving their copyright/notice text on redistribution. A machine-readable SBOM does not substitute for that notice, and a release-only artifact is too weak because an Action is consumed by tag/SHA from the repo, not by downloading release assets.

## Guidance

### 1. If the bundle is committed, the attribution matching it is committed too

Name the file for what it legally is (`dist/THIRD_PARTY_NOTICES.txt`), commit it tracked, and verify it under the **same** dist-sync invariant as the rest of the bundle. Do not exempt it with a CI carve-out — bringing it under the gate is the whole point.

```yaml
# .github/workflows/ci.yaml — the dist-sync gate, now unconditional (no renovate carve-out)
- name: Compare the expected and actual dist/ directories
  run: |
    if [ "$(git diff --ignore-space-at-eol dist/ | wc -l)" -gt "0" ]; then
      echo "Detected uncommitted changes after build."
      git diff --text dist/
      exit 1
    fi
```

### 2. Generate the notice deterministically — the dist-diff gate is then the reproducibility proof

Stable sort + normalized line endings make the committed file byte-reproducible, so the existing dist-sync gate self-checks it. No separate "did the notice drift" test is needed.

```ts
// tsdown.config.ts — pure, exported for unit testing
export function formatThirdPartyNotices(entries: ReadonlyMap<string, LicenseEntry>): string {
  return Array.from(entries.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, {version, license, content}]) => `${name}@${version}\n${license}\n${content}`)
    .join('\n\n')
    .replaceAll('\r\n', '\n')
}
```

### 3. Fail closed on a *total* collection failure — but not on benign per-dependency gaps

A generation failure must fail the build rather than silently write nothing (the old fail-soft `catch { warn; return }` was the latent bug). The distinction matters: a single dependency with no resolvable license text is handled inside the collector and does **not** reach this catch, so per-dependency gaps stay non-fatal.

```ts
// Fail closed: a total failure means the notice would be incomplete; throw rather than write nothing.
try {
  licenses = await getProjectLicenses('./package.json')
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)
  throw new Error(`[license-collector] license collection failed; cannot produce THIRD_PARTY_NOTICES.txt: ${reason}`)
}
```

### 4. Fix the file model, don't exempt the file

The carve-out existed to paper over a fail-soft generator interacting with an untracked base state. The right fix is to make generation reliable (deterministic + fail-closed) and track the file — then remove the exception. This is the same meta-rule as [removing a duplicate version source rather than adding a drift-detection test](harness-base-version-source-of-truth-2026-06-12.md): delete the thing that can drift, don't add a check that asserts it didn't.

### 5. Know your Renovate mechanics: `ignorePaths` is scan-only, not a commit filter

Removing the CI carve-out is only safe because Renovate already regenerates the file. `ignorePaths: ['dist/**']` excludes `dist/` from Renovate's *dependency extraction* (so it won't open update PRs for vendored code) — it does **not** stop Renovate from committing rebuilt `dist/`, and it does **not** suppress Renovate's hidden-Unicode safety scan, which runs on the same files independently. `postUpgradeTasks` runs the build on every dependency PR:

```json5
// .github/renovate.json5
ignorePaths: ['dist/**'],          // scan exclusion only (extraction, not the safety scan)
postUpgradeTasks: {
  commands: ['pnpm install', 'pnpm run fix', 'pnpm run build'],  // regenerates + commits dist on dep PRs
  executionMode: 'branch',
}
```

These three commands are the ones `bfra-me/renovate-action` allowlists for `postUpgradeTasks`; a bespoke command outside the allowlist is silently dropped, so any dist transform must ride inside an allowlisted command (e.g. as the final step of `build`). So dependency PRs regenerate the notice deterministically and the unconditional dist-diff gate verifies it — no exception required. The same allowlist constraint, and why committed-dist transforms must live in `build` rather than only a bundler hook, is covered in [Escape committed dist/ artifacts independently of the bundler lifecycle](durable-dist-hidden-unicode-fix-2026-06-22.md).

### 6. SBOM is a separate lane from the NOTICE — ship it as a non-blocking CI artifact

The human-readable legal notice and the machine-readable SBOM serve different consumers. Generate the SBOM with native tooling (`pnpm sbom`, CycloneDX), upload it as a CI artifact, and keep it **non-blocking** — it is informational, not a build gate, and a generation failure must not fail the build.

```yaml
- name: Generate the dependency SBOM
  id: sbom
  continue-on-error: true
  run: pnpm sbom --sbom-format cyclonedx --prod > sbom.cdx.json
- uses: actions/upload-artifact@...
  if: ${{ steps.sbom.outcome == 'success' }}   # gate on the step, not file existence — a shell redirect creates the file even on failure
  with:
    name: sbom-cyclonedx
    path: sbom.cdx.json
```

### 7. Probe empirically before assuming a root cause

The initial assumption was non-determinism, but two consecutive clean builds produced byte-identical output — the file was already deterministic. The real defect was process (the file was never landed in the tracked tree, and CI exempted it). Separately, a high-confidence reviewer finding ("`parsePackageName` collapses all scoped packages, dropping their attribution") was a **false positive**: checking the actual committed file showed 103 distinct scoped entries with zero collision (`.find(Boolean)` skips the leading empty string from the leading `@`). Verify load-bearing claims — both your own root-cause hypothesis and high-confidence review findings — against the real artifact before acting.

## Why This Matters

| Rule | Failure it prevents |
|------|---------------------|
| Committed bundle ⇒ committed notice | Perpetual untracked-file churn; legal under-attribution for a redistributed bundle |
| Deterministic generation | Flaky builds / dist-diff thrash from non-reproducible output |
| Fail closed on total failure only | A silent empty notice (fail-soft) shipping with no attribution; or an over-eager hard-fail on a benign per-dep gap |
| Fix the file model, don't exempt it | A carve-out that lets the exempted file rot indefinitely |
| `ignorePaths` is scan-only | Wrongly assuming Renovate won't commit dist, and either keeping an unnecessary carve-out or breaking dep PRs |
| SBOM as non-blocking artifact | A broken SBOM run failing the build, or a redirect-created empty SBOM being uploaded |
| Probe before assuming | Building the wrong fix (e.g. determinism machinery the file didn't need); acting on a false-positive review finding |

## When to Apply

Any project that commits a bundled or vendored `dist/` and redistributes third-party dependencies — GitHub Actions especially, where consumers pull by tag/SHA. Also when deciding an SBOM/license-attribution strategy: the modern split is a committed human-readable notice plus a CI-generated machine-readable SBOM artifact.

## Examples

**Carve-out removal** — before, the dist-diff check exempted the notice for Renovate branches (`DIFF_TARGETS="dist/ ':!dist/licenses.txt'"`); after, it checks all of `dist/` unconditionally (Rule 1 snippet). The eval/pathspec indirection that only existed to inject the exclusion was deleted with it.

**Fail-closed generation** — before, `catch { console.warn(...); return }` (silently wrote nothing on failure); after, the catch throws and fails the build (Rule 3 snippet).

**Deterministic helper** — the sort + EOL-normalization pure function (Rule 2 snippet) makes the committed file byte-reproducible so the dist-diff gate is the determinism proof.

## See also

- [harness-base-version-source-of-truth](harness-base-version-source-of-truth-2026-06-12.md) — the "remove the duplicate/exception, don't add a drift-detection test" meta-rule that justifies removing the carve-out (Rule 4).
- [cross-libc-build-and-release-safety](../best-practices/cross-libc-build-and-release-safety-2026-06-14.md) — the project's fail-closed canon ("abort on anomaly, no fallback"); Rule 3 applies it to license generation.
- [versioned-tool-config-plugin-pattern](../best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md) — Renovate customManager / config-source-of-truth discipline behind Rule 5.
- [gateway-docker-runtime-resolution-crash-loop](../build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md) — the sibling "build-time invariant in the bundler + CI self-check" pattern; the dist-diff-gate-as-proof here is the same discipline.
- [tool-binary-caching-ephemeral-runners](../build-errors/tool-binary-caching-ephemeral-runners.md) — the dist/ rebuild-verification convention this builds on.
- [durable-dist-hidden-unicode-fix](durable-dist-hidden-unicode-fix-2026-06-22.md) — the durability fix for the hidden-Unicode scan Rule 5 alludes to: escape `dist/` in `build` so the scanner is irrelevant, not load-bearing.

Source: PR #978 (no issue — arose from a maintainer question on why `dist/licenses.txt` was untracked and the modern SBOM/license approach). Files: `tsdown.config.ts`, `.github/workflows/ci.yaml`, `.github/renovate.json5`, `RULES.md`.
