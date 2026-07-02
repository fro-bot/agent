---
title: "feat: Gateway announce webhook (POST /v1/announce) for control-plane presence messages"
type: feat
status: active
date: 2026-05-29
origin: https://github.com/fro-bot/agent/issues/671
deepened: 2026-05-29
---

# feat: Gateway announce webhook (POST /v1/announce)

## Overview

Add a signed HTTP webhook to the gateway so the control plane (`fro-bot/.github`) can post presence messages in Discord **as the Fro Bot user** when notable autonomous activity happens (surveys completing, collaboration invitations accepted). Discord webhooks post as a webhook bot, not as the user; the gateway already holds `DISCORD_TOKEN` and a live discord.js `Client`, so it is the natural place to turn a signed POST into a user-posted Discord embed.

This plan covers the **gateway side only**. The control-plane side (event detection, payload construction, HMAC signing, POST + retry) is separate work in `fro-bot/.github`.

## Problem Frame

The gateway has no HTTP surface today — it is a long-lived Discord bot process wired through `makeGatewayProgram` (Effect.gen) with Discord client events only. We need a minimal, authenticated, single-route HTTP server that:

1. Accepts a signed `POST /v1/announce` from the control plane.
2. Verifies authenticity (HMAC-SHA256, constant-time) and freshness (replay window).
3. Validates the payload shape (two v1 event types; unknown → reject).
4. Posts a Discord embed to a fixed presence channel via the existing client.
5. Logs an auditable accept/reject trail without ever echoing the body.

See origin: https://github.com/fro-bot/agent/issues/671 (issue body + Fro Bot triage comment together form the requirements).

## Requirements Trace

- **R1.** `POST /v1/announce` over HTTP, path-versioned, authenticated. (origin: Endpoint)
- **R2.** HMAC-SHA256 auth with shared secret; constant-time comparison; `X-Gateway-Signature` (hex) + `X-Gateway-Timestamp` (ISO8601) headers. (origin: Authentication)
- **R3.** Replay protection: reject when `|now - timestamp| > 5 min` (both directions). (origin: Replay protection)
- **R4.** Signature binds the timestamp: HMAC is computed over `timestamp + "." + rawBody`; `X-Gateway-Timestamp` is the **exact literal string** used in the HMAC, and the body `fired_at` must equal it by **exact-string comparison before any date parsing**. (origin: Authentication + Canonicalization; **decision flips the issue's "parse + re-serialize" lean to raw-bytes + signed timestamp** — see Key Technical Decisions)
- **R4a.** Replay cache (v1, required): a duplicate valid request within the window posts a duplicate Discord message — the action is NOT idempotent — so a seen-signature cache (TTL ≥ window) rejects exact replays. (security review; reverses the issue's "LRU optional" lean)
- **R5.** Payload v1: `{v:1, event_type, fired_at, context, rendered_text}`; two event types (`invitation_accepted`, `survey_completed`); unknown `event_type` → 4xx. (origin: Payload contract)
- **R6.** `rendered_text` forward-compat: if non-null, use verbatim as message content; if null, fall back to gateway-side template for the event type. (origin: v2 forward compatibility)
- **R7.** Single channel routing via `GATEWAY_PRESENCE_CHANNEL_ID` env (never from payload). (origin: Channel routing)
- **R8.** Post a Discord embed with event-type accent color via the existing client; return 2xx after Discord accepts; 5xx on Discord failure (control plane retries once); best-effort, no queue. (origin: Posting behavior)
- **R9.** Observability: log accepted (`event_type`, `fired_at`, Discord status) and rejected (`hmac_invalid`/`timestamp_expired`/`unknown_event_type`/`malformed_body`) requests — never echo `context` or `rendered_text`. (origin: Observability)
- **R10.** DoS posture: 8 KB max body enforced before hashing/parsing; soft per-identity rate limit (~60/min). (origin: DoS posture)
- **R11.** Config: `GATEWAY_WEBHOOK_SECRET` (required), `GATEWAY_PRESENCE_CHANNEL_ID` (required), `GATEWAY_HTTP_PORT` (optional, default 3000) — `GATEWAY_` prefix is the operator-facing contract used consistently across config, plan, and deploy. (origin: Deployment + triage open questions)
- **R12.** HTTP server lifecycle integrates with the existing shutdown drain. (origin: triage Architecture notes)

## Scope Boundaries

- No two-way conversation features; existing `@fro-bot` mention handling is unchanged.
- No multi-channel routing — single presence channel in v1.
- No LLM composition of message text — v1 control-plane payloads emit `rendered_text: null` and the gateway renders from templates. The gateway still **accepts** non-null `rendered_text` for forward-compat (R6), but treats it as untrusted (see mention-sanitization decision).
- High-risk privacy events (visibility transitions, integrity alerts) are NOT in scope — those stay on GitHub issue surfaces.
- No mTLS / OAuth — trust boundary is the shared secret + replay window.

### Deferred to Separate Tasks

- **Control-plane side** (event detection, payload construction, HMAC signing, POST + retry): separate work in `fro-bot/.github`. **This plan's R4 decision changes that spec** — the control plane must sign `timestamp + "." + rawBody` and send those exact bytes (see Documentation / Operational Notes).
- **Deploy wiring** (`GATEWAY_WEBHOOK_SECRET` secret + `GATEWAY_PRESENCE_CHANNEL_ID` env): separate PR in `marcusrbrown/infra`. Prerequisite for end-to-end testing, not for the gateway build.
- **Fast-follower event types** (`reconcile_notable` purple, `wiki_lint_findings` yellow): out of scope, but the template registry leaves stub slots so adding them is a one-liner.

## Context & Research

### Relevant Code and Patterns

- `packages/gateway/src/program.ts` — `makeGatewayProgram(deps, config)` Effect.gen program. HTTP server wires in after `installShutdownHandlers`, around `deps.login`. `GatewayProgramDeps` is the injection seam (testable-factory pattern: `makeClient`, `setupReadinessFlag`, `login`).
- `packages/gateway/src/config.ts` — `GatewayConfig` interface + `loadGatewayConfig()`. `readSecret(name)` (checks `${NAME}_FILE` then env, throws if missing), `readOptionalSecret(name)` (returns null, trims, rejects embedded newlines, `O_NOFOLLOW` + fstat + 4 KB cap).
- `packages/gateway/src/shutdown.ts` — `installShutdownHandlers(client, logger, drainMs)`; races `client.destroy()` against a drain timer; `isShuttingDown()` getter. Signature widens to also close the HTTP server.
- `apps/workspace-agent/src/server.ts` + `main.ts` — Hono + `@hono/node-server` reference: `createApp(deps)`, `serve({fetch, port, hostname})`, server handle `.close()` in SIGTERM drain, content-length body guard. **Note:** uses `c.req.json()` — no raw-body capture; the webhook needs `c.req.arrayBuffer()` instead.
- `packages/gateway/src/discord/commands/add-project.ts:~572` — embed posting pattern: `channel.send({embeds:[{title, description, color: 0x57f287}]})`, plain object literals (not `EmbedBuilder`), send failures caught + logged via `logger.warn(ctx, msg)`.

### Institutional Learnings

- `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md` — **never log request/response bodies that can carry secrets; enforce with a captured-logger test across all error paths.** Directly governs R9. Also: test the real bootstrap/dispatch path, not just the handler.
- `docs/solutions/best-practices/architectural-issues-type-safety-and-resource-cleanup.md` — **shutdown belongs in `finally` with its own guarded try/catch so teardown can't be masked by a business-logic error.** Governs R12 server lifecycle.
- No existing repo learnings for HMAC / canonical JSON / Effect Schema / Hono DoS hardening — fresh territory; document the pattern after implementation (`ce:compound` candidate).

### External References

- RFC 8785 (JSON Canonicalization Scheme) and RFC 2104 (HMAC) — basis for the raw-bytes + signed-timestamp decision.
- Stripe webhook signing (`t=<ts>,v1=<sig>`, HMAC over `timestamp + "." + body`) and GitHub webhook validation — the dominant industry pattern this plan adopts.
- Node `crypto.timingSafeEqual` — must guard length-mismatch (throws otherwise); compare Buffers, not hex strings.
- OWASP REST Security Cheat Sheet — body-size cap before processing (413), fail closed.
- Effect 3.21.x Schema: `Schema.Union(Schema.Struct, Schema.Struct)` discriminated on `Schema.Literal(event_type)`, `Schema.decodeUnknownEither`, surface only `ParseError.message`.
- Hono 4.12.x: `c.req.arrayBuffer()` for byte-exact body, `c.req.header(...)`, `c.json(body, status)`.

## Key Technical Decisions

- **Raw-bytes + signed timestamp (Stripe-style), NOT parse-then-re-serialize.** The gateway HMACs the exact received body bytes; the signature covers `timestamp + "." + rawBody`. The `X-Gateway-Timestamp` header is the signed material and must equal the body's `fired_at`. This flips the issue's stated lean — chosen because it eliminates intermittent auth failures from JSON-implementation drift between the two repos (number formatting, Unicode normalization, key order), is less gateway code (no canonicalization step), and matches the dominant industry pattern. Cost: the control-plane spec must sign raw bytes. (Decision confirmed with maintainer.)
- **Hono + `@hono/node-server`**, not hand-rolled `node:http`. Already a proven, security-hardened dependency in `apps/workspace-agent` (`hono@4.12.23`, `@hono/node-server@1.19.14`); gives body-size handling and clean routing for free.
- **Effect Schema for payload validation** — first use in the repo; AGENTS.md already earmarks Schema for "Unit 6+". `Schema.Union` of two structs; `decodeUnknownEither`; unknown `event_type` fails decode → 4xx.
- **Plain HTTP internally** — TLS terminates at the ingress/load balancer in `marcusrbrown/infra`. Document the assumption; do not add TLS to the gateway binary. (Resolves a triage open question.)
- **Port via `GATEWAY_HTTP_PORT`, default 3000.** (Resolves a triage open question.)
- **Replay cache IS in v1** — reversing the issue's "optional" lean. Posting a Discord message is not idempotent, so a valid request replayed within the ±5 min window would post a duplicate. A per-secret in-memory seen-signature cache (key = signature hex, TTL = window + small buffer) rejects exact replays. In-memory is acceptable for single-instance v1; a restart or multi-instance deploy reopens the window (documented limitation).
- **`rendered_text` is untrusted → mention-safe rendering.** Even though v1 control-plane payloads emit null, the gateway accepts non-null for forward-compat and must treat it as attacker-controllable (compromised/buggy control plane). Render it as the embed **description** only (embed descriptions do not trigger pings), and set `allowedMentions: {parse: []}` on the announce send (stricter than the client-global `{parse: ['users']}`) as defense-in-depth. Never place payload-derived text in raw message `content`.
- **Exact-string timestamp binding** — `X-Gateway-Timestamp` is the literal string fed into the HMAC; `fired_at` is compared to it by exact-string equality BEFORE any date parsing, so a semantically-equal but byte-different timestamp cannot slip through.
- **Generic auth-failure responses** — `hmac_invalid` and `timestamp_expired` return the same status/body to the caller (no oracle); the precise reason is logged server-side only. Auth failures → 401; malformed/bad JSON/missing headers → 400; oversized → 413; unknown event_type → 400 (catch contract drift loudly, per the issue).
- **HTTP server lifecycle as an injected factory** in `GatewayProgramDeps` (e.g., `startAnnounceServer`), mirroring `makeClient`/`login`, so program tests assert wiring without binding a real port.
- **Embed templates as a registry keyed by `event_type`**, with stub slots for the two fast-follower types, so v2 additions are one-liners.

## Open Questions

### Resolved During Planning

- Canonicalization contract: **raw-bytes + signed timestamp** (see Key Technical Decisions).
- HTTP library: **Hono** (matches workspace-agent).
- HTTP vs HTTPS at the binary: **plain HTTP**, TLS at ingress.
- Port: **`GATEWAY_HTTP_PORT`, default 3000**.
- Replay cache: **included in v1** (in-memory seen-signature cache) — reversed from the issue's "optional" lean because the Discord post is not idempotent.
- Effect Schema vs Zod: **Effect Schema** (in-ecosystem, first wiring).
- Env-var namespace: **`GATEWAY_*` prefix** (`GATEWAY_WEBHOOK_SECRET`, `GATEWAY_PRESENCE_CHANNEL_ID`, `GATEWAY_HTTP_PORT`) — matches the deploy contract in the issue + `marcusrbrown/infra`. (Note: existing gateway secrets like `DISCORD_TOKEN`/`S3_BUCKET` are unprefixed, but the announce contract is operator-facing and the issue specifies the `GATEWAY_` names — align to those.)

### Deferred to Implementation

- Exact `ParseError.message` → rejection-reason mapping string (resolve against real decode output; must not echo payload).
- Whether the token-bucket key is source IP or a per-secret identity header (depends on what the ingress forwards; default to IP, revisit if ingress masks it).
- Final embed copy/wording for each event type (in-character voice; iterate during implementation against the template hints).

## Output Structure

    packages/gateway/src/
    ├── http/
    │   ├── server.ts            # Hono app + serve() lifecycle (createAnnounceServer)
    │   ├── server.test.ts
    │   ├── hmac.ts              # verifyHmac (timing-safe) + timestamp binding
    │   ├── hmac.test.ts
    │   ├── announce-schema.ts   # Effect Schema payload union + decode
    │   ├── announce-schema.test.ts
    │   ├── announce-handler.ts  # route handler: size→hmac→timestamp→decode→post
    │   ├── announce-handler.test.ts
    │   ├── templates.ts         # event_type → embed registry (+ fast-follower stubs)
    │   ├── templates.test.ts
    │   ├── rate-limit.ts        # in-memory token bucket
    │   ├── rate-limit.test.ts
    │   ├── replay-cache.ts      # seen-signature cache (TTL = window + buffer)
    │   └── replay-cache.test.ts
    └── discord/
        └── presence.ts          # resolve presence channel by ID + post embed
        └── presence.test.ts

## Implementation Units

- [ ] **Unit 0: Add Hono dependency to the gateway package**

**Goal:** Make `hono` + `@hono/node-server` available to `packages/gateway` so Unit 6 can compile. They currently exist only in `apps/workspace-agent/package.json`, NOT in the gateway.

**Requirements:** (enables R1, R10)

**Dependencies:** None — must land before Unit 6.

**Files:**
- Modify: `packages/gateway/package.json`
- Modify: `pnpm-lock.yaml` (via `pnpm install`)

**Approach:**
- Add `hono` and `@hono/node-server` to `packages/gateway/package.json` dependencies, pinned to the exact versions already used in `apps/workspace-agent` (`hono@4.12.23`, `@hono/node-server@1.19.14`) to keep the monorepo on one version. Run `pnpm install` to update the lockfile.
- These versions are post-advisory (the workspace-agent bump in PR #674 moved both past their GHSAs) — do not downgrade.

**Test expectation:** none — dependency manifest change. Verified by Unit 6 compiling and `pnpm --filter @fro-bot/gateway build` succeeding.

**Verification:** `hono` resolves in the gateway package; `pnpm install` leaves a clean lockfile; no version divergence from workspace-agent.

- [ ] **Unit 1: Config — webhook secret, presence channel, HTTP port**

**Goal:** Thread the three new config values through `GatewayConfig` and `loadGatewayConfig()`.

**Requirements:** R11

**Dependencies:** None

**Files:**
- Modify: `packages/gateway/src/config.ts`
- Modify: `packages/gateway/src/config.test.ts`

**Approach:**
- Add `webhookSecret: string` (`readSecret('GATEWAY_WEBHOOK_SECRET')`), `presenceChannelId: string` (`readSecret('GATEWAY_PRESENCE_CHANNEL_ID')`), `httpPort: number` to `GatewayConfig`.
- `httpPort`: parse `readOptionalSecret('GATEWAY_HTTP_PORT') ?? '3000'` with `Number.parseInt`; validate it's a finite integer in 1–65535, throw a clear error otherwise.
- Note: existing gateway secrets (`DISCORD_TOKEN`, `S3_BUCKET`) are unprefixed; the new announce vars intentionally use the `GATEWAY_` prefix to match the issue + infra deploy contract.
- Follow the existing required-vs-optional validation + error-message style exactly.

**Patterns to follow:** existing `readSecret`/`readOptionalSecret` calls and validation in `config.ts`.

**Test scenarios:**
- Happy path: all three present → config populated; `HTTP_PORT` unset → defaults to 3000.
- Edge case: `HTTP_PORT` = `"0"`, `"70000"`, `"abc"` → throws with a clear message.
- Error path: missing `WEBHOOK_SECRET` or `PRESENCE_CHANNEL_ID` → throws "Missing required secret".
- Edge case: `WEBHOOK_SECRET_FILE` path read works (file convention), trailing newline trimmed.

**Verification:** `loadGatewayConfig()` returns the new fields; missing required secrets fail fast; invalid port rejected.

- [ ] **Unit 2: HMAC verification + timestamp binding (pure utility)**

**Goal:** A pure, well-tested module that verifies an HMAC-SHA256 signature over `timestamp + "." + rawBody` and enforces the replay window.

**Requirements:** R2, R3, R4

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/http/hmac.ts`
- Test: `packages/gateway/src/http/hmac.test.ts`

**Approach:**
- `verifyHmac(secret, rawBody: Buffer, timestampHeader: string, signatureHex: string): {ok: true} | {ok: false; reason}`.
- Compute `createHmac('sha256', secret).update(timestampHeader + '.' ).update(rawBody).digest()`; decode `signatureHex` via `Buffer.from(sig, 'hex')`; **guard length mismatch before `timingSafeEqual`** (it throws otherwise); compare Buffers, not hex strings.
- Separate `checkTimestamp(timestampHeader, now, windowMs)` → reject when `|now - ts| > 5 min` (both directions); reject unparseable timestamps.
- Keep both pure (inject `now` for testability). The handler (Unit 5) cross-checks header timestamp == body `fired_at`.

**Execution note:** Implement test-first — this is the security core; pin every rejection branch with a failing test before the implementation.

**Patterns to follow:** Node `node:crypto` (`createHmac`, `timingSafeEqual`).

**Test scenarios:**
- Happy path: correct secret + matching signature over `ts.body` → ok.
- Error path: wrong secret → reject; tampered body (1 byte) → reject; tampered timestamp → reject (proves timestamp is bound into the signature).
- Edge case: signature hex of wrong length → reject WITHOUT throwing (length guard).
- Edge case: malformed hex (odd length / non-hex chars) → reject, no throw.
- Replay: timestamp 6 min old → reject; 6 min in the future → reject; within ±5 min → ok; unparseable timestamp → reject.
- Security: equal-length-but-wrong signature still uses `timingSafeEqual` (no early-return shortcut).

**Verification:** every tampering and skew case rejects; only an exact match within window passes; no input shape throws.

- [ ] **Unit 3: Announce payload schema (Effect Schema)**

**Goal:** Validate the decoded JSON into a typed `AnnouncePayload`, rejecting unknown event types.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Create: `packages/gateway/src/http/announce-schema.ts`
- Test: `packages/gateway/src/http/announce-schema.test.ts`

**Approach:**
- `Schema.Union` of `InvitationAccepted` and `SurveyCompleted` structs, each with `v: Schema.Literal(1)`, `event_type: Schema.Literal(...)`, `fired_at: Schema.String` (keep as string; add an ISO-8601 refinement — `Schema.Date` is too permissive), event-specific `context` struct, `rendered_text: Schema.NullOr(Schema.String)`.
- Export `decodeAnnounce(input: unknown): Either<reason, AnnouncePayload>` via `Schema.decodeUnknownEither`; map `ParseError` to a short reason string that does NOT include payload content.

**Technical design:** *(directional — not implementation spec)*

    Payload = Union(
      Struct{ v:Literal(1), event_type:Literal("invitation_accepted"),
              fired_at:ISOString, context:Struct{count:Number, repos:Array(Struct{owner,name})},
              rendered_text:NullOr(String) },
      Struct{ v:Literal(1), event_type:Literal("survey_completed"),
              fired_at:ISOString, context:Struct{owner,repo,slug,wiki_pages_changed:Number},
              rendered_text:NullOr(String) },
    )

**Patterns to follow:** Effect Schema (new in repo) — `Schema.Struct`, `Schema.Literal`, `Schema.Union`, `Schema.NullOr`, `Schema.decodeUnknownEither`.

**Test scenarios:**
- Happy path: valid `invitation_accepted` and `survey_completed` payloads decode to typed values.
- Error path: unknown `event_type` → Left (reason). `v: 2` → Left. Missing `context` keys → Left. Wrong `context` type for the event → Left.
- Edge case: `rendered_text` null → ok; non-null string → ok. Malformed `fired_at` (not ISO) → Left.
- Security: rejection reason string contains no `context`/`rendered_text` values (assert it doesn't include a planted repo name).

**Verification:** valid payloads decode; every malformed shape returns Left with a content-free reason.

- [ ] **Unit 4: Presence channel posting helper**

**Goal:** Resolve the presence channel by ID and post an embed via the existing discord.js client.

**Requirements:** R7, R8

**Dependencies:** None (consumes `presenceChannelId` from config at call time)

**Files:**
- Create: `packages/gateway/src/discord/presence.ts`
- Test: `packages/gateway/src/discord/presence.test.ts`

**Approach:**
- `postPresenceEmbed(client, channelId, embed): Promise<Result<void, PresenceError>>`.
- Resolve via `client.channels.fetch(channelId)` (this lookup does NOT exist in the gateway yet); guard that the resolved channel exists and is text-sendable (`isTextBased()` / has `.send`); on missing/wrong-type channel → typed error (do not throw).
- `channel.send({embeds: [embed], allowedMentions: {parse: []}})` — the explicit empty `allowedMentions` is mandatory (stricter than the client-global `{parse: ['users']}`) so payload-derived embed text can never trigger a ping. Map a send failure to a typed error so the handler returns 5xx.
- Never include the embed/message content in error logs.

**Patterns to follow:** `add-project.ts` embed object-literal shape + `0x57f287` color convention; its catch-and-log failure handling.

**Test scenarios:**
- Happy path: valid text channel → `send` called with the embed; returns ok.
- Error path: `channels.fetch` returns null → typed error, no throw. Resolved channel not text-based → typed error. `send` rejects (Discord API failure) → typed error (maps to 5xx upstream).
- Integration: assert the exact embed object passed to `send` (mock client), proving the template wiring.

**Verification:** posts to the configured channel; all failure modes return typed errors, never throw, never log content.

- [ ] **Unit 5: Embed templates registry**

**Goal:** Map `event_type` → embed (accent color + in-character text), honoring `rendered_text` override.

**Requirements:** R6, R8

**Dependencies:** Unit 3 (payload types)

**Files:**
- Create: `packages/gateway/src/http/templates.ts`
- Test: `packages/gateway/src/http/templates.test.ts`

**Approach:**
- `renderEmbed(payload): Embed`. If `payload.rendered_text` is non-null → use it verbatim as the description; else render from a per-`event_type` template.
- `invitation_accepted` → blue accent, "Just accepted N collaboration invitation(s): …"; `survey_completed` → green accent, "Surveyed owner/repo, added N wiki entries".
- Registry keyed by `event_type` with explicit stub entries for `reconcile_notable` (purple) and `wiki_lint_findings` (yellow) marked "v2 — not yet emitted" so adding them later is a one-liner.

**Patterns to follow:** `add-project.ts` embed literal shape.

**Test scenarios:**
- Happy path: each v1 event_type → correct accent color + text incorporating context (count/repos; owner/repo/pages).
- Edge case: `rendered_text` non-null → used verbatim, template ignored, accent still by event_type.
- Edge case: `invitation_accepted` with count 0 / many repos → text reads correctly.

**Verification:** correct color + copy per type; `rendered_text` override wins.

- [ ] **Unit 6: HTTP server + announce route handler**

**Goal:** The Hono server and the `POST /v1/announce` handler that composes size-cap → HMAC → timestamp cross-check → decode → render → post, with the rate limiter and structured logging.

**Requirements:** R1, R2, R3, R4, R4a, R5, R8, R9, R10

**Dependencies:** Unit 0 (Hono dep), Units 1–5

**Files:**
- Create: `packages/gateway/src/http/server.ts`
- Create: `packages/gateway/src/http/announce-handler.ts`
- Create: `packages/gateway/src/http/rate-limit.ts`
- Create: `packages/gateway/src/http/replay-cache.ts`
- Test: `packages/gateway/src/http/server.test.ts`, `announce-handler.test.ts`, `rate-limit.test.ts`, `replay-cache.test.ts`

**Approach:**
- `createAnnounceServer(deps, config)` builds a Hono app with one route and returns the `serve()` handle (for shutdown). `deps` carries the discord client + logger + clock + replay cache so the handler is testable.
- Handler order (fail closed, cheapest checks first): (1) content-length precheck + read `c.req.arrayBuffer()` with an 8 KB byte guard → 413; (2) rate-limit by source key → 429; (3) require both headers present → 400; (4) `verifyHmac` over the literal `X-Gateway-Timestamp` string + `"."` + rawBody → 401 (generic) on failure; (5) timestamp window → 401 (generic, same body as hmac — no oracle); (6) **replay-cache check on signature hex → 401 (generic) if already seen**; (7) `JSON.parse` raw body → 400 on syntax error; (8) cross-check `X-Gateway-Timestamp` == body `fired_at` by **exact-string equality** → 400 on mismatch; (9) `decodeAnnounce` → 400 (unknown event included); (10) `renderEmbed` → `postPresenceEmbed` → 5xx on Discord failure; (11) on success: record signature in the replay cache, then 2xx. (Record AFTER a successful post so a Discord-failure 5xx retry isn't blocked as a replay.)
- Replay cache (`replay-cache.ts`): in-memory `Map<signatureHex, expiryMs>`; `check(sig)`/`record(sig)`; opportunistic eviction of expired entries; TTL = replay window + small buffer; injectable clock. Single-instance only — a restart reopens the window (documented limitation).
- Rate limiter: in-memory token bucket (~60/min) keyed by source IP (or forwarded identity if present); pure + injectable clock.
- **Mention safety:** payload-derived text (template output AND verbatim `rendered_text`) goes into the embed **description** only — never raw message `content`. The `postPresenceEmbed` send sets `allowedMentions: {parse: []}` (stricter than the client-global `{parse: ['users']}`) so a compromised control plane cannot ping `@everyone`/roles.
- Logging (R9): on accept log `{event_type, fired_at, discordStatus}`; on reject log `{reason}` only (`hmac_invalid`/`timestamp_expired`/`replayed`/`unknown_event_type`/`malformed_body`/`timestamp_mismatch`/`too_large`/`rate_limited`). NEVER log body, headers, signature, or secret.

**Execution note:** Start with a failing integration test for the full happy-path request/response contract, then drive the reject branches.

**Patterns to follow:** `apps/workspace-agent/src/server.ts` (Hono + serve + content-length guard) — but use `arrayBuffer()` not `json()`; gateway logger shape `logger.info(ctx, msg)`.

**Test scenarios:**
- Happy path: signed valid `survey_completed` POST → 2xx, embed posted to the presence channel, accept log emitted.
- Error path: bad signature → 401, no Discord post; stale timestamp → 401 (same body as bad-signature — no oracle); replayed signature (second identical valid POST within window) → 401, NO second Discord post; header/body timestamp mismatch → 400; unknown event_type → 400; malformed JSON → 400; missing headers → 400; >8 KB body → 413 (before any HMAC work); Discord post fails → 5xx.
- Edge case: rate limit exceeded → 429. Discord-failure 5xx then a legitimate retry of the SAME signature → NOT blocked as replay (signature recorded only after successful post).
- Security (mention injection): `rendered_text` containing `@everyone`/role-ping/`@here` → posted in embed description with `allowedMentions:{parse:[]}` → assert no ping is triggered (mock send receives `allowedMentions:{parse:[]}` and content stays out of raw `content`).
- Security (captured-logger): iterate every reject branch AND the happy path; assert no log line contains the secret, signature, raw body, a planted repo name, or `rendered_text`.
- Integration: full path with a mock discord client asserts the embed shape, target channel id, and `allowedMentions:{parse:[]}`.

**Verification:** every status-code branch behaves per spec; auth failures are indistinguishable to the caller; no secret/body leakage in logs; oversized bodies rejected before hashing.

- [ ] **Unit 7: Wire server into program lifecycle + shutdown drain**

**Goal:** Start the announce server in `makeGatewayProgram` and close it in the shutdown drain.

**Requirements:** R12

**Dependencies:** Unit 6

**Files:**
- Modify: `packages/gateway/src/program.ts`
- Modify: `packages/gateway/src/shutdown.ts`
- Modify: `packages/gateway/src/main.ts` (inject the real server factory into `GatewayProgramDeps`)
- Modify: `packages/gateway/src/program.test.ts`, `packages/gateway/src/shutdown.test.ts`

**Approach:**
- Add a `startAnnounceServer` factory to `GatewayProgramDeps` (mirrors `makeClient`/`login`); call it in `makeGatewayProgram` after `installShutdownHandlers`, around `deps.login`. `main.ts` injects the real `createAnnounceServer`; tests inject a stub.
- Widen `installShutdownHandlers` to accept the server handle (or a closeable list) and race its `.close()` alongside `client.destroy()` within the existing drain timer. Shutdown stays in the `finally`-equivalent path with its own guarded catch so a server-close failure can't mask client teardown (per the resource-cleanup learning).
- Refuse new announce requests during drain: when `isShuttingDown()` is true, the handler returns 503 before any other work (mandatory, not optional — mirrors the add-project shutdown gate; the control plane retries once). This is a decided behavior, not an implementer choice.

**Patterns to follow:** the testable-factory pattern already in `GatewayProgramDeps`; the `Promise.race([destroy, drainTimer])` shape in `shutdown.ts`.

**Test scenarios:**
- Integration: `makeGatewayProgram` with stub deps starts the announce server (factory called) and wires it; no real port bound.
- Happy path: shutdown closes BOTH the client and the server within the drain window.
- Error path: server `.close()` rejects → logged, does not prevent client destroy (no masking).
- Edge case: shutdown idempotent (second signal ignored), matching existing behavior.

**Verification:** program boots the server via injected factory; SIGTERM drains client + server; a server-close failure is logged without masking client teardown.

## System-Wide Impact

- **Interaction graph:** New inbound HTTP entry point — the first non-Discord ingress into the gateway. Touches `makeGatewayProgram` (start), `shutdown.ts` (stop), and reuses the live discord.js client for posting. No change to `interactionCreate`/`messageCreate` paths.
- **Error propagation:** HTTP handler maps each failure class to a status code; Discord post failure → 5xx so the control plane retries once. Server-close failure is isolated from client teardown.
- **State lifecycle risks:** In-memory rate-limit map and (deferred) replay cache are per-process, lost on restart — acceptable for best-effort v1. Body must be read once (`arrayBuffer`) and reused for both HMAC and JSON parse — do not consume twice.
- **API surface parity:** This is the gateway's first HTTP contract; `POST /v1/announce` is consumed by `fro-bot/.github`. The R4 raw-bytes decision is a cross-repo contract both sides must implement identically.
- **Integration coverage:** A mock-discord integration test must prove embed shape + channel targeting; a captured-logger test must prove no secret/body leakage across all branches — unit tests alone won't.
- **Unchanged invariants:** `DISCORD_TOKEN`/client construction, slash-command registration, mention handling, readiness flag, and the existing drain timing are unchanged; the server is additive and shares the same drain budget.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| JSON-impl drift breaks HMAC between repos | Raw-bytes + signed-timestamp contract (R4) — gateway never re-serializes; both sides agree on exact bytes |
| `timingSafeEqual` throws on length mismatch | Explicit length guard before the call (Unit 2 test pins it) |
| Body consumed twice (HMAC then parse) | Read `arrayBuffer()` once into a Buffer; HMAC and `JSON.parse` both use it |
| Oversized body wastes CPU on hashing | Content-length precheck + byte guard BEFORE HMAC (413); fail closed |
| Auth-failure oracle (which check failed) | `hmac_invalid`, `timestamp_expired`, and `replayed` return identical caller-facing response; precise reason logged server-side only |
| Replayed valid request posts a duplicate Discord message (action not idempotent) | In-memory seen-signature replay cache rejects exact replays within the window (R4a, Unit 6); signature recorded only after a successful post so 5xx retries still work |
| Malicious/compromised `rendered_text` pings @everyone/roles or injects links | Payload text confined to embed description; `allowedMentions:{parse:[]}` on the send; never placed in raw message content (Unit 4 + Unit 6) |
| Secret/body leakage in logs | Never-log-body invariant + captured-logger test across all branches (R9) |
| Presence channel-by-ID lookup is new (untested path) | Dedicated `presence.ts` unit with fetch-null / wrong-type / send-failure coverage |
| Control-plane spec still says "parse + re-serialize" | Documentation/Operational Notes flags the cross-repo update; deploy + control-plane work is sequenced after this lands |
| Plain HTTP if ingress TLS assumption is wrong | Documented assumption; revisit only if `marcusrbrown/infra` does not terminate TLS at ingress |

## Documentation / Operational Notes

- **Cross-repo contract change:** The control-plane requirements doc in `fro-bot/.github` currently leans toward "parse + re-serialize sorted-key canonical JSON." This plan adopts **raw-bytes + signed timestamp** (R4). File/Update the `fro-bot/.github` spec so the signer computes `HMAC(secret, timestamp + "." + rawBody)` and sends those exact bytes, with `X-Gateway-Timestamp` == body `fired_at`. Sequence this before the control-plane side is built.
- **Deploy (separate, `marcusrbrown/infra`):** add `GATEWAY_WEBHOOK_SECRET` secret + `GATEWAY_PRESENCE_CHANNEL_ID` env + `GATEWAY_HTTP_PORT` (optional). The readiness/deploy gate may optionally confirm the endpoint is reachable.
- **AGENTS.md:** add an `http/` entry to `packages/gateway/AGENTS.md` package layout and note the announce contract + the raw-bytes HMAC decision; record that Effect Schema is now in use (it was previously "planned for Unit 6+").
- **Secret rotation:** support current+previous secret acceptance during rotation as a future enhancement; v1 single secret.
- **Compound candidate:** after landing, document the HMAC + canonical-bytes + Hono-DoS pattern in `docs/solutions/` (no existing learning covers it).

## Sources & References

- **Origin issue:** https://github.com/fro-bot/agent/issues/671 (body + Fro Bot triage comment)
- Related code: `packages/gateway/src/program.ts`, `config.ts`, `shutdown.ts`, `discord/commands/add-project.ts`; `apps/workspace-agent/src/server.ts`
- Institutional learnings: `docs/solutions/best-practices/discord-slash-command-orchestration-patterns-2026-05-27.md`, `docs/solutions/best-practices/architectural-issues-type-safety-and-resource-cleanup.md`
- External: RFC 8785 (JCS), RFC 2104 (HMAC), Stripe/GitHub webhook signing docs, OWASP REST Security Cheat Sheet, Effect 3.21 Schema docs, Hono 4.12 docs
