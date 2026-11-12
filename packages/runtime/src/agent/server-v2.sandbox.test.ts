import type {Fixture} from './server-v2-test-kit.js'
import type {OpenCodeV2SandboxLaunch, OpenCodeV2ServerHandle} from './server-v2.js'
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'
import {createFixture} from './server-v2-test-kit.js'
import {buildSandboxLaunch, startOpenCodeV2Server} from './server-v2.js'

const TIMEOUTS = {
  listenTimeoutMs: 3000,
  infoTimeoutMs: 3000,
  agentReadyTimeoutMs: 3000,
  pluginGateTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  pollIntervalMs: 20,
  interruptSettleTimeoutMs: 1500,
  exitTimeoutMs: 1500,
  killConfirmTimeoutMs: 1000,
}

const ACCOUNT = {name: 'fro-bot-sandbox', uid: 998, gid: 997, home: '/home/fro-bot-sandbox'}

function launchSpec(overrides: Partial<OpenCodeV2SandboxLaunch> = {}): OpenCodeV2SandboxLaunch {
  return {
    sudoPath: '/usr/bin/sudo',
    setprivPath: '/usr/bin/setpriv',
    envPath: '/usr/bin/env',
    account: ACCOUNT,
    path: '/usr/local/bin:/usr/bin:/bin',
    tmpdir: '/home/fro-bot-sandbox/tmp',
    xdg: {
      data: '/home/runner/.local/share',
      config: '/home/runner/.config',
      cache: '/home/runner/.cache',
      state: '/home/runner/.local/state',
    },
    ...overrides,
  }
}

describe('buildSandboxLaunch', () => {
  it('drops with the exact setpriv flags behind sudo -n', () => {
    // #given a sandbox launch
    // #when the command is built
    const built = buildSandboxLaunch(launchSpec(), '/opt/oc/opencode', ['serve', '--stdio'], {FOO: 'bar'})

    // #then the sudo command carries the exact privilege-drop flags, in order, with absolute paths
    expect(built.command).toBe('/usr/bin/sudo')
    expect(built.args.slice(0, 3)).toEqual(['-n', '--preserve-env=FOO', '--'])
    expect(built.args.slice(3, 13)).toEqual([
      '/usr/bin/setpriv',
      '--reuid=998',
      '--regid=997',
      '--clear-groups',
      '--no-new-privs',
      '--inh-caps=-all',
      '--bounding-set=-all',
      '--ambient-caps=-all',
      '--',
      '/usr/bin/env',
    ])
    expect(built.args.slice(-3)).toEqual(['/opt/oc/opencode', 'serve', '--stdio'])
  })

  it('passes secrets by name only and sets all four XDG paths to the runner-resolved values', () => {
    // #given an environment with the two secret carriers and a runner HOME that must not survive
    const secret = 'pw-0123456789-secret'
    const config = '{"provider":{"key":"cfg-secret-value"}}'
    const built = buildSandboxLaunch(launchSpec(), '/opt/oc/opencode', ['serve'], {
      OPENCODE_PASSWORD: secret,
      OPENCODE_CONFIG_CONTENT: config,
      HOME: '/home/runner',
      XDG_DATA_HOME: '/elsewhere',
      CI: 'true',
    })

    // #then the names are preserved, the values never reach argv, and the sudo environment holds only preserved names
    const preserve = built.args.find(arg => arg.startsWith('--preserve-env='))
    expect(preserve?.split('=')[1]?.split(',')).toEqual(
      expect.arrayContaining(['OPENCODE_PASSWORD', 'OPENCODE_CONFIG_CONTENT', 'CI']),
    )
    expect(preserve).not.toContain('HOME')
    expect(JSON.stringify(built.args)).not.toContain(secret)
    expect(JSON.stringify(built.args)).not.toContain('cfg-secret-value')
    expect(built.env).toEqual({OPENCODE_PASSWORD: secret, OPENCODE_CONFIG_CONTENT: config, CI: 'true'})

    // #and the identity variables are set explicitly after the drop
    expect(built.args).toEqual(
      expect.arrayContaining([
        'HOME=/home/fro-bot-sandbox',
        'USER=fro-bot-sandbox',
        'LOGNAME=fro-bot-sandbox',
        'TMPDIR=/home/fro-bot-sandbox/tmp',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'XDG_DATA_HOME=/home/runner/.local/share',
        'XDG_CONFIG_HOME=/home/runner/.config',
        'XDG_CACHE_HOME=/home/runner/.cache',
        'XDG_STATE_HOME=/home/runner/.local/state',
      ]),
    )
  })

  it('drops names that are not plain identifiers', () => {
    // #given an env name that would break out of the sudo option
    const built = buildSandboxLaunch(launchSpec(), '/b', [], {'A,B': '1', OK: '2'})

    // #then only the plain name is preserved
    expect(built.args).toContain('--preserve-env=OK')
  })
})

describe('startOpenCodeV2Server with a sandbox launch', () => {
  const fixtures: Fixture[] = []
  const handles: OpenCodeV2ServerHandle[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.shutdown()
    for (const created of fixtures.splice(0)) created.cleanup()
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
  })

  /** A stand-in for sudo: records its argv, emulates env_reset plus --preserve-env, skips the setpriv hop, execs the rest. */
  function writeFakeSudo(): {readonly sudoPath: string; readonly argvLog: string} {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-sudo-'))
    dirs.push(dir)
    const argvLog = path.join(dir, 'argv.json')
    const sudoPath = path.join(dir, 'sudo')
    writeFileSync(
      sudoPath,
      `#!${process.execPath}
const fs = require('node:fs')
const {spawn} = require('node:child_process')
const argv = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv))
const preserve = (argv[1] ?? '').replace('--preserve-env=', '').split(',')
const env = {}
for (const name of preserve) if (process.env[name] !== undefined) env[name] = process.env[name]
const rest = argv.slice(argv.indexOf('--', 3) + 1)
const child = spawn(rest[0], rest.slice(1), {stdio: 'inherit', env})
child.on('exit', code => process.exit(code ?? 0))
`,
    )
    chmodSync(sudoPath, 0o755)
    return {sudoPath, argvLog}
  }

  it('starts the server through sudo with the sandbox identity in its environment', async () => {
    // #given a fixture server behind a fake sudo
    const created = createFixture()
    fixtures.push(created)
    const {sudoPath, argvLog} = writeFakeSudo()
    const secret = 'cfg-secret-not-in-argv'

    // #when started with a sandbox launch
    const result = await startOpenCodeV2Server(
      {
        binaryPath: created.binaryPath,
        directory: created.dir,
        expectedPluginIds: [],
        timeouts: TIMEOUTS,
        config: {provider: {key: secret}},
        env: {PATH: process.env.PATH, HOME: '/home/runner', CI: 'true'},
        sandbox: launchSpec({sudoPath, envPath: '/usr/bin/env'}),
      },
      {debug: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined},
    )

    // #then the server runs under the sandbox identity and the secrets reached it without touching argv
    expect(result.success).toBe(true)
    if (result.success) handles.push(result.data)
    const recorded = created.readRecord()
    expect(recorded.env.HOME).toBe('/home/fro-bot-sandbox')
    expect(recorded.env.USER).toBe('fro-bot-sandbox')
    expect(recorded.env.XDG_DATA_HOME).toBe('/home/runner/.local/share')
    expect(recorded.env.OPENCODE_PASSWORD?.length).toBeGreaterThan(20)
    expect(recorded.env.OPENCODE_CONFIG_CONTENT).toContain(secret)
    const sudoArgv = readFileSync(argvLog, 'utf8')
    expect(sudoArgv).not.toContain(secret)
    expect(sudoArgv).not.toContain(recorded.env.OPENCODE_PASSWORD ?? 'unreachable')
  })

  it('rejects a sandbox launch combined with a uid', async () => {
    // #given both identity mechanisms
    const created = createFixture()
    fixtures.push(created)

    // #when started
    const result = await startOpenCodeV2Server(
      {
        binaryPath: created.binaryPath,
        directory: created.dir,
        expectedPluginIds: [],
        uid: 1,
        gid: 1,
        sandbox: launchSpec(),
      },
      {debug: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined},
    )

    // #then it refuses rather than picking one
    expect(!result.success && result.error.kind).toBe('invalid-options')
  })
})
