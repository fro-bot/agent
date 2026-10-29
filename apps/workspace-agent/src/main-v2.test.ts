/**
 * Tests for the V2 selector in main.ts. The image bakes WORKSPACE_IMAGE_OPENCODE_VERSION; major 2 or above injects the
 * V2 supervised runner, proxy and disposer, anything else leaves startup exactly as the V1 tests pin it.
 */

import type {CreateAppFn, ExitFn} from './main.js'
import type {CreateInstanceDisposerV2Options} from './opencode-instance-v2.js'
import type {OpencodeProxyV2Options} from './opencode-proxy-v2.js'
import type {OpencodeProxyHandle, OpencodeProxyOptions} from './opencode-proxy.js'
import type {RunSupervisedOpencodeV2Options} from './opencode-server-v2.js'
import type {RunSupervisedOpencodeOptions} from './opencode-server.js'
import type {ServerDeps} from './server.js'

import http from 'node:http'
import process from 'node:process'

import {Hono} from 'hono'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {startWorkspaceAgent} from './main.js'

const noopReconcile = async (): Promise<void> => {}

function makeFakeProxy(callLog: string[]): OpencodeProxyHandle {
  const server = new http.Server()
  return {
    server,
    listen: async () => {
      callLog.push('proxy.listen')
    },
    close: async () => {
      callLog.push('proxy.close')
    },
  }
}

function fakeServeFn(callLog: string[]) {
  return vi.fn((_options: unknown, cb?: (info: {address: string; family: string; port: number}) => void) => {
    callLog.push('serve')
    const server = new http.Server()
    // After serveFn returns, as the real bind does, so the resolved server is the one startup holds.
    queueMicrotask(() => cb?.({address: '0.0.0.0', family: 'IPv4', port: 9100}))
    return server
  })
}

function makeExitFn(exitLog: string[]): ExitFn {
  return code => {
    exitLog.push(`exit(${code})`)
    throw new Error(`exitFn(${code})`)
  }
}

interface Harness {
  readonly callLog: string[]
  readonly v1Runner: ReturnType<typeof vi.fn>
  readonly v2Runner: ReturnType<typeof vi.fn>
  readonly v1Proxy: ReturnType<typeof vi.fn>
  readonly v2Proxy: ReturnType<typeof vi.fn>
  readonly v1Disposer: ReturnType<typeof vi.fn>
  readonly v2Disposer: ReturnType<typeof vi.fn>
  readonly appDeps: {value?: ServerDeps}
  readonly deps: Parameters<typeof startWorkspaceAgent>[0]
}

function harness(
  env: NodeJS.ProcessEnv,
  extra: Partial<NonNullable<Parameters<typeof startWorkspaceAgent>[0]>> = {},
): Harness {
  const callLog: string[] = []
  const appDeps: {value?: ServerDeps} = {}
  const v1Runner = vi.fn(async (_options: RunSupervisedOpencodeOptions) => {
    callLog.push('runV1')
  })
  const v2Runner = vi.fn(async (_options: RunSupervisedOpencodeV2Options) => {
    callLog.push('runV2')
  })
  const v1Proxy = vi.fn((_options: OpencodeProxyOptions) => {
    callLog.push('proxyV1')
    return makeFakeProxy(callLog)
  })
  const v2Proxy = vi.fn((_options: OpencodeProxyV2Options) => {
    callLog.push('proxyV2')
    return makeFakeProxy(callLog)
  })
  const v1Disposer = vi.fn(() => async () => ({kind: 'skipped' as const}))
  const v2Disposer = vi.fn((_options: CreateInstanceDisposerV2Options) => async () => ({kind: 'skipped' as const}))
  const createAppFn: CreateAppFn = deps => {
    appDeps.value = deps
    return new Hono()
  }
  return {
    callLog,
    v1Runner,
    v2Runner,
    v1Proxy,
    v2Proxy,
    v1Disposer,
    v2Disposer,
    appDeps,
    deps: {
      env,
      serveFn: fakeServeFn(callLog),
      readSecretFn: () => 'gateway-bearer',
      reconcileUpdateJournalsFn: noopReconcile,
      reconcileRecoveryJournalsFn: noopReconcile,
      createAppFn,
      runSupervisedOpencodeFn: v1Runner,
      createOpencodeProxyFn: v1Proxy,
      createInstanceDisposerFn: v1Disposer,
      runSupervisedOpencodeV2Fn: v2Runner,
      createOpencodeProxyV2Fn: v2Proxy,
      createInstanceDisposerV2Fn: v2Disposer,
      ...extra,
    },
  }
}

async function terminate(h: Harness): Promise<string[]> {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    h.callLog.push(`process.exit(${code ?? 0})`)
  }) as never)
  process.emit('SIGTERM')
  for (let i = 0; i < 6; i++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  return h.callLog
}

describe('startWorkspaceAgent — OpenCode generation selector', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    vi.restoreAllMocks()
  })

  describe('V1 (variable unset or a V1 version)', () => {
    it('uses the V1 runner, proxy and disposer when the image sets nothing, and reports no version', async () => {
      // #given an image that predates the variable
      const h = harness({})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then exactly the V1 trio is wired
      expect(h.v1Runner).toHaveBeenCalledTimes(1)
      expect(h.v1Proxy).toHaveBeenCalledTimes(1)
      expect(h.v1Disposer).toHaveBeenCalledTimes(1)
      expect(h.v2Runner).not.toHaveBeenCalled()
      expect(h.v2Proxy).not.toHaveBeenCalled()
      expect(h.v2Disposer).not.toHaveBeenCalled()
      expect(h.appDeps.value).toBeDefined()
      expect(h.appDeps.value).not.toHaveProperty('opencodeVersion')
    })

    it('keeps the V1 trio for a V1 image version and reports that version', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '1.19.4+harness.5bde2635'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then
      expect(h.v1Runner).toHaveBeenCalledTimes(1)
      expect(h.v2Runner).not.toHaveBeenCalled()
      expect(h.appDeps.value?.opencodeVersion).toBe('1.19.4+harness.5bde2635')
    })
  })

  describe('V2 (major 2 or above)', () => {
    it('uses the V2 runner, proxy and disposer, and reports the version', async () => {
      // #given an image that installed stock 2.2.0
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.0', WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '7000'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then exactly the V2 trio is wired
      expect(h.v2Runner).toHaveBeenCalledTimes(1)
      expect(h.v2Proxy).toHaveBeenCalledTimes(1)
      expect(h.v2Disposer).toHaveBeenCalledTimes(1)
      expect(h.v1Runner).not.toHaveBeenCalled()
      expect(h.v1Proxy).not.toHaveBeenCalled()
      expect(h.v1Disposer).not.toHaveBeenCalled()
      expect(h.appDeps.value?.opencodeVersion).toBe('2.2.0')
      expect(h.v2Runner.mock.calls[0]?.[0]).toMatchObject({rootDir: '/workspace/repos', readyTimeoutMs: 7000})
      expect(h.v2Proxy.mock.calls[0]?.[0]).toMatchObject({
        token: 'gateway-bearer',
        upstreamUrl: 'http://127.0.0.1:54321',
      })
      expect(h.v2Disposer.mock.calls[0]?.[0]).toMatchObject({upstreamUrl: 'http://127.0.0.1:54321'})
    })

    it('hands the runner, the proxy and the disposer the same credential holder', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.0'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then one holder: what the runner publishes is what the proxy and the disposer read
      const runnerHolder = (h.v2Runner.mock.calls[0]?.[0] as RunSupervisedOpencodeV2Options).credentials
      const proxyHolder = (h.v2Proxy.mock.calls[0]?.[0] as OpencodeProxyV2Options).credentials
      const disposerHolder = (h.v2Disposer.mock.calls[0]?.[0] as CreateInstanceDisposerV2Options).credentials
      expect(proxyHolder).toBe(runnerHolder)
      expect(disposerHolder).toBe(runnerHolder)
    })

    it('keeps the startup order: serve, proxy created, proxy listening, and only then the runner', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.0'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then the unprivileged server never runs before both control ports are bound
      expect(h.callLog).toEqual(['serve', 'proxyV2', 'proxy.listen', 'runV2'])
    })

    it('lets the V2 disposer run only while the supervisor reports ready', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.0'})
      await startWorkspaceAgent(h.deps)
      const options = h.v2Disposer.mock.calls[0]?.[0] as CreateInstanceDisposerV2Options

      // #then the readiness predicate follows the status ref the app and the runner share
      const statusRef = (h.v2Runner.mock.calls[0]?.[0] as RunSupervisedOpencodeV2Options).statusRef
      statusRef.status = 'starting'
      expect(options.isRunning?.()).toBe(false)
      statusRef.status = 'ready'
      expect(options.isRunning?.()).toBe(true)
    })
  })

  describe('a value that is set but is not a version', () => {
    it('refuses to start and binds nothing, rather than guess a generation', async () => {
      // #given an operator override that names no version
      const exitLog: string[] = []
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: 'latest'}, {exitFn: makeExitFn(exitLog)})

      // #when / #then
      await expect(startWorkspaceAgent(h.deps)).rejects.toThrow('exitFn(1)')
      expect(exitLog).toEqual(['exit(1)'])
      expect(h.callLog).toEqual([])
      expect(h.v1Runner).not.toHaveBeenCalled()
      expect(h.v2Runner).not.toHaveBeenCalled()
    })
  })

  describe('shutdown', () => {
    it('waits for the V2 supervisor to finish its teardown before it closes the proxy and exits', async () => {
      // #given a V2 supervisor whose teardown takes a moment after the abort, and main.ts as the only SIGTERM handler
      process.removeAllListeners('SIGTERM')
      let finishTeardown: () => void = () => undefined
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.0'})
      const slowRunner = vi.fn(async (options: RunSupervisedOpencodeV2Options): Promise<void> => {
        h.callLog.push('runV2')
        await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), {once: true}))
        h.callLog.push('teardown.start')
        await new Promise<void>(resolve => {
          finishTeardown = resolve
        })
        h.callLog.push('teardown.done')
      })
      await startWorkspaceAgent({...h.deps, runSupervisedOpencodeV2Fn: slowRunner})

      // #when SIGTERM arrives
      const pending = terminate(h)
      await new Promise<void>(resolve => setTimeout(resolve, 30))

      // #then the proxy is still open while sessions are being interrupted
      expect(h.callLog).toContain('teardown.start')
      expect(h.callLog).not.toContain('proxy.close')
      expect(h.callLog).not.toContain('process.exit(0)')

      // #and once the teardown is done the service finishes closing
      finishTeardown()
      const log = await pending
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      expect(log.indexOf('teardown.done')).toBeLessThan(log.indexOf('proxy.close'))
    })
  })
})
