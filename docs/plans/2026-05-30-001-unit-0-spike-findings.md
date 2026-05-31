---
title: Unit 0 spike findings — remote-attach streaming + bearer-token proxy
status: complete
date: 2026-05-30
plan: docs/plans/2026-05-30-001-feat-gateway-unit-6-mention-loop-plan.md
verdict: GO
---

# Unit 0 Spike — Go/No-Go

**Verdict: GO.** The remote-attach topology (Option A) is viable, and both stricter
security decisions (bearer-token proxy on the attach path) are validated on HTTP **and** SSE.

## What was proven

Two evidence sources: (1) SDK source inspection at the pinned version, (2) a live throwaway
spike (`_spike.mjs`, deleted) that booted a real `opencode serve`, fronted it with a prototype
bearer-token reverse proxy, and attached a client through the proxy.

| Question | Result | Evidence |
|---|---|---|
| `createOpencodeServer()` returns a reachable URL | ✅ | live: `server.url` resolved; `dist/server.d.ts` → `{url, close}` |
| `createOpencode()` is itself server + `createOpencodeClient({baseUrl})` | ✅ | source: `sdk/js/src/index.ts` — remote-attach is the **same transport production already uses** |
| Attach option name | ✅ `baseUrl` (camelCase) | `gen/client/types.gen.ts:10-17` (NOT `baseURL`/`url`) |
| Custom `Authorization` header on HTTP | ✅ honored | live: POST `/session` saw `hasAuth:true`; client config extends `RequestInit` (`headers`/`fetch`) |
| Custom `Authorization` header on **SSE `/event`** | ✅ honored | live: GET `/event` saw `hasAuth:true`; SSE is **fetch-based, not EventSource** (`gen/core/serverSentEvents.gen.ts:82-103`) |
| Proxy rejects missing/wrong bearer | ✅ 401, no forward | live: `negativeRejected:true` |

## The key finding (gates the bearer-token proxy)

The SDK's `event.subscribe()` SSE transport uses `fetch(request, {headers})`, **not** native
`EventSource`. Native `EventSource` cannot send custom headers; a fetch-based reader can. So
`Authorization: Bearer <token>` survives on the streaming path — the Unit 1 proxy design is sound
on both HTTP and SSE. Confirmed in source AND live (`seen.sse[].hasAuth === true`).

## What was NOT re-proven live here (and why that's fine)

Live tool-streaming events (`message.part.delta` / `session.next.tool.*` / `session.idle` under a
real LLM prompt) were **not** re-run in this spike, for two reasons:

1. **Local binary is `opencode 1.15.12`** — squarely in the regressed range (1.14.42+ broke
   `session.next.*` SSE; filed upstream as `anomalyco/opencode#27966`). A live streaming run here
   would false-negative and prove nothing about our pinned `1.14.41`.
2. **Token cost** — a real prompt burns LLM tokens for a result already in evidence.

Tool-streaming over this exact HTTP+SSE transport at the pinned `1.14.41` is already proven by
production CI on PR #621 (visible `| Bash` tool lines end-to-end). Remote attach changes only the
URL host (cross-container vs localhost), not the transport, so that evidence carries.

## Implications for Units 1–5

- **Unit 1 proxy:** use a fetch/stream-piping reverse proxy (the spike's `http.request` pipe pattern
  works for SSE). Bind OpenCode to loopback; expose only the proxy on `sandbox-net`.
- **Unit 2 attach:** `createOpencodeClient({baseUrl: <proxyUrl>, headers: {Authorization: Bearer <token>}})`.
  Header is threaded automatically to both HTTP and the `event.subscribe` SSE call — no special-casing.
- **Version pin:** the workspace container MUST run pinned `1.14.41` (not host `1.15.x`). Deploy must
  install the pinned binary; do not rely on PATH drift.
- **No fallback to Option B needed** — the topology held.
