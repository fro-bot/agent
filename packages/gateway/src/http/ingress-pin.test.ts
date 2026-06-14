/**
 * Gateway HTTP ingress surface pinning test.
 *
 * The gateway is reachable from the workspace over sandbox-net. Its only
 * inbound HTTP surface must be the HMAC/replay-gated POST /v1/announce
 * endpoint — a fixed-embed webhook that does not perform caller-directed
 * outbound requests. Any new route added to the gateway's HTTP ingress
 * could reopen the egress trust boundary (a workspace-reachable endpoint
 * that performs arbitrary outbound requests would let the workspace bypass
 * mitmproxy via the gateway). This test fails if the route inventory
 * changes, forcing a deliberate security review before the change ships.
 *
 * If you are adding a new HTTP route and this test fails:
 *   1. Confirm the new endpoint does NOT perform caller-directed outbound
 *      requests on behalf of the workspace.
 *   2. Update EXPECTED_ROUTES below with the new route after review.
 *   3. Update deploy/README.md (Egress topology → Forward constraint) to
 *      document the new endpoint and its trust properties.
 */

import type {Client} from 'discord.js'
import type {AnnounceLogger} from './announce-handler.js'
import {describe, expect, it, vi} from 'vitest'
import {buildAnnounceApp} from './server.js'

// ---------------------------------------------------------------------------
// Pinned ingress surface — update only after deliberate security review.
// ---------------------------------------------------------------------------

/**
 * The complete set of HTTP routes the gateway exposes over sandbox-net.
 * Each entry is { method, path } matching Hono's app.routes shape.
 *
 * Current surface: exactly one endpoint — the HMAC/replay/timestamp/schema-gated
 * announce webhook. It posts a fixed embed to a configured Discord channel and
 * does not perform caller-directed outbound requests.
 */
const EXPECTED_ROUTES: readonly {method: string; path: string}[] = [{method: 'POST', path: '/v1/announce'}]

// ---------------------------------------------------------------------------
// Minimal stubs — we only need to build the app, not run requests.
// ---------------------------------------------------------------------------

function makeStubDeps(): Parameters<typeof buildAnnounceApp>[0] {
  const logger: AnnounceLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  // Structural stub — only the shape matters; no real Discord calls are made.
  const client = {channels: {fetch: vi.fn()}} as unknown as Client
  return {client, logger}
}

function makeStubConfig(): Parameters<typeof buildAnnounceApp>[1] {
  return {
    webhookSecret: 'stub-secret',
    presenceChannelId: 'stub-channel',
    httpPort: 0, // not used — we never call serve()
  }
}

// ---------------------------------------------------------------------------
// Pin test
// ---------------------------------------------------------------------------

describe('gateway HTTP ingress surface', () => {
  it('is exactly {POST /v1/announce} — no undeclared routes', () => {
    // #given — build the Hono app without starting a server
    const app = buildAnnounceApp(makeStubDeps(), makeStubConfig())

    // #when — extract the registered user-defined routes as unique (method, path) pairs.
    // Hono registers each middleware in a chain as a separate entry for the same route
    // (e.g. bodyLimit + handler both appear as POST /v1/announce). Deduplicate by
    // (method, path) so the pin reflects the logical route inventory, not the
    // middleware-chain expansion. A new logical route still produces a new unique pair.
    const seen = new Set<string>()
    const actualRoutes = app.routes
      .map(r => ({method: r.method, path: r.path}))
      .filter(r => {
        const key = `${r.method}:${r.path}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

    // #then — the inventory must match the pinned set exactly.
    // Adding a route without updating this pin fails the test, requiring a
    // security review of the new workspace-reachable endpoint.
    expect(actualRoutes).toEqual(EXPECTED_ROUTES)
  })
})
