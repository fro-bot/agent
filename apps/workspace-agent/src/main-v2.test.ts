/**
 * Tests for the image-version gate in main.ts. The image bakes WORKSPACE_IMAGE_OPENCODE_VERSION; startup wires the V2
 * supervised runner, proxy and disposer from a V2 version, and exits before it binds anything for an unset, V1 or
 * malformed one.
 */

import type {CreateAppFn, ExitFn} from './main.js'
import type {CreateInstanceDisposerV2Options} from './opencode-instance-v2.js'
import type {OpencodeProxyHandle, OpencodeProxyV2Options} from './opencode-proxy-v2.js'
import type {RunSupervisedOpencodeV2Options} from './opencode-server-v2.js'
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
  readonly runner: ReturnType<typeof vi.fn>
  readonly proxy: ReturnType<typeof vi.fn>
  readonly disposer: ReturnType<typeof vi.fn>
  readonly appDeps: {value?: ServerDeps}
  readonly deps: Parameters<typeof startWorkspaceAgent>[0]
}

function harness(
  env: NodeJS.ProcessEnv,
  extra: Partial<NonNullable<Parameters<typeof startWorkspaceAgent>[0]>> = {},
): Harness {
  const callLog: string[] = []
  const appDeps: {value?: ServerDeps} = {}
  const runner = vi.fn(async (_options: RunSupervisedOpencodeV2Options) => {
    callLog.push('runV2')
  })
  const proxy = vi.fn((_options: OpencodeProxyV2Options) => {
    callLog.push('proxyV2')
    return makeFakeProxy(callLog)
  })
  const disposer = vi.fn((_options: CreateInstanceDisposerV2Options) => async () => ({kind: 'skipped' as const}))
  const createAppFn: CreateAppFn = deps => {
    appDeps.value = deps
    return new Hono()
  }
  return {
    callLog,
    runner,
    proxy,
    disposer,
    appDeps,
    deps: {
      env,
      serveFn: fakeServeFn(callLog),
      readSecretFn: () => 'gateway-bearer',
      reconcileUpdateJournalsFn: noopReconcile,
      reconcileRecoveryJournalsFn: noopReconcile,
      createAppFn,
      runSupervisedOpencodeFn: runner,
      createOpencodeProxyFn: proxy,
      createInstanceDisposerFn: disposer,
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

describe('startWorkspaceAgent — OpenCode image version', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    vi.restoreAllMocks()
  })

  describe('a V2 image version', () => {
    it('wires the runner, proxy and disposer, and reports the version', async () => {
      // #given an image that installed stock 2.2.6
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.6', WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '7000'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then
      expect(h.runner).toHaveBeenCalledTimes(1)
      expect(h.proxy).toHaveBeenCalledTimes(1)
      expect(h.disposer).toHaveBeenCalledTimes(1)
      expect(h.appDeps.value?.opencodeVersion).toBe('2.2.6')
      expect(h.runner.mock.calls[0]?.[0]).toMatchObject({rootDir: '/workspace/repos', readyTimeoutMs: 7000})
      expect(h.proxy.mock.calls[0]?.[0]).toMatchObject({
        token: 'gateway-bearer',
        upstreamUrl: 'http://127.0.0.1:54321',
      })
      expect(h.disposer.mock.calls[0]?.[0]).toMatchObject({upstreamUrl: 'http://127.0.0.1:54321'})
    })

    it('hands the runner, the proxy and the disposer the same credential holder', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.6'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then one holder: what the runner publishes is what the proxy and the disposer read
      const runnerHolder = (h.runner.mock.calls[0]?.[0] as RunSupervisedOpencodeV2Options).credentials
      const proxyHolder = (h.proxy.mock.calls[0]?.[0] as OpencodeProxyV2Options).credentials
      const disposerHolder = (h.disposer.mock.calls[0]?.[0] as CreateInstanceDisposerV2Options).credentials
      expect(proxyHolder).toBe(runnerHolder)
      expect(disposerHolder).toBe(runnerHolder)
    })

    it('keeps the startup order: serve, proxy created, proxy listening, and only then the runner', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.6'})

      // #when
      await startWorkspaceAgent(h.deps)

      // #then the unprivileged server never runs before both control ports are bound
      expect(h.callLog).toEqual(['serve', 'proxyV2', 'proxy.listen', 'runV2'])
    })

    it('lets the V2 disposer run only while the supervisor reports ready', async () => {
      // #given
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.6'})
      await startWorkspaceAgent(h.deps)
      const options = h.disposer.mock.calls[0]?.[0] as CreateInstanceDisposerV2Options

      // #then the readiness predicate follows the status ref the app and the runner share
      const statusRef = (h.runner.mock.calls[0]?.[0] as RunSupervisedOpencodeV2Options).statusRef
      statusRef.status = 'starting'
      expect(options.isRunning?.()).toBe(false)
      statusRef.status = 'ready'
      expect(options.isRunning?.()).toBe(true)
    })
  })

  describe('an image without a V2 version', () => {
    it.each([
      ['unset', {}, 'WORKSPACE_IMAGE_OPENCODE_VERSION is not set'],
      ['blank', {WORKSPACE_IMAGE_OPENCODE_VERSION: '  '}, 'WORKSPACE_IMAGE_OPENCODE_VERSION is not set'],
      ['a V1 harness build', {WORKSPACE_IMAGE_OPENCODE_VERSION: '1.19.5+harness.bf7f7dfe'}, 'V2 only'],
      ['a stock V1 build', {WORKSPACE_IMAGE_OPENCODE_VERSION: '1.19.4'}, 'V2 only'],
      ['not a version', {WORKSPACE_IMAGE_OPENCODE_VERSION: 'latest'}, 'is not an OpenCode version'],
    ])('exits 1 with a named error and binds nothing when the image version is %s', async (_label, env, expected) => {
      // #given
      const exitLog: string[] = []
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const h = harness(env, {exitFn: makeExitFn(exitLog)})

      // #when / #then
      await expect(startWorkspaceAgent(h.deps)).rejects.toThrow('exitFn(1)')
      expect(exitLog).toEqual(['exit(1)'])
      expect(h.callLog).toEqual([])
      expect(h.runner).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(
        'workspace-agent: cannot start — invalid OpenCode image version',
        expect.objectContaining({message: expect.stringContaining(expected) as string}),
      )
    })
  })

  describe('shutdown', () => {
    it('waits for the V2 supervisor to finish its teardown before it closes the proxy and exits', async () => {
      // #given a V2 supervisor whose teardown takes a moment after the abort, and main.ts as the only SIGTERM handler
      process.removeAllListeners('SIGTERM')
      let finishTeardown: () => void = () => undefined
      const h = harness({WORKSPACE_IMAGE_OPENCODE_VERSION: '2.2.6'})
      const slowRunner = vi.fn(async (options: RunSupervisedOpencodeV2Options): Promise<void> => {
        h.callLog.push('runV2')
        await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), {once: true}))
        h.callLog.push('teardown.start')
        await new Promise<void>(resolve => {
          finishTeardown = resolve
        })
        h.callLog.push('teardown.done')
      })
      await startWorkspaceAgent({...h.deps, runSupervisedOpencodeFn: slowRunner})

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
