/**
 * Tests for opencode-server.ts — startOpencodeServer lifecycle.
 *
 * DOES NOT spawn a real opencode binary — spawn and readiness poll are
 * injected for isolation and speed.
 */

import type {SpawnFn} from './opencode-server.js'

import {EventEmitter} from 'node:events'
import {describe, expect, it, vi} from 'vitest'
import {defaultPollReady, startOpencodeServer} from './opencode-server.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeLogger(overrides?: {error?: (msg: string, meta?: Record<string, unknown>) => void}) {
  return {
    info: (_msg: string, _meta?: Record<string, unknown>) => undefined,
    warn: (_msg: string, _meta?: Record<string, unknown>) => undefined,
    error: overrides?.error ?? ((_msg: string, _meta?: Record<string, unknown>) => undefined),
  }
}

/**
 * Create a fake child process that stays alive until kill() is called.
 * Returns the child handle and a `killCalls` array for assertions.
 */
function makeFakeChild(opts: {exitImmediately?: boolean; exitCode?: number | null}) {
  const emitter = new EventEmitter()
  let exited = false

  if (opts.exitImmediately === true) {
    // Schedule immediate exit on next tick so caller can attach listeners
    setImmediate(() => {
      exited = true
      emitter.emit('exit', opts.exitCode ?? 1)
    })
  }

  const killCalls: (string | undefined)[] = []

  const child = {
    kill: (sig?: string): boolean => {
      killCalls.push(sig)
      if (exited === false) {
        exited = true
        setImmediate(() => emitter.emit('exit', 0))
      }
      return true
    },
    on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
      emitter.on(event, listener)
    },
  }

  return {child, killCalls}
}

/** Build a SpawnFn from a fake child; records call args in spawnArgs[]. */
function makeSpawnFn(
  fakeChild: ReturnType<typeof makeFakeChild>['child'],
  spawnArgs: {command: string; args: readonly string[]}[] = [],
): SpawnFn {
  return (command, args, _opts) => {
    spawnArgs.push({command, args})
    return fakeChild
  }
}

/** Poll that immediately returns ready. */
const alwaysReady = async (_url: string) => true

/** Poll that never returns ready. */
const neverReady = async (_url: string) => false

/** Poll that returns ready after N calls. */
function readyAfter(n: number): (url: string) => Promise<boolean> {
  let calls = 0
  return async (_url: string) => {
    calls++
    return calls >= n
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('startOpencodeServer — happy path', () => {
  it('resolves with a loopback url when the server becomes ready', async () => {
    // #given
    const {child} = makeFakeChild({})
    const spawnArgs: {command: string; args: readonly string[]}[] = []
    const spawnFn = makeSpawnFn(child, spawnArgs)

    // #when
    const handle = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      hostname: '127.0.0.1',
      port: 54321,
      spawnFn,
      pollReadyFn: alwaysReady,
    })

    // #then
    expect(handle.url).toBe('http://127.0.0.1:54321')
    expect(spawnArgs).toHaveLength(1)
    expect(spawnArgs[0]).toMatchObject({
      command: 'opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '54321'],
    })

    handle.close()
  })

  it('calls kill on the child when close() is invoked', async () => {
    // #given
    const {child, killCalls} = makeFakeChild({})
    const handle = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      spawnFn: makeSpawnFn(child),
      pollReadyFn: alwaysReady,
    })

    // #when
    handle.close()

    // #then
    expect(killCalls).toContain('SIGTERM')
  })

  it('resolves after multiple poll attempts', async () => {
    // #given — ready only on the 3rd poll attempt
    const {child} = makeFakeChild({})
    const poll = vi.fn(readyAfter(3))

    // #when
    const handle = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      spawnFn: makeSpawnFn(child),
      pollReadyFn: poll,
      pollIntervalMs: 0, // no actual wait in tests
    })

    // #then
    expect(poll).toHaveBeenCalledTimes(3)
    expect(handle.url).toContain('127.0.0.1')
    handle.close()
  })
})

describe('startOpencodeServer — error paths', () => {
  it('throws if the process exits before becoming ready (spawn fail / crash)', async () => {
    // #given — process exits immediately with code 1
    const {child} = makeFakeChild({exitImmediately: true, exitCode: 1})

    // #when / #then
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 2000,
      }),
    ).rejects.toThrow(/exited before becoming ready/)
  })

  it('throws on timeout and kills the process', async () => {
    // #given — server never becomes ready; very short timeout
    const {child, killCalls} = makeFakeChild({})

    // #when / #then
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1, // 1ms — immediately times out
      }),
    ).rejects.toThrow(/did not become ready within/)

    // Process should have been killed
    expect(killCalls).toContain('SIGTERM')
  })

  it('logs errors without throwing on spawn error event', async () => {
    // #given — spawn emits 'error' event (e.g. binary not found) then exits
    const errorMessages: string[] = []
    const emitter = new EventEmitter()

    const errorChild = {
      kill: (_sig?: string): boolean => true,
      on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
        emitter.on(event, listener)
      },
    }
    setImmediate(() => {
      emitter.emit('error', new Error('spawn ENOENT'))
      emitter.emit('exit', null)
    })

    // #when / #then — should throw (due to exit), not silently hang
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger({error: (msg: string) => errorMessages.push(msg)}),
        spawnFn: () => errorChild,
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 2000,
      }),
    ).rejects.toThrow()

    // Error should have been logged (not swallowed silently)
    expect(errorMessages.some(m => m.includes('opencode-server'))).toBe(true)
  })
})

describe('startOpencodeServer — abort signal', () => {
  it('kills the child when the abort signal fires before ready', async () => {
    // #given
    const {child, killCalls} = makeFakeChild({})
    const ac = new AbortController()

    const promise = startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      signal: ac.signal,
      spawnFn: makeSpawnFn(child),
      pollReadyFn: neverReady,
      pollIntervalMs: 10,
      readyTimeoutMs: 30_000,
    })

    // #when — abort immediately
    ac.abort()

    // #then — child.kill called; promise either rejects or resolves depending on timing
    await promise.then(
      h => h.close(),
      () => undefined,
    )
    expect(killCalls).toContain('SIGTERM')
  })
})

// ── defaultPollReady — per-probe timeout tests ────────────────────────────────
//
// These tests exercise the REAL defaultPollReady (exported for testing) with an
// injected fetchFn so the AbortController composition logic is actually tested.
// Real timers are used with tiny per-probe timeouts (5–20ms) for speed.

describe('defaultPollReady — per-probe timeout', () => {
  it('returns true immediately when fetch resolves with HTTP 200', async () => {
    // #given — fetch resolves immediately with a 200 response
    const fakeFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
      return new Response(null, {status: 200})
    }

    // #when
    const result = await defaultPollReady('http://127.0.0.1:54321', undefined, {
      fetchFn: fakeFetch,
      probeTimeoutMs: 3000,
    })

    // #then
    expect(result).toBe(true)
  })

  it('returns false (not ready yet) when fetch hangs past the per-probe timeout', async () => {
    // #given — fetch hangs until the signal aborts (simulates a hung connection)
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }

    // #when — use a very short per-probe timeout so the test is fast
    const result = await defaultPollReady('http://127.0.0.1:54321', undefined, {
      fetchFn: fakeFetch,
      probeTimeoutMs: 10, // 10ms — fires quickly
    })

    // #then — per-probe timeout treated as "not ready yet", not a fatal error
    expect(result).toBe(false)
  })

  it('resolves ready when first probe hangs but second probe succeeds (loop unblocked)', async () => {
    // #given — first fetch hangs until aborted, second resolves immediately
    let callCount = 0
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      callCount++
      if (callCount === 1) {
        // First call: hang until the per-probe signal fires
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      }
      // Subsequent calls: resolve immediately
      return new Response(null, {status: 200})
    }

    const {child} = makeFakeChild({})

    // #when — use a tiny per-probe timeout so the hung first probe unblocks quickly
    const handle = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      spawnFn: makeSpawnFn(child),
      // Use the real defaultPollReady via pollReadyFn wrapper that injects our fakeFetch
      pollReadyFn: async (url: string, signal?: AbortSignal) =>
        defaultPollReady(url, signal, {fetchFn: fakeFetch, probeTimeoutMs: 10}),
      pollIntervalMs: 0,
      readyTimeoutMs: 5000, // generous outer deadline
    })

    // #then — resolved ready despite the first probe hanging
    expect(handle.url).toContain('127.0.0.1')
    expect(callCount).toBeGreaterThanOrEqual(2)
    handle.close()
  })

  it('times out and kills the child when every probe hangs past the per-probe timeout', async () => {
    // #given — every fetch hangs until aborted (simulates a permanently hung connection)
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }

    const {child, killCalls} = makeFakeChild({})

    // #when — tiny per-probe timeout + tiny outer deadline → must fail fast
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn: async (url: string, signal?: AbortSignal) =>
          defaultPollReady(url, signal, {fetchFn: fakeFetch, probeTimeoutMs: 10}),
        pollIntervalMs: 0,
        readyTimeoutMs: 50, // outer deadline — must expire after a few hung probes
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — child was killed (no permanent 'starting' state)
    expect(killCalls).toContain('SIGTERM')
  })

  it('propagates caller signal abort through the per-probe controller', async () => {
    // #given — fetch hangs until the signal fires; caller aborts mid-probe
    const fakeFetch = async (_url: string, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        // Wire the abort signal so fetch rejects when aborted
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }

    const ac = new AbortController()

    // #when — start a probe then abort the caller signal
    const probePromise = defaultPollReady('http://127.0.0.1:54321', ac.signal, {
      fetchFn: fakeFetch,
      probeTimeoutMs: 5000, // long per-probe timeout — caller abort fires first
    })

    // Abort the caller signal after a short delay
    setTimeout(() => ac.abort(), 5)

    // #then — the probe rejects with an abort error (caller abort propagates)
    await expect(probePromise).rejects.toThrow(/abort/i)
  })
})
