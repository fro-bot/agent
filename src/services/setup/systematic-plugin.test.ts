import type {ExecAdapter, Logger} from './types.js'
import {Buffer} from 'node:buffer'
import {describe, expect, it, vi} from 'vitest'
import {installSystematicPlugin} from './systematic-plugin.js'

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createExecAdapter(exec: ExecAdapter['exec']): ExecAdapter {
  return {
    exec,
    getExecOutput: vi.fn(),
  }
}

describe('installSystematicPlugin', () => {
  it('installs the configured plugin through the OpenCode CLI', async () => {
    // #given an OpenCode CLI that exits successfully
    const logger = createLogger()
    const exec = vi.fn<ExecAdapter['exec']>().mockResolvedValue(0)

    // #when the plugin is installed
    const result = await installSystematicPlugin({
      logger,
      execAdapter: createExecAdapter(exec),
      opencodePath: '/cached/opencode',
      systematicVersion: '2.1.0',
      timeoutMs: 100,
    })

    // #then OpenCode receives a non-interactive global install command
    expect(result.status).toBe('installed')
    const call = exec.mock.calls[0]
    expect(call?.[0]).toBe('/cached/opencode')
    expect(call?.[1]).toEqual(['--pure', 'plugin', '@fro.bot/systematic@2.1.0', '--global'])
    expect(call?.[2]?.ignoreReturnCode).toBe(true)
    expect(call?.[2]?.silent).toBe(true)
    expect(call?.[2]?.env?.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify({plugin: []}))
    expect(call?.[2]?.env?.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    expect(logger.warning).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('Systematic plugin install complete', expect.any(Object))
  })

  it('scrubs secrets from the install child, which runs untrusted npm lifecycle scripts', async () => {
    // #given a runner environment carrying credentials alongside what an install needs
    const logger = createLogger()
    const exec = vi.fn<ExecAdapter['exec']>().mockResolvedValue(0)
    const secrets = {
      GITHUB_TOKEN: 'ghs-secret',
      GH_TOKEN: 'gh-secret',
      NPM_AUTH_TOKEN: 'npm-secret',
      ANTHROPIC_API_KEY: 'sk-secret',
      SOME_CLIENT_SECRET: 'client-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      'INPUT_AUTH-JSON': 'auth-json-secret',
    }
    const originals = new Map(Object.keys(secrets).map(key => [key, process.env[key]]))
    Object.assign(process.env, secrets)

    try {
      // #when the plugin is installed
      await installSystematicPlugin({
        logger,
        execAdapter: createExecAdapter(exec),
        opencodePath: '/cached/opencode',
        systematicVersion: '2.1.0',
        timeoutMs: 100,
      })

      // #then no credential reaches the child, while install prerequisites survive
      const childEnv = exec.mock.calls[0]?.[2]?.env ?? {}
      for (const key of Object.keys(secrets)) {
        expect(childEnv[key]).toBeUndefined()
      }
      expect(childEnv.PATH).toBe(process.env.PATH)
    } finally {
      for (const [key, value] of originals) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  it('warns and returns when the install times out', async () => {
    // #given an OpenCode CLI that never exits
    const logger = createLogger()
    const exec = vi.fn<ExecAdapter['exec']>().mockImplementation(async () => new Promise<number>(() => {}))

    // #when the bounded install reaches its timeout
    const result = await installSystematicPlugin({
      logger,
      execAdapter: createExecAdapter(exec),
      opencodePath: '/cached/opencode',
      systematicVersion: '2.1.0',
      timeoutMs: 1,
    })

    // #then setup receives a warning instead of an exception
    expect(result.status).toBe('timed-out')
    const warningCall = vi.mocked(logger.warning).mock.calls[0]
    expect(warningCall?.[0]).toBe('Systematic plugin install timed out')
    expect(warningCall?.[1]?.timeoutMs).toBe(1)
    expect(warningCall?.[1]?.duration).toEqual(expect.any(Number))
  })

  it('uses the adapter timeout when the execution adapter can terminate children', async () => {
    // #given an adapter with a killable timeout implementation
    const logger = createLogger()
    const exec = vi.fn<ExecAdapter['exec']>().mockResolvedValue(0)
    const execWithTimeout = vi.fn<NonNullable<ExecAdapter['execWithTimeout']>>().mockResolvedValue('timed-out')
    const execAdapter = {exec, execWithTimeout, getExecOutput: vi.fn()} satisfies ExecAdapter

    // #when the bounded install runs
    const result = await installSystematicPlugin({
      logger,
      execAdapter,
      opencodePath: '/cached/opencode',
      systematicVersion: '2.1.0',
      timeoutMs: 1,
    })

    // #then the killable adapter owns the timeout behavior
    expect(result.status).toBe('timed-out')
    expect(execWithTimeout).toHaveBeenCalledWith(
      '/cached/opencode',
      ['--pure', 'plugin', '@fro.bot/systematic@2.1.0', '--global'],
      1,
      expect.objectContaining({silent: true}),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  it('warns and returns when the install exits unsuccessfully', async () => {
    // #given an OpenCode CLI that reports failure
    const logger = createLogger()
    const exec = vi.fn<ExecAdapter['exec']>().mockResolvedValue(17)

    // #when the plugin install runs
    const result = await installSystematicPlugin({
      logger,
      execAdapter: createExecAdapter(exec),
      opencodePath: '/cached/opencode',
      systematicVersion: '2.1.0',
      timeoutMs: 100,
    })

    // #then setup receives a warning instead of an exception
    expect(result.status).toBe('failed')
    const warningCall = vi.mocked(logger.warning).mock.calls[0]
    expect(warningCall?.[0]).toBe('Systematic plugin install failed')
    expect(warningCall?.[1]?.exitCode).toBe(17)
    expect(warningCall?.[1]?.duration).toEqual(expect.any(Number))
  })

  it('includes only the bounded stderr tail when the install exits unsuccessfully', async () => {
    // #given an OpenCode CLI that reports failure after writing verbose stderr
    const logger = createLogger()
    const stderr = `${'x'.repeat(2_100)}tail of registry failure`
    const execWithTimeout = vi
      .fn<NonNullable<ExecAdapter['execWithTimeout']>>()
      .mockImplementation(async (_commandLine, _args, timeoutMs, options) => {
        options?.listeners?.stderr?.(Buffer.from(stderr))
        expect(timeoutMs).toBe(100)
        return 17
      })
    const execAdapter = {exec: vi.fn(), execWithTimeout, getExecOutput: vi.fn()} satisfies ExecAdapter

    // #when the plugin install runs
    const result = await installSystematicPlugin({
      logger,
      execAdapter,
      opencodePath: '/cached/opencode',
      systematicVersion: '2.1.0',
      timeoutMs: 100,
    })

    // #then the warning contains the final 2,000 characters of stderr
    expect(result.status).toBe('failed')
    const warningCall = vi.mocked(logger.warning).mock.calls[0]
    expect(warningCall?.[1]?.stderr).toBe(stderr.slice(-2_000))
  })
})
