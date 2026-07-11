/**
 * Tests for opencode-server.ts — startOpencodeServer lifecycle.
 *
 * DOES NOT spawn a real opencode binary — spawn and readiness poll are
 * injected for isolation and speed.
 */

import type {SpawnFn} from './opencode-server.js'

import {EventEmitter} from 'node:events'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {defaultPollReady, runSupervisedOpencode, startOpencodeServer} from './opencode-server.js'

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

// ── Supervised respawn tests ──────────────────────────────────────────────────
//
// These tests exercise the supervised respawn loop.
// Real timers, zero/tiny delays, injected spawnFn/pollReadyFn per convention.

/**
 * Create a factory-based spawnFn that returns a different fake child on each
 * call. Each child in `children` is used in order; the last one is reused if
 * the list is exhausted.
 */
function makeMultiSpawnFn(
  children: {readonly child: ReturnType<typeof makeFakeChild>['child']}[],
  spawnCalls: number[] = [],
): SpawnFn {
  let idx = 0
  return (_command, _args, _opts) => {
    spawnCalls.push(idx)
    const entry = children[Math.min(idx, children.length - 1)]
    if (entry === undefined) {
      throw new Error('makeMultiSpawnFn: no children provided')
    }
    idx++
    return entry.child
  }
}

/**
 * A controllable fake child whose exit can be triggered manually.
 * Returns `{child, killCalls, triggerExit}`.
 */
function makeControllableChild() {
  const emitter = new EventEmitter()
  let exited = false
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

  const triggerExit = (code: number | null = 1): void => {
    if (exited === false) {
      exited = true
      emitter.emit('exit', code)
    }
  }

  return {child, killCalls, triggerExit}
}

describe('runSupervisedOpencode — happy path', () => {
  it('resolves with status ready when first spawn becomes ready (then exits cleanly)', async () => {
    // #given — first child becomes ready immediately, then exits cleanly (simulates
    // a normal lifecycle: ready → child exits → supervisor goes to degraded since
    // maxAttempts=1 and no more attempts remain).
    // The key assertion is that status was 'ready' at some point and the supervisor
    // does not crash or hang.
    const {child, triggerExit} = makeControllableChild()
    const spawnCalls: number[] = []
    const spawnFn = makeMultiSpawnFn([{child}], spawnCalls)
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    let wasReady = false

    // #when — start supervisor; it will become ready, then we trigger exit
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn: alwaysReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000,
      maxAttempts: 1, // single attempt — resolves after child exits
      initialBackoffMs: 0,
    })

    // Wait for status to become ready, then trigger a clean exit
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          wasReady = true
          // Trigger clean exit so the supervisor can resolve
          triggerExit(0)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    await supervisorPromise

    // #then — status was ready; only one spawn; supervisor resolved cleanly
    expect(wasReady).toBe(true)
    expect(spawnCalls).toHaveLength(1)
  })
})

describe('runSupervisedOpencode — transient failure recovery', () => {
  it('recovers when first spawn fails but second becomes ready', async () => {
    // #given — first child exits immediately (failure), second becomes ready then exits
    const failChild = makeFakeChild({exitImmediately: true, exitCode: 1})
    const successChild = makeControllableChild()
    const spawnCalls: number[] = []
    const spawnFn = makeMultiSpawnFn([failChild, successChild], spawnCalls)
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // Poll: never ready for first child (it exits), always ready for second
    const pollReadyFn = async (_url: string): Promise<boolean> => {
      // spawnCalls.length tracks how many spawns have happened
      return spawnCalls.length >= 2
    }

    // #when — start supervisor; trigger exit on second child once ready
    let wasReady = false
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000,
      maxAttempts: 2, // first fails, second succeeds
      initialBackoffMs: 0,
    })

    // Wait for ready, then trigger exit so supervisor can resolve
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          wasReady = true
          successChild.triggerExit(0)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    await supervisorPromise

    // #then — status was ready after second attempt; two spawns
    expect(wasReady).toBe(true)
    expect(spawnCalls).toHaveLength(2)
  })

  it('gives each respawn attempt a fresh readiness deadline', async () => {
    // #given — first child exits immediately; second child is slow-but-ready
    // The second attempt must NOT be killed by a carried-over deadline from attempt 1.
    const failChild = makeFakeChild({exitImmediately: true, exitCode: 1})
    const successChild = makeControllableChild()
    const spawnCalls: number[] = []
    const spawnFn = makeMultiSpawnFn([failChild, successChild], spawnCalls)
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // Poll: returns ready only after 3 calls total (simulates slow second attempt)
    let totalCalls = 0
    const pollReadyFn = async (_url: string): Promise<boolean> => {
      totalCalls++
      // Only ready after 3 polls AND we're on the second spawn
      return spawnCalls.length >= 2 && totalCalls >= 3
    }

    // #when — start supervisor; trigger exit on second child once ready
    let wasReady = false
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000, // generous — second attempt must not be killed early
      maxAttempts: 2,
      initialBackoffMs: 0,
    })

    // Wait for ready, then trigger exit so supervisor can resolve
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          wasReady = true
          successChild.triggerExit(0)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    await supervisorPromise

    // #then — second attempt succeeded; deadline was reset
    expect(wasReady).toBe(true)
    expect(spawnCalls).toHaveLength(2)
  })
})

describe('runSupervisedOpencode — exhaustion', () => {
  it('lands in degraded (not starting, not down) when all attempts fail', async () => {
    // #given — all children exit immediately
    const children = [
      makeFakeChild({exitImmediately: true, exitCode: 1}),
      makeFakeChild({exitImmediately: true, exitCode: 1}),
      makeFakeChild({exitImmediately: true, exitCode: 1}),
    ]
    const spawnCalls: number[] = []
    const spawnFn = makeMultiSpawnFn(children, spawnCalls)
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // #when
    await runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn: neverReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 50,
      maxAttempts: 3,
      initialBackoffMs: 0,
    })

    // #then — degraded, not stuck at starting, not silently down
    expect(statusRef.status).toBe('degraded')
    expect(statusRef.status).not.toBe('starting')
    expect(statusRef.status).not.toBe('down')
  })

  it('stops retrying and lands in degraded when max attempts are exhausted', async () => {
    // #given — persistent failure; maxAttempts = 2
    const children = [
      makeFakeChild({exitImmediately: true, exitCode: 1}),
      makeFakeChild({exitImmediately: true, exitCode: 1}),
      makeFakeChild({exitImmediately: true, exitCode: 1}), // should NOT be used
    ]
    const spawnCalls: number[] = []
    const spawnFn = makeMultiSpawnFn(children, spawnCalls)
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // #when
    await runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn: neverReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 50,
      maxAttempts: 2,
      initialBackoffMs: 0,
    })

    // #then — spawn count bounded by maxAttempts
    expect(spawnCalls.length).toBeLessThanOrEqual(2)
    expect(statusRef.status).toBe('degraded')
  })
})

describe('runSupervisedOpencode — post-ready exit latch fix', () => {
  it('flips status away from ready when child exits after becoming ready', async () => {
    // #given — child becomes ready, then exits unexpectedly
    const {child, triggerExit} = makeControllableChild()
    const spawnCalls: number[] = []
    const spawnFn = makeMultiSpawnFn([{child}], spawnCalls)
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // Poll: ready on first call
    let pollCount = 0
    const pollReadyFn = async (_url: string): Promise<boolean> => {
      pollCount++
      return pollCount >= 1
    }

    // #when — start supervisor (will become ready), then trigger exit
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000,
      maxAttempts: 1, // no respawn — go straight to terminal state
      initialBackoffMs: 0,
    })

    // Wait for status to become ready
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    // Confirm it's ready before the exit
    expect(statusRef.status).toBe('ready')

    // Trigger unexpected exit AFTER ready
    triggerExit(1)

    // Wait for supervisor to settle
    await supervisorPromise

    // #then — status must NOT be stuck at 'ready' after the child exited
    expect(statusRef.status).not.toBe('ready')
  })
})

describe('runSupervisedOpencode — fail-closed transition', () => {
  it('sets status to starting (not-ready) before killing the child on respawn', async () => {
    // #given — first child times out (kill is called); we capture status at kill time.
    // Second child becomes ready then exits so the supervisor can resolve.
    const statusAtKill: string[] = []
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const emitter1 = new EventEmitter()
    let child1Exited = false
    const child1 = {
      kill: (_sig?: string): boolean => {
        // Capture status at the moment kill() is called on the first child.
        // The supervisor must have set status to 'starting' BEFORE calling kill.
        statusAtKill.push(statusRef.status)
        if (child1Exited === false) {
          child1Exited = true
          setImmediate(() => emitter1.emit('exit', 0))
        }
        return true
      },
      on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
        emitter1.on(event, listener)
      },
    }

    // Second child becomes ready, then we trigger exit so supervisor can resolve.
    const child2 = makeControllableChild()

    let spawnCount = 0
    const trackingSpawnFn: SpawnFn = (_cmd, _args, _opts) => {
      spawnCount++
      return spawnCount === 1 ? child1 : child2.child
    }

    // Poll: never ready for first child (timeout kills it), always ready for second
    const pollReadyFn = async (_url: string): Promise<boolean> => {
      return spawnCount >= 2
    }

    // #when — start supervisor; first attempt times out → kill called → second becomes ready
    let wasReady = false
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn: trackingSpawnFn,
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 10, // short timeout → first attempt times out → kill called
      maxAttempts: 2,
      initialBackoffMs: 0,
    })

    // Wait for ready on second attempt, then trigger exit so supervisor resolves
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          wasReady = true
          child2.triggerExit(0)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    await supervisorPromise

    // #then — at the moment kill() was called on child1, status was 'starting' (not 'ready')
    expect(statusAtKill.length).toBeGreaterThan(0)
    expect(statusAtKill[0]).toBe('starting')
    expect(wasReady).toBe(true)
  })
})

// ── Process-group reaping tests ──────────────────────────────────────
//
// These tests verify that:
// 1. When child.pid is a number, kill uses process.kill(-pid, 'SIGTERM') (group kill).
// 2. When child.pid is undefined, falls back to child.kill('SIGTERM').
// 3. spawnFn is called with detached: true.
// 4. Security invariants: loopback bind unchanged, no secret/token logging on kill path.
// 5. Abort path uses the group-kill helper when pid is present.
//
// Strategy for existing kill-assertion tests:
// - makeFakeChild() and makeControllableChild() do NOT set a pid, so they use the
//   fallback path (child.kill('SIGTERM')). Existing assertions remain valid.
// - New tests use makeFakeChildWithPid() which sets pid, triggering the group-kill path.
//   Those tests spy on process.kill and assert the negative-pid call.

/**
 * Create a fake child with a numeric pid. The kill spy is a vi.fn() so we can
 * assert it was or was not called. process.kill is spied separately per test.
 */
function makeFakeChildWithPid(pid: number, opts: {exitImmediately?: boolean; exitCode?: number | null} = {}) {
  const emitter = new EventEmitter()
  let exited = false

  if (opts.exitImmediately === true) {
    setImmediate(() => {
      exited = true
      emitter.emit('exit', opts.exitCode ?? 1)
    })
  }

  const killSpy = vi.fn((_sig?: string): boolean => {
    if (exited === false) {
      exited = true
      setImmediate(() => emitter.emit('exit', 0))
    }
    return true
  })

  const child = {
    pid,
    kill: killSpy,
    on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
      emitter.on(event, listener)
    },
  }

  return {child, killSpy}
}

/** Build a SpawnFn that records spawn options (including detached) in spawnOpts[]. */
function makeSpawnFnWithOpts(
  fakeChild: ReturnType<typeof makeFakeChildWithPid>['child'],
  spawnOpts: {
    command: string
    args: readonly string[]
    options: {readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly detached?: boolean}
  }[] = [],
): SpawnFn {
  return (command, args, opts) => {
    spawnOpts.push({command, args, options: opts})
    return fakeChild
  }
}

describe('process-group reaping — group kill when pid is present', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls process.kill(-pid, SIGTERM) on timeout when child.pid is a number', async () => {
    // #given — child with pid 12345; server never becomes ready → timeout kill
    const pid = 12345
    const {child} = makeFakeChildWithPid(pid)
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — timeout fires
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFnWithOpts(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1, // immediate timeout
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — group kill via negative pid
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
  })

  it('falls back to child.kill(SIGTERM) on timeout when child.pid is undefined', async () => {
    // #given — child WITHOUT pid (existing makeFakeChild pattern); server never ready
    const {child, killCalls} = makeFakeChild({})
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — timeout fires
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — fallback: child.kill called, NOT process.kill(-pid)
    expect(killCalls).toContain('SIGTERM')
    // process.kill should NOT have been called with a negative pid
    const negPidCalls = processKillSpy.mock.calls.filter(([p]) => typeof p === 'number' && p < 0)
    expect(negPidCalls).toHaveLength(0)
  })

  it('spawns with detached: true', async () => {
    // #given — capture spawn options
    const pid = 99999
    const {child} = makeFakeChildWithPid(pid)
    const spawnOpts: {
      command: string
      args: readonly string[]
      options: {readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly detached?: boolean}
    }[] = []
    vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — start server (will timeout, but we only care about spawn options)
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFnWithOpts(child, spawnOpts),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow()

    // #then — detached: true was passed to spawnFn
    expect(spawnOpts).toHaveLength(1)
    expect(spawnOpts[0]?.options).toMatchObject({detached: true})
  })

  it('bind remains 127.0.0.1 and no secret/token is logged on the kill path', async () => {
    // #given — capture log calls; child with pid
    const pid = 11111
    const {child} = makeFakeChildWithPid(pid)
    vi.spyOn(process, 'kill').mockReturnValue(true)

    const loggedMeta: (Record<string, unknown> | undefined)[] = []
    const logger = {
      info: (_msg: string, meta?: Record<string, unknown>) => {
        loggedMeta.push(meta)
      },
      warn: (_msg: string, meta?: Record<string, unknown>) => {
        loggedMeta.push(meta)
      },
      error: (_msg: string, meta?: Record<string, unknown>) => {
        loggedMeta.push(meta)
      },
    }

    const spawnOpts: {command: string; args: readonly string[]; options: Record<string, unknown>}[] = []

    // #when — timeout fires (triggers kill path)
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger,
        hostname: '127.0.0.1',
        port: 54321,
        spawnFn: makeSpawnFnWithOpts(child, spawnOpts),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow()

    // #then — spawn args use loopback hostname
    expect(spawnOpts[0]?.args).toContain('127.0.0.1')

    // #then — no logged meta contains token/secret/env-like keys
    const secretKeys = ['token', 'secret', 'password', 'credential', 'env', 'authorization']
    for (const meta of loggedMeta) {
      if (meta === undefined) continue
      for (const key of Object.keys(meta)) {
        expect(secretKeys.some(s => key.toLowerCase().includes(s))).toBe(false)
      }
    }
  })

  it('uses group kill on abort path when child.pid is present', async () => {
    // #given — child with pid; abort fires while server is polling.
    // The process.kill mock must also emit exit on the child so the polling
    // loop terminates (otherwise the mocked kill is a no-op and the loop hangs).
    const pid = 22222
    const emitter = new EventEmitter()
    let exited = false
    const killSpy = vi.fn((_sig?: string): boolean => true)
    const child = {
      pid,
      kill: killSpy,
      on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
        emitter.on(event, listener)
      },
    }

    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation((..._args) => {
      // Simulate the OS killing the process group: emit exit on the child.
      if (exited === false) {
        exited = true
        setImmediate(() => emitter.emit('exit', null))
      }
      return true
    })

    const ac = new AbortController()

    const promise = startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      signal: ac.signal,
      spawnFn: makeSpawnFnWithOpts(child),
      pollReadyFn: neverReady,
      pollIntervalMs: 10,
      readyTimeoutMs: 30_000,
    })

    // #when — abort immediately
    ac.abort()

    // #then — wait for promise to settle
    await promise.then(
      h => h.close(),
      () => undefined,
    )

    // group kill via negative pid should have been called
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
  })
})

// ── Fix 1: pid guard — exclude pid 0 and 1 from negative-pid group kill ──────
//
// process.kill(-0, …) signals the supervisor's OWN process group.
// process.kill(-1, …) broadcasts SIGTERM to every process the user can reach.
// Both are catastrophic. The guard must be pid > 1 (not just isFinite).

describe('killChildGroup — pid guard (Fix 1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls process.kill(-pid, SIGTERM) for a normal pid like 12345', async () => {
    // #given — child with pid 12345; timeout fires
    const pid = 12345
    const {child} = makeFakeChildWithPid(pid)
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — timeout fires → killChildGroup called
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFnWithOpts(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — group kill via negative pid
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
  })

  it('falls back to child.kill when pid === 1 (never calls process.kill with negative arg)', async () => {
    // #given — child with pid 1 (init process — catastrophic to group-kill)
    const pid = 1
    const {child, killSpy} = makeFakeChildWithPid(pid)
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — timeout fires → killChildGroup called
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFnWithOpts(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — fallback: child.kill called, NOT process.kill(-1, …)
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    const negPidCalls = processKillSpy.mock.calls.filter(([p]) => typeof p === 'number' && p < 0)
    expect(negPidCalls).toHaveLength(0)
  })

  it('falls back to child.kill when pid === 0 (never calls process.kill with negative arg)', async () => {
    // #given — child with pid 0 (process.kill(-0) = own group — catastrophic)
    const pid = 0
    const {child, killSpy} = makeFakeChildWithPid(pid)
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — timeout fires → killChildGroup called
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFnWithOpts(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — fallback: child.kill called, NOT process.kill(-0, …)
    expect(killSpy).toHaveBeenCalledWith('SIGTERM')
    const negPidCalls = processKillSpy.mock.calls.filter(([p]) => typeof p === 'number' && p <= 0)
    expect(negPidCalls).toHaveLength(0)
  })

  it('falls back to child.kill when pid is undefined', async () => {
    // #given — child WITHOUT pid (existing pattern)
    const {child, killCalls} = makeFakeChild({})
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    // #when — timeout fires
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn: neverReady,
        pollIntervalMs: 0,
        readyTimeoutMs: 1,
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — fallback: child.kill called, NOT process.kill with negative pid
    expect(killCalls).toContain('SIGTERM')
    const negPidCalls = processKillSpy.mock.calls.filter(([p]) => typeof p === 'number' && p < 0)
    expect(negPidCalls).toHaveLength(0)
  })
})

// ── Fix 2: stable-ready reset — respawn budget resets after stable uptime ─────
//
// A child that stays ready for >= stableReadyResetMs before exiting is treated
// as a healthy run. The attempt counter + backoff reset so only RAPID crash
// loops consume the bounded budget.

describe('runSupervisedOpencode — stable-ready reset (Fix 2)', () => {
  it('does NOT go degraded after 4+ lifetime exits when each run was stable', async () => {
    // #given — child becomes ready, stays ready >= stableReadyResetMs (50ms), exits.
    // With 4 exits and maxAttempts=4, WITHOUT reset it would go degraded.
    // WITH reset, each stable run resets the budget so it keeps respawning.
    //
    // We run 5 stable-exit cycles and assert it never goes degraded.
    // After the 5th stable exit we abort the supervisor to stop it cleanly.
    const stableReadyResetMs = 50 // tiny for test speed
    const maxAttempts = 4

    // Build 6 controllable children (5 stable exits + 1 that the abort kills)
    const children = Array.from({length: 6}, () => makeControllableChild())
    let childIdx = 0
    const ac = new AbortController()
    const spawnFn: SpawnFn = () => {
      const c = children[childIdx]
      if (c === undefined) throw new Error('ran out of children')
      childIdx++
      return c.child
    }

    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      signal: ac.signal,
      spawnFn,
      pollReadyFn: alwaysReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000,
      maxAttempts,
      initialBackoffMs: 0,
      stableReadyResetMs,
    })

    // Cycle through 5 stable exits: wait for ready, wait stableReadyResetMs, exit
    for (let i = 0; i < 5; i++) {
      // Wait for status to become ready
      await new Promise<void>(resolve => {
        const check = (): void => {
          if (statusRef.status === 'ready') {
            resolve()
          } else {
            setImmediate(check)
          }
        }
        setImmediate(check)
      })

      // Assert never degraded during stable cycles
      expect(statusRef.status).toBe('ready')

      // Wait for the stable period to elapse, then trigger exit
      await new Promise<void>(r => setTimeout(r, stableReadyResetMs + 10))
      children[i]?.triggerExit(0)
    }

    // After 5 stable exits the supervisor spawns the 6th child and waits for it
    // to become ready. Wait for ready, then abort to stop the supervisor cleanly.
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    // Abort — the supervisor's abort handler kills the 6th child's group and returns.
    ac.abort()
    // Also trigger exit on the 6th child so the post-ready wait resolves.
    children[5]?.triggerExit(0)

    await supervisorPromise

    // #then — never went degraded despite 5+ lifetime exits (budget reset each time)
    expect(statusRef.status).not.toBe('degraded')
  })

  it('goes degraded when child crashes RAPIDLY maxAttempts times (rapid crash-loop bounded)', async () => {
    // #given — child crashes immediately (< stableReadyResetMs) on every spawn
    // This must still exhaust the budget and go degraded.
    const stableReadyResetMs = 200 // large enough that immediate crash is always "rapid"
    const maxAttempts = 3

    const children = Array.from({length: maxAttempts + 1}, () => makeFakeChild({exitImmediately: true, exitCode: 1}))
    let childIdx = 0
    const spawnFn: SpawnFn = () => {
      const c = children[childIdx]
      if (c === undefined) throw new Error('ran out of children')
      childIdx++
      return c.child
    }

    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // #when — all children exit immediately before becoming ready
    await runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn,
      pollReadyFn: neverReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 50,
      maxAttempts,
      initialBackoffMs: 0,
      stableReadyResetMs,
    })

    // #then — degraded (rapid crash-loop still bounded)
    expect(statusRef.status).toBe('degraded')
    expect(childIdx).toBeLessThanOrEqual(maxAttempts)
  })
})

// ── Fix 3: killChildGroup does not throw ─────────────────────────────────────
//
// process.kill(-pid) can throw ESRCH if the child exited between the state
// check and the OS call. The exception must not escape the supervisor path.

describe('killChildGroup — does not throw on ESRCH (Fix 3)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('supervisor proceeds (no rejection) when process.kill throws ESRCH', async () => {
    // #given — child with pid; process.kill throws ESRCH (child already gone)
    const pid = 55555
    const {child} = makeFakeChildWithPid(pid)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH: no such process'), {code: 'ESRCH'})
    })

    // #when — timeout fires → killChildGroup called → process.kill throws
    // The supervisor must NOT reject; it should resolve (or throw only the timeout error)
    const result = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      spawnFn: makeSpawnFnWithOpts(child),
      pollReadyFn: neverReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 1,
    }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    // #then — the error is the timeout error, NOT an ESRCH propagation
    expect(result).toMatch(/did not become ready within/)
  })

  it('supervisor proceeds when child.kill throws (fallback path)', async () => {
    // #given — child WITHOUT pid; child.kill throws
    const emitter = new EventEmitter()
    const child = {
      kill: (_sig?: string): boolean => {
        throw new Error('kill failed')
      },
      on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
        emitter.on(event, listener)
      },
    }

    // #when — timeout fires → killChildGroup → child.kill throws
    const result = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      spawnFn: () => child,
      pollReadyFn: neverReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 1,
    }).then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    // #then — timeout error propagates, kill error is swallowed
    expect(result).toMatch(/did not become ready within/)
  })
})

// ── Per-probe readiness deadline cap ──────────────────────────────────
//
// The readiness polling loop must cap each probe to the remaining overall
// deadline so the loop can't overshoot WORKSPACE_OPENCODE_READY_TIMEOUT_MS by
// a full probe timeout. This must be applied to BOTH call sites:
//   1. startOpencodeServer() readiness loop
//   2. runSupervisedOpencode() readiness loop (the production supervisor path)
//
// Strategy: inject a pollReadyFn spy that records the probeTimeoutMs it receives
// and returns false (never ready) so the loop keeps running until the deadline.
// Use real timers — the deadline is set to a very short value (e.g. 50ms) and
// the probe timeout is set to a large value (e.g. 3000ms). The spy asserts the
// capped value (≤ remaining) was passed, not the raw 3000ms.

describe('startOpencodeServer — per-probe deadline cap', () => {
  it('caps per-probe timeout to remaining deadline when overall timeout is very short', async () => {
    // #given — overall timeout 50ms, default probe timeout 3000ms
    // The spy records every probeTimeoutMs value passed to it
    const {child, killCalls} = makeFakeChild({})
    const capturedProbeTimeouts: (number | undefined)[] = []

    const pollReadyFn = async (_url: string, _signal?: AbortSignal, probeTimeoutMs?: number): Promise<boolean> => {
      capturedProbeTimeouts.push(probeTimeoutMs)
      // Simulate a fast-returning probe (not actually waiting probeTimeoutMs)
      return false
    }

    // #when — start with a very short overall timeout
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn,
        pollIntervalMs: 0,
        readyTimeoutMs: 50, // very short overall deadline
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — every probe timeout passed must be ≤ 50ms (capped to remaining)
    expect(capturedProbeTimeouts.length).toBeGreaterThan(0)
    for (const t of capturedProbeTimeouts) {
      expect(t).toBeDefined()
      expect(t).toBeGreaterThanOrEqual(1) // Math.max(1, ...) floor
      expect(t).toBeLessThanOrEqual(50) // capped to overall timeout
    }
    expect(killCalls).toContain('SIGTERM')
  })

  it('uses full probeTimeoutMs (3000ms default) when remaining >> probeTimeoutMs', async () => {
    // #given — overall timeout 60000ms (default), probe timeout 3000ms
    // When remaining is large, the probe gets the full 3000ms cap
    const {child} = makeFakeChild({})
    const capturedProbeTimeouts: (number | undefined)[] = []
    let callCount = 0

    const pollReadyFn = async (_url: string, _signal?: AbortSignal, probeTimeoutMs?: number): Promise<boolean> => {
      capturedProbeTimeouts.push(probeTimeoutMs)
      callCount++
      // Return ready on first call so the test doesn't run for 60s
      return true
    }

    // #when — start with generous overall timeout
    const handle = await startOpencodeServer({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      spawnFn: makeSpawnFn(child),
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 60_000,
    })

    // #then — the probe timeout passed should be the full 3000ms (not capped)
    expect(callCount).toBeGreaterThan(0)
    expect(capturedProbeTimeouts[0]).toBe(3_000)
    handle.close()
  })

  it('exits loop before probing when remaining <= 0', async () => {
    // #given — overall timeout 1ms (already expired by the time the loop runs)
    const {child} = makeFakeChild({})
    let probeCallCount = 0

    const pollReadyFn = async (_url: string, _signal?: AbortSignal, _probeTimeoutMs?: number): Promise<boolean> => {
      probeCallCount++
      return false
    }

    // #when — start with effectively-zero timeout
    await expect(
      startOpencodeServer({
        rootDir: '/workspace/repos',
        logger: makeLogger(),
        spawnFn: makeSpawnFn(child),
        pollReadyFn,
        pollIntervalMs: 0,
        readyTimeoutMs: 1, // expires almost immediately
      }),
    ).rejects.toThrow(/did not become ready within/)

    // #then — the loop exits very early: with a 1ms deadline the `remaining <= 0`
    // guard fires within the first few iterations. The key invariant is that the
    // probe is NOT called many times — the early-exit guard prevents unbounded
    // probing past the deadline. A small upper bound (10) is generous enough to
    // be stable on slow CI while still proving the guard works.
    expect(probeCallCount).toBeLessThan(10)
  })
})

describe('runSupervisedOpencode — per-probe deadline cap', () => {
  it('caps per-probe timeout to remaining deadline in the supervisor readiness loop', async () => {
    // #given — overall timeout 50ms, default probe timeout 3000ms
    // The supervisor readiness loop must also cap per-probe timeout
    const {child, triggerExit} = makeControllableChild()
    const capturedProbeTimeouts: (number | undefined)[] = []
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const pollReadyFn = async (_url: string, _signal?: AbortSignal, probeTimeoutMs?: number): Promise<boolean> => {
      capturedProbeTimeouts.push(probeTimeoutMs)
      return false // never ready — let the deadline expire
    }

    // #when — start supervisor with very short overall timeout
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn: makeSpawnFn(child),
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 50, // very short overall deadline
      maxAttempts: 1, // single attempt — no respawn
      initialBackoffMs: 0,
    })

    // Trigger exit so the supervisor can resolve after the deadline
    setImmediate(() => triggerExit(1))

    await supervisorPromise

    // #then — every probe timeout passed must be ≤ 50ms (capped to remaining)
    expect(capturedProbeTimeouts.length).toBeGreaterThan(0)
    for (const t of capturedProbeTimeouts) {
      expect(t).toBeDefined()
      expect(t).toBeGreaterThanOrEqual(1) // Math.max(1, ...) floor
      expect(t).toBeLessThanOrEqual(50) // capped to overall timeout
    }
  })

  it('uses full probeTimeoutMs (3000ms default) in supervisor when remaining >> probeTimeoutMs', async () => {
    // #given — overall timeout 60000ms, probe timeout 3000ms
    // When remaining is large, the supervisor probe gets the full 3000ms cap
    const {child, triggerExit} = makeControllableChild()
    const capturedProbeTimeouts: (number | undefined)[] = []
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    let probeCount = 0
    const pollReadyFn = async (_url: string, _signal?: AbortSignal, probeTimeoutMs?: number): Promise<boolean> => {
      capturedProbeTimeouts.push(probeTimeoutMs)
      probeCount++
      // Return ready on first call so the test doesn't run for 60s
      return true
    }

    // #when — start supervisor with generous overall timeout
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn: makeSpawnFn(child),
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 60_000,
      maxAttempts: 1,
      initialBackoffMs: 0,
    })

    // Wait for ready, then trigger exit so supervisor resolves
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          triggerExit(0)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    await supervisorPromise

    // #then — the probe timeout passed should be the full 3000ms (not capped)
    expect(probeCount).toBeGreaterThan(0)
    expect(capturedProbeTimeouts[0]).toBe(3_000)
  })

  it('exits supervisor readiness loop before probing when remaining <= 0', async () => {
    // #given — overall timeout 1ms (expires almost immediately)
    const {child, triggerExit} = makeControllableChild()
    let probeCallCount = 0
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const pollReadyFn = async (_url: string, _signal?: AbortSignal, _probeTimeoutMs?: number): Promise<boolean> => {
      probeCallCount++
      return false
    }

    // #when — start supervisor with effectively-zero timeout
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn: makeSpawnFn(child),
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 1, // expires almost immediately
      maxAttempts: 1,
      initialBackoffMs: 0,
    })

    // Trigger exit so the supervisor can resolve
    setImmediate(() => triggerExit(1))

    await supervisorPromise

    // #then — the supervisor readiness loop exits very early: with a 1ms deadline
    // the `remaining <= 0` guard fires within the first few iterations. The key
    // invariant is that the probe is NOT called many times — the early-exit guard
    // prevents unbounded probing past the deadline. A small upper bound (10) is
    // generous enough to be stable on slow CI while still proving the guard works.
    expect(probeCallCount).toBeLessThan(10)
    expect(statusRef.status).toBe('degraded')
  })
})

// ── Fix 4: abort signal wires through to supervisor + stops respawn ───────────
//
// With detached:true the child is in its OWN process group and does NOT inherit
// SIGTERM from the parent. The AbortController must be used to explicitly reap
// the child group and stop the supervisor from spawning further.

describe('runSupervisedOpencode — abort signal wires through (Fix 4)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('kills child group via negative pid and does NOT spawn again after abort', async () => {
    // #given — child with pid; abort fires while supervisor is polling for ready
    const pid = 66666
    const emitter = new EventEmitter()
    let exited = false
    const killSpy = vi.fn((_sig?: string): boolean => true)
    const child = {
      pid,
      kill: killSpy,
      on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
        emitter.on(event, listener)
      },
    }

    let spawnCount = 0
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation((..._args) => {
      if (exited === false) {
        exited = true
        setImmediate(() => emitter.emit('exit', null))
      }
      return true
    })

    const ac = new AbortController()
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      signal: ac.signal,
      spawnFn: (_cmd, _args, _opts) => {
        spawnCount++
        return child
      },
      pollReadyFn: neverReady,
      pollIntervalMs: 10,
      readyTimeoutMs: 30_000,
      maxAttempts: 4,
      initialBackoffMs: 0,
    })

    // #when — abort while polling
    ac.abort()
    await supervisorPromise.catch(() => undefined)

    // #then — group kill via negative pid
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
    // Only one spawn — no further attempts after abort
    expect(spawnCount).toBe(1)
  })

  it('resolves promptly when abort fires during respawn backoff (no later spawn)', async () => {
    // #given — first child exits immediately; abort fires during backoff sleep
    const {child: child1} = makeFakeChild({exitImmediately: true, exitCode: 1})
    const child2 = makeControllableChild()
    let spawnCount = 0

    const ac = new AbortController()
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      signal: ac.signal,
      spawnFn: (_cmd, _args, _opts) => {
        spawnCount++
        return spawnCount === 1 ? child1 : child2.child
      },
      pollReadyFn: neverReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 50,
      maxAttempts: 4,
      initialBackoffMs: 500, // long enough that abort fires during backoff
    })

    // Abort after a short delay (during the backoff sleep)
    await new Promise<void>(r => setTimeout(r, 20))
    ac.abort()

    // #then — resolves promptly (not after the full 500ms backoff)
    const start = Date.now()
    await supervisorPromise.catch(() => undefined)
    const elapsed = Date.now() - start

    // Should resolve well before the full backoff would have elapsed
    expect(elapsed).toBeLessThan(400)
    // Should NOT have spawned a second child
    expect(spawnCount).toBe(1)
  })

  it('stops supervisor when signal.aborted is true during post-ready monitoring', async () => {
    // #given — child becomes ready; abort fires while supervisor is in post-ready wait
    const {child, triggerExit} = makeControllableChild()
    let spawnCount = 0

    const ac = new AbortController()
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      signal: ac.signal,
      spawnFn: (_cmd, _args, _opts) => {
        spawnCount++
        return child
      },
      pollReadyFn: alwaysReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000,
      maxAttempts: 4,
      initialBackoffMs: 0,
    })

    // Wait for ready
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') resolve()
        else setImmediate(check)
      }
      setImmediate(check)
    })

    // #when — abort while in post-ready monitoring, then trigger child exit
    ac.abort()
    triggerExit(0)

    await supervisorPromise.catch(() => undefined)

    // #then — only one spawn (no respawn after abort)
    expect(spawnCount).toBe(1)
  })
})

describe('process-group reaping — supervised respawn group kill', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('uses group kill on timeout/respawn kill when child.pid is a number', async () => {
    // #given — first child has pid and times out; second child becomes ready then exits
    const pid1 = 33333
    const {child: child1} = makeFakeChildWithPid(pid1)
    const processKillSpy = vi.spyOn(process, 'kill').mockReturnValue(true)

    const child2 = makeControllableChild()
    let spawnCount = 0
    const trackingSpawnFn: SpawnFn = (_cmd, _args, _opts) => {
      spawnCount++
      return spawnCount === 1 ? child1 : child2.child
    }

    const pollReadyFn = async (_url: string): Promise<boolean> => spawnCount >= 2

    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // #when — start supervisor; first attempt times out → group kill → second becomes ready
    let wasReady = false
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      spawnFn: trackingSpawnFn,
      pollReadyFn,
      pollIntervalMs: 0,
      readyTimeoutMs: 10, // short timeout → first attempt times out
      maxAttempts: 2,
      initialBackoffMs: 0,
    })

    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') {
          wasReady = true
          child2.triggerExit(0)
          resolve()
        } else {
          setImmediate(check)
        }
      }
      setImmediate(check)
    })

    await supervisorPromise

    // #then — group kill was used for the first child (negative pid)
    expect(processKillSpy).toHaveBeenCalledWith(-pid1, 'SIGTERM')
    expect(wasReady).toBe(true)
  })

  it('uses group kill on abort path in runSupervisedOpencode when child.pid is present', async () => {
    // #given — child with pid; abort fires while supervisor is polling.
    // The process.kill mock must also emit exit on the child so the supervisor
    // loop terminates (otherwise the mocked kill is a no-op and the loop hangs).
    const pid = 44444
    const emitter = new EventEmitter()
    let exited = false
    const killSpy = vi.fn((_sig?: string): boolean => true)
    const child = {
      pid,
      kill: killSpy,
      on: (event: string | symbol, listener: (...args: unknown[]) => void): void => {
        emitter.on(event, listener)
      },
    }

    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation((..._args) => {
      // Simulate the OS killing the process group: emit exit on the child.
      if (exited === false) {
        exited = true
        setImmediate(() => emitter.emit('exit', null))
      }
      return true
    })

    const ac = new AbortController()
    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      signal: ac.signal,
      spawnFn: (_cmd, _args, _opts) => child,
      pollReadyFn: neverReady,
      pollIntervalMs: 10,
      readyTimeoutMs: 30_000,
      maxAttempts: 1,
      initialBackoffMs: 0,
    })

    // #when — abort immediately
    ac.abort()

    await supervisorPromise.catch(() => undefined)

    // #then — group kill via negative pid on abort path
    expect(processKillSpy).toHaveBeenCalledWith(-pid, 'SIGTERM')
  })
})

// ── Memory-leak regression: abort-listener retention across stable respawns ───
//
// Regression test for the bug where `signal.addEventListener('abort', …)` was
// called TWICE per while-loop iteration and never removed. With the stable-ready
// reset feature (`attempt = 1`), a long-lived workspace that crashes occasionally
// respawns indefinitely — causing abort listeners to accumulate without bound on
// the single shared AbortSignal, and each captured closure retaining its dead
// child so children are never GC'd.
//
// Fix: register the abort handler ONCE outside the loop (register-once pattern)
// and remove it in a finally block when the supervisor returns.
//
// This test drives N stable respawns and asserts that the NET number of 'abort'
// listeners on the signal never exceeds 1 at any point during the run.

describe('runSupervisedOpencode — abort-listener retention (memory-leak regression)', () => {
  it('abort listener count stays ≤ 1 across multiple stable respawns (register-once)', async () => {
    // #given — tiny stableReadyResetMs so each child quickly qualifies as stable
    const stableReadyResetMs = 20
    const maxAttempts = 4
    const respawnCycles = 6 // more than maxAttempts to prove budget resets

    // Track net addEventListener/removeEventListener calls on the signal
    const ac = new AbortController()
    const signal = ac.signal

    let netListeners = 0
    let maxObservedListeners = 0

    const origAdd = signal.addEventListener.bind(signal)
    const origRemove = signal.removeEventListener.bind(signal)

    vi.spyOn(signal, 'addEventListener').mockImplementation((...args: Parameters<typeof signal.addEventListener>) => {
      if (args[0] === 'abort') {
        netListeners++
        if (netListeners > maxObservedListeners) {
          maxObservedListeners = netListeners
        }
      }
      return origAdd(...args)
    })

    vi.spyOn(signal, 'removeEventListener').mockImplementation(
      (...args: Parameters<typeof signal.removeEventListener>) => {
        if (args[0] === 'abort') {
          netListeners--
        }
        return origRemove(...args)
      },
    )

    // Build respawnCycles+1 controllable children
    const children = Array.from({length: respawnCycles + 1}, () => makeControllableChild())
    let childIdx = 0
    const spawnFn: SpawnFn = () => {
      const c = children[childIdx]
      if (c === undefined) throw new Error('ran out of children')
      childIdx++
      return c.child
    }

    const statusRef = {status: 'starting' as 'starting' | 'ready' | 'down' | 'degraded'}

    // #when — run the supervisor through respawnCycles stable exits
    const supervisorPromise = runSupervisedOpencode({
      rootDir: '/workspace/repos',
      logger: makeLogger(),
      statusRef,
      signal,
      spawnFn,
      pollReadyFn: alwaysReady,
      pollIntervalMs: 0,
      readyTimeoutMs: 5000,
      maxAttempts,
      initialBackoffMs: 0,
      stableReadyResetMs,
    })

    for (let i = 0; i < respawnCycles; i++) {
      // Wait for ready
      await new Promise<void>(resolve => {
        const check = (): void => {
          if (statusRef.status === 'ready') resolve()
          else setImmediate(check)
        }
        setImmediate(check)
      })

      // Wait past the stable threshold, then trigger exit to force a respawn
      await new Promise<void>(r => setTimeout(r, stableReadyResetMs + 10))
      children[i]?.triggerExit(0)
    }

    // Wait for the last child to become ready, then abort to stop the supervisor
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (statusRef.status === 'ready') resolve()
        else setImmediate(check)
      }
      setImmediate(check)
    })

    ac.abort()
    children[respawnCycles]?.triggerExit(0)

    await supervisorPromise.catch(() => undefined)

    // #then — the abort listener count must NEVER have exceeded 1 during the run.
    // Before the fix: maxObservedListeners grows with each respawn (2 per iteration).
    // After the fix: exactly 1 listener registered once, removed in finally.
    expect(maxObservedListeners).toBeLessThanOrEqual(1)

    // Net count must be 0 after the supervisor returns (finally cleanup ran).
    expect(netListeners).toBe(0)
  })
})
