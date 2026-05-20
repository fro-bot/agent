import type {GatewayLogger} from './discord/client.js'
import type {ReadinessClient} from './readiness.js'

import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {setupReadinessFlag} from './readiness.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): {logger: GatewayLogger; calls: {method: string; ctx: Record<string, unknown>; msg: string}[]} {
  const calls: {method: string; ctx: Record<string, unknown>; msg: string}[] = []
  const logger: GatewayLogger = {
    debug: (ctx, msg) => calls.push({method: 'debug', ctx, msg}),
    info: (ctx, msg) => calls.push({method: 'info', ctx, msg}),
    warn: (ctx, msg) => calls.push({method: 'warn', ctx, msg}),
    error: (ctx, msg) => calls.push({method: 'error', ctx, msg}),
  }
  return {logger, calls}
}

/**
 * Minimal ReadinessClient mock that captures listeners registered via `on`
 * so tests can simulate events by invoking them directly.
 */
function makeClient(): {
  client: ReadinessClient
  fireClientReady: () => void
  fireShardReady: () => void
  fireShardResume: () => void
  fireShardDisconnect: () => void
} {
  const listeners: {event: string; listener: (...args: unknown[]) => void}[] = []

  const client: ReadinessClient = {
    on: (
      event: 'clientReady' | 'shardReady' | 'shardResume' | 'shardDisconnect',
      listener: (...args: unknown[]) => void,
    ) => {
      listeners.push({event, listener})
      return client
    },
  }

  const fire = (event: string) => {
    for (const entry of listeners) {
      if (entry.event === event) entry.listener()
    }
  }

  return {
    client,
    fireClientReady: () => fire('clientReady'),
    fireShardReady: () => fire('shardReady'),
    fireShardResume: () => fire('shardResume'),
    fireShardDisconnect: () => fire('shardDisconnect'),
  }
}

// ---------------------------------------------------------------------------
// Per-test temp flag path so tests are isolated and don't touch /tmp directly
// ---------------------------------------------------------------------------

let testDir: string
let flagPath: string

beforeEach(() => {
  testDir = join(tmpdir(), `readiness-test-${process.pid}-${Date.now()}`)
  mkdirSync(testDir, {recursive: true})
  flagPath = join(testDir, 'gateway-ready')
})

afterEach(() => {
  rmSync(testDir, {recursive: true, force: true})
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setupReadinessFlag', () => {
  // #given a fresh container with no prior flag
  // #when setupReadinessFlag is called and clientReady fires
  // #then the flag file is written
  it('writes the flag file when clientReady fires', () => {
    const {logger} = makeLogger()
    const {client, fireClientReady} = makeClient()

    setupReadinessFlag(client, logger, flagPath)
    expect(existsSync(flagPath)).toBe(false) // not written yet — only on event

    fireClientReady()

    expect(existsSync(flagPath)).toBe(true)
  })

  // #given a stale flag from a prior process run
  // #when setupReadinessFlag is called
  // #then the stale flag is removed BEFORE the listener is registered
  it('clears a stale flag before registering the clientReady listener', () => {
    const {logger} = makeLogger()

    // Pre-create a stale flag
    writeFileSync(flagPath, 'stale', {mode: 0o600})

    // Capture filesystem state at the exact moment on() is called
    let flagExistedAtRegistration: boolean | undefined

    const {client} = makeClient()
    const originalOn = client.on.bind(client)
    vi.spyOn(client, 'on').mockImplementation((event, listener) => {
      // Record whether the flag still exists when the first listener is being registered
      if (flagExistedAtRegistration === undefined) {
        flagExistedAtRegistration = existsSync(flagPath)
      }
      return originalOn(event, listener)
    })

    setupReadinessFlag(client, logger, flagPath)

    // The flag must have been absent at the moment of listener registration
    expect(flagExistedAtRegistration).toBe(false)
    // And still absent after setup completes
    expect(existsSync(flagPath)).toBe(false)
  })

  // #given no flag file exists (fresh container)
  // #when setupReadinessFlag is called
  // #then ENOENT is silently tolerated — no error thrown, no warn logged
  it('tolerates ENOENT when no stale flag exists', () => {
    const {logger, calls} = makeLogger()
    const {client} = makeClient()

    // flagPath does not exist — should not throw
    expect(() => setupReadinessFlag(client, logger, flagPath)).not.toThrow()

    const warnCalls = calls.filter(c => c.method === 'warn')
    expect(warnCalls).toHaveLength(0)
  })

  // #given clientReady fires
  // #then logger.info is called with 'wrote gateway-ready flag'
  it('logs info when the flag is written successfully', () => {
    const {logger, calls} = makeLogger()
    const {client, fireClientReady} = makeClient()

    setupReadinessFlag(client, logger, flagPath)
    fireClientReady()

    const infoCalls = calls.filter(c => c.method === 'info' && c.msg === 'wrote gateway-ready flag')
    expect(infoCalls).toHaveLength(1)
  })

  // #given writeFileSync fails (e.g. permission error)
  // #then logger.error is called and no exception propagates
  it('logs error and does not throw when writeFileSync fails', () => {
    const {logger, calls} = makeLogger()
    const {client, fireClientReady} = makeClient()

    // Use a path that cannot be written (directory instead of file)
    const unwritablePath = testDir // a directory — writeFileSync will throw EISDIR

    setupReadinessFlag(client, logger, unwritablePath)
    expect(() => fireClientReady()).not.toThrow()

    const errorCalls = calls.filter(c => c.method === 'error')
    expect(errorCalls).toHaveLength(1)
    expect(errorCalls[0]?.msg).toBe('failed to write gateway-ready flag')
  })

  // ---------------------------------------------------------------------------
  // Transition tests (Todo 019)
  // ---------------------------------------------------------------------------

  // #given clientReady fires (flag written), then shardDisconnect fires
  // #then flag is deleted after disconnect
  it('ready → disconnect: writes flag on clientReady, then deletes it on shardDisconnect', () => {
    const {logger} = makeLogger()
    const {client, fireClientReady, fireShardDisconnect} = makeClient()

    setupReadinessFlag(client, logger, flagPath)

    // Simulate connection
    fireClientReady()
    expect(existsSync(flagPath)).toBe(true)

    // Simulate disconnect
    fireShardDisconnect()
    expect(existsSync(flagPath)).toBe(false)
  })

  // #given clientReady → shardDisconnect → clientReady (reconnect)
  // #then flag is written both times clientReady fires
  it('disconnect → ready: re-writes flag on reconnect after disconnect', () => {
    const {logger} = makeLogger()
    const {client, fireClientReady, fireShardDisconnect} = makeClient()

    setupReadinessFlag(client, logger, flagPath)

    // First connection
    fireClientReady()
    expect(existsSync(flagPath)).toBe(true)

    // Disconnect
    fireShardDisconnect()
    expect(existsSync(flagPath)).toBe(false)

    // Reconnect — flag must be re-written
    fireClientReady()
    expect(existsSync(flagPath)).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Fix 2: shardReady and shardResume re-arm the healthcheck
  // ---------------------------------------------------------------------------

  // #given a disconnect followed by shardResume (session resumed)
  // #when shardResume fires
  // #then the flag is re-written
  it('shardResume re-writes the flag after a disconnect', () => {
    const {logger} = makeLogger()
    const {client, fireClientReady, fireShardDisconnect, fireShardResume} = makeClient()

    setupReadinessFlag(client, logger, flagPath)

    // Establish initial ready state
    fireClientReady()
    expect(existsSync(flagPath)).toBe(true)

    // Disconnect clears the flag
    fireShardDisconnect()
    expect(existsSync(flagPath)).toBe(false)

    // Session resumes — flag must be re-written
    fireShardResume()
    expect(existsSync(flagPath)).toBe(true)
  })

  // #given a disconnect followed by shardReady (new session)
  // #when shardReady fires
  // #then the flag is re-written
  it('shardReady re-writes the flag after a disconnect', () => {
    const {logger} = makeLogger()
    const {client, fireClientReady, fireShardDisconnect, fireShardReady} = makeClient()

    setupReadinessFlag(client, logger, flagPath)

    // Establish initial ready state
    fireClientReady()
    expect(existsSync(flagPath)).toBe(true)

    // Disconnect clears the flag
    fireShardDisconnect()
    expect(existsSync(flagPath)).toBe(false)

    // New shard session — flag must be re-written
    fireShardReady()
    expect(existsSync(flagPath)).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Cold-start: shardReady / shardResume without a prior clientReady
  // ---------------------------------------------------------------------------

  // #given no prior clientReady — common in multi-shard setups where shardReady fires first
  // #when shardReady fires
  // #then the flag is written
  it('cold start: shardReady writes the flag without a prior clientReady', () => {
    // #given no prior clientReady — common in multi-shard setups where shardReady fires first
    const {logger, calls} = makeLogger()
    const {client, fireShardReady} = makeClient()

    setupReadinessFlag(client, logger, flagPath)

    // #when
    fireShardReady()

    // #then flag is written
    expect(existsSync(flagPath)).toBe(true)
    const infoCalls = calls.filter(c => c.method === 'info' && c.msg === 'wrote gateway-ready flag')
    expect(infoCalls).toHaveLength(1)
    expect(infoCalls[0]?.ctx.origin).toBe('shardReady')
  })

  // #given no prior clientReady — possible if a resumed session lands before clientReady is emitted
  // #when shardResume fires
  // #then the flag is written
  it('cold start: shardResume writes the flag without a prior clientReady', () => {
    // #given no prior clientReady — possible if a resumed session lands before clientReady is emitted
    const {logger, calls} = makeLogger()
    const {client, fireShardResume} = makeClient()

    setupReadinessFlag(client, logger, flagPath)

    // #when
    fireShardResume()

    // #then flag is written
    expect(existsSync(flagPath)).toBe(true)
    const infoCalls = calls.filter(c => c.method === 'info' && c.msg === 'wrote gateway-ready flag')
    expect(infoCalls).toHaveLength(1)
    expect(infoCalls[0]?.ctx.origin).toBe('shardResume')
  })

  // ---------------------------------------------------------------------------
  // Fix 5: Disconnect ENOENT branch untested
  // ---------------------------------------------------------------------------

  // #given the flag does not exist (no prior write)
  // #when shardDisconnect fires
  // #then no throw and no error log
  it('shardDisconnect when flag is already absent: no throw, no error log', () => {
    const {logger, calls} = makeLogger()
    const {client, fireShardDisconnect} = makeClient()

    // Flag does not exist (no prior write).
    setupReadinessFlag(client, logger, flagPath)

    // Fire disconnect — unlink should hit ENOENT and silently return.
    expect(() => fireShardDisconnect()).not.toThrow()

    // No error-level log should have been emitted.
    const errorCalls = calls.filter(c => c.method === 'error')
    expect(errorCalls).toHaveLength(0)
  })
})
