---
date: 2026-06-02
topic: fro-bot-harness-patched-opencode
status: ready-for-planning
---

# @fro.bot/harness — Patched OpenCode Build + Forwarding CLI

## Summary

A new published package `@fro.bot/harness` that ships a **deterministically patched build of upstream OpenCode** behind a thin forwarding CLI (`harness <args>` → patched `opencode <args>`), distributed as native per-platform binaries the way OpenCode itself is packaged. It gets the Fro Bot agent **back onto a recent, deliberately-pinned OpenCode release** (1.15.13+) while giving us durable, reproducible control over a small set of non-mainline patches. The **action** consumes the prebuilt patched binary in v1; the **gateway** follows as a fast-follow (R16).

---

## Problem Frame

Fro Bot is pinned to OpenCode **1.14.41** because 1.14.42+ regressed `/event` SSE SyncEvent delivery and broke visible tool-call output. That pin has held for weeks: every upstream improvement since (startup perf, PermissionV2, SSE-hydration fixes, plugin reliability) is unreachable, and the gap widens with every release. The pin is also brittle — it is a bare version constant in two places (action setup, gateway Dockerfile) with no validation layer between "upstream cut a release" and "our agent runs it."

Separately, several behaviors we want or have wanted from OpenCode live in PRs that are **closed (upstream-rejected) or open/stalled** — they will never arrive in a stock release. Today we have no mechanism to carry such changes; we either fork mentally and re-discover the gap each time, or do without.

The cost shape is twofold: **staleness risk** (stranded on an old release, manually re-validating any bump from scratch) and **no carry path** (no reproducible way to apply changes upstream won't take). Both compound every time OpenCode releases.

---

## Actors

- A1. **harness CI**: Clones upstream OpenCode at the pinned ref, applies the patch set deterministically, compiles native per-platform binaries, runs verification (incl. the streaming spike), publishes the package set, and runs the scheduled upgrade-check.
- A2. **Action setup step** (`src/services/setup/`): Installs/obtains the patched harness binary instead of stock `opencode` and invokes it via the harness CLI.
- A3. **Gateway / workspace image** (`deploy/*.Dockerfile`): Obtains the same patched binary at image-build time (phase 2 — fast follow).
- A4. **Upstream `anomalyco/opencode`**: The MIT-licensed base we track, patch onto, and monitor for new releases.
- A5. **Maintainer (Marcus)**: Reviews and merges deliberate version bumps and patch-set changes; the upgrade-check never auto-merges.

---

## Key Flows

- F1. **Build a patched release**
  - **Trigger:** A pinned-version change lands on harness `main`, or a release is cut.
  - **Actors:** A1, A4
  - **Steps:** Clone opencode@`<pinned>` → apply patch set (fail hard on any patch that doesn't apply clean) → compile each native binary **on its own platform-native runner** (per-OS/arch matrix — the model OpenCode itself uses in `publish.yml`; not cross-compiled from one job) → assemble artifacts → run verification (version assertion + streaming/tool-output spike on linux x64) → publish the main package + per-platform `optionalDependencies` with provenance + integrity attestation (base version + patch list + build sha).
  - **Outcome:** A reproducible set of native patched binaries is published under `@fro.bot/harness`, each tagged with exactly which base + patches produced it.
  - **Covered by:** R4, R5, R6, R7, R8, R9, R12, R19

- F2. **Consume the patched binary (action)**
  - **Trigger:** An action run reaches the setup phase.
  - **Actors:** A2
  - **Steps:** Setup obtains the pinned `@fro.bot/harness` binary (cache-first, same accelerator pattern as today) → invokes `harness serve` → SDK talks HTTP to it exactly as it does to stock opencode today.
  - **Outcome:** The agent runs on the patched OpenCode with no change to SDK/event-stream code.
  - **Covered by:** R9, R10

- F3. **Deliberate upgrade-check**
  - **Trigger:** Scheduled CI detects a new upstream OpenCode release.
  - **Actors:** A1, A5
  - **Steps:** Re-apply the patch set onto the new base → build → run the streaming spike + verification → **only if all green**, open a PR bumping the pinned version → maintainer reviews and merges.
  - **Outcome:** Staying current becomes a reviewable, automated signal; a failing patch/spike blocks the bump instead of breaking production.
  - **Covered by:** R13, R14

---

## Requirements

**Package & CLI**
- R1. Add a new package named **`@fro.bot/harness`** (published scope — dot, matching `@fro.bot/systematic`; distinct from the internal hyphen-scoped `@fro-bot/runtime` / `@fro-bot/gateway` workspace packages) developed under `packages/harness/`, ESM-only / Node 24, consistent with existing workspace conventions (tsdown build, colocated vitest, AGENTS.md).
- R2. Expose a `harness` binary that **passes through** arbitrary OpenCode commands/args/stdio/env (`harness serve`, `harness run`, etc.) to the patched `opencode` with zero per-command maintenance, so it is a drop-in replacement.
- R3. Provide harness-specific commands beyond passthrough: `harness doctor` (verify the patched binary is present, runnable, and reports the expected base+patch provenance), `harness patches` (list the applied patches), and version/info reporting (`harness --version` / `harness info` → base OpenCode version + applied patch set + build sha).
- R18. `@fro.bot/harness` is **published to the public npm registry** and runnable with **zero prior local setup** via `bunx @fro.bot/harness <command>` (mirrors `bunx @cortexkit/orw`). Running it fetches the package and obtains/invokes the correct patched binary for the host; inspection commands (`info`, `patches`, `doctor`) work without a server. This is the local dogfooding + operator install path, not only a CI-internal artifact.

**Patch pipeline (deterministic)**
- R4. Patches are applied **deterministically** via git-native tooling (cherry-pick / `git am` / a versioned `patches/` dir) — **never** by an LLM-driven merge at build time. The applied result must be byte-reproducible from `(base ref, patch set)`.
- R5. If any patch fails to apply cleanly against the pinned base, the build **fails hard** with a clear report of which patch conflicted — no silent skips, no partial application.
- R6. The patch set is **streaming-gated minimal**: carry only patches that deliver value not available in the pinned mainline release. Mainline-merged changes are obtained for free by riding latest, not re-carried as patches.
- R7. Each patch in the set is recorded with provenance: upstream PR/source, why it is carried (and whether upstream rejected it → indefinite-ownership flag), so the maintenance cost of each patch is explicit and auditable.

**Build & distribution**
- R8. Each platform's patched OpenCode is compiled to a **native standalone binary** (the `bun build --compile` model OpenCode itself uses) at publish time, **each on its own platform-native CI runner** (a per-OS/arch matrix — verified against upstream `publish.yml`, which builds darwin on `macos-*` hosts and linux on `ubuntu` hosts; bun does not cross-compile these from a single runner). No bun/node runtime or compile toolchain is required at install/run time on the consumer.
- R9. Distribution **mirrors OpenCode's own npm packaging** (verified against `script/publish.ts`): a main `@fro.bot/harness` package declares per-platform packages as **`optionalDependencies`** (`@fro.bot/harness-linux-x64`, `-linux-arm64`, `-darwin-x64`, `-darwin-arm64`), each containing only that platform's native binary; the main package ships a `bin` shim + `postinstall` resolver that selects and execs the host's binary. npm/bun installs only the matching platform package. `bunx @fro.bot/harness <cmd>`, the action setup, and the gateway Dockerfile all consume this same package set via the harness CLI.
- R10. The published artifact carries verifiable provenance (base OpenCode version, applied patch list, build sha) retrievable via the harness CLI and at the artifact level.
- R19. The build matrix **mirrors OpenCode's platform set**: at minimum **linux (x64 + arm64)** and **darwin (x64 + arm64)**. linux x64 serves CI (the action); linux serves the gateway Docker image (multi-arch); darwin arm64 gives full local `harness serve` parity on the maintainer's Apple-Silicon machine. Every platform is built and published per bump; the streaming spike + verification run on linux x64 (the production-critical target) at minimum.

**Security & supply-chain**
- R20. Published packages carry **npm provenance attestation** (signed build provenance), and consumers **verify integrity before exec** (lockfile integrity hash / signed checksum). The `postinstall` resolver must only resolve a pre-verified, integrity-checked binary — never fetch-and-exec arbitrary code. In credentialed contexts (action CI, gateway) the binary is verified **before** any secrets/tokens are loaded.
- R21. **Publish authority is fenced**: only a protected CI workflow on a trusted ref may publish `@fro.bot/harness*`, using a narrowly-scoped npm automation token; publishing is gated by the same maintainer-review boundary as bump PRs (never auto-published).
- R22. Each carried patch is **pinned by immutable upstream commit SHA + patch-file content hash**; the build fails if fetched patch content differs from the reviewed digest (a PR number alone is not a sufficient pin — PR content can change).
- R23. The consumer version pin is **integrity-enforced** (lockfile/integrity); unexpected version or content drift is rejected at install and reported by `harness doctor`.
- R24. **MIT attribution is preserved** in the published package (LICENSE + attribution to upstream OpenCode) as required for redistributing modified MIT code.
- R25. **Publish is all-or-nothing across the platform matrix**: a partial publish (some platforms missing) must not leave consumers resolving a half-published version; behavior on an unsupported/unbuilt platform is a clear error, and a non-`postinstall` install path is documented for locked-down/airgapped runners.

**Version & bump model**
- R11. `@fro.bot/harness` pins an **exact, validated** upstream OpenCode version. "Latest" means "a recent upstream release we deliberately validated and pinned," never auto-tracked dev.
- R12. v1 targets OpenCode **1.15.13 or the latest validated release** as the initial pinned base.
- R13. A **scheduled CI job** detects new upstream OpenCode releases, re-applies the patch set + runs the streaming spike + verification against the new base, and opens a **bump PR only when all checks pass**.
- R14. The bump PR is **never auto-merged** into action/gateway; a maintainer reviews and merges. A failing patch-apply or streaming spike blocks the bump.

**Consumer integration (phased)**
- R15. v1 ships the harness package + build/patch pipeline **and cuts the action over** to consume the patched binary via the harness CLI (high-frequency surface, easy version-pin rollback = best validation).
- R16. Gateway + workspace-image cutover is a **fast follow-up** after the action validates the patched binary in production — not in v1.
- R17. Consumer cutover must **verify** SDK/event-stream compatibility against the patched base — not assume it. A compatibility check runs the existing consumer against the patched binary and asserts the exact event types/shapes it depends on (the streaming spike checks tool-output visibility; this check additionally covers the event/permission lifecycle the consumer relies on, e.g. PermissionV2-era shapes vs 1.14.41). If the event contract changed, an adapter change is budgeted rather than claiming zero code change. The existing cache-accelerator install pattern is preserved.
- R26. **Patch-conflict workflow is explicit**: when a patch fails to apply on a new base, the scheduled upgrade-check opens a **maintenance issue** (not a silent red build and not a bump PR); each carried patch has a stated per-bump revalidation owner, and the patch set has a documented threshold for dropping/upstreaming a patch rather than carrying it indefinitely.

---

## Acceptance Examples

- AE1. **Covers R5.** Given a pinned base and a patch that no longer applies cleanly, when harness CI builds, the build fails and names the conflicting patch — it does not publish a partially-patched artifact.
- AE2. **Covers R6, R12.** Given v1 pins 1.15.13 and #30182 is already merged upstream into the pinned base, when assembling the patch set, #30182 is NOT carried as a patch (it comes for free from the base).
- AE3. **Covers R13, R14.** Given a new upstream release where the patch set applies clean and the streaming spike passes, when the scheduled job runs, it opens a bump PR; given the spike fails on the new base, no PR is opened and the failure is reported.
- AE4. **Covers R3.** Given the patched binary is installed, when `harness doctor` runs, it reports the expected base version + patch set and exits non-zero if the binary is missing, unrunnable, or reports unexpected provenance.
- AE5. **Covers R2, R17.** Given the action setup obtains the harness binary, when it runs `harness serve`, the SDK connects and streams events exactly as against stock `opencode serve` today.
- AE6. **Covers R9, R19.** Given `bunx @fro.bot/harness serve` is run on darwin/arm64, when npm resolves the package, only `@fro.bot/harness-darwin-arm64` is installed and the shim execs its native binary; on linux x64 CI, only `@fro.bot/harness-linux-x64` is installed.

---

## Success Criteria

- **The spike runs first and right-sizes v1**: a recorded result (1.15.13 streams cleanly or not; real patch count) determines whether v1 is the full harness or the lean pin-bump path — no heavy pipeline is built before that evidence exists.
- The Fro Bot agent runs on a deliberately-pinned OpenCode **1.15.13+** in the action, with visible tool-call output confirmed in live CI logs (the thing the 1.14.41 pin was protecting).
- The patch set is small, each patch's carrying rationale is explicit, and any patch that stops applying breaks the build loudly rather than silently degrading.
- A maintainer can bump the OpenCode base by reviewing one automated, pre-validated PR — not by re-running a manual patch+build+spike from scratch.
- A downstream planner can implement from this doc without inventing the build model, patch policy, CLI contract, or cutover sequencing.

---

## Scope Boundaries

- **Gateway/workspace cutover is not in v1** — it is the immediate fast-follow after the action proves the patched binary (R16).
- **Platform matrix mirrors OpenCode** (R19) — native builds for linux x64/arm64 + darwin x64/arm64 are in scope (full local `serve` parity included); **windows is out of scope** for v1.
- **No install-time/on-consumer build** — explicitly rejected in favor of prebuilt artifacts (R8); not even as a fallback in v1.
- **No LLM-driven merge pipeline** (the orw approach) — explicitly rejected for non-determinism (R4).
- **No auto-tracking of upstream dev/latest** — explicitly rejected given the 1.14.42 regression history (R11, R14).
- **Carrying upstream-rejected (CLOSED) PRs is opt-in, not automatic** — #28582 and #26036 are upstream-rejected; they are carried in v1 only if they deliver value we need now, with the indefinite-ownership cost acknowledged (R6, R7, R26). Each indefinitely-carried patch is a standing per-bump rebase-conflict tax, not a one-time cost. The streaming spike result, not assumption, drives the final set.
- **The streaming fix is not assumed present** — #27959 (PubSub eager-subscribe) is confirmed an ancestor of v1.15.13, but whether 1.15.13 fully resolves OUR tool-output drop is unproven; the spike decides whether a streaming patch is still required.

---

## Key Decisions

- **Spike-gated scope (load-bearing)**: the empirical streaming spike against isolated mainline 1.15.13 is **planning Unit 1** and gates v1 *scope*, not just the patch set. If 1.15.13 still drops tool output for our `subscribeAll` pattern, OR ≥2 non-mainline patches are genuinely needed → build the full harness as specified below. If 1.15.13 streams cleanly AND the real delta is ~1 patch → the plan recommends the lean path (pin-bump 1.15.13 + thin patch/shim layer, defer the multi-platform publish pipeline + scheduled-bump automation). Nothing heavy is built speculatively before the spike proves the pain. All requirements below describe the **full-harness branch**; the lean branch is a documented planning off-ramp.
- **Both deterministic patch pipeline AND latest-tracking are co-equal goals** *(in the full-harness branch)*: the harness must give reproducible patch control *and* be the safe mechanism for riding a recent release.
- **Publish-time prebuilt artifact over install-time build**: reproducibility + fast consumers; build/compile toolchain isolated to harness CI; consumers need no runtime.
- **Streaming-gated minimal patch set**: ride latest for everything mainline; patch only non-mainline value; an empirical spike gates whether a streaming patch is needed at all.
- **Passthrough CLI + harness-specific ops commands**: drop-in `opencode` replacement plus `doctor`/`patches`/`info` for provenance and operability.
- **Deliberate pinned bumps + automated upgrade-check PR**: never auto-merge; the scheduled job turns "stay current" into a reviewable, pre-validated signal.
- **Phased cutover (action first, gateway follows)**: validate the new build on the disposable high-frequency surface before the long-lived daemon.
- **Published as `@fro.bot/harness`, bunx-runnable**: the harness is a public npm package (dot-scope, like `@fro.bot/systematic`) runnable via `bunx @fro.bot/harness <command>` with zero prior setup — the local dogfooding + operator install path, not only a CI artifact.
- **Native builds, mirroring OpenCode's npm packaging**: per-platform native binaries distributed via a main package + per-platform `optionalDependencies` (the esbuild/swc/OpenCode pattern), so no runtime/toolchain is needed on consumers and `bunx` resolves the host binary automatically. Build matrix mirrors OpenCode: linux x64/arm64 + darwin x64/arm64.
- **MIT license confirmed**: upstream OpenCode is MIT, so redistributing a modified build is permitted with attribution.

---

## Dependencies / Assumptions

- Upstream `anomalyco/opencode` remains MIT-licensed and buildable from source at the pinned ref.
- The from-source build is required because the target patches modify OpenCode **server internals** (`bus`, session prompt-building, plugin events) — these are not SDK-client patches.
- `@opencode-ai/sdk` continues to talk HTTP/SSE to the patched `opencode serve` unchanged; the harness changes the binary, not the protocol.
- The existing cache-accelerator install pattern (tools cache) can host/serve the harness binary the way it hosts stock opencode today.

---

## Outstanding Questions

### Resolved

- **Streaming spike — DONE (2026-06-02), regression FIXED in 1.15.13.** Ran an isolated `--pure` opencode@1.15.13 server (darwin arm64, `opencode/big-pickle`) with a vanilla SDK subscriber (`createOpencodeClient` with `directory` baked in, mirroring production). Result: `message.part.updated` (16) and `message.updated` (9) — the SyncEvents 1.14.42+ dropped — reached the `/event` subscriber, and the bash tool executed end-to-end (`tool.registry status=completed bash`). The bus/SSE regression that forced the 1.14.41 pin is empirically gone. **Caveat (contract shift):** 1.15.13 emits the tool lifecycle via `message.part.updated` (partType:tool, pending→running→completed) and emits **zero** `session.next.tool.called/success` and **zero** `session.next.text.delta`. `src/features/agent/streaming.ts` already has a `message.part.updated` tool-completed handler (~lines 255-275), so the action *may* already be compatible — but the action's `retry.ts` turn-arming/fallback path (where the KNOWN_ISSUE "tool output unrendered when `message.part.updated` arrives before the turn is armed" becomes the PRIMARY path on 1.15.13) needs an end-to-end integration check before flipping the pin.
- **Scope implication — LEAN PATH selected by the spike gate.** The streaming fix is in mainline 1.15.13, so it is NOT a patch we need to carry. With the primary pain dissolved, the spike-gated decision resolves to the **lean path**: pin-bump to 1.15.13 + any integration fix to `streaming.ts`/`retry.ts`, and defer the full multi-platform harness pipeline. The full-harness requirements below remain a documented future option if the carried-patch count ever grows, but are not v1.

### Resolve Before Planning

- [Affects pin-bump][Needs verification] **End-to-end integration check** — does the action harness (`retry.ts` arming + `streaming.ts` `message.part.updated` path) render tool output end-to-end on 1.15.13, given `session.next.tool.*` no longer fires? Gate before flipping `DEFAULT_OPENCODE_VERSION`.
- [Affects R6, R7, R17, scope][SUPERSEDED — see Resolved] ~~Empirical streaming spike~~ — does deliberately-pinned mainline 1.15.13 (which contains #27959) still drop visible tool-call output for our `subscribeAll` consumption pattern? This is a **gating prerequisite**: its result determines whether the patch set includes a streaming fix (and whether we must author/upstream one). Planning must define the exact CI assertion surface before this is a hard gate: server mode (isolated `--pure`), the trigger that fires a tool/permission event (e.g. `external_directory` read), timeout budget, and the precise observable signature that counts as "tool output streamed" (which event types over `/event`). If a deterministic CI assertion is not achievable, it becomes a documented manual validation step, not a hard gate. Run as the first planning/spike step against an isolated 1.15.13 server before finalizing the patch set.
- [Affects R6][User decision] **CLOSED-PR carry decision** — confirm whether #28582 (resume-from-stored-dir) and #26036 (summary-diff opt-out) deliver value we need badly enough to own indefinitely, or are dropped from v1.

### Deferred to Planning

- [Affects R8, R9][Technical] How the action setup + gateway Dockerfile fetch and cache the per-platform harness packages in the existing tools-cache accelerator (the artifact form itself is settled in R9: main package + per-platform `optionalDependencies`).
- [Affects R4][Technical] Patch storage mechanism (`patches/` + `git am` vs scripted cherry-pick) and how patches are refreshed when a bump conflicts.
- [Affects R13][Technical] Scheduled upgrade-check wiring (reuse existing Renovate/cron patterns vs a dedicated workflow) and how it builds against a candidate base in CI.
- [Affects R2][Technical] How `harness` resolves and execs the embedded `opencode` binary (bin shim form, path resolution) given ESM/Node 24.
- [Affects R6, R7][Needs research] Confirm #20084 and #19961 still apply cleanly onto 1.15.13 and deliver the intended behavior — **both target `dev`, not the release tag**, so cherry-picking onto a 1.15.x release tag may conflict; classify each carried patch by its base branch and define the fallback when a `dev`-only patch won't rebase (drop / rewrite / pin a release that already includes the hunk).
