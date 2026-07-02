---
module: "harness/release pipeline"
date: 2026-06-14
category: best-practices
problem_type: best_practice
component: tooling
severity: medium
tags:
  - github-actions
  - musl
  - cross-compilation
  - release-pipeline
  - harness
  - boolean-inputs
  - opencode
applies_when:
  - Building cross-libc binaries (musl vs glibc) that must be verified in CI
  - "Comparing GitHub Actions `if:` conditions against `type: boolean` inputs"
  - A release job auto-bumps the same version into more than one file
  - Downloading a binary from a release into a Dockerfile or CI step
---

# Cross-libc builds and release-pipeline safety

Reusable build/release/CI lessons from teaching the `@fro.bot/harness` pipeline to produce musl OpenCode binaries for the Alpine workspace executor (the action consumes glibc; the workspace needs musl). Most of these traps are not OpenCode-specific — they recur anywhere a pipeline cross-builds, cross-libcs, guards on workflow inputs, or auto-bumps a version into multiple files.

## Context

The harness build emitted glibc only. Adding musl/baseline Linux targets and repointing the Alpine workspace at them surfaced four distinct, reusable failure modes — three caught loud by guards during dry-runs before any PR, one a pre-existing release-safety bug the dry-runs exposed. Each is documented below as standalone guidance.

## 1. Compare boolean `workflow_dispatch` inputs to boolean literals, not strings

**Guidance.** A `workflow_dispatch`/`workflow_call` input declared `type: boolean` is a real boolean inside expressions. A boolean-vs-string `!=` coerces **numerically**: boolean `true` → `1`, string `'true'` → `NaN`, and `1 != NaN` is `true` **always**. So a guard like `if: inputs.dry_run != 'true'` never blocks anything — it is a silent no-op. Compare boolean inputs against the boolean literal: `inputs.dry_run != true`. Step/job **outputs** are always strings (emitted via `echo >> $GITHUB_OUTPUT`) — compare *those* to `'true'`/`'false'`. The rule: read the producer's type before writing the consumer's comparison.

**Why it matters.** A wrong-type guard misfires in exactly the wrong direction with no log, warning, or review prompt. Here it let a `dry_run: true` release open a real version-bump PR pinning a release that was never published.

**When to apply.** Every `if:` on a job/step that depends on a `type: boolean` input. Review-checklist item: any `inputs.<name> != 'true'` where `<name>` is declared `type: boolean` is a bug.

```yaml
# Before — silently always-truthy (dry_run is type: boolean)
if: ${{ needs.publish.result == 'success' && inputs.dry_run != 'true' }}

# After — boolean literal. Tag-triggered runs have inputs.dry_run == null,
# which is also != true, so real releases still pass.
if: ${{ needs.publish.result == 'success' && inputs.dry_run != true }}
```

## 2. A cross-libc binary can be built on the wrong runner — but not executed

**Guidance.** A musl-target binary builds fine on a glibc Ubuntu runner, but **running** it (e.g. `opencode --version`) fails with `posix_spawn ENOENT` — there is no musl loader on a glibc host. Every post-build verification that *executes* the binary must split into two cases: same-libc targets execute and assert the version; cross-libc targets **skip execution** and verify by **inspection** — `file <binary>` must show `ELF`, the expected arch, and `statically linked` / `static-pie linked` / `musl`, and must **not** show a glibc dynamic linker (`ld-linux-*.so`). The negative assertion is the load-bearing one: a glibc binary published under a musl asset name runs on every CI runner (all glibc) and only explodes at the Alpine consumer — CI is structurally blind to it without the `file` check.

This trap recurs at **every** verification layer independently — in this work it hit the build wrapper's `--version` probe, a separate workflow verify step, and a regression smoke test. A guard in one place does not protect the others. Mirror upstream's own predicate (OpenCode's `build.ts` only smoke-tests `os === process.platform && arch === process.arch && !item.abi`).

**Why it matters.** `posix_spawn ENOENT` reads as a toolchain error and sends investigators the wrong way; the real cause is the ELF interpreter, visible only by inspection.

```typescript
// Negative assertion FIRST → specific, actionable error for a glibc binary.
for (const pattern of [/ld-linux-x86-64\.so/, /ld-linux-aarch64\.so/, /ld-linux\.so/, /interpreter \/lib.*ld-linux/]) {
  if (pattern.test(fileOutput)) {
    throw new Error(`Binary appears glibc-linked (${fileOutput}); a musl target was requested — the build did not select musl.`)
  }
}
if (!fileOutput.includes('statically linked') && !fileOutput.includes('static-pie linked') && !fileOutput.includes('musl')) {
  throw new Error(`Binary does not show musl linkage (${fileOutput}).`)
}

// And, at the execution layer, skip exec for cross-libc targets:
if (abi === 'musl') {
  // musl binaries cannot execute on a glibc runner (posix_spawn ENOENT).
  // Verify by existence + file-inspection instead; do not run --version.
  return
}
```

## 3. Patch an upstream build script at workflow time instead of carrying a fork

**Guidance.** Upstream OpenCode's `build.ts --single` filters to the current-platform glibc target and unconditionally skips `abi: musl` with no override flag. The bad workarounds: drop `--single` (builds the whole 12-target matrix), or carry a permanent fork (burns a carry slot, drifts every bump). Instead, apply an **ephemeral in-place patch** to the freshly-checked-out integration-tree `build.ts` before invoking it: (1) assert the exact pre-patch block is present and **abort loud** if not (upstream shape drifted); (2) replace it with an env-var-driven selector that preserves original behavior verbatim when the env var is unset and, when set, drives the *entire* selection (so a request for one target cannot also build the default glibc target); (3) after writing, assert a hook marker is present — a `String.replace` that matches nothing is a silent no-op, and the marker is what makes it loud. The patch lives in the source tree, reapplies on every clone, and fails closed when upstream changes.

**Why it matters.** "Patch and proceed regardless" is worse than no patch: it produces a glibc binary under a musl asset name, which only the §2 file-inspection catches. Fail-loud assertions on both sides (patch landed, binary is musl) are what keep the ephemeral patch trustworthy.

## 4. Coupled multi-file version bumps need a dual-source idempotency guard

**Guidance.** When a release job auto-bumps the same version into N>1 files (here: the action's `DEFAULT_OPENCODE_VERSION` and the workspace Dockerfile `ARG OPENCODE_VERSION`), the idempotency `skip` must check **all N** files — skip only when *every* coupled file already equals the new value. A one-file check is a one-way data-loss ratchet: the first time file A bumps but file B's step fails (with `continue-on-error: true`), every later run sees A current → skips → B is frozen at the old version forever, with no signal. Also give each file-update step an `id:` and gate PR-open on **all** their outcomes, so a half-bumped diff is never opened. Keep each replacement a precise literal match that fails loud on a no-op match.

**Why it matters.** `continue-on-error: true` (correct for "the release already shipped") removes the safety net that would otherwise stop partial state — the dual-source idempotency *is* the replacement net. Retrying the job does not help: retries hit the same skip branch.

```yaml
# Skip only if BOTH files already equal NEW_VERSION.
if [ "${CURRENT_CONSTANTS}" = "${NEW_VERSION}" ] && [ "${CURRENT_DOCKERFILE}" = "${NEW_VERSION}" ]; then
  echo "skip=true" >> "$GITHUB_OUTPUT"
fi
# ...each update step gets `id:`; PR-open gates on all of them:
# if: steps.version.outputs.skip != 'true' && steps.build.outcome == 'success' && steps.dockerfile.outcome == 'success'
```

## 5. Fail-closed binary download in a Dockerfile (supporting)

**Guidance.** Downloading a binary from a release into a Dockerfile is a small set of deliberate choices in service of one rule — **on any anomaly, abort with no fallback**: validate the version against a strict allowlist before interpolating it into a URL; use a fixed asset-name allowlist (branch on `${TARGETARCH}`, never interpolate the version into the name); URL-encode SemVer build metadata (`${VAR//+/%2B}` — GitHub reads a raw `+` as a space); `curl --retry` for transient blips while `-f` keeps a persistent 404 fatal; verify the checksum by **exact field match** (`awk '$2 == f {print $1}'`, not a regex that a substring can satisfy); `set -euo pipefail`; and prove the binary runs (`opencode --version`) so a corrupt-but-extracted binary fails at build, not in production. No "fall back to cached", no "fall back to stock", no "warn and continue".

**Why it matters.** A supply-chain gate with a fallback is not a gate — the fallback becomes the gate and the fallback does not verify. Every layer above (§2, §4) assumes the asset at the URL *is* the asset.

## When to apply

- Any build matrix mixing glibc and musl targets, or a static binary built to run on a different libc than the builder.
- Any GitHub Actions guard on a `type: boolean` input.
- Any release job that writes the same version to more than one file.
- Any Dockerfile/CI step that downloads a binary from a release.

## Why this matters (cross-cutting)

The four layers reinforce each other: the fail-closed download (§5) assumes the asset is the asset; the dual-source bump (§4) assumes the bumped file matches the asset; the musl verification (§2) assumes the asset is the expected libc; the patch guard (§3) assumes the asset was built against the requested target. Drop any one and the others work in the dark. Note also that `fail-fast: false` on the matrix is required so the all-or-nothing existence/libc/dual-source gates can evaluate against *all* artifacts.

## Related

- `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md` — direct predecessor on version-source drift. Its "Renovate tracks the consumed source" rule still holds generally, but the workspace `OPENCODE_VERSION` pin specifically moved *off* Renovate (build-metadata `+harness.<sha>` tags can't be ordered) onto the release-job coupled bump described in §4.
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — sibling image-only packaging gap; same "verify by inspection, not host-checkout execution" pattern.
- `docs/solutions/best-practices/workspace-executor-opencode-provisioning-best-practices-2026-06-01.md` — the workspace Dockerfile surface these changes modify.
- `docs/solutions/performance-issues/tool-binary-caching-ephemeral-runners.md` — verify the tools cache key includes the full `+harness.<sha>` literal so two harness builds of the same base don't collide.
- PRs #887 (musl build/publish), #889 (workspace repoint + coupled bump), #874 (harness GitHub Release + boolean-gate fix).
