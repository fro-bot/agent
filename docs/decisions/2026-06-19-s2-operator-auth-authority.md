---
title: 'S2 operator-auth authority: the Gateway operator-auth surface is the single authority'
status: accepted
date: 2026-06-19
issue: https://github.com/fro-bot/agent/issues/951
tracks: https://github.com/fro-bot/agent/issues/907
supersedes: []
---

## Status

Accepted (2026-06-19, ratified by @marcusrbrown on [#951](https://github.com/fro-bot/agent/issues/951)).

## Context

Two operator-auth systems existed in parallel:

- **Dashboard auth** (`fro-bot/dashboard`, read-only, shipped): GitHub OAuth via Arctic v3 (`src/auth/oauth.ts`) plus a signed-cookie session (`src/session.ts`, `src/routes/auth.ts`).
- **Gateway operator-auth** (S2, this repo, under [#907](https://github.com/fro-bot/agent/issues/907)): a hand-rolled GitHub OAuth PKCE + state flow, server-side opaque sessions, CSRF/origin guard, numeric-GitHub-user-ID allowlist, and per-repo authorization, all under `packages/gateway/src/web/auth/`.

For read-only Phase 1 the duplication was acceptable. The interactive phase must not grow two independent operator identity systems with divergent allowlists, revocation, CSRF posture, and cookie semantics. The two systems already diverged on stack (Arctic vs. hand-rolled PKCE), session model (signed-cookie vs. server-side opaque), and the gateway additionally owned CSRF, allowlist, and repo-authz that the dashboard did not.

## Decision

**The Gateway operator-auth surface is the single S2 authority. The dashboard delegates interactive operator auth to the gateway and does not maintain a parallel operator identity.**

The gateway operator-auth is live and verified end-to-end in production: PKCE + state OAuth, opaque server-side sessions, CSRF/origin guard, numeric-GitHub-user-ID allowlist, and repo-authz.

### Rationale

1. Interactive **launch** and **approval settlement** terminate at the gateway's single fail-closed gate (`launchWork`, `registry.handleDecision` — Phase A). The auth that issues those commands belongs at the same trust boundary.
2. The gateway already implements the harder, security-critical surface (PKCE + state, opaque sessions, CSRF/origin guard, allowlist, repo-authz). Re-deriving this in the dashboard would duplicate the most security-sensitive code.
3. The Phase B same-origin cookie posture (`GATEWAY_OPERATOR_PUBLIC_ORIGIN`) already assumes a separate dashboard origin proxies through the same public origin and rides the gateway session, rather than relying on cross-site cookies.

## Convergence path

- **Interactive dashboard actions authenticate via the gateway operator session** (same-origin through the gateway public origin), reusing the gateway allowlist, CSRF posture, revocation, and repo-authz.
- **The dashboard's read-only Arctic + signed-cookie session is retired.** The dashboard converges on the gateway session for all auth (read and interactive). There is **no transitional dual-session period**.
- **Single allowlist source of truth = the gateway's numeric-GitHub-user-ID allowlist.** The dashboard maintains no independent allowlist.

## Consequences

- Dashboard-side consuming work (retire Arctic session, ride gateway session, drop the independent allowlist) is tracked at `fro-bot/dashboard#53`.
- This decision was ratified **before** interactive command flows wire up, satisfying the sequencing gate from [#951](https://github.com/fro-bot/agent/issues/951). It does not block Phase B core (the gateway auth infrastructure is already complete) but does gate dashboard interactive integration.
- The Phase B plan (`docs/plans/2026-06-15-002-feat-gateway-web-operator-control-surface-plan.md`) and `packages/gateway/AGENTS.md` are aligned to name the gateway operator-auth surface as the single S2 authority.

## Alternative considered

**Shared hardened auth package** consumed by both the gateway and the dashboard. Viable, but it would require extracting the gateway auth into a separate package for less benefit, given that interactive launch and approval already live in the gateway. Rejected in favor of gateway-as-authority.
