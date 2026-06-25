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

- [ ] **Unit 1: Image-level operator-route registration smoke (R3)**

**Goal:** The `Gateway Image Smoke Test` boots the built image with operator env and
proves the operator routes register and respond (mounted, not 404) in the shipped
image.

**Requirements:** R3

**Dependencies:** None (extends the existing job)

**Files:**
- Modify: `.github/workflows/ci.yaml` (add a smoke step to the `Gateway Image Smoke
  Test` job)

**Approach:**
- After the existing "announce opt-out boots past config" step, add a step that runs
  the image detached (`docker run -d --name operator-smoke -p <hostport>:<operatorport>`)
  with the core fake secrets (mirror the #738 block) PLUS the `GATEWAY_OPERATOR_*`
  env needed to enable `operatorWeb`: bind host `0.0.0.0`, a bind port, a public
  origin, fake OAuth client id/secret, and a fake CSRF secret.
- Wait for the operator server to listen (bounded retry: `nc -z`/`curl` loop on the
  operator port, capped with a clear timeout-fail).
- `curl` from the host and assert the registration signals:
  - `/operator/health` → `200` (operator server up).
  - `/operator` → `302` (redirect to OAuth start — surface mounted).
  - `/operator/repos` (no auth) → mounted auth response (e.g. `401`), explicitly
    **not** `404` (the #1001 regression signal).
- Always `docker logs operator-smoke` on failure and `docker rm -f` in cleanup so
  the step is debuggable and leaves no container. Add `timeout-minutes` to the step.
- Keep the existing two smoke steps unchanged.

**Patterns to follow:** the existing #738 smoke step (`set +e` / capture output /
status checks / `grep` assertions) in the same job; the readiness-wait + host-curl
shape used elsewhere in CI for container probes.

**Test scenarios:**
- Happy path: image booted with operator env → `/operator/health` 200, `/operator`
  302, `/operator/repos` non-404 auth response → step passes.
- Regression guard (the reason this exists): if the operator routes do not mount
  (e.g. a future deps-wiring regression like #1001), `/operator/repos` returns 404 →
  the assertion fails the step. (Validated during implementation by temporarily
  asserting the inverse, or by reasoning from the #1001 case; do not ship the
  inverse assertion.)
- Edge case: operator server never binds within the timeout → bounded wait fails
  with a clear message + `docker logs`, not a hang.

**Verification:** the `Gateway Image Smoke Test` job has a new green step that boots
the operator surface and asserts the routes are mounted; a simulated unmount would
fail it; no leaked container; the step has a bounded timeout.

- [ ] **Unit 2: Consolidated Operator Web Surface runbook in deploy/README (R2)**

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
