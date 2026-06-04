/**
 * Tests for opencode-server.ts — startOpencodeServer lifecycle.
 *
 * DOES NOT spawn a real opencode binary — spawn and readiness poll are
 * injected for isolation and speed.
 */

import type {SpawnFn} from './opencode-server.js'

import {EventEmitter} from 'node:events'
import {describe, expect, it, vi} from 'vitest'
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
// These tests exercise the supervised respawn loop added in Unit 5.
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

describe('runSupervisedOpencode — happy path (Unit 5)', () => {
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

describe('runSupervisedOpencode — transient failure recovery (Unit 5)', () => {
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

describe('runSupervisedOpencode — exhaustion (Unit 5)', () => {
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

describe('runSupervisedOpencode — post-ready exit latch fix (Unit 5)', () => {
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

describe('runSupervisedOpencode — fail-closed transition (Unit 5)', () => {
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
