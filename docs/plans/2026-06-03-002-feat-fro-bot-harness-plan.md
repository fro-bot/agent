---
title: "feat: @fro.bot/harness — orw-embedded patched OpenCode (LLM-merge integration, default setup)"
type: feat
status: active
date: 2026-06-03
origin: docs/brainstorms/2026-06-02-fro-bot-harness-patched-opencode-requirements.md
---

# feat: @fro.bot/harness — orw-embedded patched OpenCode

## Overview

`@fro.bot/harness` is a published package that embeds **orw's integration method** (`cortexkit/orw`) into this project: on each deliberately-pinned upstream OpenCode release, it bases an integration branch on the **release tag**, fetches a configured set of integration refs (stalled/closed upstream PRs, branch URLs, local branches), and runs an **LLM merge** (`opencode run`) to carry those refs onto the release tag — resolving the base drift that `git am`/cherry-pick structurally cannot — then builds the native OpenCode CLI per platform and verifies it. The produced per-platform binary is the `harness` binary (the patched OpenCode), shipped in the package dist. The action setup **replaces** its stock OpenCode download with the harness-produced binary: the harness **is** the default OpenCode for Fro Bot, not an opt-in.

This corrects the prior draft on three points:
1. **LLM merge is the mechanism, not a flaw.** The v1 carry target (#30182) is based on upstream `dev`, not the release tag — `git am` cannot bridge that base. orw uses `opencode run` to merge it onto the tag and resolve conflicts. This **supersedes brainstorm R4** ("deterministic git-native, never LLM merge"); R4 was the wrong call. Determinism is preserved differently (below).
2. **Harness is the default**, replacing the stock `opencode` install in the action setup — not an opt-in path.
3. **Full harness as specified** in the origin brainstorm (published package, native per-platform distribution, scheduled deliberate bumps), delivered with orw's method as the integration engine.

## Problem Frame

Fro Bot has no reproducible way to carry OpenCode changes that upstream won't take (closed/stalled PRs) or to ride a newer release without a from-scratch manual re-validation. The behaviors live in `dev`-based PRs that can't be `git am`-ed onto a release tag. orw already solves exactly this — clone at the release tag, LLM-merge the dev refs, build, verify — but as a personal local watcher (launchd, desktop install). The harness embeds that method as a **project-integrated, published, CI-built** OpenCode supplier that the action consumes as its default OpenCode.

## How determinism works under an LLM merge

The LLM merge is non-deterministic per run, so reproducibility moves one level up — exactly orw's model plus a freeze:

- The LLM merge runs **once per release bump** (scheduled or manual), in CI, producing an **integration commit** on a branch based on the release tag.
- That integration commit is **captured, reviewed by the maintainer (the bump PR), and frozen** — its SHA is pinned. Nothing rebuilds the merge on the action's hot path.
- Per-platform **builds are pinned to the frozen integration commit** and are deterministic from there.
- **Provenance** = upstream release tag + ordered integration refs (each pinned by upstream commit SHA: PR `refs/pull/N/head`, branch ref, or local) + the **frozen integration commit SHA** + build sha. `harness info`/`patches`/`doctor` report this.
- The maintainer review of the bump PR **is** the quality gate on the LLM merge — never auto-merged.

So the guarantee is "the **reviewed, frozen integration commit** reproducibly builds the binary," not "base+patches byte-reproduce the binary." This is honest and matches orw + the brainstorm's deliberate-pinned-bump model.

## Requirements Trace

Carries the origin brainstorm's full-harness requirements, with R4 corrected to LLM-merge:

- R1. New published package **`@fro.bot/harness`** under `packages/harness/` (dot-scope, ESM-only/Node 24 + bun, workspace conventions). *(origin R1)*
- R2. `harness` CLI **passes through** arbitrary OpenCode commands/args/stdio/env to the patched binary — drop-in. *(origin R2)*
- R3. Harness commands: `harness doctor` (binary present/runnable/expected provenance), `harness patches` (integration refs + frozen integration commit), `harness info`/`--version` (base release + integration refs + integration commit + build sha). *(origin R3)*
- **R4′ (corrected).** Integration is an **LLM merge** of configured refs onto the release tag (orw's `opencode run` method), **not** `git am`. The merge runs once per bump, is reviewed, and its result is **frozen** as a pinned integration commit. *(supersedes origin R4)*
- R5. A failed integration (merge unresolved, build fails, or version mismatch) **fails the bump hard** and opens a maintenance issue — never a silent/partial publish. *(origin R5, R26)*
- R6. The integration ref set carries **non-mainline value only**; refs already in the stable release tag arrive free and are not carried. A ref merged to `dev` but not yet in the stable tag (e.g. #30182 in v1) is carried until the next release includes it, then auto-drops. *(origin R6)*
- R7. Each integration ref records provenance (upstream PR/source, pinned commit SHA, why carried, upstream-rejected → indefinite-ownership flag). *(origin R7, R22)*
- R8/R19. Each platform's integrated OpenCode is compiled to a **native standalone binary** via upstream's **own build** (`packages/opencode/script/build.ts` — a full-repo build, not a standalone compile), **each on its own platform-native runner**; matrix mirrors OpenCode: linux x64/arm64 + darwin x64/arm64. *(origin R8, R19)*
- R9/R18. Distribution **mirrors OpenCode's npm packaging**: a main `@fro.bot/harness` + per-platform `optionalDependencies` (`@fro.bot/harness-linux-x64`, …), `bin` shim + `postinstall` resolver; **published to public npm**, runnable via `bunx @fro.bot/harness <cmd>`. *(origin R9, R18)*
- R10/R20–R25. Provenance + integrity: published packages carry npm provenance attestation; `postinstall` resolver verifies integrity before exec; publish authority fenced to a protected CI workflow + maintainer gate; all-or-nothing across the matrix; MIT attribution preserved. *(origin R10, R20–R25)*
- R11/R12. The harness pins an **exact, validated** base release — initial target **1.15.13** (already validated/shipped). *(origin R11, R12)*
- **R15′ (corrected).** The action setup **replaces** its stock OpenCode download with the harness binary — the harness **is the default** OpenCode for the action. *(corrects origin R15 — not opt-in)*
- R13/R14. A **scheduled CI job** detects new upstream releases, runs the integration + verification, and opens a **bump PR only when green**; never auto-merged; maintainer reviews the frozen LLM-merge result. *(origin R13, R14)*
- R16. **Gateway/workspace-image cutover follows** after the action validates the harness binary in production. *(origin R16 — fast-follow, not v1)*
- R17. The action cutover **verifies** SDK/event-stream + tool-output compatibility against the integrated binary (reuse the proven streaming/tool-output assertion), not assume it. *(origin R17)*

## Scope Boundaries

- **Action is the cutover surface; gateway/workspace follows** (R16) — see Deferred.
- **No auto-tracking of upstream dev/latest** — bumps are deliberate, maintainer-reviewed (R11/R14).
- **The LLM merge is a build/bump-time step, never on the action's hot path** — the action consumes the published, frozen, pre-built binary.
- **windows out of scope** (origin) — matrix is linux x64/arm64 + darwin x64/arm64.

### Deferred to Separate Tasks

- **Gateway + workspace-image cutover** to the harness binary (`deploy/*.Dockerfile`): the immediate fast-follow after the action validates the harness in production (R16).
- **`harness`-driven local dev install** (orw's launchd/desktop-install ergonomics) beyond `bunx @fro.bot/harness` inspection/run: out of v1; the project-integration + action-consumption path is v1.

## Context & Research

### orw method (the integration engine to embed) — read in `.slim/clonedeps/repos/cortexkit__orw/`

- `src/index.ts` `check()` → `prep()` → `render()` → `opencode run` → `verifyBuild()` is the core loop: detect latest release → clone `git_origin` into a disposable work repo → fetch each integration ref → render `prompt.txt` → run `opencode run --agent build --model <model> <prompt>` (the LLM merge: base branch on the release tag, merge refs in order, resolve conflicts, build the host CLI) → verify the built CLI `--version` equals the release version.
- `parseSource()` maps each config ref to a fetch ref: **local branch** → `refs/heads/<b>`; **GitHub branch URL** (`/tree/`) → that branch; **GitHub PR URL** (`/pull/N`) → `refs/pull/N/head`. This is exactly how dev-targeted PRs (e.g. #30182 `/pull/30182`) are carried.
- `prompt.txt` is the merge instruction: "Base the integration branch on the release tag … Merge these refs in order … resolve conflicts completely … build the host CLI with `OPENCODE_CHANNEL=… OPENCODE_VERSION=… bun run build -- --single` … verify `--version`."
- `package.json`: orw is MIT, `bin: { orw }`, `bunx @cortexkit/orw`-runnable, config-driven (`orw.config.json`: `release_repo`, `base_branch: dev`, `branches: []`, `agent`, `model`, `opencode_bin`). The harness mirrors this config + CLI shape.

### Cut-over seam (action) — verified in-repo

- The SDK spawns `opencode` **by name from PATH** (`src/features/agent/execution.ts` `createOpencode`; `src/features/agent/server.ts` `ensureOpenCodeAvailable` resolves `process.env.OPENCODE_PATH ?? 'opencode'`). `src/services/setup/opencode.ts` `installOpenCode()` downloads the stock binary and `runSetup()` `core.addPath()`s it. → The cutover **replaces** what `installOpenCode()` puts on PATH with the harness-published binary. SDK/event code is untouched.
- `src/services/setup/tools-cache.ts` caches the opencode binary under a version-keyed tools-cache; the harness binary reuses this accelerator.
- `DEFAULT_OPENCODE_VERSION` (`packages/runtime/src/shared/constants.ts`, Renovate-tracked, `<=1.15.13` cap) pins the base release the harness integrates onto.

### Upstream build reality — verified in clonedeps

- `packages/opencode/script/build.ts` is **not** a standalone compile: it runs `bun run --cwd ${appDir} build` (embedded app) and `bun install @opentui/core` / `@parcel/watcher` (platform-native deps). `.github/workflows/publish.yml` builds each platform on its **own native runner** (`macos-26`/`macos-26-intel`/`ubuntu`). → The harness build must check out the **full upstream repo** at the frozen integration commit and invoke upstream's real build script per platform; it cannot "compile just opencode" in isolation. The LLM merge also needs a bootstrap `opencode` on PATH to run the merge.

### Institutional Learnings

- `docs/solutions/performance-issues/tool-binary-caching-ephemeral-runners.md` — OpenCode binary must be cached under a dedicated tools-cache key; `latest` is a non-determinism trap → the harness binary follows the same cache discipline; bumps are pinned.
- `docs/solutions/build-errors/gateway-docker-runtime-resolution-crash-loop-2026-05-31.md` — ship compiled artifacts, not source-resolved entries → harness CLI ships built `dist/`; the per-platform packages ship native binaries.
- `docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — pinned-version-constant + Renovate regex idiom → the base-release pin reuses it.

### External References

- `cortexkit/orw` (MIT) — the integration method embedded here.
- `anomalyco/opencode` (MIT) `packages/opencode/script/build.ts` + `.github/workflows/publish.yml` — the per-platform native build model.
- Live PR status (verified 2026-06-03): **#30182 MERGED→`dev`** (NOT in 1.15.13 tag — v1 carry; auto-drops when next release includes it); #28582, #26036 **CLOSED** (upstream-rejected, dropped); #20084, #19961 **OPEN**, base `dev` (watch/needs-empirical-check, NOT in v1 — see Carry Policy). Latest release 1.15.13.

## Key Technical Decisions

- **Embed orw's LLM-merge integration as the harness engine.** It is the only mechanism that carries `dev`-based refs onto a release tag. The merge runs at bump time, is maintainer-reviewed, and is frozen. *(supersedes brainstorm R4)*
- **Harness is the default OpenCode for the action** — `installOpenCode()` is replaced to put the harness binary on PATH; the SDK is unchanged. Not opt-in. The shipped artifact is a native binary named `harness` that IS the pinned, patched OpenCode (a drop-in) with the carried refs baked into the binary dist — the way upstream ships its per-platform binaries. Installing it as the `opencode` on PATH (or invoking `harness` directly) both work since it is OpenCode with the integration applied.
- **LLM merge off the hot path.** The action consumes the published, frozen, pre-built binary; the merge never runs during an action invocation.
- **Determinism via frozen integration commit + pinned builds** (see "How determinism works"). Provenance pins refs by commit SHA + the integration commit SHA + build sha.
- **Native per-platform distribution mirroring OpenCode** — full-repo build per native runner, `optionalDependencies` packaging, npm publish with provenance attestation, MIT attribution. Publish fenced to a protected workflow + maintainer gate.
- **Deliberate, reviewed bumps** — scheduled detection → integrate → verify → bump PR; a failed integration opens a maintenance issue, never a silent red build.

## Carry Policy

The pipeline is the asset; the patch list stays boring. Target **1–3 carried refs max**. Every carried ref records: reason, owner, upstream status, drop condition, verification fixture. Re-gauge every upstream release tag.

**A ref qualifies to carry only if it is one of:**
1. **Merged-to-dev correctness fix not yet in stable** — small diff, clear Fro Bot impact, auto-drops on the next release that includes it (e.g. #30182).
2. **Open/stalled upstream fix for Fro-Bot-critical behavior** — affects event-stream correctness, retry/error classification, permission flow, session durability, or Anthropic/OpenAI request correctness; has a failing fixture or reproducible incident; explicit carry owner.
3. **Perf/DX/agent-quality patch with evidence** — before/after numbers required (token cost, latency, failure rate, degraded output). No vibes.
4. **Stable-lane guardrail** — must preserve 1.15.x public behavior unless Fro Bot explicitly owns the divergence. No broad refactors, provider rewrites, or speculative plugin-API changes without a concrete Fro Bot failure.

**Drop a carried ref when any of:** upstream stable release includes it; it stops applying cleanly and no longer has high value; upstream rejected it and Fro Bot lacks a concrete ongoing need; it changes event/API semantics without matching Fro Bot consumer handling; no recent incident/metric/test justifies the maintenance burden.

**Drift controls:** keep the carry count tiny; prefer 'merged-to-dev, not yet released' over 'closed-rejected-forever'; don't carry a ref just because it was Fro-Bot-authored — past-authored stale PRs are guilty until re-proven useful; never leap ahead of the stable lane.

**Watch-list (carry candidates, not yet carried):** Anthropic request correctness (signed thinking, redacted reasoning, tool-call ordering, prompt-cache boundaries); SSE/event robustness (message.part.updated/delta, session.idle/error, permission events); permission-flow reliability (asked/replied ordering, duplicate asks, cancellation, timeout); error classification (provider/LLM-retryable vs plugin/config/session-lifecycle); session/workspace routing (query:{directory}, remote attach, project-scoped listing); token/cost regressions (summarization/compaction/context transforms — with numbers).

**#20084 (plugin.error vs session.error) — NEEDS-EMPIRICAL-CHECK before carrying:** structurally still relevant (Fro Bot treats session.error as retry signal in src/features/agent/streaming.ts and the gateway throws on it in run-core.ts; 1.15.13 publishes plugin-load failures as sessionless session.error). But carrying it changes the event contract, so promote only after a fixture proves: plugin load failure is surfaced clearly; it does NOT trigger LLM retry; it does NOT falsely fail an unrelated active session; a critical Fro Bot plugin failure is NOT silently swallowed. Tracked as a future carry candidate, not v1.

## Open Questions

### Resolved During Planning

- Integration mechanism → **LLM merge (orw method)**, not git am (the dev→tag base drift requires it).
- Default vs opt-in → **harness replaces the stock opencode install; it is the default**.
- Cut-over seam → replace what `installOpenCode()` puts on PATH (SDK spawns `opencode` by name — verified).
- Build reality → full upstream-repo build per native runner (verified in clonedeps), not a standalone compile.
- Initial carry set → v1 carries **#30182** (preserve signed Anthropic thinking during reorder) as the sole integration ref. It is MERGED to upstream `dev` but not in the 1.15.13 release tag, so the LLM merge carries it onto the tag — which is exactly why it's the ideal proof-carry: it genuinely exercises the dev→release-tag LLM-merge mechanism, delivers real Anthropic-model correctness value (Fro Bot runs Claude), is small/correctness-only, and AUTO-DROPS when the next upstream release includes it. #20084 and #19961 are NOT in v1 (see Carry Policy). #28582/#26036 dropped.

### Deferred to Implementation

- **Exact model/agent for the merge** (orw uses a configurable `model`; the harness merge runs in CI non-interactively — pick a capable model + the `build` agent; budget token cost per bump).
- **Where the frozen integration commit lives** (a `fro-bot/opencode-integration` mirror branch vs an artifact-captured patch series re-derived from the frozen commit) and how per-platform build jobs check it out.
- **Whether the tools-cache stores the resolved native binary directly vs the installed `@fro.bot/harness` package tree** (perf detail); the resolver flow itself is specified in Unit 4.
- **(Specified in Unit 2 — stock base binary from a dedicated bootstrap cache key.)**

## Output Structure

    packages/harness/
    ├── package.json            # @fro.bot/harness, public, type:module, bin:{harness}, optionalDependencies (per-platform), postinstall resolver
    ├── tsconfig.json · tsdown.config.ts · AGENTS.md · LICENSE (MIT + OpenCode + orw attribution)
    ├── harness.config.json     # release_repo, base pin, integration refs (PR/branch/local), model, agent
    ├── prompt.txt              # the LLM-merge instruction (adapted from orw)
    ├── src/
    │   ├── cli.ts              # bin: passthrough + doctor/patches/info
    │   ├── integrate.ts        # orw-embedded: detect release → clone@tag → fetch refs → opencode run (LLM merge) → build → verify → freeze
    │   ├── sources.ts          # parseSource: PR URL / branch URL / local → fetch refs (orw parseSource)
    │   ├── provenance.ts       # base tag + refs(SHA) + integration commit + build sha
    │   └── resolve-binary.ts   # postinstall resolver: select+verify host binary
    ├── scripts/
    │   ├── build-platform.mjs       # per-platform: checkout frozen integration commit → upstream build → native binary
    │   ├── verify-binary.mjs        # spike: --version == base, tool-output streams, integration markers present
    │   └── *.test.mjs               # node --test for integrate/sources/provenance/verify logic
    └── patches/README.md       # integration-ref policy + provenance format

## Implementation Units

- [ ] **Unit 1: `packages/harness/` published scaffold + CLI (passthrough + doctor/patches/info)**

**Goal:** A public `@fro.bot/harness` package that builds with the repo toolchain, exposes a `bunx`-runnable `harness` bin (passthrough + provenance/operability commands), with the `optionalDependencies` + `postinstall` resolver skeleton.

**Requirements:** R1, R2, R3, R9 (packaging skeleton), R18, R24

**Dependencies:** None

**Files:**
- Create: `packages/harness/{package.json,tsconfig.json,tsdown.config.ts,AGENTS.md,LICENSE}`, `packages/harness/src/{cli.ts,provenance.ts,resolve-binary.ts}`, `packages/harness/src/cli.test.ts`
- Modify: root `package.json` script matrix + `pnpm-workspace.yaml`/`workspaces` to include the package; `.github/renovate.json5` (track the base-release pin)

**Approach:** Mirror `packages/runtime`/`packages/gateway` (composite tsconfig, tsdown ESM) + add `bin` (first in-repo) + `optionalDependencies` per-platform + `postinstall` resolver + `publishConfig.access: public`. CLI: passthrough execs the resolved binary (args/stdio/env, propagate exit code); `info`/`--version`/`patches`/`doctor` read provenance. LICENSE = MIT + OpenCode + orw attribution.

**Patterns to follow:** `packages/runtime` shape; orw `package.json` (`bin`, `bunx`, `publishConfig`).

**Test scenarios:**
- Happy: `harness info` prints base+refs+(placeholder)commit/sha; `--version` returns a string; `patches` lists configured refs.
- Edge: `doctor` non-zero when no binary resolvable, zero when one is present.
- Edge: passthrough forwards args + stdio + exit code; harness commands (info/patches/doctor) disambiguated from passthrough.

**Verification:** `pnpm --filter @fro.bot/harness build` emits `dist/cli.mjs`; CLI runs; tests + types + lint clean.

- [ ] **Unit 2: Integration engine — orw-embedded LLM merge onto the release tag**

**Goal:** Given a pinned release + configured integration refs, base a branch on the release tag, fetch the refs, run the LLM merge (`opencode run`) to integrate + resolve conflicts, build the native CLI, verify `--version`, and freeze the integration commit + provenance.

**Requirements:** R4′, R5, R6, R7, R11, R12

**Dependencies:** Unit 1

**Files:**
- Create: `packages/harness/src/{integrate.ts,sources.ts}`, `packages/harness/prompt.txt`, `packages/harness/harness.config.json`, `packages/harness/scripts/integrate.test.mjs`, `packages/harness/scripts/sources.test.mjs`

**Approach:** Port orw's `check`/`prep`/`render`/`parseSource`/`verifyBuild` into `integrate.ts`/`sources.ts`, adapted for CI/non-interactive use: clone the base repo, base the integration branch on `refs/tags/v<pin>`, fetch each ref (`parseSource`: PR `refs/pull/N/head`, branch, local), render `prompt.txt`, run `opencode run --agent build --model <model> <prompt>` (needs a bootstrap `opencode` on PATH), then build + verify `--version == base`. **Freeze** the resulting integration commit SHA + write the provenance manifest (base tag, ordered refs with resolved commit SHAs, integration commit SHA). On any failure (unresolved merge / build fail / version mismatch) → exit non-zero with the failure surfaced (R5). Initial `harness.config.json` carries **#30182** as `https://github.com/anomalyco/opencode/pull/30182` (the sole v1 integration ref).

**CI merge runner contract (non-interactive determinism):** The `opencode run` merge runs headless in CI, so the job must specify: (a) a **pinned bootstrap `opencode`** version (see Unit 2 bootstrap below) and a **fixed model + `build` agent** (the merge model is a `harness.config.json` field; pick a capable model — the merge reasons over conflicts); (b) a **hard timeout** on the merge job and a **poll-to-terminal-state** loop (do not let bash background-promotion end the run — mirror orw's prompt.txt guidance that warns `background:true` breaks the non-interactive tool); (c) **explicit failure criteria** that abort the bump: merge left unresolved, build fails, or built `--version` != base; (d) **log/artifact capture** of the full merge transcript so the maintainer reviews a deterministic bump PR. The merge prompt is adapted from orw's prompt.txt (base branch on the release tag, merge refs in order, resolve conflicts completely, build the host CLI, verify version) and must retain the non-interactive guardrails (no background bash; poll completion).

**Bootstrap opencode (chicken-and-egg):** the merge step needs a working stock `opencode` on PATH to run `opencode run` — but the harness PRODUCES opencode. Resolve by bootstrapping the **stock upstream release binary at the pinned base** (e.g. stock `opencode@1.15.13` from a **dedicated bootstrap cache key**, separate from the integration-artifact cache). The merge job runs with that bootstrap binary only; **fail the job if the bootstrap version != the declared base pin** (prevents version skew at the exact step where determinism matters most). Bootstrapping stock to build patched is sound — there is no circularity because the bootstrap is the unpatched base, used only to drive the merge, not shipped.

**Execution note:** Test-first for `sources.parseSource` (ref mapping) and the fail-hard/freeze/provenance contract (the load-bearing guarantees). The actual `opencode run` merge is exercised by the Unit 4 CI integration job, not a unit test.

**Patterns to follow:** orw `src/index.ts` `parseSource` (lines ~632-680), `prep`/`render`/`check` (lines ~297-456), `prompt.txt`; `deploy/scripts/*.mjs` + `node --test` style.

**Test scenarios:**
- Happy: `parseSource` maps a PR URL → `refs/pull/N/head`, a `/tree/` URL → branch ref, a local name → `refs/heads/<b>` (mirror orw).
- Error (R5): a stubbed merge/build failure → `integrate` exits non-zero, freezes nothing, surfaces which ref/step failed.
- Edge: empty ref set → integration = the release tag unchanged; provenance manifest is base-only and valid.
- Integration: the provenance manifest content matches what `harness info`/`patches` reports (single source of truth).

**Verification:** running `integrate` against `v1.15.13` with the bootstrap opencode fetches the refs, the LLM merge integrates #30182 onto the tag, the built CLI reports `1.15.13`, and a frozen integration commit + manifest are produced.

- [ ] **Unit 3: Native per-platform build + distribution (optionalDependencies, npm publish, provenance)**

**Goal:** Build the integrated OpenCode to native binaries for the full matrix from the frozen integration commit, package as a main + per-platform `optionalDependencies` set, and publish to npm with provenance attestation + MIT attribution, fenced to a protected workflow.

**Requirements:** R8, R19, R9, R10, R20, R21, R23, R24, R25

**Dependencies:** Unit 2

**Files:**
- Create: `packages/harness/scripts/build-platform.mjs`, `packages/harness/scripts/verify-binary.mjs`, `.github/workflows/harness-release.yaml` (per-platform native runners → build → verify → assemble → publish, maintainer-gated)
- Modify: `packages/harness/package.json` (`optionalDependencies` + `postinstall` resolver finalized)

**Build-environment contract:** upstream `packages/opencode/script/build.ts` is a full-repo build (embedded-app build + native `@opentui/core`/`@parcel/watcher` install), not a standalone compile. Each per-platform job must: pin the **Bun version** (match upstream's `packageManager`/declared bun), check out the **full upstream repo** at the frozen integration commit (native-dep install + embedded-app build happen under the **upstream repo root**, not the harness package), and run the build with the release-identity env orw's prompt.txt uses — `OPENCODE_CHANNEL=<stable> OPENCODE_VERSION=<base> bun run build -- --single` (or the fork's equivalent flags). Verify the built binary `--version` == base before packaging.

**Approach:** Per platform on its **own native runner** (mirror upstream `publish.yml`): check out the **full upstream repo** at the frozen integration commit → run upstream's real build (`packages/opencode/script/build.ts`, the embedded-app + native-dep build) → emit the native binary → `verify-binary.mjs` (version == base, tool-output streams, integration markers present). Assemble the main package + per-platform packages; publish **all-or-nothing** with npm provenance attestation; `postinstall` resolver selects + integrity-verifies the host binary **before** exec (R20). Publish fenced to the protected workflow + maintainer gate (R21).

**Patterns to follow:** upstream `.github/workflows/publish.yml` matrix; OpenCode `script/publish.ts` `optionalDependencies` model; the gateway image-smoke job shape for a build+smoke job.

**Test scenarios:**
- Happy: each platform leg builds a binary; `verify-binary.mjs` asserts version + integration marker + tool-output → zero.
- Error: wrong version / missing marker / unverified integrity → `verify-binary`/resolver exits non-zero (the spike + resolver actually gate).
- Edge: a missing platform leg blocks the whole publish (all-or-nothing, R25).
- Test expectation: build/publish exercised by the CI workflow; `verify-binary.mjs` + `resolve-binary.ts` have `node --test`/unit coverage against stubs.

**Verification:** `harness-release.yaml` builds the matrix from the frozen commit, verifies, and publishes a provenance-attested package set; `bunx @fro.bot/harness info` on a host resolves the right binary.

- [ ] **Unit 4: Action cutover — harness binary becomes the default OpenCode**

**Goal:** The action setup installs the harness-published binary as `opencode` (replacing the stock download) as the **default**, CI-proven to stream tool output end-to-end through the real harness path.

**Requirements:** R15′, R17

**Dependencies:** Unit 3

**Files:**
- Modify: `src/services/setup/opencode.ts` / `src/services/setup/setup.ts` (install the harness binary as the `opencode` on PATH instead of the stock GitHub-release download), `src/services/setup/tools-cache.ts` (cache key/paths for the harness binary)
- Modify: `.github/workflows/ci.yaml` (the agent/review path runs on the harness binary and asserts tool-output renders — the SDK-level R17 proof)
- Test: `src/services/setup/*.test.ts` (the install path now resolves the harness binary)

**Source-of-binary (the critical seam):** setup installs the published **`@fro.bot/harness`** package; its `postinstall` resolver selects the host-platform `optionalDependencies` package and exposes the native binary; setup **integrity-verifies** it and **caches it under the existing tools-cache key** (extend the key with the harness/base version + frozen integration commit), then `addPath`s it as the `opencode` on PATH. If the published package or the host-platform binary is **missing or fails integrity** (e.g. a publish is mid-flight or partial), setup **fails loud with an actionable error** — no silent stock fallback (the harness is the default; its absence is an error, not a degraded mode).

**Approach:** Replace the stock `installOpenCode()` acquisition with `@fro.bot/harness` resolution (npm/bunx into the tools-cache → `addPath` the resolved binary as `opencode`). SDK/event code (`server.ts`, `execution.ts`, `streaming.ts`, `retry.ts`) is **untouched** — it spawns `opencode` by name. CI runs the real agent path on the harness binary and asserts the `| Bash` tool line + assistant text render (reuse the proven 1.15.13 tool-output assertion) — the consumer-level R17 check. Update setup/docs to reflect the harness as the OpenCode source.

**Execution note:** Characterization-first — capture the current stock-install behavior, then replace it, asserting the agent path still streams tool output on the harness binary.

**Patterns to follow:** `installOpenCode()` + `core.addPath()` seam; tools-cache version-keying; the lean-path tool-output CI assertion.

**Test scenarios:**
- Happy: setup resolves + installs the harness binary as `opencode`; `--version` reports the base release; `harness info` reports the integration refs.
- Integration: the CI agent path renders tool output on the harness binary (SDK-level R17).
- Error: harness binary unavailable → setup fails loud (no silent fallback to stock — the harness is the default, its absence is an error).

**Verification:** CI shows the agent streaming tool output on the harness binary as the default; setup tests updated; `dist/` in sync if the action surface changed.

- [ ] **Unit 5: Scheduled deliberate-bump pipeline + maintainer review**

**Goal:** A scheduled CI job detects new upstream releases, runs the integration + verification, and opens a **bump PR only when green** (maintainer reviews the frozen LLM-merge result); a failed integration opens a maintenance issue. Never auto-merged.

**Requirements:** R13, R14, R5/R26

**Dependencies:** Units 2-3

**Files:**
- Create: `.github/workflows/harness-bump.yaml` (scheduled: detect latest release vs pin → run integrate → verify → on green open a bump PR updating the base pin + frozen integration commit; on failure open a maintenance issue)

**Approach:** Mirror orw's `check` cadence as CI: compare latest upstream release to the pinned base; if newer, run `integrate` (LLM merge onto the new tag) + `verify-binary`; on green, open a bump PR (updates `DEFAULT_OPENCODE_VERSION`/the harness base pin + the frozen integration commit + provenance) for maintainer review; on a merge/build/spike failure, open a maintenance issue naming the conflicting ref + step (R26). Never auto-merge (R14).

**Patterns to follow:** orw `check`/`latest`; the repo's existing scheduled-workflow + bump-PR patterns; the patch-conflict→maintenance-issue policy.

**Test scenarios:**
- Happy: new release + clean integration + green spike → a bump PR is opened with updated pins + provenance.
- Error: integration fails on the new base → no bump PR; a maintenance issue is opened naming the failing ref/step.
- Edge: no new release → no-op.
- Test expectation: the workflow is validated by a manual dispatch run; the detect/compare logic has unit coverage.

**Verification:** a manual dispatch against a newer (or forced) release runs the integration and opens either a bump PR (green) or a maintenance issue (fail), never auto-merging.

## System-Wide Impact

- **Interaction graph:** Unit 4 replaces the OpenCode acquisition in setup; the SDK spawn path is unchanged (binary is `opencode` on PATH). The LLM merge is build/bump-time only — never in an action run.
- **Error propagation:** integration, build, publish, and the action install all **fail loud** — unresolved merge/build/version-mismatch blocks the bump and opens a maintenance issue; a missing harness binary fails setup (no silent stock fallback, since the harness is the default).
- **State lifecycle:** the harness binary follows the existing tools-cache discipline; the frozen integration commit + provenance manifest are the durable pinned state.
- **API surface parity:** the published `@fro.bot/harness` is a new external artifact; the base-release pin stays Renovate-tracked.
- **Integration coverage:** the Unit 4 CI agent-path proof and the Unit 3 per-platform verify-binary spike are the cross-layer guarantees unit tests can't provide.
- **Unchanged invariants:** the SDK/event/streaming code; the tools-cache accelerator pattern; `<=1.15.13` base pin until a reviewed bump. **Changed invariant (intended):** the action's OpenCode source is now the harness binary, not the stock GitHub-release download.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| LLM merge is non-deterministic / could mis-resolve a conflict | Runs once per bump, **maintainer-reviewed** as the bump PR, then **frozen**; builds pin to the frozen commit; `verify-binary` asserts version + tool-output before publish. |
| The merge needs a bootstrap `opencode` + model tokens in CI | Pin a bootstrap opencode; budget per-bump token cost; the merge is bump-time only, not per-action. |
| Upstream build is a full-repo build (embedded app + native deps), not a standalone compile | Build jobs check out the full upstream repo at the frozen commit and run upstream's real build per native runner (verified in clonedeps). |
| Carrying CLOSED/stalled PRs is an indefinite re-merge tax | Governed by the Carry Policy: v1 carries only #30182 (merged-to-dev, auto-drops on the next release that includes it), keeping the indefinite-carry tax near zero for v1. Provenance flags upstream-rejected refs; the scheduled bump re-runs the LLM merge each release; a documented drop/upstream threshold per ref per the Carry Policy. |
| Harness publish/supply-chain is a new trust surface | Fenced publish workflow + maintainer gate; npm provenance attestation; resolver integrity-verifies before exec; all-or-nothing matrix. |
| Action depends on a published external package for its core runtime | Tools-cache accelerator + integrity pin; setup fails loud if unavailable; bumps are deliberate/reviewed. |

## Documentation / Operational Notes

- `packages/harness/AGENTS.md` + `patches/README.md` document the integration-ref policy, the LLM-merge + freeze model, the provenance format, and the bump cadence.
- Strong `ce:compound` candidate post-merge: "patched-dependency via LLM-merge integration + frozen-commit determinism" — no existing docs/solutions covers it.
- Gateway/workspace cutover (R16) is the immediate documented fast-follow once the action validates the harness in production.

## Sources & References

- **Origin:** [docs/brainstorms/2026-06-02-fro-bot-harness-patched-opencode-requirements.md](../brainstorms/2026-06-02-fro-bot-harness-patched-opencode-requirements.md) (full-harness spec; R4 corrected here to LLM-merge per orw)
- Integration method: `cortexkit/orw` (`src/index.ts`, `prompt.txt`, `package.json`) — embedded as the harness engine
- Build/publish model: `anomalyco/opencode` `packages/opencode/script/build.ts`, `script/publish.ts`, `.github/workflows/publish.yml`
- Cut-over seam: `src/services/setup/opencode.ts`, `src/services/setup/setup.ts`, `src/features/agent/server.ts`, `src/services/setup/tools-cache.ts`
- Carry candidates (verified 2026-06-03): anomalyco/opencode **#30182 = v1 carry** (MERGED→`dev`, not in 1.15.13 tag; auto-drops when next release includes it); #20084, #19961 = watch/needs-empirical-check (OPEN, dev-based; NOT in v1 — see Carry Policy); #28582, #26036 = dropped (CLOSED, upstream-rejected)
