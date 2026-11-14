import type {Fixture} from './server-v2-test-kit.js'
import type {OpenCodeV2SandboxLaunch, OpenCodeV2SandboxView, OpenCodeV2ServerHandle} from './server-v2.js'
import {spawn, spawnSync} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, it, vi} from 'vitest'
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

/** The three fixed scripts of the view launch. They take every path as a positional argument. */
const GATE_SCRIPT =
  'r=$1; s=$2; g=$3; n=$4; shift 4; ' +
  'id=$("$r" /proc/self/ns/mnt) || exit 70; echo "$id" > "$g/ns" || exit 70; i=0; ' +
  'while :; do { read -r v < "$g/go"; } 2>/dev/null && [ "$v" = "$id" ] && break; ' +
  'i=$((i+1)); [ "$i" -gt "$n" ] && exit 71; "$s" 0.1 || exit 72; done; exec "$@"'
const BUILD_SCRIPT = '"$1" "$2" "$3" && shift 3 && exec "$@"'
const ENTER_SCRIPT = '"$1" "$2" "$3" && cd / && "$4" -l "$5" && shift 5 && exec "$@"'

const VIEW: OpenCodeV2SandboxView = {
  unsharePath: '/usr/bin/unshare',
  shPath: '/usr/bin/sh',
  pivotRootPath: '/usr/sbin/pivot_root',
  umountPath: '/usr/bin/umount',
  nodePath: '/opt/runner-cache/externals/node24/bin/node',
  builderPath: '/home/runner/work/_actions/fro-bot/agent/v1/dist/sandbox-view.js',
  policy: {
    newRoot: '/home/runner/work/_temp/view/root',
    putOld: '/mnt',
    tools: {mount: '/usr/bin/mount', umount: '/usr/bin/umount'},
    writable: ['/home/runner/work/repo/repo', '/home/fro-bot-sandbox'],
    readOnly: [],
    runnerHome: '/home/runner',
    actionsDir: '/home/runner/work/_actions',
  },
  gate: {
    dir: '/home/runner/work/_temp/fro-bot-view-AbC123/g-XyZ789',
    readlinkPath: '/usr/bin/readlink',
    sleepPath: '/usr/bin/sleep',
    ticks: 200,
  },
}

describe('buildSandboxLaunch with a read-only view', () => {
  it('launches sudo, unshare with a private mount namespace, the builder, then the enter-and-drop chain', () => {
    // #given a sandbox launch with a view
    const built = buildSandboxLaunch(
      launchSpec({view: VIEW}),
      '/opt/oc/opencode',
      ['serve', '--stdio'],
      {FOO: 'bar'},
      '/home/runner/work/repo/repo',
    )

    // #then the chain is exact: nothing is interpolated, every path is its own argument
    expect(built.command).toBe('/usr/bin/sudo')
    expect(built.args).toEqual([
      '-n',
      '--preserve-env=FOO',
      '--',
      '/usr/bin/unshare',
      '--mount',
      '--propagation',
      'private',
      '--',
      '/usr/bin/sh',
      '-c',
      GATE_SCRIPT,
      'sh',
      '/usr/bin/readlink',
      '/usr/bin/sleep',
      '/home/runner/work/_temp/fro-bot-view-AbC123/g-XyZ789',
      '200',
      '/usr/bin/sh',
      '-c',
      BUILD_SCRIPT,
      'sh',
      '/opt/runner-cache/externals/node24/bin/node',
      '/home/runner/work/_actions/fro-bot/agent/v1/dist/sandbox-view.js',
      JSON.stringify(VIEW.policy),
      '/usr/bin/sh',
      '-c',
      ENTER_SCRIPT,
      'sh',
      '/usr/sbin/pivot_root',
      '/home/runner/work/_temp/view/root',
      '/home/runner/work/_temp/view/root/mnt',
      '/usr/bin/umount',
      '/mnt',
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
      '-C',
      '/home/runner/work/repo/repo',
      'HOME=/home/fro-bot-sandbox',
      'USER=fro-bot-sandbox',
      'LOGNAME=fro-bot-sandbox',
      'TMPDIR=/home/fro-bot-sandbox/tmp',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'XDG_DATA_HOME=/home/runner/.local/share',
      'XDG_CONFIG_HOME=/home/runner/.config',
      'XDG_CACHE_HOME=/home/runner/.cache',
      'XDG_STATE_HOME=/home/runner/.local/state',
      '/opt/oc/opencode',
      'serve',
      '--stdio',
    ])
  })

  it('keeps secrets out of argv, as the launch without a view does', () => {
    // #given the two secret carriers
    const built = buildSandboxLaunch(
      launchSpec({view: VIEW}),
      '/opt/oc/opencode',
      ['serve'],
      {OPENCODE_PASSWORD: 'pw-secret-value', OPENCODE_CONFIG_CONTENT: '{"k":"cfg-secret"}'},
      '/work',
    )

    // #then they are preserved by name and absent from argv
    expect(JSON.stringify(built.args)).not.toContain('pw-secret-value')
    expect(JSON.stringify(built.args)).not.toContain('cfg-secret')
    expect(built.env).toEqual({OPENCODE_PASSWORD: 'pw-secret-value', OPENCODE_CONFIG_CONTENT: '{"k":"cfg-secret"}'})
  })

  it('passes a path with a space, a quote and a newline as one argument to the builder and to the server', () => {
    // #given hostile characters in the working directory, the builder path, the binary and a policy root
    const hostile = 'a b"c\'d\ne$(touch x);`id`'
    const view: OpenCodeV2SandboxView = {
      ...VIEW,
      builderPath: `/opt/${hostile}/sandbox-view.js`,
      policy: {...VIEW.policy, writable: [`/work/${hostile}`]},
    }

    // #when built
    const built = buildSandboxLaunch(
      launchSpec({view}),
      `/opt/${hostile}/opencode`,
      ['serve', hostile],
      {},
      `/work/${hostile}`,
    )

    // #then each is still a single element, byte for byte, and the scripts are the fixed text
    expect(built.args).toContain(`/opt/${hostile}/sandbox-view.js`)
    expect(built.args).toContain(`/opt/${hostile}/opencode`)
    expect(built.args).toContain(hostile)
    const cwdIndex = built.args.indexOf('-C')
    expect(built.args[cwdIndex + 1]).toBe(`/work/${hostile}`)
    expect(
      (JSON.parse(built.args.find(arg => arg.startsWith('{"newRoot"')) ?? '{}') as {writable: string[]}).writable,
    ).toEqual([`/work/${hostile}`])
    expect(built.args.filter(arg => arg === GATE_SCRIPT || arg === BUILD_SCRIPT || arg === ENTER_SCRIPT)).toHaveLength(
      3,
    )
  })

  it('omits the preserve-env option when there is nothing to preserve', () => {
    // #given an empty environment
    const built = buildSandboxLaunch(launchSpec({view: VIEW}), '/opt/oc/opencode', ['serve'], {}, '/work')

    // #then sudo is not given an empty option
    expect(built.args.slice(0, 2)).toEqual(['-n', '--'])
  })

  it('without a view the launch is the one it always was', () => {
    // #given a spec with no view
    const built = buildSandboxLaunch(launchSpec(), '/opt/oc/opencode', ['serve'], {FOO: 'bar'}, '/work')

    // #then there is no unshare, no shell and no working-directory option
    expect(built.args).not.toContain('--mount')
    expect(built.args).not.toContain('-C')
    expect(built.args.slice(3, 5)).toEqual(['/usr/bin/setpriv', '--reuid=998'])
  })
})

const NAMESPACE_LINK = 'mnt:[777]'

const serverRan = (dir: string): boolean => existsSync(path.join(dir, 'server-ran'))

function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function runChain(spec: OpenCodeV2SandboxLaunch, binary: string, cwd: string) {
  const built = buildSandboxLaunch(spec, binary, ['serve'], {})
  const withCwd = buildSandboxLaunch(spec, binary, ['serve'], {}, cwd)
  expect(withCwd.args.slice(0, 2)).toEqual(built.args.slice(0, 2))
  // Skip `sudo -n --preserve-env=… --`; run the rest as the namespace launcher would see it.
  const rest = withCwd.args.slice(withCwd.args.indexOf('--') + 1)
  return spawnSync(rest[0] ?? '', rest.slice(1), {encoding: 'utf8'})
}

describe('the view launch chain, run for real with stand-in privileged tools', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
  })

  /**
   * Stand-ins for the tools that need root. `unshare` skips its own options, `pivot_root` and `umount` log and succeed,
   * `setpriv` skips the drop and `env` understands `-C`. The shells and the quoting are the real ones.
   */
  function standIns(
    builderBody: string,
    pivotBody = 'true',
    gate: {readonly ticks?: number; readonly go?: string | null; readonly readlinkBody?: string} = {},
  ): {
    readonly view: OpenCodeV2SandboxView
    readonly spec: OpenCodeV2SandboxLaunch
    readonly dir: string
    readonly log: string
  } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'view-chain-'))
    dirs.push(dir)
    const log = path.join(dir, 'log')
    const builder = path.join(dir, 'builder.js')
    writeFileSync(builder, builderBody)
    const gateDir = path.join(dir, 'gate')
    mkdirSync(gateDir)
    // The runner side's go-ahead, in place before the launch unless a test withholds it.
    if (gate.go !== null) writeFileSync(path.join(gateDir, 'go'), gate.go ?? `${NAMESPACE_LINK}\n`)
    const view: OpenCodeV2SandboxView = {
      ...VIEW,
      gate: {
        dir: gateDir,
        readlinkPath: script(
          dir,
          'readlink',
          gate.readlinkBody ?? `echo "$1" >> ${log}.readlink\necho '${NAMESPACE_LINK}'`,
        ),
        sleepPath: '/bin/sleep',
        ticks: gate.ticks ?? 50,
      },
      unsharePath: script(dir, 'unshare', 'shift 4\nexec "$@"'),
      shPath: '/bin/sh',
      pivotRootPath: script(dir, 'pivot_root', `echo "pivot $1 $2" >> ${log}\n${pivotBody}`),
      umountPath: script(dir, 'umount', `echo "umount $1 $2" >> ${log}`),
      nodePath: process.execPath,
      builderPath: builder,
    }
    const spec = launchSpec({
      view,
      sudoPath: '/unused',
      setprivPath: script(dir, 'setpriv', 'while [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"'),
      envPath: script(dir, 'env', 'cd "$2" || exit 97\nshift 2\nexec /usr/bin/env "$@"'),
    })
    return {view, spec, dir, log}
  }

  /** The stand-ins plus a server that leaves a marker, so a test can tell whether the chain got that far. */
  function counted(builderBody: string, gate: Parameters<typeof standIns>[2]) {
    const made = standIns(builderBody, 'true', gate)
    const server = script(made.dir, 'opencode', `echo ran > ${path.join(made.dir, 'server-ran')}`)
    return {...made, server}
  }

  it('never executes the server when the builder exits non-zero, and passes its exit code on', () => {
    // #given a builder that fails
    const {spec, dir, log} = standIns('process.exit(78)')
    const marker = path.join(dir, 'server-ran')
    const server = script(dir, 'opencode', `echo ran > ${marker}`)

    // #when the chain runs
    const result = runChain(spec, server, dir)

    // #then the server did not run, and neither did the pivot
    expect(result.status).toBe(78)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(log)).toBe(false)
  })

  it('never executes the server when entering the new root fails', () => {
    // #given a builder that succeeds and a pivot that fails
    const {spec, dir, log} = standIns('process.exit(0)', 'exit 1')
    const marker = path.join(dir, 'server-ran')
    const server = script(dir, 'opencode', `echo ran > ${marker}`)

    // #when the chain runs
    const result = runChain(spec, server, dir)

    // #then the old root was not unmounted and the server did not run
    expect(result.status).toBe(1)
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(log, 'utf8')).not.toContain('umount')
  })

  it('enters the new root, unmounts the old one and only then runs the server in the working directory', () => {
    // #given a builder that succeeds
    const {spec, dir, log} = standIns('process.exit(0)')
    const work = path.join(dir, 'work dir')
    const server = script(dir, 'opencode', `pwd > ${path.join(dir, 'cwd')}\necho "$1" > ${path.join(dir, 'arg')}`)
    spawnSync('mkdir', ['-p', work])

    // #when the chain runs
    const result = runChain(spec, server, work)

    // #then pivot and umount ran first, with the new root and the old root's name, then the server, in the cwd
    expect(result.status).toBe(0)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'pivot /home/runner/work/_temp/view/root /home/runner/work/_temp/view/root/mnt',
      'umount -l /mnt',
    ])
    expect(readFileSync(path.join(dir, 'cwd'), 'utf8').trim()).toBe(work)
    expect(readFileSync(path.join(dir, 'arg'), 'utf8').trim()).toBe('serve')
  })

  describe('the gate', () => {
    it('records the id of its own namespace before anything else runs, and lets the chain continue on a matching go-ahead', () => {
      // #given a go-ahead that names the id the gate will report
      const made = counted('process.exit(0)', {})
      const marker = path.join(made.dir, 'builder-ran')
      writeFileSync(made.view.builderPath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)

      // #when the chain runs
      const result = runChain(made.spec, made.server, made.dir)

      // #then the id was recorded where the runner reads it, read from the process's own namespace link, and the chain went on
      expect(readFileSync(path.join(made.view.gate.dir, 'ns'), 'utf8')).toBe(`${NAMESPACE_LINK}\n`)
      expect(readFileSync(`${made.log}.readlink`, 'utf8').trim()).toBe('/proc/self/ns/mnt')
      expect(result.status).toBe(0)
      expect(existsSync(marker)).toBe(true)
      expect(serverRan(made.dir)).toBe(true)
    })

    it('exits without running the builder, the pivot or the server when no go-ahead comes within its bound', () => {
      // #given no go-ahead and a bound of three ticks
      const made = counted('process.exit(0)', {go: null, ticks: 3})

      // #when the chain runs
      const result = runChain(made.spec, made.server, made.dir)

      // #then it gave up with the gate's own exit code having recorded its id, and nothing past the gate ran
      expect(result.status).toBe(71)
      expect(existsSync(path.join(made.view.gate.dir, 'ns'))).toBe(true)
      expect(existsSync(made.log)).toBe(false)
      expect(serverRan(made.dir)).toBe(false)
    })

    it('does not accept a go-ahead that names another namespace', () => {
      // #given a go-ahead for some other id
      const made = counted('process.exit(0)', {go: 'mnt:[999]\n', ticks: 3})

      // #when the chain runs
      const result = runChain(made.spec, made.server, made.dir)

      // #then
      expect(result.status).toBe(71)
      expect(serverRan(made.dir)).toBe(false)
      expect(existsSync(made.log)).toBe(false)
    })

    it('does not accept an empty or partial go-ahead', () => {
      // #given a go-ahead file that is still empty
      const made = counted('process.exit(0)', {go: '', ticks: 3})

      // #when the chain runs
      const result = runChain(made.spec, made.server, made.dir)

      // #then
      expect(result.status).toBe(71)
      expect(serverRan(made.dir)).toBe(false)
    })

    it('exits without running anything when its own namespace id cannot be read', () => {
      // #given a readlink that fails
      const made = counted('process.exit(0)', {readlinkBody: 'exit 1', ticks: 3})

      // #when the chain runs
      const result = runChain(made.spec, made.server, made.dir)

      // #then
      expect(result.status).toBe(70)
      expect(serverRan(made.dir)).toBe(false)
    })

    it('exits without running anything when it cannot record its id', () => {
      // #given a gate directory that does not exist
      const made = counted('process.exit(0)', {go: null, ticks: 3})
      rmSync(made.view.gate.dir, {recursive: true, force: true})

      // #when the chain runs
      const result = runChain(made.spec, made.server, made.dir)

      // #then
      expect(result.status).toBe(70)
      expect(serverRan(made.dir)).toBe(false)
    })

    it('waits for a go-ahead that arrives after it started, and then runs the chain', async () => {
      // #given no go-ahead yet, and a runner that writes it shortly after the gate has reported
      const made = counted('process.exit(0)', {go: null, ticks: 100})
      const built = buildSandboxLaunch(made.spec, made.server, ['serve'], {}, made.dir)
      const rest = built.args.slice(built.args.indexOf('--') + 1)
      const child = spawn(rest[0] ?? '', rest.slice(1))
      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
      const goFile = path.join(made.view.gate.dir, 'go')
      const nsFile = path.join(made.view.gate.dir, 'ns')

      // #when the runner reads the id and then writes the go-ahead
      await vi.waitFor(() => expect(existsSync(nsFile)).toBe(true), {timeout: 5000})
      expect(serverRan(made.dir)).toBe(false)
      writeFileSync(goFile, readFileSync(nsFile, 'utf8'))

      // #then the chain ran to the server
      expect(await exited).toBe(0)
      expect(serverRan(made.dir)).toBe(true)
    })
  })
})

describe('startOpenCodeV2Server with a read-only view', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true})
  })

  it('reports the spawned launch pid and names the failed stage when the view cannot be built', async () => {
    // #given a launcher that prints the builder's failure line and exits 78
    const dir = mkdtempSync(path.join(os.tmpdir(), 'view-fail-'))
    dirs.push(dir)
    const sudoPath = path.join(dir, 'sudo')
    writeFileSync(sudoPath, `#!/bin/sh\necho '{"view":"failed","stage":"seal"}'\nexit 78\n`)
    chmodSync(sudoPath, 0o755)
    const pids: number[] = []

    // #when started
    const result = await startOpenCodeV2Server(
      {
        binaryPath: '/unused',
        directory: dir,
        expectedPluginIds: [],
        timeouts: TIMEOUTS,
        sandbox: launchSpec({sudoPath, view: VIEW}),
        onSpawn: pid => pids.push(pid),
      },
      {debug: () => undefined, info: () => undefined, warning: () => undefined, error: () => undefined},
    )

    // #then the start failed with the stage, and the pid was reported before anything else could go wrong
    expect(result.success).toBe(false)
    expect(!result.success && result.error.kind).toBe('exited-early')
    expect(!result.success && result.error.message).toContain('stage seal')
    expect(!result.success && result.error.exitCode).toBe(78)
    expect(pids).toHaveLength(1)
    expect(pids[0]).toBeGreaterThan(0)
  })
})
