import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {
  readV1DatabaseFacts,
  V1_IMPORT_STALL_TIMEOUT_MS,
  V1_IMPORT_WAIT_TIMEOUT_MS,
  waitForV1Import,
} from './v1-import-wait.js'

type Body = Record<string, unknown>

/** A status endpoint scripted by how many milliseconds of fake time have passed since the wait began. */
function statusServer(script: (elapsedMs: number, call: number) => Body | Response): {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly calls: () => number
} {
  const startedAt = Date.now()
  let calls = 0
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1
      const answer = script(Date.now() - startedAt, calls)
      return answer instanceof Response ? answer : new Response(JSON.stringify(answer), {status: 200})
    },
  }
}

const running = (numerator: number | undefined, denominator = 100): Body => ({
  status: 'running',
  progress: {label: 'Migrating sessions', ...(numerator === undefined ? {} : {numerator}), denominator},
})

/** Runs the wait under fake timers and drives time until it settles. */
async function drive<T>(pending: Promise<T>, stepMs = 250, maxMs = 400_000): Promise<T> {
  const state = {settled: false}
  const tracked = pending.finally(() => {
    state.settled = true
  })
  for (let elapsed = 0; !state.settled && elapsed < maxMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  return tracked
}

describe('waitForV1Import', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns once the import reports completed, after waiting through required and running', async () => {
    // #given a restore that hit V1: required, then running with progress, then completed
    const server = statusServer(elapsed => {
      if (elapsed < 1_000) return {status: 'required'}
      if (elapsed < 3_000) return running(10)
      if (elapsed < 5_000) return running(60)
      return {status: 'completed'}
    })

    // #when
    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    // #then the wait did not return early, and it reports success only at completed
    expect(unwrapOk(result).durationMs).toBeGreaterThanOrEqual(5_000)
    expect(unwrapOk(result).polls).toBeGreaterThan(3)
  })

  it('returns at once when there is no history to import (completed on the first read)', async () => {
    const server = statusServer(() => ({status: 'completed'}))

    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    expect(result).toMatchObject({success: true, data: {polls: 1}})
    expect(server.calls()).toBe(1)
  })

  it('keeps waiting on a V2-tier restore that reports running', async () => {
    // #given a restored V2 database that still reports a running import for 20 s
    const server = statusServer(elapsed =>
      elapsed < 20_000 ? running(Math.floor(elapsed / 1000)) : {status: 'completed'},
    )

    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    expect(unwrapOk(result).durationMs).toBeGreaterThanOrEqual(20_000)
  })

  it('fails at once on an import error, after a single read', async () => {
    const logger = createMockLogger()
    const server = statusServer(() => ({status: 'error', error: 'disk image is malformed\n    at /secret/path:1'}))

    const result = await drive(waitForV1Import({fetch: server.fetch, logger}))

    expect(result).toMatchObject({success: false, error: {kind: 'import-error'}})
    expect(server.calls()).toBe(1)
    expect(unwrapErr(result).message).toContain('disk image is malformed')
    // Only the first line of the server's text is kept.
    expect(unwrapErr(result).message).not.toContain('/secret/path')
  })

  it('fails when the import runs past the hard bound while progress keeps moving', async () => {
    // #given progress that advances every 10 s, so the stall check never trips
    const server = statusServer(elapsed => running(Math.floor(elapsed / 10_000), 100_000))

    // #when
    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    // #then
    expect(result).toMatchObject({success: false, error: {kind: 'timeout'}})
    expect(V1_IMPORT_WAIT_TIMEOUT_MS).toBe(300_000)
    expect(Date.now()).toBeGreaterThanOrEqual(V1_IMPORT_WAIT_TIMEOUT_MS)
  })

  it('fails before the hard bound when the numerator stops advancing', async () => {
    // #given progress that moves every 5 s up to 7 (reached at 35 s), then freezes
    const logger = createMockLogger()
    const startedAt = Date.now()
    const server = statusServer(elapsed => running(Math.min(Math.floor(elapsed / 5_000), 7)))

    // #when
    const result = await drive(waitForV1Import({fetch: server.fetch, logger}))

    // #then it failed 60 s after the last movement, far below 300 s
    expect(result).toMatchObject({success: false, error: {kind: 'stalled'}})
    expect(V1_IMPORT_STALL_TIMEOUT_MS).toBe(60_000)
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(35_000 + V1_IMPORT_STALL_TIMEOUT_MS)
    expect(elapsed).toBeLessThan(35_000 + V1_IMPORT_STALL_TIMEOUT_MS + 5_000)
    expect(unwrapErr(result).message).toContain('7 sessions migrated')
  })

  it('does not call a slow but moving import stalled', async () => {
    // #given one session every 50 s: never 60 s without movement, completed at 200 s
    const server = statusServer(elapsed =>
      elapsed < 200_000 ? running(Math.floor(elapsed / 50_000), 10) : {status: 'completed'},
    )

    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    expect(result.success).toBe(true)
  })

  it('has no stall check for a running reading without progress, only the hard bound', async () => {
    const server = statusServer(() => ({status: 'running'}))

    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    expect(result).toMatchObject({success: false, error: {kind: 'timeout'}})
  })

  it('retries an unreadable reading and never reads it as completed', async () => {
    // #given two failed reads, then a real running reading, then completed
    const server = statusServer((elapsed, call) => {
      if (call <= 2) return new Response('upstream down', {status: 503})
      return elapsed < 3_000 ? running(1) : {status: 'completed'}
    })
    const logger = createMockLogger()

    // #when
    const result = await drive(waitForV1Import({fetch: server.fetch, logger}))

    // #then
    expect(unwrapOk(result).polls).toBeGreaterThan(3)
    expect(logger.warning).toHaveBeenCalledWith(
      'OpenCode V2 import status could not be read',
      expect.objectContaining({reason: 'http', httpStatus: 503}),
    )
  })

  it('fails after too many consecutive unreadable readings', async () => {
    const server = statusServer(() => ({unexpected: 'shape'}))

    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    expect(result).toMatchObject({success: false, error: {kind: 'unreadable'}})
    expect(server.calls()).toBe(5)
  })

  it('counts only consecutive unreadable readings', async () => {
    // #given an unreadable read between every two good ones
    const server = statusServer((elapsed, call) => {
      if (elapsed >= 20_000) return {status: 'completed'}
      return call % 2 === 0 ? new Response('', {status: 500}) : running(Math.floor(elapsed / 1000))
    })

    const result = await drive(waitForV1Import({fetch: server.fetch, logger: createMockLogger()}))

    expect(result.success).toBe(true)
  })

  it('fails with an aborted error when the caller cancels', async () => {
    const controller = new AbortController()
    const server = statusServer(() => running(1))

    const pending = waitForV1Import({fetch: server.fetch, logger: createMockLogger(), signal: controller.signal})
    await vi.advanceTimersByTimeAsync(2_000)
    controller.abort()
    const result = await drive(pending)

    expect(result).toMatchObject({success: false, error: {kind: 'aborted'}})
  })

  it('logs the database size and session count, and nothing secret', async () => {
    const logger = createMockLogger()
    const server = statusServer(() => ({status: 'completed'}))

    await drive(waitForV1Import({fetch: server.fetch, logger, facts: {bytes: 488_000_000, sessions: 22_000}}))

    expect(logger.info).toHaveBeenCalledWith(
      'Waiting for the OpenCode V2 import of V1 session history',
      expect.objectContaining({databaseBytes: 488_000_000, sessionCount: 22_000}),
    )
  })
})

describe('readV1DatabaseFacts', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-facts-test-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('reports the byte size and the V1 session count', () => {
    const dbPath = path.join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('a'), ('b'), ('c')")
    db.close()

    const facts = readV1DatabaseFacts(dbPath)

    expect(facts.sessions).toBe(3)
    expect(facts.bytes).toBe(fs.statSync(dbPath).size)
  })

  it('reports no session count for a database without a V1 session table, and nothing for a missing file', () => {
    const dbPath = path.join(dir, 'opencode.db')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY)')
    db.close()

    expect(readV1DatabaseFacts(dbPath).sessions).toBeNull()
    expect(readV1DatabaseFacts(path.join(dir, 'missing.db'))).toEqual({bytes: null, sessions: null})
  })

  it('never throws on a file that is not a database', () => {
    const dbPath = path.join(dir, 'opencode.db')
    fs.writeFileSync(dbPath, 'not sqlite at all')

    expect(readV1DatabaseFacts(dbPath)).toEqual({bytes: 17, sessions: null})
  })
})
