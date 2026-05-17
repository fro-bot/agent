import type {Client} from 'discord.js'
import type {GatewayLogger} from './discord/client.js'

import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {DEFAULT_DRAIN_MS, installShutdownHandlers} from './shutdown.js'

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

function makeClient(destroyDelay = 0): Client {
  return {
    destroy: vi.fn().mockImplementation(async () => new Promise<void>(resolve => setTimeout(resolve, destroyDelay))),
  } as unknown as Client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('installShutdownHandlers', () => {
  let exitCodes: (number | string | null | undefined)[]
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    exitCodes = []
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      exitCodes.push(code)
      // Do NOT throw — throwing from inside Promise.then() causes the .catch()
      // branch to fire process.exit(1) again, masking the real exit code.
      return undefined as never
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(exitSpy as {mockRestore: () => void}).mockRestore()
  })

  it('registers SIGTERM and SIGINT listeners', () => {
    // #given
    const {logger} = makeLogger()
    const client = makeClient()
    const beforeSigterm = process.listenerCount('SIGTERM')
    const beforeSigint = process.listenerCount('SIGINT')

    // #when
    const cleanup = installShutdownHandlers(client, logger)

    // #then
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm + 1)
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint + 1)

    cleanup()
  })

  it('cleanup function removes both listeners', () => {
    // #given
    const {logger} = makeLogger()
    const client = makeClient()
    const beforeSigterm = process.listenerCount('SIGTERM')
    const beforeSigint = process.listenerCount('SIGINT')
    const cleanup = installShutdownHandlers(client, logger)

    // #when
    cleanup()

    // #then
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm)
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint)
  })

  it('logs shutdown clean and exits 0 when destroy resolves within drainMs', async () => {
    // #given
    const {logger, calls} = makeLogger()
    const client = makeClient(0) // resolves immediately
    const drainMs = 1_000
    const cleanup = installShutdownHandlers(client, logger, drainMs)

    // #when — emit SIGTERM and flush all timers so Promise.race resolves
    process.emit('SIGTERM')
    await vi.runAllTimersAsync()
    cleanup()

    // #then
    expect(calls.some(c => c.method === 'info' && c.msg === 'shutdown initiated')).toBe(true)
    expect(calls.some(c => c.method === 'info' && c.msg === 'shutdown clean')).toBe(true)
    expect(exitCodes).toContain(0)
    expect(exitCodes).not.toContain(1)
  })

  it('logs shutdown timeout and exits 1 when destroy hangs longer than drainMs', async () => {
    // #given
    const {logger, calls} = makeLogger()
    const drainMs = 500
    const client = makeClient(drainMs * 10) // hangs well past drain window
    const cleanup = installShutdownHandlers(client, logger, drainMs)

    // #when — emit SIGTERM then advance past drain window
    process.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(drainMs + 1)
    cleanup()

    // #then
    expect(calls.some(c => c.method === 'info' && c.msg === 'shutdown initiated')).toBe(true)
    expect(calls.some(c => c.method === 'warn' && c.msg === 'shutdown timeout')).toBe(true)
    expect(exitCodes).toContain(1)
  })

  it('default drain ms is 25000', () => {
    expect(DEFAULT_DRAIN_MS).toBe(25_000)
  })
})
