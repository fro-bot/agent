/**
 * Cache → listing-route regression for #1875: an unavailable redaction policy must read as 503, never as an
 * empty listing.
 *
 * Uses the real denylist cache over a fake metadata reader with a deterministic clock, wired to the real
 * GET /operator/repos and GET /operator/runs handlers exactly as server.ts wires them (`isRepoDenied` and
 * `isPolicyAvailable` bound to the one cache). Fail-closed stays fail-closed: a denied repo is never listed in
 * any phase.
 */

import type {RunState} from '@fro-bot/runtime'
import type {RepoBinding} from '../../bindings/types.js'
import type {MetadataReader} from '../../redaction/metadata-reader.js'
import {Hono} from 'hono'
import {describe, expect, it, vi} from 'vitest'
import {createDenylistCache} from '../../redaction/denylist.js'
import {setOperatorRouteGuard} from '../operator-route.js'
import {buildReposRoute} from './repos-route.js'
import {buildRunsRoute} from './runs-route.js'

const TTL_MS = 1000
const GRACE_MS = 3000

const ALLOWED_DB_ID = 11
const DENIED_DB_ID = 22

// The denylist redacts DENIED_DB_ID; nothing else.
const DENYLIST_YAML = [
  'version: 1',
  'repos:',
  '  -',
  '    owner: "[REDACTED]"',
  '    name: "[REDACTED]"',
  '    private: true',
  '    node_id: "MDEwOlJlcG9zaXRvcnkyMg"',
  `    database_id: ${DENIED_DB_ID}`,
].join('\n')

function makeBinding(owner: string, repo: string, databaseId: number): RepoBinding {
  return {
    owner,
    repo,
    channelId: `chan-${owner}-${repo}`,
    channelName: `${repo}-channel`,
    workspacePath: `/workspace/${owner}/${repo}`,
    createdAt: '2024-01-01T00:00:00Z',
    createdByDiscordId: '999888777',
    databaseId,
    nodeId: `MDEwOlJlcG9zaXRvcnk${databaseId}`,
  }
}

function makeRunState(owner: string, repo: string, runId: string): RunState {
  return {
    run_id: runId,
    entity_ref: `${owner}/${repo}#1`,
    surface: 'discord' as const,
    phase: 'EXECUTING' as const,
    started_at: '2024-01-01T00:00:00Z',
    last_heartbeat: '',
    thread_id: '',
    holder_id: '',
    details: {},
  }
}

const ALLOWED_BINDING = makeBinding('acme', 'visible-repo', ALLOWED_DB_ID)
const DENIED_BINDING = makeBinding('acme', 'hidden-repo', DENIED_DB_ID)

function setup() {
  let nowMs = 0
  const reader = {healthy: false}
  const metadataReader: MetadataReader = async () => {
    if (reader.healthy === false) throw new Error('metadata unavailable')
    return DENYLIST_YAML
  }
  const logger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
  const cache = createDenylistCache({
    reader: metadataReader,
    ttlMs: TTL_MS,
    graceMs: GRACE_MS,
    now: () => nowMs,
    logger,
  })

  const listBindings = vi.fn(async () => ({
    success: true as const,
    data: [ALLOWED_BINDING, DENIED_BINDING],
  }))
  const listRunsForRepo = vi.fn(async (repo: string): Promise<readonly RunState[]> => {
    const [owner, name] = repo.split('/')
    return [makeRunState(owner ?? '', name ?? '', `run-${name}`)]
  })
  const routeLogger = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}

  const app = new Hono()
  setOperatorRouteGuard(app, async () => ({ok: true, githubUserId: 1001, sessionId: 'sess-abc'}))
  const common = {
    listBindings,
    isRepoDenied: cache.isRepoDenied.bind(cache),
    isPolicyAvailable: cache.isPolicyAvailable.bind(cache),
    logger: routeLogger,
    now: () => nowMs,
    // The rate limit is not under test here.
    perMinRateLimiter: {allow: () => true},
  }
  buildReposRoute(app, common)
  buildRunsRoute(app, {
    ...common,
    listRunsForRepo,
    approvalRegistry: {hasPendingForScope: () => false},
    questionRegistry: {hasPendingForScope: () => false},
  })

  return {
    cache,
    reader,
    routeLogger,
    listBindings,
    listRunsForRepo,
    advance: (ms: number) => {
      nowMs += ms
    },
    setNow: (ms: number) => {
      nowMs = ms
    },
    repos: async () => app.fetch(new Request('http://localhost/operator/repos')),
    runs: async () => app.fetch(new Request('http://localhost/operator/runs')),
  }
}

async function expectListed(res: Response, kind: 'repos' | 'runs'): Promise<void> {
  expect(res.status).toBe(200)
  const text = await res.text()
  // Only the allowed repo, never the denied one.
  expect(text).toContain('visible-repo')
  expect(text).not.toContain('hidden-repo')
  expect(kind === 'repos' ? Array.isArray(JSON.parse(text)) : 'runs' in JSON.parse(text)).toBe(true)
}

async function expectUnavailable(res: Response): Promise<void> {
  expect(res.status).toBe(503)
  const text = await res.text()
  expect(JSON.parse(text)).toEqual({error: 'redaction-policy-unavailable'})
  expect(text).not.toContain('visible-repo')
  expect(text).not.toContain('hidden-repo')
  expect(text).not.toContain('acme')
}

describe('operator listings — redaction policy availability (#1875)', () => {
  it('answers 503 on both listings at cold start, with no store read', async () => {
    // #given — the first load fails, so the cache never held a policy
    const t = setup()
    await t.cache.getDenylistState()

    // #when / #then
    await expectUnavailable(await t.repos())
    await expectUnavailable(await t.runs())
    expect(t.listBindings).not.toHaveBeenCalled()
    expect(t.listRunsForRepo).not.toHaveBeenCalled()
  })

  it('answers 503 once the grace window has expired, even when a repo was listed before', async () => {
    // #given — a good load, listings served
    const t = setup()
    t.reader.healthy = true
    await t.cache.getDenylistState()
    await expectListed(await t.repos(), 'repos')
    await expectListed(await t.runs(), 'runs')

    // #when — the reader breaks and the grace window runs out
    t.reader.healthy = false
    t.setNow(GRACE_MS + 1)

    // #then — the same request that listed before now reports the outage
    await expectUnavailable(await t.repos())
    await expectUnavailable(await t.runs())
  })

  it('serves the filtered last-known-good listing within the grace window, denied repos omitted', async () => {
    // #given — a good load, then the reader breaks
    const t = setup()
    t.reader.healthy = true
    await t.cache.getDenylistState()
    t.reader.healthy = false

    // #when — a refresh fails inside the grace window, and again at the exact boundary
    t.setNow(TTL_MS + 1)
    await t.cache.getDenylistState()
    await expectListed(await t.repos(), 'repos')
    await expectListed(await t.runs(), 'runs')

    t.setNow(GRACE_MS)
    await expectListed(await t.repos(), 'repos')
    await expectListed(await t.runs(), 'runs')
  })

  it('recovers to 200 after a successful reload', async () => {
    // #given — cold start: 503
    const t = setup()
    await t.cache.getDenylistState()
    await expectUnavailable(await t.repos())
    await expectUnavailable(await t.runs())

    // #when — the reader comes back and the next refresh succeeds
    t.reader.healthy = true
    t.advance(TTL_MS + 1)
    await t.cache.getDenylistState()

    // #then — the filtered listings are served again
    await expectListed(await t.repos(), 'repos')
    await expectListed(await t.runs(), 'runs')
  })

  it('never lists a denied repo and logs no repo identity while unavailable', async () => {
    // #given — cold start with both a bound allowed repo and a bound denied repo
    const t = setup()
    await t.cache.getDenylistState()

    // #when
    await expectUnavailable(await t.repos())
    await expectUnavailable(await t.runs())

    // #then — one warning per request, none carrying a repo name
    expect(t.routeLogger.warn).toHaveBeenCalledTimes(2)
    const logged = JSON.stringify(t.routeLogger.warn.mock.calls)
    expect(logged).not.toContain('visible-repo')
    expect(logged).not.toContain('hidden-repo')
    expect(logged).not.toContain('acme')
  })
})
