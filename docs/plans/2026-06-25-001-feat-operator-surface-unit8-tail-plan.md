---
title: "feat: Operator web surface Unit 8 tail — image-level route smoke + deploy runbook"
type: feat
status: active
date: 2026-06-25
---

# Operator web surface Unit 8 tail — image-level route smoke + deploy runbook

## Overview

The gateway operator web surface (auth, launch, repo query, run stream, approvals)
is functionally complete and live. The reconciliation that cut Unit 7
([agent#994](https://github.com/fro-bot/agent/pull/994)) narrowed the remaining
agent-side gate to the **Unit 8 operable tail**: R1 (deploy README route table)
already landed via [agent#996](https://github.com/fro-bot/agent/pull/996). This plan
closes the two remaining rungs:

- **R3** — a CI smoke that proves the operator routes actually register and respond
  in the **built Docker image**, not just at the unit-test level. The current
  `Gateway Image Smoke Test` only asserts config-load / no-module-crash; nothing
  proves the operator HTTP surface mounts in the shipped image.
- **R2** — a concise, consolidated **Operator Web Surface** runbook section in
  `deploy/README.md` (the operator-facing home), cross-linking the existing route
  table and the per-pattern solution docs. Chosen over a new
  `docs/solutions/` doc because six operator best-practice docs already exist and a
  seventh consolidated doc would overlap them; the deploy README is where an
  operator actually looks.

## Problem Frame

The operator producer is now genuinely live (route mounted via #1020, deny-key
backfill runnable via #1023), but two assurance gaps remain before the agent-side
operator gate is closed:

1. No image-level proof that `GET /operator/health`, `/operator`, `/operator/repos`,
   etc. register when the operator env is present — a regression that unmounts the
   operator server (like the #1001 `listBindings` wiring gap) would pass CI today
   because the smoke never boots the operator surface.
2. The operator deployment story is spread across `deploy/README.md`'s OAuth
   section, the route table from #996, and six `docs/solutions/best-practices/`
   pattern docs, with no single operator-facing entry point that ties them together.

## Requirements Trace

- R2. `deploy/README.md` has a consolidated "Operator Web Surface" runbook section
  that names the routes, the env needed to enable them, and links the existing
  route table + pattern docs — without duplicating their content.
- R3. The `Gateway Image Smoke Test` boots the built image with operator env and
  asserts the operator routes register and respond correctly (mounted, not 404),
  so an unmount/registration regression fails CI.

## Scope Boundaries

- No new operator routes, contract changes, or behavior changes — assurance + docs
  only.
- No new `docs/solutions/` doc (R2 satisfied in `deploy/README.md`; the six existing
  operator pattern docs stay authoritative for their patterns).
- No dashboard work — the fixture→live migration is downstream (`fro-bot/dashboard#48`).

### Deferred to Separate Tasks

- Dashboard fixture→live migration: `fro-bot/dashboard` (#48).
- Non-blocking #1000 review residuals (dynamic-import isolation, ESLint
  import-boundary rule, `readEnv` dedup): future gateway hardening pass.

## Context & Research

### Relevant Code and Patterns

- `.github/workflows/ci.yaml` — the `Gateway Image Smoke Test` job (build runtime +
  gateway, build Docker image with retries, then two smoke steps: "assert config
  load, not module crash" and the #738 "announce opt-out boots past config" step
  using a `docker run` with fake env). R3 adds a third smoke step following the
  #738 pattern but with operator env + a **running** (`-d`) container and host-side
  `curl` probes.
- `packages/gateway/src/program.ts:458` — operator server only starts when
  `config.operatorWeb !== undefined` AND `startOperatorServer` dep is present.
- `packages/gateway/src/config.ts:110,563` — `operatorWeb` is gated by
  `GATEWAY_OPERATOR_BIND_HOST` / `GATEWAY_OPERATOR_BIND_PORT` /
  `GATEWAY_OPERATOR_PUBLIC_ORIGIN` plus OAuth client id/secret and CSRF secret
  (`GATEWAY_OPERATOR_GITHUB_CLIENT_ID[_FILE]`,
  `GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET[_FILE]`, `GATEWAY_OPERATOR_CSRF_SECRET[_FILE]`).
- `packages/gateway/src/web/server.test.ts` — the unit-level registration test from
  #996 that asserts the operator route set registers when deps are present (the
  in-process analog of what R3 proves in-image).
- `deploy/README.md:261` — existing "Operator OAuth (Web Surface)" section (callback
  URL, credentials) and the route table from #996 — the anchor R2 consolidates from.
- `deploy/gateway.Dockerfile` — build stage has `curl`; final image has
  `netcat-openbsd` + a baked `HEALTHCHECK`. R3 probes from the **host** runner
  (ubuntu runners always have `curl`) against a published operator port.

### Institutional Learnings

- `docs/solutions/best-practices/` operator docs: `gateway-control-surface-spine-*`,
  `web-operator-launch-surface-*`, `authenticated-sse-run-observation-*`,
  `sse-output-streaming-terminal-drain-*`, `signed-webhook-ingress-hardening-*`,
  `gateway-opencode-mention-loop-*`. R2 links these rather than restating them.
- The #1001 regression class (an operator route silently unmounted because a dep
  wasn't wired) is exactly what R3's image-level smoke guards against.

## Key Technical Decisions

- **Probe from the host, not inside the container.** The R3 step runs the image with
  `docker run -d` publishing the operator bind port, waits for readiness, then
  `curl`s from the runner. Avoids depending on in-image HTTP tooling and matches how
  a real operator/browser reaches the surface.
- **Assert "mounted, not 404" as the core signal.** `GET /operator/repos`
  unauthenticated returns `401` when mounted (and `404` when not). Asserting
  `401`-not-`404` is the precise registration proof; `/operator` → `302` to the OAuth
  start and `/operator/health` → `200` corroborate. (Confirm exact unauth statuses
  against the route handlers during implementation; the assertion set adapts to the
  real codes, but the principle is "mounted route gives an auth/redirect response,
  unmounted gives 404".)
- **Reuse the #738 fake-env pattern for non-operator secrets.** The operator server
  needs `operatorWeb` config but the gateway also needs the core fake secrets
  (`DISCORD_TOKEN`, `S3_BUCKET`, etc.) to boot far enough to start the operator
  server. Mirror the existing #738 env block and add the `GATEWAY_OPERATOR_*` vars.
- **R2 lives in `deploy/README.md`, not a new solution doc** — operator-facing home,
  avoids a seventh overlapping operator doc.

## Open Questions

### Resolved During Planning

- New solution doc vs deploy/README for R2: **deploy/README** (avoids overlap with
  the six existing operator pattern docs; operator-facing home).
- In-container vs host-side probing for R3: **host-side `curl`** against a published
  port (no in-image tooling dependency).

### Deferred to Implementation

- The exact unauthenticated status codes per operator route (`/operator/repos`,
  `/operator/runs/...`) — read the handlers and pin the real codes in the smoke
  assertions. The invariant is "mounted ⇒ non-404 auth/redirect response".
- Whether the operator server binds before or after the gateway reports unhealthy
  with fake Discord credentials — determine the minimal env that lets the operator
  server listen, and the readiness signal to wait on (port-open via `nc`, or a
  bounded `curl` retry loop on `/operator/health`).

## Implementation Units

- [x] **Unit 1: Operator-route registration smoke via shared deps helper + diagnostic subcommand (R3)**

**Goal:** Prove the operator routes register in the shipped image using the SAME
deps-construction production wires — catching the #1001 route-unmount class (a route
gated on a runtime dep that `program.ts` forgets to pass) at the image level.

**Requirements:** R3

**Dependencies:** None

**Background (why HTTP-probing fails):** the operator HTTP server only starts in
`program.ts` AFTER `runProviderSelfTest` (fails with fake S3 creds) and
`registerSlashCommands` (fails with a fake Discord token), so it never binds in CI
without real backends. A static bundle/symbol check can't catch #1001 either (the
bug is a runtime deps-gating omission, not a missing symbol). The fix: evaluate
route registration with production's real deps construction, without starting the
server. `buildOperatorApp(deps, config): Hono` (`server.ts:336`) builds the app
without binding a port; its mount gates are deps-presence checks (e.g.
`GET /operator/repos` mounts only if `deps.listBindings !== undefined`,
`server.ts:647`). So a missing dep → the route is absent from `app.routes` → assertion
fails. This is the exact #1001 signal.

**Files:**
- Modify: `packages/gateway/src/program.ts` (extract the operator deps/config
  construction at lines ~461-535 into an exported `buildOperatorServerInputs(...)`
  helper; production calls it so the smoke and prod share one wiring path)
- Modify: `packages/gateway/src/main-dispatch.ts` (add an `operator-route-smoke`
  subcommand alongside the existing `backfill-deny-keys` dispatch)
- Create: `packages/gateway/src/web/operator-route-smoke.ts` (the diagnostic: build
  the operator inputs via the shared helper with realistic stub-but-present
  instances, call `buildOperatorApp`, assert the expected route inventory, exit 0/1)
- Test: `packages/gateway/src/web/operator-route-smoke.test.ts`,
  `packages/gateway/src/main-dispatch.test.ts` (extend), and a
  `buildOperatorServerInputs` test
- Modify: `.github/workflows/ci.yaml` (replace the config-acceptance step with one
  that runs `node dist/main.mjs operator-route-smoke` in the built image)

**Approach:**
- **Extract the shared helper.** Pull the `OperatorServerDeps` + `OperatorServerConfig`
  object construction (currently inline at `program.ts:499-535`, including the
  load-bearing `listBindings` wiring) into an exported `buildOperatorServerInputs(...)`
  that takes the program-scoped instances (logger, denylistCache, bindingsStore,
  runObservationManager, runIndex, sessionStore, githubOAuthDeps, operatorWeb config,
  etc.) and returns `{deps, config}`. Production's `startOperatorServer(...)` call
  passes the helper's output unchanged — behavior-identical. This is the seam that
  makes the smoke catch #1001: if a future edit drops a dep from the helper, BOTH
  production and the smoke lose it.
- **Diagnostic module.** `runOperatorRouteSmoke()` builds realistic-but-offline stub
  instances for the program-scoped deps (no real S3/Discord/network — the route
  mount gates only check presence/shape, not liveness), calls
  `buildOperatorServerInputs(...)` then `buildOperatorApp(deps, config)`, reads
  `app.routes`, and asserts the expected operator route set is present:
  `GET /operator/health`, `GET /operator/repos`, `GET /operator/runs/:runId/stream`,
  `GET /operator/runs/:runId/approvals`, `POST /operator/runs/:runId/.../decision`,
  `POST /operator/runs`, plus the OAuth/session routes. Missing any → non-zero exit
  with a clear message naming the absent route. Returns an exit code; the subcommand
  `process.exit`s with it (mirror the backfill runner's exit-code pattern).
- **Subcommand.** Add `operator-route-smoke` to `main-dispatch.ts`'s argv dispatch
  (same shape as `backfill-deny-keys`), with `--help`. Update the bundle symbol
  guard if needed (it asserts `dispatchArgv`).
- **CI step.** Replace the implemented config-acceptance step in the `Gateway Image
  Smoke Test` job with: `docker run --rm fro-bot-gateway:smoke operator-route-smoke`
  and assert exit 0 + an expected success marker. No env/creds needed (the smoke
  doesn't boot the gateway). Add `timeout-minutes`. Keep the two existing smoke steps.

**Execution note:** test-first for the diagnostic and the helper extraction — write
the route-inventory assertion and a "missing-dep ⇒ route absent ⇒ failure" test
before/alongside the extraction, so the #1001-class guard is proven non-vacuous.

**Patterns to follow:** the `backfill-deny-keys` subcommand + `parseBackfillArgs` +
exit-code shape in `main-dispatch.ts`/`backfill-runner.ts` (just shipped in #1023);
`buildOperatorApp` in `server.ts`; the existing `server.test.ts` registration test
(the in-process analog).

**Test scenarios:**
- Happy path: with all operator deps present, the diagnostic asserts the full
  operator route set is in `app.routes` and exits 0.
- Regression guard (the reason this exists): drop `listBindings` from the deps the
  helper produces (simulating #1001) → `GET /operator/repos` is absent from
  `app.routes` → diagnostic exits non-zero naming the missing route. Prove this is
  non-vacuous.
- Edge case: each gated route (run-stream, approvals) absent when its dep is missing
  → diagnostic fails, naming it.
- Subcommand dispatch: `operator-route-smoke` argv → runs the diagnostic, exits with
  its code; `--help` → usage, exit 0; no subcommand → gateway path unaffected.
- Helper parity: `buildOperatorServerInputs` returns deps that, fed to
  `buildOperatorApp`, mount the same route set production does (the helper extraction
  is behavior-preserving).

**Verification:** `node dist/main.mjs operator-route-smoke` in the built image exits
0 and reports the operator routes present; a simulated missing-dep makes it fail
naming the route; production startup is behavior-identical (the helper output equals
the previous inline object); the CI step is green and bounded; the two existing smoke
steps are unchanged.

- [x] **Unit 2: Consolidated Operator Web Surface runbook in deploy/README (R2)**

**Goal:** `deploy/README.md` has one operator-facing "Operator Web Surface" section
that ties together the route table, the enabling env, and the pattern docs.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `deploy/README.md`

**Approach:**
- Add/extend a consolidated "Operator Web Surface" section near the existing
  "Operator OAuth (Web Surface)" content (`deploy/README.md:261`). It should:
  - State what the surface is and the env required to enable it (the
    `GATEWAY_OPERATOR_*` bind/origin/OAuth/CSRF vars — reference, don't duplicate the
    full secrets table).
  - Point to the shipped route table (from #996) rather than re-listing routes.
  - Cross-link the relevant `docs/solutions/best-practices/` operator pattern docs
    (control-surface spine, launch surface, authenticated SSE observation, SSE output
    streaming, signed-webhook ingress) for the design rationale.
  - Note the deny-key backfill runbook (the `backfill-deny-keys` command documented
    in `packages/gateway/AGENTS.md`) as the step that makes pre-gate bindings appear
    in `GET /operator/repos`.
- Operator-facing prose only — no plan-speak, no process taxonomy.

**Patterns to follow:** the existing `deploy/README.md` operator/OAuth section style;
the route table from #996.

**Test scenarios:** Test expectation: none — docs only.

**Verification:** an operator can read one section in `deploy/README.md` and know
what the operator web surface is, what env enables it, where the route table is, and
where the design docs live, without that section duplicating the route table or the
pattern docs.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| The operator server may not bind with fake Discord/S3 env if startup ordering gates it behind a failing dependency | During implementation, determine the minimal env that lets the operator server listen; if the gateway must reach a later startup stage first, supply the minimal fake env (mirroring #738) so the operator server starts. If genuinely infeasible to boot the operator surface in-image without real backends, fall back to asserting the operator bind log line + keep the unit-level registration test as the contract, and document why. |
| Host→container port probing flakiness (timing) | Bounded readiness wait with a clear timeout-fail and `docker logs` on failure; `timeout-minutes` on the step. |
| Asserting exact status codes that differ from assumptions | Pin the real unauth codes by reading the handlers during implementation; assert the "mounted ⇒ non-404" invariant rather than a brittle exact code where the code is uncertain. |

## Documentation / Operational Notes

- R2 is itself the doc deliverable. No runbook/monitoring changes beyond the
  `deploy/README.md` consolidation.

## Sources & References

- Related PRs: [agent#994](https://github.com/fro-bot/agent/pull/994) (Unit 7 cut /
  reconciliation), [agent#996](https://github.com/fro-bot/agent/pull/996) (R1 route
  table + unit-level registration test), [agent#1020](https://github.com/fro-bot/agent/pull/1020)
  (#1001 route mount), [agent#1023](https://github.com/fro-bot/agent/pull/1023)
  (#1000 backfill runnable).
- Epic: [agent#907](https://github.com/fro-bot/agent/issues/907).
- Tracker: [fro-bot/.github#3512](https://github.com/fro-bot/.github/issues/3512).
- Related code: `.github/workflows/ci.yaml` (Gateway Image Smoke Test),
  `packages/gateway/src/program.ts`, `packages/gateway/src/config.ts`,
  `packages/gateway/src/web/server.test.ts`, `deploy/README.md`.
