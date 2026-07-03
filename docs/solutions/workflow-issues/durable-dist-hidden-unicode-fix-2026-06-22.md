---
title: Escape committed dist/ artifacts independently of the bundler lifecycle
date: 2026-06-22
category: workflow-issues
module: scripts/
problem_type: workflow_issue
component: tooling
severity: low
last_updated: 2026-06-24
applies_when:
  - "A committed generated artifact (dist/, build/, codegen) must satisfy an external scanner that runs on the same files"
  - "The bundler's writeBundle hook is the only stage that escapes a known character set in the bundle"
  - "The external tool (Renovate, pre-commit, CI runner) allowlists the commands it will run on its own branches"
  - "A scanner's ignore/exclude knob is documented but does not actually suppress the warning"
  - "A committed bundle is regenerated on a path that does not re-run the full local build pipeline"
tags:
  - renovate
  - hidden-unicode
  - dist-bundle
  - build-pipeline
  - post-upgrade
  - tsdown
  - escape
  - allowlist
---

# Escape committed dist/ artifacts independently of the bundler lifecycle

## Context

The GitHub Action runtime requires a committed `dist/` bundle, and CI enforces a "rebuild and `git diff dist/` must be empty" gate. Renovate's Dependency Dashboard kept surfacing **"hidden Unicode characters discovered in file(s)"** through three successive fix attempts:

- **PR #554** — `ignorePaths: ['dist/**']`. Failed: `ignorePaths` excludes `dist/` from dependency *extraction*, but the hidden-Unicode safety scan runs independently and still fires.
- **PR #571** — a tsdown (rolldown) `escapeHiddenUnicodePlugin` `writeBundle` hook escaping hidden chars to `\uXXXX`. Failed: the hook only re-processes chunks the bundler re-emits.
- **PR #654** — widen the plugin to all text files + disable sourcemaps. Failed for the same lifecycle reason on a different surface.

The real mechanism: **Renovate scans its own update branches, not just `main`.** `main`'s `dist/` was correctly escaped; only a Renovate branch's rebuilt `dist/artifact-*.js` carried raw bytes — and that branch had also *dropped* `dist/THIRD_PARTY_NOTICES.txt`. The dropped notices file was the smoking gun: the committed `dist/` on that branch was **not produced by the current plugin chain**. A bundler `writeBundle` hook only reliably escapes what the bundler re-emits in that run, so a stale code-split chunk a Renovate rebuild never re-touched kept its raw characters.

PR #988 fixed it by moving the guarantee out of the bundler and into the `build` command itself.

## Guidance

### 1. Put a dist-tree invariant in the command every consumer runs, not in the bundler hook

A `writeBundle` hook is invisible to any path that commits `dist/` without re-emitting every chunk — Renovate update branches, partial caches, hand-edits. Wire the transform into `bun run build` so local dev, the CI Build job, and Renovate's `postUpgradeTasks` all apply it:

```json
// package.json — the scrub is the FINAL step of build
"build": "bun run --filter @fro-bot/runtime build && bun run --filter @fro-bot/action build && bun run --filter @fro.bot/harness build && bun run dist:escape-hidden-unicode"
```

A `bun run build` that exits zero is, by construction, free of the flagged codepoints.

### 2. `ignorePaths` is extraction-only — fix the artifact, not the scanner config

Renovate's `ignorePaths: ['dist/**']` stops dependency extraction from the bundle; it does **not** suppress the hidden-Unicode scan. Keep it for its real job, but don't expect it to silence the warning — make the committed artifact clean instead.

### 3. Tool allowlists match command *strings*, not what a command chains

`bfra-me/renovate-action` only accepts `postUpgradeTasks` commands from a fixed allowlist (`bootstrap`, `build`, `build-release`, `check`, `clean`, `fix`, `format`, `generate`, `lint`, `typecheck`, `update-snapshots`). A bespoke `pnpm run dist:escape-hidden-unicode` entry is rejected. The workaround: append the transform to an allowlisted command's shell chain — the allowlist sees `pnpm run build`, not what `build` internally runs.

```json5
// .github/renovate.json5 — only allowlisted commands; build does the scrubbing
postUpgradeTasks: {
  commands: ['bun install', 'bun run fix', 'bun run build'],
  executionMode: 'branch',
}
```

### 4. Recursive tree walk, not an extension allowlist, for "no X anywhere under dist/"

The old plugin's non-recursive `readdir` missed code-split chunks in subdirectories. Walk the whole tree:

```ts
// scripts/dist-hidden-unicode.ts
const entries = await readdir(dir, {recursive: true, withFileTypes: true})
```

`withFileTypes: true` also avoids the stat→read TOCTOU that CodeQL flags.

### 5. One source of truth for the shared regex/binary-set

The regex and binary-extension set were duplicated in the bundler plugin and the script, and had already drifted — the script wrongly listed `'map'`, but `.map` files are JSON text that should be checked, not skipped. Extract them into one module the plugin imports:

```ts
// tsdown.config.ts — plugin imports, no longer redefines
import {BINARY_EXTENSIONS, HIDDEN_UNICODE_REPLACE_RE, HIDDEN_UNICODE_TEST_RE} from './scripts/dist-hidden-unicode.ts'
```

If the same regex/set/constant lives in two places, it will drift. The drift here was caught by extraction, not by a test.

### 6. A shared `/g` regex under `Promise.all` silently skips matches

A `/g`-flagged `RegExp` is stateful (`lastIndex` mutates per `.exec`/`.replace`). Reusing one across concurrent files makes later iterations resume mid-string and skip matches. Share the stateless test regex; construct a fresh `/g` regex per file:

```ts
const re = new RegExp(HIDDEN_UNICODE_REPLACE_RE.source, 'g') // fresh per file
const fixed = content.replaceAll(re, escapeChar) // escapeChar: char => `\\u${hex}`
```

### 7. Lean on idempotency; document the deliberate exclusions

`char → \uXXXX` is the identical codepoint to the JS engine, and an already-escaped sequence is a no-op, so re-running across CI/Renovate/local is safe. **U+200D (ZWJ) is deliberately excluded** — it appears legitimately in emoji sequences and is not in Renovate's set. A comment encodes that judgment so a future edit doesn't "widen the range to fix the gap."

### 8. Verify at the right layer; the checker fails closed

`build` escapes; `lint` and the CI Build job *check* and exit non-zero on any violation, turning a recurring dashboard warning into a direct CI failure with a one-line remediation:

```yaml
# .github/workflows/ci.yaml — Build job
- name: Rebuild the dist/ directory
  run: bun run build
- name: Check dist/ for hidden Unicode characters
  run: bun run dist:check-hidden-unicode
```

### 9. Reference the real config; trigger scripts tests on script changes

The action build pointed at a nonexistent `apps/action/tsdown.config.ts` and silently fell back to the root config — point it at the real one. And add `scripts/**` to the `should-build` CI paths filter (it was only in `should-lint`) so a scripts-only change runs the tests that pin the regex to Renovate's codepoint list.

## Why This Matters

- **Invariants belong at the layer every consumer runs.** A bundler-hook fix is bypassed by Renovate, partial caches, and hand-edits. Wire it into the command and there is no bypass.
- **External "ignore" knobs have narrow scope.** Read the doc; if the knob doesn't cover your case, fix the artifact.
- **Tool allowlists are string-matched.** When you can't add a command, extend an allowlisted one's chain.
- **Stateful regexes are concurrency footguns.** `Promise.all` + shared `/g` = silent, invisible data loss.
- **One source of truth beats N drifting copies** — and the drift is rarely caught by a test.

## When to Apply

- A committed generated artifact is flagged by an external scanner that runs on the same files.
- A "make it go away" config knob (`ignorePaths`, scanner excludes) was tried and didn't suppress the warning.
- A CI/automation tool allowlists the commands it runs on its branches.
- A bundler emits output (sourcemaps, license bundles, runtime data, worker chunks) the build's own plugins don't fully control.
- The same regex/set/constant is duplicated across more than one file.

## Related

- [Committed-bundle attribution and SBOM hygiene](committed-dist-attribution-and-sbom-hygiene-2026-06-21.md) — sibling fix on the same `dist/` surface; its Rule 5 (`ignorePaths` is scan-only) is the prerequisite mechanic this builds on.
- [Harness base-version source of truth](harness-base-version-source-of-truth-2026-06-12.md) — the "delete the source of drift, don't add a detection test" meta-rule behind the single-source-of-truth dedup.
- [Gateway Docker runtime-resolution crash-loop](../build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md) — the "build-time invariant + CI self-check" template this refines with the bundler-lifecycle caveat.
- [Build pipelines — fallible work is a preflight, cleanup is a finally](build-pipeline-fallible-preflight-and-finally-cleanup-2026-06-22.md) — the lifecycle-ordering refinement: *where in the build command* fail-closed work and cleanup run (preflight before the bundler, escape in a finally after it), not just that they run in `build`.
- [Migrating a pnpm workspace to Bun](migrate-pnpm-to-bun-monorepo-2026-06-24.md) — the pnpm→Bun migration that replaced the `pnpm run build` / `pnpm install` tokens in the Renovate allowlist and the build command chain with their Bun equivalents.
- Failed-attempt trail: PR #554 (ignorePaths), PR #571 (escape plugin), PR #654 (widen to text files); PR #988 is the durable fix.
