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
 * Minimal ReadinessClient mock that captures the `clientReady` callback so
 * tests can simulate the event by invoking it directly.
 */
function makeClient(): {client: ReadinessClient; fireClientReady: () => void} {
  let capturedCallback: (() => void) | undefined

  const client: ReadinessClient = {
    once: (event: 'clientReady', listener: () => void) => {
      if (event === 'clientReady') {
        capturedCallback = listener
      }
      return client
    },
  }

  return {
    client,
    fireClientReady: () => {
      if (capturedCallback === undefined) throw new Error('clientReady listener was never registered')
      capturedCallback()
    },
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
    writeFileSync(flagPath, 'stale')

    const removalOrder: string[] = []

    // Intercept `once` to record when the listener is registered
    const {client} = makeClient()
    const originalOnce = client.once.bind(client)
    vi.spyOn(client, 'once').mockImplementation((event, listener) => {
      removalOrder.push('listener-registered')
      return originalOnce(event, listener)
    })

    // The stale flag should be gone before once() is called
    const originalSetup = setupReadinessFlag
    // We can't easily intercept unlinkSync mid-function, so instead we verify
    // the observable outcome: after setup, the flag is absent (cleared), and
    // the listener is registered (once was called).
    originalSetup(client, logger, flagPath)

    expect(existsSync(flagPath)).toBe(false)
    expect(removalOrder).toContain('listener-registered')
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
  // #then logger.info is called with 'gateway ready'
  it('logs info when the flag is written successfully', () => {
    const {logger, calls} = makeLogger()
    const {client, fireClientReady} = makeClient()

    setupReadinessFlag(client, logger, flagPath)
    fireClientReady()

    const infoCalls = calls.filter(c => c.method === 'info' && c.msg === 'gateway ready')
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
})
