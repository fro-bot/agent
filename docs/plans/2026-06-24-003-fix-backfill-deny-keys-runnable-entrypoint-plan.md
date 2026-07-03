---
title: "fix: ship a runnable deny-key backfill entrypoint with --dry-run"
type: fix
status: done
date: 2026-06-24
---

> **Status: done.** All 5 units shipped: `--dry-run` on the backfill function, the daemon-free `backfill-runner.ts`, the `main-dispatch.ts` unconditional entrypoint + testable dispatch, the hermetic gateway tsdown build, and the docs runbook — all verified on `main` (`packages/gateway/src/bindings/backfill-runner.ts`, `packages/gateway/src/main-dispatch.ts`).

# fix: ship a runnable deny-key backfill entrypoint with --dry-run

## Overview

The operator redaction gate fail-closes any binding whose deny keys
(`databaseId`/`nodeId`) are null. All bindings created before the gate landed are
keyless, so `GET /operator/repos` returns `[]` for them — the dashboard operator
page has no live repos even after #1001 mounted the route. The documented
remediation (the deny-key backfill) exists as source but is **not runnable in the
shipped production image**: the build bundles only `dist/main.mjs`, the Dockerfile
copies only `dist/`, and the existing `backfill-deny-keys-cli.ts` is invoked via
`tsx src/...` (neither `tsx` nor `src/` ship in the image). It also has a latent
`createS3Adapter` arity bug and no `--dry-run`.

This plan makes the backfill runnable on a live install via an argv subcommand on
`main.ts` (so it ships inside the single existing bundle — no Dockerfile change),
fixes the adapter wiring, and adds a no-write `--dry-run` preview since the
backfill mutates the live bindings store.

## Problem Frame

`GET /operator/repos` returns an empty list on live installs because every
pre-gate binding is keyless and the surface gate denies keyless bindings
(intended fail-closed behavior — `surface-gate.ts:19-20`). The only fix is to
backfill `databaseId`/`nodeId` onto existing bindings. The backfill *logic*
(`backfillActiveBindingDenyKeys`) is complete and correct, but there is no
shipped command an operator can run against the production image to execute it.

Requirements are sourced from Fro Bot's triage on issue #1000, which verified the
not-runnable condition by inspection and recommended the argv-subcommand approach.

## Requirements Trace

- R1. The backfill must be invocable against the shipped production image with no
  source tree or `tsx` present — i.e. reachable through `node dist/main.mjs`.
- R2. Adding the entrypoint must not change the Dockerfile or the single-bundle
  build (the subcommand ships *inside* `dist/main.mjs`).
- R3. A `--dry-run` mode must resolve identities and report the would-write plan
  (`total`/`updated`/`skipped`/`failed`) without mutating the bindings store.
- R4. The `createS3Adapter` arity bug must be fixed — it requires `(config, logger)`
  but the CLI passes only `config`, yielding an `undefined` logger that crashes on
  first use.
- R5. Running the gateway normally (`node dist/main.mjs` with no subcommand) must
  be unchanged — the gateway Effect program still starts.
- R6. The redaction-gate plan and `packages/gateway/AGENTS.md` must carry the
  concrete `node dist/main.mjs backfill-deny-keys [--dry-run]` runbook.

## Scope Boundaries

- Not changing the surface-gate's fail-closed-on-keyless behavior — that is
  intentional and correct.
- Not changing `deploy/gateway.Dockerfile` or the `tsdown` build entry set — the
  whole point is that the subcommand rides the existing `dist/main.mjs`.
- Not adding the end-to-end `/operator/repos` returns-real-repos integration test
  here — that is downstream verification (deferred).

### Deferred to Separate Tasks

- End-to-end `GET /operator/repos` integration coverage against backfilled
  bindings: future test once a live/fixture install with real keys exists.
- Removing the standalone `import.meta.url` entry guard on the CLI module: keep it
  for now (harmless; tests import `main`); revisit if it becomes redundant after
  the argv refactor.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/main.ts` — single Effect program, no argv branch (R5
  fall-through site).
- `packages/gateway/src/bindings/backfill-deny-keys.ts` — `backfillActiveBindingDenyKeys`
  (idempotent, fail-closed per-binding); gains an optional `dryRun` dep.
- `packages/gateway/src/bindings/backfill-deny-keys-cli.ts` — existing wiring to
  refactor: env reads, App client, S3 adapter, `writeBinding`, status-code exits.
- `packages/gateway/src/program.ts:170` — canonical `createS3Adapter(config.objectStore, runtimeLogger)`
  call to mirror (the correct 2-arg arity).
- `packages/gateway/src/github/app-client.ts` — `getRepoIdentity(owner, repo)`.
- `packages/gateway/src/bindings/store.ts` — `createBindingsStore`; the backfill's
  `writeBinding` does an unconditional `conditionalPut(key, body, {})` overwrite on
  the primary key.

### Institutional Learnings

- Redaction gate (`docs/solutions/best-practices/`): denylist-before-query,
  fail-closed; keyless == denied is by design.
- `dist/` is committed and must stay in sync — a `main.ts` change requires a
  gateway rebuild, but note this is the **gateway** bundle (`packages/gateway/dist`),
  built/consumed by the gateway image, not the root action `dist/`.

## Key Technical Decisions

- **Argv subcommand on `main.ts`, not a second build entry**: smallest shippable
  surface, no Dockerfile/build-entry change, matches Fro Bot's recommendation. The
  backfill ships inside `dist/main.mjs`; operators run
  `node dist/main.mjs backfill-deny-keys [--dry-run]`.
- **Extract a daemon-free builder** for the adapter/store/App-client/`writeBinding`
  wiring into a shared module so both the (now thin) CLI and the `main.ts` argv
  path use one statically-imported `createS3Adapter(config, logger)` — fixing the
  arity bug and dropping the dynamic-import branch.
- **`--dry-run` as a dep on `backfillActiveBindingDenyKeys`** (`dryRun: boolean`):
  when set, resolve identities and count what *would* be written, but skip
  `writeBinding`. Keeps the mutation decision in one place.
- **Security invariant preserved**: the backfill remains offline/admin-only; it is
  never imported from a request/route/command path. The argv branch runs and
  `process.exit`s before the gateway program starts.

## Open Questions

### Resolved During Planning

- Does the backfill need a new store overwrite method? No — the existing
  unconditional `conditionalPut(key, body, {})` on the primary key is the overwrite
  path; the channel index is unchanged so it is not rewritten.
- Dockerfile change needed? No — argv-on-`main.ts` ships in the existing bundle.

### Deferred to Implementation

- Exact module name/location for the extracted builder (e.g.
  `bindings/backfill-runner.ts` vs a `cli/` dir) — pick during implementation to
  match local conventions.

## Implementation Units

- [x] **Unit 1: Add `--dry-run` to the backfill function**

**Goal:** `backfillActiveBindingDenyKeys` can resolve and count without writing.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/bindings/backfill-deny-keys.ts`
- Test: `packages/gateway/src/bindings/backfill-deny-keys.test.ts`

**Approach:**
- Add an optional `dryRun?: boolean` to `BackfillDeps`. When true, after a
  successful `getRepoIdentity`, count the binding as it would be written
  (`updated`) but skip the `writeBinding` call. Already-keyed bindings still count
  as `skipped`; identity-resolution failures still count as `failed`.
- Keep the return shape (`total/updated/skipped/failed`) identical so dry-run and
  real runs report the same plan.

**Execution note:** Implement test-first — add the dry-run scenarios as failing
tests before the branch.

**Patterns to follow:** existing per-binding loop and Result handling in the same
file.

**Test scenarios:**
- Happy path: dry-run with one keyless binding → `updated=1`, `writeBinding` never
  called.
- Edge case: dry-run with mixed (one keyed, one keyless) → `skipped=1`, `updated=1`,
  zero writes.
- Error path: dry-run where `getRepoIdentity` fails → `failed=1`, zero writes.
- Happy path (regression): `dryRun` absent/false still writes (existing behavior
  unchanged).

**Verification:** dry-run paths call `getRepoIdentity` but never `writeBinding`;
counts match the equivalent real run.

- [x] **Unit 2: Extract a daemon-free backfill runner and fix the adapter arity**

**Goal:** One shared builder constructs the adapter/store/App-client/`writeBinding`
with the correct `createS3Adapter(config, logger)` arity; the CLI becomes a thin
caller.

**Requirements:** R4

**Dependencies:** Unit 1

**Files:**
- Create: `packages/gateway/src/bindings/backfill-runner.ts` (or similar — see
  deferred note)
- Modify: `packages/gateway/src/bindings/backfill-deny-keys-cli.ts`
- Test: `packages/gateway/src/bindings/backfill-deny-keys-cli.test.ts`

**Approach:**
- Move env reads, `createAppClient`, `createS3Adapter`, `createBindingsStore`, and
  the `writeBinding` closure into the runner. Use the **static** barrel import of
  `createS3Adapter` and call it with `(storeConfig, logger)` — mirroring
  `program.ts:170`. Drop the dynamic `import('@fro-bot/runtime')` + `typeof`
  branch.
- Expose a function like `runDenyKeyBackfill({dryRun, logger})` that builds deps
  and calls `backfillActiveBindingDenyKeys`, returning the result (or an exit
  code). The CLI module and the `main.ts` argv path both call it.

**Patterns to follow:** `program.ts` adapter/store/App-client construction; existing
CLI env-read + status-code-exit shape.

**Test scenarios:**
- Happy path: runner builds deps and calls `backfillActiveBindingDenyKeys` once
  (mocked) with a defined logger on the adapter (arity fix proven — adapter
  constructed with 2 args).
- Edge case: missing required env var → clear error / non-zero exit.
- Happy path: `dryRun` flag threads through to the backfill deps.

**Verification:** `createS3Adapter` is called with `(config, logger)`; no
dynamic-import branch remains; CLI test still passes via the runner.

- [x] **Unit 3: Split `main.ts` into an unconditional entrypoint + testable dispatch**

**Goal:** `node dist/main.mjs backfill-deny-keys [--dry-run]` runs the backfill and
exits; no subcommand runs the gateway unchanged — WITHOUT a fragile entry guard.

**Requirements:** R1, R2, R5

**Dependencies:** Unit 2

**Files:**
- Modify: `packages/gateway/src/main.ts` (becomes a tiny unconditional entrypoint)
- Create: `packages/gateway/src/main-dispatch.ts` (testable dispatch logic)
- Modify/Move: `packages/gateway/src/main.test.ts` → tests target `main-dispatch.ts`

**Approach (Oracle-reviewed):**
- The original `main.ts` ran `Effect.runPromise(program)` UNCONDITIONALLY at top
  level (no entry guard) — and that is the production guarantee we must preserve.
  Adding an `import.meta.url === \`file://${process.argv[1]}\`` guard introduces a
  catastrophic risk: if it ever evaluates false in the bundled `dist/main.mjs`, the
  gateway silently never starts. Unit tests calling dispatch directly would not
  catch it.
- Instead, SPLIT:
  - `main-dispatch.ts` exports `dispatchArgv()` (the `program` Effect + the argv
    branch: `backfill-deny-keys` → parse `--dry-run` → `runDenyKeyBackfill` →
    `process.exit(code)`; else `Effect.runPromise(program).catch(...)`). NO
    import-time execution — safe to unit-test.
  - `main.ts` becomes: `import {dispatchArgv} from './main-dispatch.js'` then a bare
    top-level `void dispatchArgv()`. No `import.meta.url` guard. Entrypoint files are
    allowed import-time side effects.
- Update tests to import `main-dispatch.js` (not `main.js`). The old
  no-import-time-side-effects test on `main.ts` is replaced by testing the dispatch
  module directly.

**Patterns to follow:** Oracle recommendation; keep `program` construction
identical to current `main.ts`.

**Test scenarios:**
- Happy path: argv `['node','main','backfill-deny-keys']` → `dispatchArgv` calls the
  runner (mocked) with `dryRun: false`, gateway program NOT started, exits with
  runner code.
- Happy path: `--dry-run` parsed → runner called with `dryRun: true`.
- Regression: no subcommand → gateway program path taken, runner NOT called.
- Edge case: unknown subcommand → falls through to gateway (runner not called).

**Verification:** with the subcommand the gateway program never starts and exits
with the runner's code; without it behavior matches today's unconditional start; no
`import.meta.url` guard remains.

- [x] **Unit 4: Make the gateway tsdown build hermetic (config-relative entry)**

**Goal:** building the gateway from a full-monorepo checkout resolves the GATEWAY's
`src/main.ts`, not the root action's `src/main.ts` — so the bundle is correct and
locally verifiable.

**Requirements:** R1 (the shipped bundle must contain the gateway + subcommand)

**Dependencies:** Unit 3

**Files:**
- Modify: `packages/gateway/tsdown.config.ts`
- Modify: `packages/gateway/package.json` (build script entry, if it hardcodes
  `src/main.ts`)

**Background:** `packages/gateway/tsconfig.json` has `rootDir: "../../"`, and the
build runs `tsdown src/main.ts`. From a full monorepo, the bare relative
`src/main.ts` can resolve the ROOT `src/main.ts` (the GitHub Action entry) instead
of the gateway's — the same non-hermetic fragility #847 fixed for `workspace-agent`.
Production Docker is unaffected (it copies only `packages/{runtime,gateway}/`), but
local builds bundle the wrong entry, blocking verification.

**Approach (Oracle-reviewed):** mirror the workspace-agent fix — compute the config
dirname via `fileURLToPath(import.meta.url)` and use an ABSOLUTE entry
`path.join(dirname, 'src/main.ts')` in `tsdown.config.ts`; align the `package.json`
build script to the config (drop the hardcoded relative `src/main.ts` arg if
present). Optionally add a bundle symbol guard asserting a gateway-only symbol
(e.g. `dispatchArgv`/`makeGatewayProgram`) is present (defer if it adds churn).
- DO NOT change gateway `tsconfig.json` `rootDir` to `"src"` here — Oracle flagged
  it may trip TS rootDir/project-reference errors because gateway includes runtime
  source; file that as a separate issue.

**Test scenarios:** none (build config). Verification is the build output.

**Verification:** a full-monorepo `bun run --filter @fro-bot/gateway build` produces
a `dist/main.mjs` whose bundle contains gateway symbols (`makeGatewayProgram`,
`dispatchArgv`) and NOT the action's `Starting Fro Bot Agent`; running
`node packages/gateway/dist/main.mjs` attempts gateway startup, and
`node packages/gateway/dist/main.mjs backfill-deny-keys --dry-run` dispatches the
backfill runner.

- [x] **Unit 5: Docs runbook**

**Goal:** operators have a documented runbook for the backfill command.

**Requirements:** R6

**Dependencies:** Unit 3

**Files:**
- Modify: `docs/plans/2026-06-19-002-feat-gateway-redaction-gate-plan.md`
- Modify: `packages/gateway/AGENTS.md`

**Approach:**
- Document the concrete command (`node dist/main.mjs backfill-deny-keys --dry-run`
  first, then without `--dry-run`) and required env vars in the redaction-gate
  plan's backfill section and `AGENTS.md`. NOTE: the gateway `dist/` is gitignored
  and built in the image — there is NO committed bundle to keep in sync (the
  original Unit 4 "rebuild + commit dist" was incorrect and is removed).

**Test scenarios:** none — docs only.

**Verification:** the runbook names the exact command and env vars; no claim that a
committed bundle must be rebuilt.

## System-Wide Impact

- **Interaction graph:** `main.ts` gains a pre-program argv branch; the gateway
  startup path is otherwise untouched. The backfill runner is reachable only from
  the CLI module and the argv branch — never from a request/route/command.
- **Error propagation:** runner failures surface as non-zero exit codes
  (`1` config/adapter/backfill failure, `2` partial per-binding failures), matching
  the existing CLI contract.
- **State lifecycle risks:** the backfill mutates the live primary binding records
  via unconditional overwrite. `--dry-run` is the mitigation; the operation is
  idempotent (keyed bindings are skipped).
- **Unchanged invariants:** surface-gate fail-closed-on-keyless behavior, the
  gateway daemon startup path, the Dockerfile, and the `tsdown` build-entry set are
  all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Backfill mutates the live bindings store incorrectly | `--dry-run` preview first; idempotent (skips keyed); per-binding fail-closed |
| Argv branch accidentally alters normal gateway startup | Regression test asserting no-subcommand path starts the gateway; branch is additive and exits early |
| Adapter still built with wrong arity after refactor | Unit 2 test asserts `createS3Adapter` called with `(config, logger)` |

## Documentation / Operational Notes

- Runbook (redaction-gate plan + `AGENTS.md`): set the gateway env vars
  (`GITHUB_APP_ID`/`_FILE`, `S3_BUCKET`, `AWS_*`, `GATEWAY_IDENTITY`), run
  `node dist/main.mjs backfill-deny-keys --dry-run` to preview, then re-run without
  `--dry-run`. Exit `0` = clean, `2` = some bindings failed (inspect logs).

## Sources & References

- Issue: #1000 (Fro Bot triage comment is the de-facto requirements spec)
- Unblocks: dashboard `/operator` live repos (depends on #1001, merged via #1020)
- Related code: `packages/gateway/src/bindings/backfill-deny-keys{,-cli}.ts`,
  `packages/gateway/src/main.ts`, `packages/gateway/src/program.ts:170`
- Related plan: `docs/plans/2026-06-19-002-feat-gateway-redaction-gate-plan.md`
