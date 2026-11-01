import {afterEach, describe, expect, it, vi} from 'vitest'

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

  describe('bounds under fake timers', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('ends a fetch that never resolves as unreadable (timeout) at the 5000 ms default', async () => {
      // #given a fetch that never settles and no timeoutMs
      vi.useFakeTimers()
      const fetch = vi.fn(async () => new Promise<Response>(() => {}))
      let settled: unknown

      // #when
      const pending = readV1MigrationStatus({fetch}).then(reading => {
        settled = reading
        return reading
      })
      await vi.advanceTimersByTimeAsync(MIGRATION_V1_STATUS_TIMEOUT_MS - 1)

      // #then it is still waiting one millisecond before the default bound
      expect(settled).toBeUndefined()

      // #when the bound passes
      await vi.advanceTimersByTimeAsync(1)

      // #then
      expect(await pending).toEqual({status: 'unreadable', reason: 'timeout'})
      expect(vi.getTimerCount()).toBe(0)
    })

    it('reads as aborted when the caller aborts while the response body is still being consumed', async () => {
      // #given headers have arrived and the body stalls, ignoring every signal
      vi.useFakeTimers()
      const controller = new AbortController()
      let bodyRequested = false
      const stalled = {
        ok: true,
        status: 200,
        json: async () => {
          bodyRequested = true
          return new Promise<unknown>(() => {})
        },
      } as unknown as Response

      // #when the caller aborts once the body read has started
      const pending = readV1MigrationStatus({fetch: serving(stalled), signal: controller.signal, timeoutMs: 60_000})
      await vi.advanceTimersByTimeAsync(10)
      expect(bodyRequested).toBe(true)
      controller.abort()

      // #then it settles at once as aborted, long before the bound
      expect(await pending).toEqual({status: 'unreadable', reason: 'aborted'})
      expect(vi.getTimerCount()).toBe(0)
    })

    it('reads as aborted when a real streaming body is cut off by the caller mid-read', async () => {
      // #given a streaming body that has sent one chunk and then stops
      vi.useFakeTimers()
      const controller = new AbortController()
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"status":'))
        },
      })
      const response = new Response(body, {status: 200, headers: {'content-type': 'application/json'}})

      // #when
      const pending = readV1MigrationStatus({fetch: serving(response), signal: controller.signal, timeoutMs: 60_000})
      await vi.advanceTimersByTimeAsync(10)
      controller.abort()

      // #then
      expect(await pending).toEqual({status: 'unreadable', reason: 'aborted'})
    })

    it('settles an HTTP error as unreadable (http) when cancelling its body rejects', async () => {
      // #given
      const failing = {
        ok: false,
        status: 503,
        body: {cancel: async () => Promise.reject(new Error('stream already errored'))},
      } as unknown as Response

      // #when
      const reading = await readV1MigrationStatus({fetch: serving(failing)})

      // #then
      expect(reading).toEqual({status: 'unreadable', reason: 'http', httpStatus: 503})
    })

    it('settles an HTTP error as unreadable (http) when cancelling its body throws synchronously', async () => {
      // #given
      const throwing = {
        ok: false,
        status: 502,
        body: {
          cancel: () => {
            throw new TypeError('locked')
          },
        },
      } as unknown as Response

      // #when
      const reading = await readV1MigrationStatus({fetch: serving(throwing)})

      // #then
      expect(reading).toEqual({status: 'unreadable', reason: 'http', httpStatus: 502})
    })

    it('settles an HTTP error whose body cancellation stalls as unreadable within the bound', async () => {
      // #given a cancel() that never resolves
      vi.useFakeTimers()
      const stalling = {
        ok: false,
        status: 503,
        body: {cancel: async () => new Promise<void>(() => {})},
      } as unknown as Response
      let settled = false

      // #when
      const pending = readV1MigrationStatus({fetch: serving(stalling)}).then(reading => {
        settled = true
        return reading
      })
      await vi.advanceTimersByTimeAsync(MIGRATION_V1_STATUS_TIMEOUT_MS)
      const reading = await pending

      // #then the HTTP status is still reported, it settled, and no timer is left behind
      expect(settled).toBe(true)
      expect(reading).toEqual({status: 'unreadable', reason: 'http', httpStatus: 503})
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
