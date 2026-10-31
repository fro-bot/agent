import {describe, expect, it, vi} from 'vitest'

import {MIGRATION_V1_STATUS_PATH, MIGRATION_V1_STATUS_TIMEOUT_MS, readV1MigrationStatus} from './migration-status-v2.js'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

function serving(response: Response | (() => Response)) {
  return vi.fn(async (_path: string, _init?: RequestInit) => (typeof response === 'function' ? response() : response))
}

describe('readV1MigrationStatus', () => {
  it('requests the experimental migration route with GET and a signal', async () => {
    // #given
    const fetch = serving(json({status: 'completed'}))

    // #when
    await readV1MigrationStatus({fetch})

    // #then
    expect(MIGRATION_V1_STATUS_PATH).toBe('/api/experimental/migration/v1')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0] ?? []
    expect(path).toBe('/api/experimental/migration/v1')
    expect(init?.method).toBe('GET')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  // The bodies below are the shapes P7 recorded from v2.2.0 (`p07-import-synth.out.json`, `p10b.run.log`) and the
  // union in `protocol/src/groups/migration.ts`.
  it.each([
    ['required', {status: 'required'}, {status: 'required'}],
    ['completed', {status: 'completed'}, {status: 'completed'}],
    [
      'running with progress numbers',
      {status: 'running', progress: {label: 'Migrating sessions', numerator: 2, denominator: 2954}},
      {status: 'running', progress: {label: 'Migrating sessions', numerator: 2, denominator: 2954}},
    ],
    [
      'running before the first count',
      {status: 'running', progress: {label: 'Clearing old events'}},
      {status: 'running', progress: {label: 'Clearing old events'}},
    ],
    [
      'running with a zero numerator',
      {status: 'running', progress: {label: 'Migrating sessions', numerator: 0, denominator: 10}},
      {status: 'running', progress: {label: 'Migrating sessions', numerator: 0, denominator: 10}},
    ],
    [
      'error',
      {status: 'error', error: 'SQLITE_CORRUPT: database disk image is malformed'},
      {status: 'error', error: 'SQLITE_CORRUPT: database disk image is malformed'},
    ],
  ])('parses %s', async (_name, body, expected) => {
    // #when
    const reading = await readV1MigrationStatus({fetch: serving(json(body))})

    // #then
    expect(reading).toEqual(expected)
  })

  it('reads a running status that carries no progress as running without numbers', async () => {
    // #given a server that says running but sends no progress object
    // #when
    const reading = await readV1MigrationStatus({fetch: serving(json({status: 'running'}))})

    // #then the caller still knows to wait; it just cannot detect a stall
    expect(reading).toStrictEqual({status: 'running'})
  })

  it.each([
    ['an unknown status', {status: 'paused'}],
    ['a missing status', {}],
    ['a non-object body', 'completed'],
    ['null', null],
    ['an error status without text', {status: 'error'}],
    ['a fractional numerator', {status: 'running', progress: {label: 'x', numerator: 1.5, denominator: 3}}],
    ['a negative denominator', {status: 'running', progress: {label: 'x', numerator: 1, denominator: -3}}],
    ['a string numerator', {status: 'running', progress: {label: 'x', numerator: '1', denominator: 3}}],
    ['a progress label that is not text', {status: 'running', progress: {label: 7}}],
  ])('reports %s as unreadable (malformed)', async (_name, body) => {
    // #when
    const reading = await readV1MigrationStatus({fetch: serving(json(body))})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'malformed'})
  })

  it('reports a body that is not JSON as unreadable (malformed)', async () => {
    // #when
    const reading = await readV1MigrationStatus({fetch: serving(new Response('<html>nope</html>', {status: 200}))})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'malformed'})
  })

  it.each([401, 404, 500, 503])('reports HTTP %i as unreadable and keeps the code', async httpStatus => {
    // #when
    const reading = await readV1MigrationStatus({fetch: serving(json({_tag: 'ServiceUnavailableError'}, httpStatus))})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'http', httpStatus})
  })

  it('reports a failed request as unreadable (network)', async () => {
    // #given
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    // #when
    const reading = await readV1MigrationStatus({fetch})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'network'})
  })

  it('times out a request that never answers, even when fetch ignores its signal', async () => {
    // #given a fetch that hangs and does not look at the signal
    const fetch = vi.fn(async () => new Promise<Response>(() => {}))

    // #when
    const reading = await readV1MigrationStatus({fetch, timeoutMs: 20})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'timeout'})
  })

  it('times out a body that never arrives', async () => {
    // #given headers arrive but the body stalls and ignores the signal
    const stalled = {
      ok: true,
      status: 200,
      json: async () => new Promise<unknown>(() => {}),
    } as unknown as Response

    // #when
    const reading = await readV1MigrationStatus({fetch: serving(stalled), timeoutMs: 20})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'timeout'})
  })

  it('bounds the request by default', () => {
    // #then a single poll cannot outlive the wait loop that calls it
    expect(MIGRATION_V1_STATUS_TIMEOUT_MS).toBe(5_000)
  })

  it('does not call fetch when the signal is already aborted', async () => {
    // #given
    const fetch = serving(json({status: 'completed'}))
    const controller = new AbortController()
    controller.abort()

    // #when
    const reading = await readV1MigrationStatus({fetch, signal: controller.signal})

    // #then
    expect(reading).toEqual({status: 'unreadable', reason: 'aborted'})
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops waiting when the caller aborts mid-request', async () => {
    // #given a request that hangs
    const controller = new AbortController()
    const fetch = vi.fn(async () => new Promise<Response>(() => {}))

    // #when
    const pending = readV1MigrationStatus({fetch, signal: controller.signal, timeoutMs: 60_000})
    controller.abort()

    // #then it reads as aborted, not as a timeout
    expect(await pending).toEqual({status: 'unreadable', reason: 'aborted'})
  })

  it('passes a signal that follows the caller abort to fetch', async () => {
    // #given
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.signal != null) seen.push(init.signal)
      return json({status: 'completed'})
    })

    // #when
    await readV1MigrationStatus({fetch, signal: controller.signal})
    controller.abort()

    // #then
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })
})
