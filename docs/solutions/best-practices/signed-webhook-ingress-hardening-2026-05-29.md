---
title: Signed webhook ingress hardening
date: 2026-05-29
category: best-practices
module: packages/gateway/src/http
problem_type: best_practice
component: authentication
severity: high
related_components:
  - assistant
applies_when:
  - adding a signed inbound webhook endpoint
  - verifying raw-body HMAC signatures
  - preventing replay on awaited side effects
  - enforcing pre-auth body-size limits
  - rate limiting untrusted ingress by socket address
tags:
  - webhook-security
  - hmac-signing
  - replay-protection
  - raw-body
  - rate-limiting
  - dos-hardening
  - discord-gateway
---

# Signed webhook ingress hardening

## Context

The gateway's `POST /v1/announce` endpoint (`packages/gateway/src/http/`) is the first inbound HTTP ingress in the project. A control plane calls it to post presence messages into Discord **as the Fro Bot user**, authenticated with an HMAC shared secret. The endpoint is reachable before authentication, performs a **non-idempotent** side effect (posting a Discord message), and is retried by the caller on failure.

That combination — pre-auth reachability, non-idempotent work, retry semantics, an awaited downstream call — is exactly where naive webhook handlers leak auth state, double-post, or fall over to memory-pressure DoS. The patterns below are the hardening that survived Oracle review, an 11-persona review pass, and a follow-up review that caught a pre-auth buffering DoS the first pass missed.

The handler runs a single fail-closed pipeline, cheapest check first:

```
1. Body size guard (8 KB, enforced during read)
2. Rate limit (socket-keyed)
3. Required headers present
4. HMAC verification
5. Timestamp window check
6. Replay-cache reserve (atomic check-and-set)
7. JSON parse
8. Timestamp cross-check (body fired_at === header, exact string)
9. Schema decode (unknown event_type → 400)
10. Render embed + post to Discord
11. Commit replay cache → 200
```

## Guidance

### 1. Sign the raw bytes, never re-serialized JSON

```ts
// hmac.ts — HMAC-SHA256 over `timestamp + "." + rawBody`
const expected = createHmac('sha256', secret).update(timestampHeader).update('.').update(rawBody).digest()
```

Sign the **exact received bytes** plus the timestamp prefix. Do not parse the body and re-serialize it to compute the signature. Two independent JSON serializers drift — `1` vs `1.0`, key order, Unicode normalization, float precision — and any drift produces intermittent signature mismatches even when both sides are "correct." Read the body once as bytes, HMAC those bytes, then parse the same buffer for use.

### 2. Bind the timestamp into the signature, with a replay window and exact-string cross-check

```ts
// hmac.ts
export function checkTimestamp(timestampHeader: string, nowMs: number, windowMs: number) {
  const parsedMs = Date.parse(timestampHeader)
  if (Number.isFinite(parsedMs) === false) return {ok: false, reason: 'timestamp_expired'}
  if (Math.abs(nowMs - parsedMs) > windowMs) return {ok: false, reason: 'timestamp_expired'}
  return {ok: true}
}
```

```ts
// announce-handler.ts — body fired_at must equal the signed header, exact string
if (
  typeof parsed !== 'object' ||
  parsed === null ||
  'fired_at' in parsed === false ||
  (parsed as Record<string, unknown>).fired_at !== timestampHeader
) {
  replayCache.release(signatureHex)
  return {status: 400, body: {error: 'bad request'}}
}
```

The signature is computed over `timestamp + "." + rawBody`, so the timestamp can't be altered without breaking the signature. A bounded window (±5 min) caps how long a captured-but-valid request stays replayable. The exact-string equality between the signed header and the body's `fired_at` stops a mismatched/spliced timestamp.

### 3. Return an identical 401 for every auth failure (no oracle)

```ts
// announce-handler.ts
const UNAUTHORIZED_BODY = {error: 'unauthorized'} as const

if (hmacResult.ok === false) return {status: 401, body: UNAUTHORIZED_BODY}
if (tsResult.ok === false) return {status: 401, body: UNAUTHORIZED_BODY}
if (replayCache.reserve(signatureHex) === false) return {status: 401, body: UNAUTHORIZED_BODY}
```

Bad signature, expired timestamp, and replayed signature all return the **same** body via a shared constant. A caller cannot distinguish "wrong secret" from "clock skew" from "already seen," so it can't probe secret validity, the replay window, or cache state.

### 4. Reserve the replay key before the await, commit after success, release on every failure

```ts
// replay-cache.ts — atomic check-and-set (absent | reserved | recorded)
function reserve(sig: string): boolean {
  const entry = store.get(sig)
  if (entry !== undefined) return false // already reserved or recorded
  store.set(sig, RESERVED)
  return true
}
```

```ts
// announce-handler.ts
if (replayCache.reserve(signatureHex) === false) return {status: 401, body: UNAUTHORIZED_BODY}

const postResult = await postPresenceEmbed(client, presenceChannelId, embed)
if (postResult.success === false) {
  replayCache.release(signatureHex) // failed post → retry must succeed
  return {status: 500, body: {error: 'internal error'}}
}

replayCache.commit(signatureHex) // recorded only after the side effect lands
```

The obvious shape — `check()` → `await post()` → `record()` — is a concurrency race. The `await` yields the event loop, so two requests carrying the same signature both pass `check()` and both post a duplicate message. Reserving **synchronously before** the await closes the window; committing only after a successful post (and releasing on every post-reserve early return) means a failed post still allows a legitimate retry. Every early return after a successful `reserve()` must `release()`, or a malformed-but-reserved request permanently burns that signature.

### 5. Cap the body during the read, not after buffering

```ts
// server.ts — streaming limit runs before the handler allocates
app.post(
  '/v1/announce',
  bodyLimit({maxSize: ANNOUNCE_MAX_BODY_BYTES, onError: c => c.json({error: 'payload too large'}, 413)}),
  async c => {
    const arrayBuffer = await c.req.arrayBuffer()
    const rawBody = Buffer.from(arrayBuffer)
    // ...
  },
)
```

A `Content-Length` precheck is a useful fast reject for honest clients, but it is trivially bypassed by omitting or understating the header (chunked transfer encoding). If the only real enforcement is a `rawBody.byteLength` check **after** `arrayBuffer()`, an unauthenticated caller can force the server to buffer an arbitrarily large body into memory before any rejection — a pre-auth memory-pressure DoS. A streaming `bodyLimit` middleware bounds the read itself. Keep the cheap content-length precheck and the post-buffer `byteLength` guard as defense in depth, but the streaming limit is the real control.

### 6. Rate-limit on the socket address, not `X-Forwarded-For`, and bound the key map

```ts
// server.ts
const connInfo = getConnInfo(c) // @hono/node-server/conninfo
const sourceKey = connInfo.remote.address ?? undefined
```

```ts
// rate-limit.ts — bounded key cardinality
if (store.size >= MAX_KEYS) return false
```

`X-Forwarded-For` is caller-supplied and spoofable; keying the limiter on it lets an attacker rotate the header to get unlimited buckets — defeating the limit **and** growing the key map without bound (a second memory sink). Key on the real TCP peer address. Behind an ingress that terminates connections, this keys on the proxy, which is the correct trust boundary for a single-caller v1. Cap the number of tracked keys regardless.

### 7. Treat payload text as untrusted: disable mentions, confine to the embed body

```ts
// presence.ts — mentions disabled on every send
await channel.send({embeds: [embed], allowedMentions: {parse: []}})
```

```ts
// templates.ts — verbatim text only when non-empty, else fall back to the template
if (payload.rendered_text !== null && payload.rendered_text.trim().length > 0) {
  description = payload.rendered_text
}
```

Even a "trusted" control plane can be compromised or send a future payload format. Payload-supplied text goes into the embed **description** (which never triggers pings) and every send sets `allowedMentions: {parse: []}` so it can't `@everyone`/`@role`. Empty or whitespace-only override text falls back to the templated description, because an empty embed description makes Discord reject the post (→ 500 → released reservation → retries also fail).

### 8. Bound every outbound call so it can't pin a reservation

```ts
// presence.ts
const DEFAULT_DISCORD_TIMEOUT_MS = 10_000

const result = await Promise.race([
  discordOp().catch(() => err({kind: 'send-failed', message: 'discord post timed out'})),
  timeoutOp, // setTimeout-backed rejection → send-failed
])
clearTimeout(timeoutHandle)
```

The replay reservation is released on the post-failure path — but only if the post **settles**. A hung Discord call with no timeout never settles, so the reservation leaks for the process lifetime and permanently blocks retries for that signature. A timeout budget guarantees the call resolves one way or the other, so `release()` always runs. (The losing promise gets a no-op `.catch` so a late rejection doesn't surface as an unhandled rejection.)

## Why This Matters

Webhook ingress is hostile by default, and each of these is a real failure mode, not a hypothetical:

- JSON canonicalization drift → intermittent, maddening signature failures in production.
- Auth/timing oracles → attackers probe secret validity and replay state.
- Racey replay checks → duplicate non-idempotent side effects under concurrency.
- Post-buffer size checks → pre-auth memory DoS via chunked encoding.
- XFF-keyed rate limits → spoofable bypass plus an unbounded memory sink.
- Trusted-by-default payload text → unwanted `@everyone` pings.
- Unbounded downstream calls → a single hung API wedges the ingress path.

## When to Apply

Use this pattern set for any signed inbound webhook that:

- authenticates with a shared secret / HMAC signature,
- performs non-idempotent work (posting, creating, charging),
- is reachable before authentication or full validation,
- can be retried by the sender,
- or makes any downstream call that can hang or fail after a resource is reserved.

## Examples

**Good** — sign raw bytes, reserve before the await, release on failure, socket-keyed limit:

```ts
const expected = createHmac('sha256', secret).update(timestampHeader).update('.').update(rawBody).digest()

if (replayCache.reserve(signatureHex) === false) return {status: 401, body: UNAUTHORIZED_BODY}

const postResult = await postPresenceEmbed(client, channelId, embed)
if (postResult.success === false) {
  replayCache.release(signatureHex)
  return {status: 500, body: {error: 'internal error'}}
}
replayCache.commit(signatureHex)
```

**Bad** — re-serialized signature, XFF rate-limit key, record-after-await race:

```ts
const payload = JSON.parse(body.toString('utf8'))
const sig = createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex') // drift
if (rateLimit(req.headers['x-forwarded-for']) === false) return res.status(429).end()   // spoofable
await sendDiscord(payload)                                                              // race window
replayCache.record(sig)                                                                 // too late
```

## Related

- Closes issue #671 (Fro Bot presence webhook: `POST /v1/announce` for control-plane events).
- Shipped in PR #697 (`feat(gateway): signed announce webhook for control-plane presence messages`), merged to `main` as commit `88cddce`.
- [Discord slash command orchestration patterns](discord-slash-command-orchestration-patterns-2026-05-27.md) — adjacent gateway-boundary doc covering the never-log-body / credential-handling posture for the `/add-project` flow. This webhook doc and that one together describe the gateway's inbound trust boundary; consider a consolidated "gateway security" umbrella if a third surface lands.
