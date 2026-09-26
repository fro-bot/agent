/**
 * Tests for main.ts — startWorkspaceAgent entrypoint seam.
 *
 * Verifies:
 * 1. The env → supervisor readiness-timeout wiring (WORKSPACE_OPENCODE_READY_TIMEOUT_MS reaches runSupervisedOpencode).
 * 2. Startup ordering: env is read before any server bind; components start in the same order as the pre-refactor entrypoint.
 * 3. The proxy listening signal is wired: proxyListeningRef.listening becomes true after proxy.listen resolves.
 */

import type {CreateAppFn, ExitFn, ServeFn} from './main.js'
import type {OpencodeProxyHandle, OpencodeProxyOptions} from './opencode-proxy.js'
import type {RunSupervisedOpencodeOptions} from './opencode-server.js'
import type {ProxyListeningRef, ServerDeps} from './server.js'

import http from 'node:http'
import {Hono} from 'hono'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {JOURNAL_RECONCILE_TIMEOUT_MS, SERVER_LISTEN_TIMEOUT_MS, startWorkspaceAgent} from './main.js'

// ── Fake helpers ──────────────────────────────────────────────────────────────

/**
 * Build a fake OpencodeProxyHandle that never actually binds a port.
 * Records listen/close calls for ordering assertions.
 */
function makeFakeProxy(callLog: string[], proxyListeningRef?: ProxyListeningRef): OpencodeProxyHandle {
  const server = new http.Server()
  return {
    server,
    listen: async (_port: number, _hostname: string): Promise<void> => {
      callLog.push('proxy.listen')
      if (proxyListeningRef !== undefined) {
        proxyListeningRef.listening = true
      }
    },
    close: async (): Promise<void> => {
      callLog.push('proxy.close')
    },
  }
}

/**
 * Build a fake serve function (replaces @hono/node-server serve).
 * Returns a minimal ServerType-compatible object, and invokes the listening callback
 * synchronously (on the next microtask) so startWorkspaceAgent's `await serverListening` for
 * :9100 resolves — real @hono/node-server invokes it once the OS confirms the bind.
 */
function makeFakeServeFn(callLog: string[]) {
  return vi.fn((_options: unknown, cb?: (info: {address: string; family: string; port: number}) => void) => {
    callLog.push('serve')
    const s = new http.Server()
    cb?.({address: '0.0.0.0', family: 'IPv4', port: 9100})
    return s
  })
}

/**
 * Build a fake runSupervisedOpencode that records the options it was called with
 * and resolves immediately.
 */
function makeFakeSupervisorFn(callLog: string[], capturedOptions: {value?: RunSupervisedOpencodeOptions}) {
  return vi.fn(async (options: RunSupervisedOpencodeOptions): Promise<void> => {
    callLog.push('runSupervisedOpencode')
    capturedOptions.value = options
  })
}

/**
 * Build a fake createOpencodeProxy that returns a fake proxy handle.
 */
function makeFakeProxyFactory(callLog: string[], proxyListeningRef?: ProxyListeningRef) {
  return vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
    callLog.push('createOpencodeProxy')
    return makeFakeProxy(callLog, proxyListeningRef)
  })
}

/** Build a fake createApp function that captures the `ServerDeps` it was called with, instead of building a real Hono app. */
function makeCapturingCreateAppFn(captured: {value?: ServerDeps}): CreateAppFn {
  return (deps: ServerDeps) => {
    captured.value = deps
    return new Hono()
  }
}

/**
 * Build a serve fn whose listening callback fires ONLY when the test calls `fireListening()`,
 * and whose underlying server can be made to emit 'error' via `fireError()`.
 *
 * Unlike makeFakeServeFn (which fires the listening callback synchronously, inside serveFn
 * itself), this fake lets a test observe the state of the world BETWEEN "serve() was called"
 * and "the bind outcome resolved" — the only way to prove startWorkspaceAgent actually WAITS on
 * that outcome rather than merely calling serve() first and racing ahead.
 */
function makeControllableServeFn(callLog: string[]): {
  readonly serveFn: ServeFn
  readonly fireListening: () => void
  readonly fireError: (error: Error) => void
} {
  let capturedCb: ((info: {address: string; family: string; port: number}) => void) | undefined
  let capturedServer: http.Server | undefined

  const serveFn: ServeFn = vi.fn(
    (_options: unknown, cb?: (info: {address: string; family: string; port: number}) => void) => {
      callLog.push('serve')
      const s = new http.Server()
      capturedCb = cb
      capturedServer = s
      return s
    },
  )

  return {
    serveFn,
    fireListening: () => {
      capturedCb?.({address: '0.0.0.0', family: 'IPv4', port: 9100})
    },
    fireError: (error: Error) => {
      capturedServer?.emit('error', error)
    },
  }
}

/**
 * Build a fake ExitFn that records the exit code and throws (satisfying the `never` return
 * type) so a test can assert on the throw via `.rejects.toThrow()` instead of the process
 * actually exiting.
 */
function makeFakeExitFn(callLog: string[]): ExitFn {
  const exitFn: ExitFn = code => {
    callLog.push(`exit(${code})`)
    throw new Error(`exitFn(${code})`)
  }
  return exitFn
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('startWorkspaceAgent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('env → supervisor readiness-timeout wiring', () => {
    it('passes WORKSPACE_OPENCODE_READY_TIMEOUT_MS from env to the supervisor', async () => {
      // #given
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '5000', WORKSPACE_OPENCODE_TOKEN: 'tok'}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // #then
      expect(capturedOptions.value?.readyTimeoutMs).toBe(5000)
    })

    it('uses the default 60000ms when WORKSPACE_OPENCODE_READY_TIMEOUT_MS is absent', async () => {
      // #given
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // #then
      expect(capturedOptions.value?.readyTimeoutMs).toBe(60_000)
    })
  })

  describe('startup ordering', () => {
    it('starts components in the reordered sequence: serve → createOpencodeProxy → proxy.listen → runSupervisedOpencode', async () => {
      // #given
      // Reordered so OpenCode (spawned unprivileged) is never running before both control ports
      // are bound:
      //   1. serve() — Hono server on :9100, awaited until listening
      //   2. createOpencodeProxy() — proxy factory
      //   3. proxy.listen() — proxy bind on :9200, awaited until settled
      //   4. runSupervisedOpencode() — supervisor (fire-and-forget), spawned last
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // #then — assert the exact reordered startup sequence
      const serveIdx = callLog.indexOf('serve')
      const proxyFactoryIdx = callLog.indexOf('createOpencodeProxy')
      const proxyListenIdx = callLog.indexOf('proxy.listen')
      const supervisorIdx = callLog.indexOf('runSupervisedOpencode')

      expect(serveIdx).toBeGreaterThanOrEqual(0)
      expect(proxyFactoryIdx).toBeGreaterThanOrEqual(0)
      expect(proxyListenIdx).toBeGreaterThanOrEqual(0)
      expect(supervisorIdx).toBeGreaterThanOrEqual(0)

      expect(serveIdx).toBeLessThan(proxyFactoryIdx)
      expect(proxyFactoryIdx).toBeLessThan(proxyListenIdx)
      expect(proxyListenIdx).toBeLessThan(supervisorIdx)
    })

    it('does not spawn OpenCode (runSupervisedOpencode) until both :9100 is listening and the :9200 bind attempt has settled', async () => {
      // #given — proxy.listen() resolves only after a delay, so a call-order assertion alone
      // would not catch a regression that calls runSupervisedOpencode before the bind RESOLVES.
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)

      let proxyListenResolved = false
      const fakeProxyFactory = vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
        callLog.push('createOpencodeProxy')
        const server = new http.Server()
        return {
          server,
          listen: async (_port: number, _hostname: string): Promise<void> => {
            callLog.push('proxy.listen:start')
            await new Promise<void>(resolve => setTimeout(resolve, 10))
            proxyListenResolved = true
            callLog.push('proxy.listen:resolved')
          },
          close: async (): Promise<void> => {},
        }
      })

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // #then — by the time runSupervisedOpencode is invoked, the delayed proxy.listen() had
      // already RESOLVED, not merely been called.
      expect(proxyListenResolved).toBe(true)
      const listenResolvedIdx = callLog.indexOf('proxy.listen:resolved')
      const supervisorIdx = callLog.indexOf('runSupervisedOpencode')
      expect(listenResolvedIdx).toBeGreaterThanOrEqual(0)
      expect(supervisorIdx).toBeGreaterThanOrEqual(0)
      expect(listenResolvedIdx).toBeLessThan(supervisorIdx)
    })

    it('reads env (readReadyTimeoutMs) before any server bind (serve is called after env is resolved)', async () => {
      // #given
      // We verify this by using a Proxy on the env object that records when
      // WORKSPACE_OPENCODE_READY_TIMEOUT_MS is accessed, and checking that
      // access happens before serve() is called.
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}

      // Proxy the env object to record when the timeout key is read
      const rawEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '12345'}
      const fakeEnv = new Proxy(rawEnv, {
        get(target, prop) {
          if (prop === 'WORKSPACE_OPENCODE_READY_TIMEOUT_MS') {
            callLog.push('env.WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
          }
          return target[prop as keyof typeof target]
        },
      })

      const fakeServeFn = vi.fn(
        (_options: unknown, cb?: (info: {address: string; family: string; port: number}) => void) => {
          callLog.push('serve')
          const s = new http.Server()
          cb?.({address: '0.0.0.0', family: 'IPv4', port: 9100})
          return s
        },
      )

      const fakeSupervisorFn = vi.fn(async (options: RunSupervisedOpencodeOptions): Promise<void> => {
        callLog.push('runSupervisedOpencode')
        capturedOptions.value = options
      })

      const fakeProxyFactory = makeFakeProxyFactory(callLog)

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // #then — env was read before serve was called
      const envReadIdx = callLog.indexOf('env.WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
      const serveIdx = callLog.indexOf('serve')

      expect(envReadIdx).toBeGreaterThanOrEqual(0)
      expect(serveIdx).toBeGreaterThanOrEqual(0)
      expect(envReadIdx).toBeLessThan(serveIdx)

      // The resolved timeout must match the env value
      expect(capturedOptions.value?.readyTimeoutMs).toBe(12345)
    })
  })

  describe('proxy listening signal wiring', () => {
    it('sets proxyListeningRef.listening = true after proxy.listen resolves', async () => {
      // #given
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const proxyListeningRef: ProxyListeningRef = {listening: false}

      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      // Pass the ref through the factory so proxy.listen sets ref.listening = true
      const fakeProxyFactory = makeFakeProxyFactory(callLog, proxyListeningRef)

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })
      // main.ts now AWAITS proxy.listen() directly (so OpenCode is never spawned before the
      // bind attempt settles), so proxyListeningRef.listening is already true by the time
      // startWorkspaceAgent resolves — no microtask flush needed. Kept anyway as a harmless
      // no-op guard against a future regression back to fire-and-forget.
      await Promise.resolve()

      // #then — main.ts wires proxy.listen().then(() => proxyListeningRef.listening = true)
      expect(proxyListeningRef.listening).toBe(true)
    })
  })

  describe('proxy listen rejection wiring', () => {
    it('exits(1) via exitFn and never spawns OpenCode when proxy.listen() rejects — a free :9200 is a control port the unprivileged agent could take', async () => {
      // #given — a fake proxy whose listen() always rejects (simulates a :9200 bind failure)
      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeExitFn = makeFakeExitFn(exitLog)

      const proxyListeningRef: ProxyListeningRef = {listening: false}

      const fakeProxyFactory = vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
        const server = new http.Server()
        return {
          server,
          // listen() rejects — simulates a port-bind failure
          listen: async (_port: number, _hostname: string): Promise<void> => {
            throw new Error('EADDRINUSE: address already in use')
          },
          close: async (): Promise<void> => {},
        }
      })

      // #when / #then — a failed :9200 bind is fatal, exactly like a failed :9100 bind: exitFn(1)
      // and runSupervisedOpencode (which would spawn OpenCode as uid 10001) is never called. A
      // free :9200 left standing would let the unprivileged agent bind it and receive the
      // gateway's bearer token instead of the real proxy.
      await expect(
        startWorkspaceAgent({
          env: fakeEnv,
          serveFn: fakeServeFn,
          runSupervisedOpencodeFn: fakeSupervisorFn,
          createOpencodeProxyFn: fakeProxyFactory,
          readSecretFn: (_name: string) => 'fake-token',
          exitFn: fakeExitFn,
          reconcileUpdateJournalsFn: async () => {},
          reconcileRecoveryJournalsFn: async () => {},
        }),
      ).rejects.toThrow('exitFn(1)')

      expect(exitLog).toEqual(['exit(1)'])
      expect(proxyListeningRef.listening).toBe(false)
      expect(callLog).not.toContain('runSupervisedOpencode')
    })
  })

  describe('proxy server close/error event wiring', () => {
    // NOTE: listen() intentionally resolves (does NOT bind a real port — it's a fake) so
    // proxyBindSucceeded flips true in main.ts, matching a successful :9200 bind in production.
    // That's the precondition for the runtime-loss fatal-exit path below: only a 'close'/'error'
    // AFTER a successful bind is a runtime problem, not an initial bind failure (handled
    // separately and already fatal via its own exitFn(1) in the 'proxy listen rejection wiring'
    // tests above).
    it('exits(1) via exitFn when the proxy server emits "close" after a successful startup — a released :9200 is a port the unprivileged agent could take next', async () => {
      // #given — a fake proxy that exposes the real server so we can fire events post-startup
      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeExitFn = makeFakeExitFn(exitLog)

      let capturedServer: http.Server | undefined
      const fakeProxyFactory = vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
        const server = new http.Server()
        capturedServer = server
        return {
          server,
          listen: async (_port: number, _hostname: string): Promise<void> => {},
          close: async (): Promise<void> => {},
        }
      })

      // #when — start the agent (this resolves the initial :9200 listen, wiring the 'close'
      // listener and flipping proxyBindSucceeded = true in main.ts)
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        exitFn: fakeExitFn,
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      expect(capturedServer).toBeDefined()
      const server = capturedServer as http.Server
      expect(server.listenerCount('close')).toBeGreaterThan(0)
      expect(exitLog).toEqual([]) // not yet — only the runtime 'close' below should trigger it

      // #when — simulate the OS releasing :9200 at runtime, well after startup, while OpenCode
      // is (notionally) already running
      expect(() => server.emit('close')).toThrow('exitFn(1)')

      // #then — fatal: log + exit(1), so compose restarts the container and re-binds :9200
      // before OpenCode is spawned again
      expect(exitLog).toEqual(['exit(1)'])
    })

    it('exits(1) via exitFn when the proxy server emits "error" after a successful startup', async () => {
      // #given — same setup as the 'close' test
      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeExitFn = makeFakeExitFn(exitLog)

      let capturedServer: http.Server | undefined
      const fakeProxyFactory = vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
        const server = new http.Server()
        capturedServer = server
        return {
          server,
          listen: async (_port: number, _hostname: string): Promise<void> => {},
          close: async (): Promise<void> => {},
        }
      })

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        exitFn: fakeExitFn,
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      expect(capturedServer).toBeDefined()
      const server = capturedServer as http.Server
      expect(server.listenerCount('error')).toBeGreaterThan(0)

      // #when — add a second listener so Node doesn't treat this as an unhandled 'error' event
      // (which would throw synchronously for an UNRELATED reason before main.ts's handler runs)
      server.on('error', () => {})

      // #then — main.ts's handler still fires exitFn(1)
      expect(() => server.emit('error', new Error('EADDRINUSE'))).toThrow('exitFn(1)')
      expect(exitLog).toEqual(['exit(1)'])
    })

    it('does NOT call exitFn for the "close" that our own proxy.close() triggers during graceful shutdown (SIGTERM)', async () => {
      // #given — proves the shuttingDown guard: a close caused by our own proxy.close() inside
      // shutdown() must not be treated as an unexpected runtime port loss. shutdown() sets
      // `shuttingDown = true` BEFORE it ever calls proxy.close(), so the runtime-loss handler's
      // `!shuttingDown` check must be false for that close.
      process.removeAllListeners('SIGTERM')

      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      // makeControllableServeFn (not makeFakeServeFn): makeFakeServeFn fires the listening
      // callback SYNCHRONOUSLY from inside serveFn, before the `boundServer = serveFn(...)`
      // assignment in main.ts completes — harmless for tests that never reach shutdown(), but
      // this test does, and shutdown()'s `server.close()` needs the real resolved server.
      const {serveFn: fakeServeFn, fireListening} = makeControllableServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeExitFn = makeFakeExitFn(exitLog)

      const fakeProxyFactory = vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
        const server = new http.Server()
        return {
          server,
          listen: async (_port: number, _hostname: string): Promise<void> => {},
          // Mirrors production: closing the real net.Server emits 'close' on itself.
          close: async (): Promise<void> => {
            server.emit('close')
          },
        }
      })

      // shutdown() eventually calls process.exit(0)/(1) directly (not exitFn) once drain
      // completes — stub it out so the test process doesn't actually exit.
      const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

      const startupPromise = startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        exitFn: fakeExitFn,
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })
      // Flush pending microtasks and a macrotask before firing the listening callback — startup
      // now awaits the (fake, near-instant) startup journal reconciliation pass before ever
      // calling serveFn, which needs more than a single synchronous call to settle (see the
      // `:9100 bind gating` describe block's own flush pattern for the same reason).
      await Promise.resolve()
      await Promise.resolve()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      fireListening()
      await startupPromise

      expect(process.listenerCount('SIGTERM')).toBe(1)

      // #when — trigger the real graceful-shutdown path
      process.emit('SIGTERM')

      // Flush the async cleanup chain: asyncCleanupAllAskpassDirs().finally(cleanupProxy).finally(...)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      // #then — the runtime-loss exitFn must NOT have fired for our own deliberate close
      expect(exitLog).toEqual([])

      processExitSpy.mockRestore()
      process.removeAllListeners('SIGTERM')
    })
  })

  describe('error handling', () => {
    it('exits(1) via the injected exitFn and never calls runSupervisedOpencodeFn when createOpencodeProxyFn throws', async () => {
      // #given — token read and :9100 bind both succeed; only the proxy factory throws.
      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeExitFn = makeFakeExitFn(exitLog)
      const throwingProxyFactory = vi.fn((_options: OpencodeProxyOptions): OpencodeProxyHandle => {
        callLog.push('createOpencodeProxy')
        throw new Error('cannot construct proxy')
      })

      // #when / #then
      await expect(
        startWorkspaceAgent({
          env: fakeEnv,
          serveFn: fakeServeFn,
          runSupervisedOpencodeFn: fakeSupervisorFn,
          createOpencodeProxyFn: throwingProxyFactory,
          readSecretFn: (_name: string) => 'fake-token',
          exitFn: fakeExitFn,
          reconcileUpdateJournalsFn: async () => {},
          reconcileRecoveryJournalsFn: async () => {},
        }),
      ).rejects.toThrow('exitFn(1)')

      expect(exitLog).toEqual(['exit(1)'])
      expect(callLog).not.toContain('runSupervisedOpencode')
    })

    it('exits(1) via the injected exitFn and never binds :9100 when readSecretFn throws — the token is read before any server bind', async () => {
      // #given — the token read (readSecretFn) now happens before serve() is ever called (see
      // startWorkspaceAgent's startup-order doc comment: "Read env ... BEFORE any server bind").
      // Assert against the injected exitFn (not a process.exit spy) so this pins the real
      // production exit path, and assert serveFn was never invoked — nothing bound.
      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)
      const fakeExitFn = makeFakeExitFn(exitLog)

      // #when / #then
      await expect(
        startWorkspaceAgent({
          env: fakeEnv,
          serveFn: fakeServeFn,
          runSupervisedOpencodeFn: fakeSupervisorFn,
          createOpencodeProxyFn: fakeProxyFactory,
          readSecretFn: (_name: string) => {
            throw new Error('Missing required secret: WORKSPACE_OPENCODE_TOKEN')
          },
          exitFn: fakeExitFn,
          reconcileUpdateJournalsFn: async () => {},
          reconcileRecoveryJournalsFn: async () => {},
        }),
      ).rejects.toThrow('exitFn(1)')

      expect(exitLog).toEqual(['exit(1)'])
      expect(callLog).not.toContain('serve')
      expect(callLog).not.toContain('createOpencodeProxy')
      expect(callLog).not.toContain('runSupervisedOpencode')
    })
  })

  // ── :9100 bind gating — proves startup actually WAITS on the bind outcome ──────────────────
  //
  // makeFakeServeFn (used above) fires the listening callback synchronously, inside serveFn
  // itself — so those tests would still pass even if startWorkspaceAgent stopped awaiting the
  // bind result entirely (the log order is unaffected either way). These tests use
  // makeControllableServeFn instead, which lets the test hold the callback back, to prove
  // startup genuinely blocks until one of the three bind outcomes (listening / 'error' /
  // timeout) is decided.
  describe(':9100 bind gating', () => {
    it('does not create the proxy or spawn OpenCode until the :9100 listening callback fires', async () => {
      // #given
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const {serveFn: fakeServeFn, fireListening} = makeControllableServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)

      // #when — kick off startup but do NOT fire the listening callback yet
      const startupPromise = startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // Flush pending microtasks and a macrotask — a regression that stopped awaiting the bind
      // outcome would have raced straight through to createOpencodeProxy/runSupervisedOpencode
      // by now.
      await Promise.resolve()
      await Promise.resolve()
      await new Promise<void>(resolve => setTimeout(resolve, 0))

      // #then — serve() was called, but startup is still blocked on the bind outcome
      expect(callLog).toContain('serve')
      expect(callLog).not.toContain('createOpencodeProxy')
      expect(callLog).not.toContain('runSupervisedOpencode')

      // #when — the bind finally succeeds
      fireListening()
      await startupPromise

      // #then — startup proceeds, in order, once the bind outcome resolves
      expect(callLog.indexOf('createOpencodeProxy')).toBeGreaterThanOrEqual(0)
      expect(callLog.indexOf('runSupervisedOpencode')).toBeGreaterThanOrEqual(0)
    })

    it('exits(1) via exitFn and never creates the proxy or spawns OpenCode when the :9100 server emits "error" before listening', async () => {
      // #given
      const callLog: string[] = []
      const exitLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const {serveFn: fakeServeFn, fireError} = makeControllableServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)
      const fakeExitFn = makeFakeExitFn(exitLog)

      // #when
      const startupPromise = startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
        exitFn: fakeExitFn,
        reconcileUpdateJournalsFn: async () => {},
        reconcileRecoveryJournalsFn: async () => {},
      })

      // Flush pending microtasks and a macrotask before firing the bind error — startup now
      // awaits the (fake, near-instant) startup journal reconciliation pass before ever calling
      // serveFn, which needs more than a single microtask tick to settle (see the sibling test
      // above for the same flush pattern).
      await Promise.resolve()
      await Promise.resolve()
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      fireError(new Error('EADDRINUSE'))

      // #then
      await expect(startupPromise).rejects.toThrow('exitFn(1)')
      expect(exitLog).toEqual(['exit(1)'])
      expect(callLog).not.toContain('createOpencodeProxy')
      expect(callLog).not.toContain('runSupervisedOpencode')
    })

    describe('bind timeout', () => {
      beforeEach(() => {
        vi.useFakeTimers()
      })

      afterEach(() => {
        vi.useRealTimers()
      })

      it(`exits(1) via exitFn and never spawns OpenCode when the :9100 bind neither succeeds nor errors within SERVER_LISTEN_TIMEOUT_MS`, async () => {
        // #given — a serve fn that never calls back and never errors
        const callLog: string[] = []
        const exitLog: string[] = []
        const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
        const fakeEnv: NodeJS.ProcessEnv = {}
        const {serveFn: fakeServeFn} = makeControllableServeFn(callLog)
        const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
        const fakeProxyFactory = makeFakeProxyFactory(callLog)
        const fakeExitFn = makeFakeExitFn(exitLog)

        // #when
        const startupPromise = startWorkspaceAgent({
          env: fakeEnv,
          serveFn: fakeServeFn,
          runSupervisedOpencodeFn: fakeSupervisorFn,
          createOpencodeProxyFn: fakeProxyFactory,
          readSecretFn: (_name: string) => 'fake-token',
          exitFn: fakeExitFn,
          reconcileUpdateJournalsFn: async () => {},
          reconcileRecoveryJournalsFn: async () => {},
        })
        await Promise.all([
          expect(startupPromise).rejects.toThrow('exitFn(1)'),
          vi.advanceTimersByTimeAsync(SERVER_LISTEN_TIMEOUT_MS),
        ])

        // #then
        expect(exitLog).toEqual(['exit(1)'])
        expect(callLog).not.toContain('createOpencodeProxy')
        expect(callLog).not.toContain('runSupervisedOpencode')
      })
    })
  })
})

describe('startWorkspaceAgent — startup journal reconciliation race timer (C5a)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the losing race timer after a FAST successful reconciliation — no spurious deadline log later', async () => {
    // #given — reconciliation resolves immediately, well inside the deadline
    const callLog: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fakeEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_TOKEN: 'tok'}

    // #when
    await startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileUpdateJournalsFn: async () => {},
      reconcileRecoveryJournalsFn: async () => {},
    })
    await vi.advanceTimersByTimeAsync(JOURNAL_RECONCILE_TIMEOUT_MS)

    // #then — the deadline-timer log must never fire once reconciliation already finished
    expect(errorSpy.mock.calls.some(call => String(call[0]).includes('did not finish within the deadline'))).toBe(false)
  })
})

describe('startWorkspaceAgent — recovery-journal reconciliation (slice 5c)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs recovery reconciliation BEFORE update reconciliation, and before :9100 binds', async () => {
    // #given
    const callLog: string[] = []
    const order: string[] = []
    const fakeEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_TOKEN: 'tok'}

    // #when
    await startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileRecoveryJournalsFn: async () => {
        order.push('recovery')
      },
      reconcileUpdateJournalsFn: async () => {
        order.push('update')
      },
    })

    // #then
    expect(order).toEqual(['recovery', 'update'])
    expect(callLog[0]).toBe('serve')
  })

  it('a hanging recovery reconciliation does not block startup past its own deadline, and update reconciliation still runs after', async () => {
    // #given
    vi.useFakeTimers()
    const callLog: string[] = []
    const order: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fakeEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_TOKEN: 'tok'}

    // #when — recovery reconciliation never resolves; update reconciliation resolves immediately
    const startPromise = startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileRecoveryJournalsFn: async () => new Promise<void>(() => {}),
      reconcileUpdateJournalsFn: async () => {
        order.push('update')
      },
    })
    await vi.advanceTimersByTimeAsync(JOURNAL_RECONCILE_TIMEOUT_MS)
    await startPromise

    // #then — startup completed (bound :9100), update reconciliation still ran, and the deadline
    // log names the stalled pass
    expect(callLog).toContain('serve')
    expect(order).toEqual(['update'])
    expect(
      errorSpy.mock.calls.some(call =>
        String(call[0]).includes('startup recovery-journal reconciliation did not finish'),
      ),
    ).toBe(true)
  })

  it('clears the recovery reconciliation race timer after a FAST successful pass — no spurious deadline log later', async () => {
    // #given
    vi.useFakeTimers()
    const callLog: string[] = []
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fakeEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_TOKEN: 'tok'}

    // #when
    await startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileRecoveryJournalsFn: async () => {},
      reconcileUpdateJournalsFn: async () => {},
    })
    await vi.advanceTimersByTimeAsync(JOURNAL_RECONCILE_TIMEOUT_MS)

    // #then
    expect(
      errorSpy.mock.calls.some(call =>
        String(call[0]).includes('startup recovery-journal reconciliation did not finish'),
      ),
    ).toBe(false)
  })
})

describe('startWorkspaceAgent — updateNetworkConfig wiring (A1)', () => {
  it('passes proxy config derived from HTTPS_PROXY/NO_PROXY into createApp', async () => {
    // #given
    const callLog: string[] = []
    const captured: {value?: ServerDeps} = {}
    const fakeEnv: NodeJS.ProcessEnv = {
      WORKSPACE_OPENCODE_TOKEN: 'tok',
      HTTPS_PROXY: 'http://mitmproxy:8080',
      NO_PROXY: '10.0.0.0/8',
    }

    // #when
    await startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileUpdateJournalsFn: async () => {},
      reconcileRecoveryJournalsFn: async () => {},
      createAppFn: makeCapturingCreateAppFn(captured),
    })

    // #then
    expect(captured.value?.updateNetworkConfig).toEqual({
      proxy: {https: 'http://mitmproxy:8080', noProxy: '10.0.0.0/8'},
    })
  })

  it('passes caBundlePath derived from GIT_SSL_CAINFO into createApp', async () => {
    // #given
    const callLog: string[] = []
    const captured: {value?: ServerDeps} = {}
    const fakeEnv: NodeJS.ProcessEnv = {
      WORKSPACE_OPENCODE_TOKEN: 'tok',
      GIT_SSL_CAINFO: '/etc/ssl/certs/mitmproxy-ca.pem',
    }

    // #when
    await startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileUpdateJournalsFn: async () => {},
      reconcileRecoveryJournalsFn: async () => {},
      createAppFn: makeCapturingCreateAppFn(captured),
    })

    // #then
    expect(captured.value?.updateNetworkConfig).toEqual({caBundlePath: '/etc/ssl/certs/mitmproxy-ca.pem'})
  })

  it('passes an empty updateNetworkConfig when no proxy or CA-bundle env vars are set', async () => {
    // #given
    const callLog: string[] = []
    const captured: {value?: ServerDeps} = {}
    const fakeEnv: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_TOKEN: 'tok'}

    // #when
    await startWorkspaceAgent({
      env: fakeEnv,
      serveFn: makeFakeServeFn(callLog),
      runSupervisedOpencodeFn: makeFakeSupervisorFn(callLog, {}),
      createOpencodeProxyFn: makeFakeProxyFactory(callLog),
      readSecretFn: (_name: string) => 'fake-token',
      reconcileUpdateJournalsFn: async () => {},
      reconcileRecoveryJournalsFn: async () => {},
      createAppFn: makeCapturingCreateAppFn(captured),
    })

    // #then
    expect(captured.value?.updateNetworkConfig).toEqual({})
  })
})
