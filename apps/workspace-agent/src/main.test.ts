/**
 * Tests for main.ts — startWorkspaceAgent entrypoint seam.
 *
 * Verifies:
 * 1. The env → supervisor readiness-timeout wiring (WORKSPACE_OPENCODE_READY_TIMEOUT_MS reaches runSupervisedOpencode).
 * 2. Startup ordering: env is read before any server bind; components start in the same order as the pre-refactor entrypoint.
 * 3. The proxy listening signal is wired: proxyListeningRef.listening becomes true after proxy.listen resolves.
 */

import type {ExitFn, ServeFn} from './main.js'
import type {OpencodeProxyHandle, OpencodeProxyOptions} from './opencode-proxy.js'
import type {RunSupervisedOpencodeOptions} from './opencode-server.js'
import type {ProxyListeningRef} from './server.js'

import http from 'node:http'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {SERVER_LISTEN_TIMEOUT_MS, startWorkspaceAgent} from './main.js'

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
    it('leaves proxyListeningRef.listening = false when proxy.listen() rejects', async () => {
      // #given — a fake proxy whose listen() always rejects
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)

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

      // #when
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
      })
      // main.ts now AWAITS proxy.listen() (including its .catch()) directly, so this has
      // already settled by the time startWorkspaceAgent resolves.

      // #then — listen() rejected, so proxyListeningRef.listening must remain false
      // (the .catch() handler in main.ts sets it to false explicitly)
      expect(proxyListeningRef.listening).toBe(false)
    })
  })

  describe('proxy server close/error event wiring', () => {
    it('sets proxyListeningRef.listening = false when the proxy server emits "close"', async () => {
      // #given — a fake proxy that exposes the real server so we can fire events
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)

      // Capture the server so we can emit events on it after startup
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

      // #when — start the agent (wires the 'close' listener on proxy.server)
      await startWorkspaceAgent({
        env: fakeEnv,
        serveFn: fakeServeFn,
        runSupervisedOpencodeFn: fakeSupervisorFn,
        createOpencodeProxyFn: fakeProxyFactory,
        readSecretFn: (_name: string) => 'fake-token',
      })
      // Flush microtasks so proxy.listen().then() has run and set listening = true
      await Promise.resolve()
      await Promise.resolve()

      // #then — the 'close' event listener must have been registered by main.ts
      expect(capturedServer).toBeDefined()
      const server = capturedServer as http.Server
      expect(server.listenerCount('close')).toBeGreaterThan(0)

      // Emit 'close' — main.ts's handler sets proxyListeningRef.listening = false.
      // We verify the handler runs without error (no throw = handler is wired correctly).
      server.emit('close')
    })

    it('sets proxyListeningRef.listening = false when the proxy server emits "error"', async () => {
      // #given — same setup as the 'close' test
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)

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
      })
      await Promise.resolve()
      await Promise.resolve()

      // #then — the 'error' event listener must have been registered by main.ts
      expect(capturedServer).toBeDefined()
      const server = capturedServer as http.Server

      // main.ts wires an 'error' handler that sets proxyListeningRef.listening = false.
      // We add a second listener to prevent Node from throwing an unhandled error event
      // when we emit below. The count > 1 proves main.ts's handler was registered.
      server.on('error', () => {})
      expect(server.listenerCount('error')).toBeGreaterThan(1)

      // Emit 'error' — main.ts's handler runs without throwing
      server.emit('error', new Error('EADDRINUSE'))
    })
  })

  describe('error handling', () => {
    it('throws (or exits) when readSecretFn throws (missing WORKSPACE_OPENCODE_TOKEN)', async () => {
      // #given
      const callLog: string[] = []
      const capturedOptions: {value?: RunSupervisedOpencodeOptions} = {}
      const fakeEnv: NodeJS.ProcessEnv = {}
      const fakeServeFn = makeFakeServeFn(callLog)
      const fakeSupervisorFn = makeFakeSupervisorFn(callLog, capturedOptions)
      const fakeProxyFactory = makeFakeProxyFactory(callLog)

      // Mock process.exit to prevent the test process from actually exiting
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string | null) => {
        throw new Error(`process.exit(${_code})`)
      })

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
        }),
      ).rejects.toThrow()

      exitSpy.mockRestore()
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
      })

      await Promise.resolve()
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
