---
date: 2026-06-15
topic: gateway-control-surface-spine
---

# Gateway inbound control surface + operator web auth (the spine)

## Problem Frame

The gateway (`packages/gateway`) is the live presence and execution engine for Fro Bot. Today every way to command it or approve its actions flows through Discord: `/fro-bot` slash commands, `@fro-bot` mention-triggered runs (`runMention`), and OpenCode `permission.asked` → Discord approval buttons. Its only inbound HTTP surface is `POST /v1/announce` (outbound presence announcements: `survey_completed` / `invitation_accepted` / `daily_digest`), authenticated by shared-secret HMAC over the raw body — there is no user/session auth and no inbound command, state, or query API.

This blocks the broader vision (see `fro-bot/.github` `docs/brainstorms/2026-06-15-fro-bot-personal-agent-north-star-requirements.md`): an operator dashboard that can launch work and approve actions from the web, push notifications with action handling, and agent-to-agent coordination all need an authenticated inbound web control surface. A read-only monitoring dashboard is already being built (`fro-bot/dashboard`), but its third data population — gateway repo↔Discord bindings — has no read path out of the gateway today.

This brainstorm scopes the spine: the inbound control surface, operator web auth, the transport-agnostic execution/approval refactor it requires, and a bindings read path. Tracking issue: [fro-bot/agent#907](https://github.com/fro-bot/agent/issues/907).

## Requirements

### Grounded constraints (verified current facts)

- **The ingress-pin constraint (load-bearing):** `packages/gateway/src/http/ingress-pin.test.ts` statically scans gateway source and asserts exactly one `serve()` call, located in `server.ts`. Rationale: the gateway is workspace-reachable over sandbox-net, so any new inbound listener could reopen the egress trust boundary (a workspace-reachable endpoint doing outbound requests would let the workspace bypass the mitmproxy egress filter). A new control surface must therefore be a separate listener on a non-sandbox-net interface (preferred) OR a deliberately-reviewed `EXPECTED_ROUTES`/pin update + deploy/README egress-topology update + security review. This is a hard architectural gate, not a detail.
- **Execution is Discord-coupled:** `packages/gateway/src/execute/run.ts` exports `runMention(message: Message, binding: RepoBinding, deps)` — the entry point still takes a Discord `Message`. `packages/gateway/AGENTS.md` explicitly notes that mention-triggered execution and `addProject` are Discord-only and that a Discord-independent execution primitive is "deferred until a non-Discord caller exists." This spine is that caller.
- **Approvals are Discord-hard-coupled:** `packages/gateway/src/approvals/coordinator.ts` and `registry.ts` bridge OpenCode `permission.asked`/`replied` to Discord buttons. The coordinator/registry are not transport-agnostic yet. Fail-closed semantics exist (timeout/restart → reject/dispose). A web approval path must reuse the same fail-closed gate by construction, not a parallel one.
- **Auth is HMAC-only:** `packages/gateway/src/http/hmac.ts` (raw-body HMAC, `REPLAY_WINDOW_MS=5min`, constant-time, fail-closed) + `config.ts` secret loading (`readSecret`/`readMultilineSecret`, `*_FILE` precedence, `O_NOFOLLOW`). No user/session/browser-auth concept exists anywhere — operator web auth is genuinely net-new.
- **Bindings store:** `packages/gateway/src/bindings/store.ts` `createBindingsStore({adapter, storeConfig, identity})` exposes `createBinding` / `getBindingByRepo` / `getBindingByChannelId` / `listBindings` (create/read/list only, no delete/update), S3-backed via `@fro-bot/runtime` `ObjectStoreAdapter`. `RepoBinding = {owner, repo, channelId, channelName, workspacePath, createdAt, createdByDiscordId}`. There is no HTTP/read surface exposing bindings outside the gateway process today.
- **`@fro-bot/runtime` scope:** `packages/runtime` (`private: true`) exports shared/session/coordination/object-store/agent primitives. The gateway's HTTP/Hono primitives (server bootstrap, HMAC, replay-cache, rate-limit) and the GitHub App client are still gateway-local, not extracted. Extraction is related future work, not in scope here.

### Phase A — Transport-agnostic execution + approval extraction

_No new listener, no new auth. The prerequisite every web path needs and the "non-Discord caller" the `AGENTS.md` note defers to._

- A1. Extract a transport-agnostic `launchWork(request, deps)` core from `runMention` so both the Discord path and a future web caller invoke the same execution engine. `runMention` becomes a thin Discord adapter over it.
- A2. Generalize the approval coordinator/registry so a decision can arrive from Discord OR a future web operator surface, preserving fail-closed/timeout/restart semantics by construction — one gate, multiple transports.
- A3. No behavior change to the Discord experience. This is a refactor that adds a seam, not a feature.
- A4. The new `launchWork` seam and the generalized approval gate are covered by tests before Phase B begins.

### Phase B — Inbound web control surface (S1) + operator web auth (S2)

_Depends on Phase A._

- B1. A separate authenticated inbound listener — honoring the ingress-pin egress boundary (separate interface/port, not sandbox-net-reachable; or a deliberately-reviewed pin update) — exposing: launch a unit of work, query run/agent state, stream state back.
- B2. Operator web auth (S2): a real browser auth/session model (operator identity, sessions, revocation, CSRF/origin binding) replacing shared-secret-HMAC-only for this surface. The security keystone, treated as first-class hard work, not Discord parity.
- B3. Web-launched work routes through the same fail-closed approval gate as Discord work (depends on A2). No parallel approval path.
- B4. The ingress-pin constraint is either honored (separate listener on a non-sandbox-net interface) or deliberately and reviewably updated with a documented egress-topology rationale.

### Phase C — Bindings read path

_Unblocks the dashboard's third data population. Depends on Phase B's authenticated surface or ships as a minimal read endpoint._

- C1. A read surface for gateway bindings (`listBindings` / `getBindingByRepo`) consumable by the dashboard — either via the authenticated control surface from Phase B, or a minimal read endpoint, honoring the same egress/auth boundaries.
- C2. No write or create capability over this path in v1.

## Success Criteria

- Each phase is independently shippable and reviewable.
- Phase A ships with zero Discord behavior change; the new `launchWork` core and generalized approval gate are covered by tests.
- The ingress-pin constraint is either honored (separate listener) or deliberately and reviewably updated — never silently bypassed.
- Web auth is real session auth (operator identity, sessions, revocation, CSRF/origin binding), not shared-secret HMAC repurposed for a browser.
- Web-launched work cannot bypass the fail-closed approval gate; the same coordinator/registry handles all transports.
- The bindings read path exposes no write capability.

## Scope Boundaries

- **Not in scope:** building the dashboard app (`fro-bot/dashboard` is a separate repo and effort).
- **Not in scope:** agent-to-agent negotiation (north-star frontier, later).
- **Not in scope:** real-time push notifications (later).
- **Not in scope:** write/create over the bindings read path in v1.
- **Not in scope:** extracting `@fro-bot/runtime` as part of this work. The gateway's HTTP primitives and GitHub App client are extraction candidates, but that is its own effort.

## Key Decisions

- **Separate listener strongly preferred over pin-update.** A separate listener on a non-sandbox-net interface respects the egress boundary with the least risk and the clearest security story. A pin-update is permissible only with a deliberate, documented, reviewed rationale.
- **Phase A first.** It is the lowest-risk, highest-leverage move: it unblocks every web path, resolves the deferred `AGENTS.md` note, and produces a testable seam before any new listener or auth lands.
- **One approval gate, shared across transports.** The fail-closed coordinator/registry is the trust anchor. A parallel web gate would be a security regression by construction.
- **Operator web auth is net-new and security-critical.** It is not a thin wrapper over HMAC. It requires a real session model, operator allowlist, revocation, and CSRF/origin binding — designed and reviewed as a first-class security primitive.

## Dependencies / Assumptions

- The ingress-pin egress-boundary decision must be settled in review before any new listener lands. The preferred path (separate non-sandbox-net interface) needs confirmation that the deploy topology (`marcusrbrown/infra` gateway compose + mitmproxy egress filter) can keep it off sandbox-net.
- Phase B and Phase C depend on Phase A's `launchWork` seam and generalized approval gate.
- Assumes the separate-listener interface can be made non-sandbox-net-reachable in the deploy topology.

## Outstanding Questions

- **Separate listener bind interface/port:** which interface and port, and how does the deploy topology (`marcusrbrown/infra`) keep it off sandbox-net? Needs coordination with infra.
- **Web auth mechanism:** GitHub OAuth operator allowlist + signed cookie (mirroring the dashboard's own auth)? Or device-flow/token? What is the operator allowlist source of truth?
- **State-stream transport:** SSE vs. WebSocket vs. poll for streaming run/agent state back to the web caller?
- **Phase C delivery:** does the bindings read path ride Phase B's authenticated surface, or ship as a separate minimal read endpoint? The answer affects sequencing and the auth surface area.

## Next Steps

→ Run `ce:plan` against this brainstorm to produce `docs/plans/2026-06-15-001-feat-...`, starting with Phase A as the first buildable plan or a phased plan covering all three phases.

Reference the north-star (`fro-bot/.github` `docs/brainstorms/2026-06-15-fro-bot-personal-agent-north-star-requirements.md`) and the dashboard requirements as upstream context. Tracking issue: [fro-bot/agent#907](https://github.com/fro-bot/agent/issues/907).
