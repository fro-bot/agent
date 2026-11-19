import {execFileSync} from 'node:child_process'
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {filterAgentEnv} from '@fro-bot/runtime'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

import {
  HEADLESS_MARKERS,
  MAX_SETTINGS_FILE_BYTES,
  resolveTracingSettings,
  TRACING_LAUNCHER_ENV,
  userSettingsFilePath,
} from './settings.js'

const isPosix = process.platform !== 'win32'
/** The machine name every test resolves against, injected: no test depends on the real host name. */
const HOSTNAME = 'build-box.example.test'
const uid = process.getuid?.() ?? 0

/** A throwaway user home, config directory and project directory. Nothing here touches the real home. */
let root: string
let home: string
let configHome: string
let project: string
let lines: string[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fro-bot-tracing-settings-')))
  home = path.join(root, 'home')
  configHome = path.join(home, '.config')
  project = path.join(root, 'project')
  mkdirSync(configHome, {recursive: true})
  mkdirSync(project, {recursive: true})
  lines = []
})

afterEach(() => {
  rmSync(root, {recursive: true, force: true})
})

const IDENTITY = {repository: 'fro-bot/agent', runId: '123456', attempt: '1', job: 'fro-bot', trigger: 'issue_comment'}
const RELAY = 'http://127.0.0.1:43211/v1/traces'

function launcher(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({version: 1, host: 'action', tracing: 'on', relay: RELAY, identity: IDENTITY, ...overrides})
}

function settingsFile(): string {
  return userSettingsFilePath({HOME: home, XDG_CONFIG_HOME: configHome})
}

function writeSettings(
  content: unknown = {
    version: 1,
    endpoint: 'https://collector.example/v1/traces',
    headers: {authorization: 'Basic abc'},
    hosts: [HOSTNAME],
  },
  mode = 0o600,
  target = settingsFile(),
): string {
  mkdirSync(path.dirname(target), {recursive: true})
  writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content), {mode})
  chmodSync(target, mode)
  return target
}

function resolve(
  env: Record<string, string | undefined> = {},
  extra: {platform?: NodeJS.Platform; uid?: number; hostname?: () => string; argv?: readonly string[]} = {},
) {
  return resolveTracingSettings({
    env: {HOME: home, XDG_CONFIG_HOME: configHome, ...env},
    directory: project,
    log: line => lines.push(line),
    hostname: () => HOSTNAME,
    // Not the test runner's own: an interactive `opencode` with no subcommand.
    argv: ['bun', '/$bunfs/root/opencode'],
    ...extra,
  })
}

describe('the launcher variable name', () => {
  it('is admitted by the Action environment filter, which drops credential-shaped names', () => {
    // #given the name and a credential-shaped neighbour
    // #when the Action filters an environment holding both
    const kept = filterAgentEnv({[TRACING_LAUNCHER_ENV]: launcher(), OPENCODE_FROBOT_TRACING_TOKEN: 'x'})

    // #then the launcher survives and carries no credential
    expect(kept[TRACING_LAUNCHER_ENV]).toBe(launcher())
    expect(kept.OPENCODE_FROBOT_TRACING_TOKEN).toBeUndefined()
  })
})

describe('Action host', () => {
  it('resolves to on with the relay address and run identity the launcher carries', () => {
    // #given an Action launcher variable
    // #when settings resolve
    const settings = resolve({[TRACING_LAUNCHER_ENV]: launcher()})

    // #then it is on, with exactly what the variable carried, and nothing was logged
    expect(settings).toEqual({mode: 'on', host: 'action', endpoint: RELAY, identity: IDENTITY})
    expect(lines).toEqual([])
  })

  it('uses only what the launcher carries: a valid user file changes nothing', () => {
    // #given a valid user file and a launcher that says off
    writeSettings()

    // #when settings resolve
    const settings = resolve({[TRACING_LAUNCHER_ENV]: launcher({tracing: 'off'})})

    // #then the file is never consulted: off, and silent because off was declared
    expect(settings).toEqual({mode: 'off', reason: 'action-off'})
    expect(lines).toEqual([])
  })

  it('resolves to off for the workspace host even with a valid user file', () => {
    // #given the workspace launcher value and a valid user file
    writeSettings()

    // #when settings resolve
    const settings = resolve({[TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'workspace', tracing: 'off'})})

    // #then tracing is off
    expect(settings).toEqual({mode: 'off', reason: 'workspace-host'})
  })

  it('resolves to off for a workspace host that says on', () => {
    // #given a workspace launcher that claims on, with a relay
    const settings = resolve({[TRACING_LAUNCHER_ENV]: launcher({host: 'workspace'})})

    // #then it is still off
    expect(settings).toEqual({mode: 'off', reason: 'workspace-host'})
  })

  // Each value is a sentinel: it must never appear in the log line.
  it.each([
    ['malformed JSON', '{"version":1,"host":"action","tracing":"on","relay":"SENTINEL', 'launcher-malformed'],
    ['an empty value', '', 'launcher-malformed'],
    ['an array', '[]', 'launcher-malformed'],
    ['an oversized document', launcher({relay: `http://127.0.0.1:1/${'a'.repeat(5000)}`}), 'launcher-malformed'],
    ['an unknown version', launcher({version: 2}), 'launcher-unsupported'],
    ['no version', JSON.stringify({host: 'action', tracing: 'off'}), 'launcher-unsupported'],
    ['an unknown host', launcher({host: 'gateway-SENTINEL'}), 'launcher-unsupported'],
    ['an unknown tracing state', launcher({tracing: 'maybe-SENTINEL'}), 'launcher-malformed'],
    ['an extra key', launcher({extra: 'SENTINEL'}), 'launcher-malformed'],
    ['a public relay address', launcher({relay: 'http://203.0.113.9:4318/v1/traces'}), 'launcher-relay-invalid'],
    ['a relay named localhost', launcher({relay: 'http://localhost:4318/v1/traces'}), 'launcher-relay-invalid'],
    ['an https relay', launcher({relay: 'https://127.0.0.1:4318/v1/traces'}), 'launcher-relay-invalid'],
    [
      'a relay with userinfo',
      launcher({relay: 'http://user:hunter2@127.0.0.1:4318/v1/traces'}),
      'launcher-relay-invalid',
    ],
    ['a relay with no port', launcher({relay: 'http://127.0.0.1/v1/traces'}), 'launcher-relay-invalid'],
    [
      'a relay with a query',
      launcher({relay: 'http://127.0.0.1:4318/v1/traces?key=SENTINEL'}),
      'launcher-relay-invalid',
    ],
    [
      'a loopback-lookalike host',
      launcher({relay: 'http://127.0.0.1.evil.example:4318/v1/traces'}),
      'launcher-relay-invalid',
    ],
    ['a relay that is not a string', launcher({relay: 4318}), 'launcher-relay-invalid'],
    ['identity missing a field', launcher({identity: {repository: 'a/b'}}), 'launcher-identity-invalid'],
    ['identity with a non-string field', launcher({identity: {...IDENTITY, runId: 7}}), 'launcher-identity-invalid'],
    ['identity with an empty field', launcher({identity: {...IDENTITY, job: ''}}), 'launcher-identity-invalid'],
    [
      'identity with an extra field',
      launcher({identity: {...IDENTITY, extra: 'SENTINEL'}}),
      'launcher-identity-invalid',
    ],
    [
      'identity with a control character',
      launcher({identity: {...IDENTITY, job: 'a\nb'}}),
      'launcher-identity-invalid',
    ],
  ] as const)('resolves %s to off, logging a fixed reason and no value', (_label, value, reason) => {
    // #given a refused launcher value and a valid user file that must not rescue it
    writeSettings()

    // #when settings resolve
    const settings = resolve({[TRACING_LAUNCHER_ENV]: value})

    // #then off, and the one log line is the fixed reason
    expect(settings).toEqual({mode: 'off', reason})
    expect(lines).toEqual([`tracing off (${reason})`])
    expect(lines.join('\n')).not.toMatch(/SENTINEL|hunter2|203\.0\.113/)
  })

  it('accepts any 127.0.0.0/8 literal and [::1] as the relay address', () => {
    // #given loopback literals other than 127.0.0.1
    for (const relay of ['http://127.8.9.10:1/v1/traces', 'http://[::1]:43211/v1/traces']) {
      // #when / #then they resolve to on
      expect(resolve({[TRACING_LAUNCHER_ENV]: launcher({relay})})).toMatchObject({mode: 'on', host: 'action'})
    }
  })
})

describe('headless host without a launcher variable', () => {
  it.each(HEADLESS_MARKERS)('resolves to off when %s is set, even with a valid user file', marker => {
    // #given a valid user file and one headless marker
    writeSettings()

    // #when settings resolve
    const settings = resolve({[marker]: 'x'})

    // #then off, with one log line
    expect(settings).toEqual({mode: 'off', reason: 'headless-host'})
    expect(lines).toEqual(['tracing off (headless-host)'])
  })

  it('treats a marker set to an empty string as set', () => {
    // #given a marker that is present but empty
    writeSettings()

    // #when / #then it still marks the host as headless
    expect(resolve({OPENCODE_PASSWORD: ''})).toEqual({mode: 'off', reason: 'headless-host'})
  })
})

describe('a server embedded by a parent process (`serve --stdio`)', () => {
  // `opencode serve --stdio` deletes OPENCODE_PASSWORD and OPENCODE_SERVER_PASSWORD from the process environment before a
  // plugin loads (measured on 2.3.2), so a server a parent embeds (an SDK client, a gateway, the Action) may show none of
  // the markers above. The command line still says `serve --stdio`. A `serve` you start by hand, or the background
  // service, is not embedded: the user's file covers it (see the README).
  it.each([
    ['serve --stdio', ['bun', '/$bunfs/root/opencode', 'serve', '--stdio', '--port', '0']],
    ['serve with the flag first', ['bun', '/$bunfs/root/opencode', 'serve', '--port', '0', '--stdio']],
    ['a global option before serve', ['bun', '/$bunfs/root/opencode', '--print-logs', 'serve', '--stdio']],
  ])('resolves to off for %s with no launcher variable and no marker, even with a valid user file', (_label, argv) => {
    // #given a valid user file naming this machine, and nothing else that says headless
    writeSettings()

    // #when
    const settings = resolve({}, {argv})

    // #then
    expect(settings).toEqual({mode: 'off', reason: 'headless-host'})
    expect(lines).toEqual(['tracing off (headless-host)'])
  })

  it.each([
    ['serve by hand', ['bun', '/$bunfs/root/opencode', 'serve']],
    ['serve on a port', ['bun', '/$bunfs/root/opencode', 'serve', '--port', '4096']],
    ['the background service', ['bun', '/$bunfs/root/opencode', 'serve', '--service']],
    ['no subcommand', ['bun', '/$bunfs/root/opencode']],
    ['run', ['bun', '/$bunfs/root/opencode', 'run', 'fix the build']],
    ['a path that merely contains serve', ['bun', '/home/me/serve/opencode', '--stdio']],
    ['an argument that merely contains stdio', ['bun', '/$bunfs/root/opencode', 'run', 'serve --stdio please']],
    ['an empty command line', []],
  ])('does not call %s embedded: the user file applies', (_label, argv) => {
    // #given a valid file
    writeSettings()

    // #when / #then
    expect(resolve({}, {argv})).toMatchObject({mode: 'on', host: 'local'})
  })

  it('does not change the Action launcher: `serve --stdio` is how the Action starts the server', () => {
    // #given the Action's command line and launcher
    const argv = ['bun', '/$bunfs/root/opencode', 'serve', '--stdio', '--port', '0']

    // #when / #then
    expect(resolve({[TRACING_LAUNCHER_ENV]: launcher()}, {argv})).toMatchObject({mode: 'on', host: 'action'})
  })
})

describe.skipIf(!isPosix)('local session', () => {
  it('resolves to on from a valid user file and logs only the destination host, once', () => {
    // #given a valid user file and no launcher variable or headless marker
    writeSettings({
      version: 1,
      endpoint: 'https://collector.example:4318/v1/traces?x=1',
      headers: {Authorization: 'Basic abc'},
      hosts: [HOSTNAME],
    })

    // #when settings resolve
    const settings = resolve()

    // #then it is on, header names are lowercased, and the single line names the host only
    expect(settings).toEqual({
      mode: 'on',
      host: 'local',
      endpoint: 'https://collector.example:4318/v1/traces?x=1',
      headers: {authorization: 'Basic abc'},
    })
    expect(lines).toEqual(['tracing on, destination host collector.example:4318'])
  })

  it('accepts an endpoint with no headers and plain http to a loopback literal', () => {
    // #given a loopback collector file without headers
    writeSettings({version: 1, endpoint: 'http://127.0.0.1:4318/v1/traces', hosts: [HOSTNAME]})

    // #when / #then
    expect(resolve()).toEqual({mode: 'on', host: 'local', endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {}})
  })

  it('resolves to off, silently, when there is no user file', () => {
    // #given no file at all
    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'no-settings-file'})
    expect(lines).toEqual([])
  })

  it('resolves to off, silently, when the config directory itself is missing', () => {
    // #given a HOME with no .config at all
    rmSync(configHome, {recursive: true})

    // #when / #then
    expect(resolve({XDG_CONFIG_HOME: undefined})).toEqual({mode: 'off', reason: 'no-settings-file'})
    expect(lines).toEqual([])
  })

  it('reads ~/.config when XDG_CONFIG_HOME is unset or not absolute', () => {
    // #given a file under HOME/.config
    writeSettings()

    // #when the XDG variable is unset, then relative
    // #then the same file is found
    expect(resolve({XDG_CONFIG_HOME: undefined})).toMatchObject({mode: 'on', host: 'local'})
    expect(resolve({XDG_CONFIG_HOME: 'relative/dir'})).toMatchObject({mode: 'on', host: 'local'})
  })

  it('puts the file under the user config directory, away from anything OpenCode reads', () => {
    // #given / #when
    const file = userSettingsFilePath({HOME: '/home/u', XDG_CONFIG_HOME: '/xdg'})

    // #then
    expect(file).toBe('/xdg/fro-bot/opencode-plugin/tracing.json')
    expect(userSettingsFilePath({HOME: '/home/u'})).toBe('/home/u/.config/fro-bot/opencode-plugin/tracing.json')
    expect(file).not.toContain('/opencode/')
  })

  it('resolves to off on Windows without reading anything', () => {
    // #given a valid file and a Windows platform
    writeSettings()

    // #when / #then
    expect(resolve({}, {platform: 'win32'})).toEqual({mode: 'off', reason: 'unsupported-platform'})
    expect(lines).toEqual([])
  })

  it.each([
    ['writable by the group', 0o620],
    ['writable by others', 0o602],
    ['writable by everyone', 0o666],
  ])('resolves a user file %s to off', (_label, mode) => {
    // #given a file with a write bit for group or others
    writeSettings(undefined, mode)

    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
    expect(lines).toEqual(['tracing off (settings-file-unsafe)'])
  })

  it('resolves a user file owned by another user to off', () => {
    // #given a valid file and a current user id that is not its owner
    writeSettings()

    // #when / #then
    expect(resolve({}, {uid: uid + 1})).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  it('resolves a directory in place of the file to off', () => {
    // #given a directory where the file should be
    mkdirSync(settingsFile(), {recursive: true})

    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  it('resolves a FIFO in place of the file to off, without blocking', () => {
    // #given a named pipe where the file should be
    mkdirSync(path.dirname(settingsFile()), {recursive: true})
    execFileSync('mkfifo', [settingsFile()])

    // #when / #then it is refused on the opened handle
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  it('resolves an oversized user file to off', () => {
    // #given a file one byte over the ceiling
    writeSettings(' '.repeat(MAX_SETTINGS_FILE_BYTES + 1))

    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  it('resolves a user file that resolves inside the project directory to off', () => {
    // #given the user's config directory sitting inside the project
    const inside = path.join(project, 'cfg')
    writeSettings(undefined, 0o600, userSettingsFilePath({XDG_CONFIG_HOME: inside}))

    // #when settings resolve with that config directory
    const settings = resolve({XDG_CONFIG_HOME: inside})

    // #then it is refused
    expect(settings).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  it.each(['..config', '...', '..', '..a'])(
    'refuses a user file under a project child named %s: a name that starts with two dots is still inside',
    name => {
      // #given the config directory is a project child whose name starts with two dots (`path.relative` gives `..config/...`)
      const inside = path.join(project, name === '..' ? 'x' : name)
      writeSettings(undefined, 0o600, userSettingsFilePath({XDG_CONFIG_HOME: inside}))

      // #when
      const settings = resolve({XDG_CONFIG_HOME: inside})

      // #then it is refused, as any other path inside the project is
      expect(settings).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
    },
  )

  it('still accepts a config directory beside the project whose name starts with two dots', () => {
    // #given a sibling of the project directory named `..cfg` (outside it)
    const outside = path.join(path.dirname(project), '..cfg')
    writeSettings(undefined, 0o600, userSettingsFilePath({XDG_CONFIG_HOME: outside}))

    // #when / #then
    expect(resolve({XDG_CONFIG_HOME: outside})).toMatchObject({mode: 'on', host: 'local'})
  })

  it('accepts a symlinked user file whose target passes every check', () => {
    // #given the file is a link to a safe file elsewhere in the user's home
    const target = writeSettings(undefined, 0o600, path.join(home, 'dotfiles', 'tracing.json'))
    mkdirSync(path.dirname(settingsFile()), {recursive: true})
    symlinkSync(target, settingsFile())

    // #when / #then
    expect(resolve()).toMatchObject({mode: 'on', host: 'local'})
  })

  it('checks the target of a symlinked user file, not the link', () => {
    // #given a link to a group-writable file
    const target = writeSettings(undefined, 0o664, path.join(home, 'dotfiles', 'tracing.json'))
    mkdirSync(path.dirname(settingsFile()), {recursive: true})
    symlinkSync(target, settingsFile())

    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  it('refuses a symlinked user file whose target is inside the project', () => {
    // #given a link out of the config directory into the project
    const target = writeSettings(undefined, 0o600, path.join(project, 'tracing.json'))
    mkdirSync(path.dirname(settingsFile()), {recursive: true})
    symlinkSync(target, settingsFile())

    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
  })

  // Sentinels: no setting value may reach the log line.
  it.each([
    ['malformed JSON', '{"version":1,"endpoint":"SENTINEL'],
    ['a non-object document', '"SENTINEL"'],
    ['an unknown version', {version: 9, endpoint: 'https://collector.example/v1/traces'}],
    ['no endpoint', {version: 1, headers: {a: 'SENTINEL'}}],
    ['an unknown key', {version: 1, endpoint: 'https://collector.example/v1/traces', sentinel: 'SENTINEL'}],
    ['an http endpoint to a public host', {version: 1, endpoint: 'http://203.0.113.9/v1/traces'}],
    ['an endpoint named localhost over http', {version: 1, endpoint: 'http://localhost:4318/v1/traces'}],
    ['an endpoint with userinfo', {version: 1, endpoint: 'https://user:hunter2@collector.example/v1/traces'}],
    ['an endpoint with a fragment', {version: 1, endpoint: 'https://collector.example/v1/traces#SENTINEL'}],
    ['a non-https scheme', {version: 1, endpoint: 'ftp://collector.example/SENTINEL'}],
    ['headers that are not an object', {version: 1, endpoint: 'https://collector.example/t', headers: ['SENTINEL']}],
    ['a framing header', {version: 1, endpoint: 'https://collector.example/t', headers: {'Content-Length': '1'}}],
    ['a host header', {version: 1, endpoint: 'https://collector.example/t', headers: {Host: 'SENTINEL.example'}}],
    ['a header name with a space', {version: 1, endpoint: 'https://collector.example/t', headers: {'a b': 'SENTINEL'}}],
    [
      'a header value with a newline',
      {version: 1, endpoint: 'https://collector.example/t', headers: {a: 'x\r\nSENTINEL: 1'}},
    ],
    ['an empty header value', {version: 1, endpoint: 'https://collector.example/t', headers: {a: ''}}],
    ['a non-string header value', {version: 1, endpoint: 'https://collector.example/t', headers: {a: 5}}],
    [
      'duplicate header names that differ by case',
      {version: 1, endpoint: 'https://collector.example/t', headers: {A: 'SENTINEL', a: 'SENTINEL'}},
    ],
    [
      'too many headers',
      {
        version: 1,
        endpoint: 'https://collector.example/t',
        headers: Object.fromEntries(Array.from({length: 17}, (_, index) => [`x-h${index}`, 'SENTINEL'])),
      },
    ],
  ])('resolves a user file with %s to off, logging a fixed reason and no value', (_label, content) => {
    // #given a file that is safe on disk and wrong in content, and (where it is a document) names this machine, so that
    // the one thing wrong with it is what the case says
    writeSettings(typeof content === 'object' ? {hosts: [HOSTNAME], ...content} : content)

    // #when / #then
    expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-invalid'})
    expect(lines).toEqual(['tracing off (settings-file-invalid)'])
    expect(lines.join('\n')).not.toMatch(/SENTINEL|hunter2|203\.0\.113/)
  })

  describe('the machine allow-list', () => {
    const FILE = {version: 1, endpoint: 'https://collector.example/v1/traces'}
    const on = {mode: 'on', host: 'local', endpoint: 'https://collector.example/v1/traces', headers: {}}

    it.each([
      ['the exact name', ['build-box.example.test'], 'build-box.example.test'],
      ['the name in another case', ['Build-Box.Example.TEST'], 'build-box.example.test'],
      ['the machine reporting another case', ['build-box.example.test'], 'BUILD-BOX.Example.Test'],
      ['an entry with a trailing dot', ['build-box.example.test.'], 'build-box.example.test'],
      ['a name with a trailing dot', ['build-box.example.test'], 'build-box.example.test.'],
      ['surrounding spaces in the entry', ['  build-box.example.test  '], 'build-box.example.test'],
      [
        'one of several entries',
        ['other-1', 'other-2.example.test', 'build-box.example.test'],
        'build-box.example.test',
      ],
      ['the short name, when the entry has no dot', ['build-box'], 'build-box.example.test'],
      ['a short entry with a trailing dot', ['build-box.'], 'build-box.example.test'],
      ['a short name that is the whole host name', ['build-box'], 'build-box'],
    ])('resolves to on for %s', (_label, hosts, hostname) => {
      // #given a file naming machines, and a machine
      writeSettings({...FILE, hosts})

      // #when
      const settings = resolve({}, {hostname: () => hostname})

      // #then tracing is on, and the one line names the destination, not the machine
      expect(settings).toEqual(on)
      expect(lines).toEqual(['tracing on, destination host collector.example'])
    })

    it.each([
      ['another machine', ['other-box.example.test'], 'build-box.example.test'],
      ['a name that only starts the same', ['build-box'], 'build-box-2.example.test'],
      ['a name that only ends the same', ['box.example.test'], 'build-box.example.test'],
      ['a short entry against a different short name', ['build'], 'build-box.example.test'],
      ['a dotted entry against the short name only', ['build-box.example.test'], 'build-box'],
      ['a dotted entry against another domain', ['build-box.example.test'], 'build-box.other.test'],
      ['an empty machine name', ['build-box'], ''],
      ['a machine name of only a dot', ['build-box'], '.'],
    ])('resolves to off, silently, for %s', (_label, hosts, hostname) => {
      // #given a valid file that does not name this machine
      writeSettings({...FILE, hosts})

      // #when
      const settings = resolve({}, {hostname: () => hostname})

      // #then off, with no log line: a shared file is simply not for this machine
      expect(settings).toEqual({mode: 'off', reason: 'machine-not-listed'})
      expect(lines).toEqual([])
    })

    it('does not read the machine name when the file is missing or the launcher decided', () => {
      // #given a hostname that would throw, and no file at all
      const hostname = (): string => {
        throw new Error('no hostname')
      }

      // #when / #then neither a missing file nor an Action or workspace launcher consults it
      expect(resolve({}, {hostname})).toEqual({mode: 'off', reason: 'no-settings-file'})
      writeSettings({...FILE, hosts: [HOSTNAME]})
      expect(resolve({[TRACING_LAUNCHER_ENV]: launcher()}, {hostname})).toMatchObject({mode: 'on', host: 'action'})
      expect(resolve({[TRACING_LAUNCHER_ENV]: launcher({tracing: 'off'})}, {hostname})).toEqual({
        mode: 'off',
        reason: 'action-off',
      })
      expect(
        resolve({[TRACING_LAUNCHER_ENV]: JSON.stringify({version: 1, host: 'workspace', tracing: 'off'})}, {hostname}),
      ).toEqual({
        mode: 'off',
        reason: 'workspace-host',
      })
    })

    it('resolves to off with a fixed reason when the machine name cannot be read', () => {
      // #given a valid file and a hostname lookup that throws
      writeSettings({...FILE, hosts: [HOSTNAME]})

      // #when
      const settings = resolve(
        {},
        {
          hostname: () => {
            throw new Error('SENTINEL')
          },
        },
      )

      // #then it fails closed, logging a fixed reason
      expect(settings).toEqual({mode: 'off', reason: 'settings-error'})
      expect(lines).toEqual(['tracing off (settings-error)'])
    })

    // Each of these is wrong in the file, not just about this machine: logged with a fixed reason, never a value.
    it.each([
      ['no hosts field', {...FILE}],
      ['hosts that are not an array', {...FILE, hosts: 'SENTINEL-HOST'}],
      ['hosts that are an object', {...FILE, hosts: {a: 'SENTINEL-HOST'}}],
      ['an empty hosts list', {...FILE, hosts: []}],
      ['more than 16 hosts', {...FILE, hosts: Array.from({length: 17}, (_, index) => `host-${index}.SENTINEL`)}],
      ['a non-string host', {...FILE, hosts: [HOSTNAME, 5]}],
      ['an empty host', {...FILE, hosts: [HOSTNAME, '']}],
      ['a blank host', {...FILE, hosts: [HOSTNAME, '   ']}],
      ['a host that is only a dot', {...FILE, hosts: [HOSTNAME, '.']}],
      ['a wildcard host', {...FILE, hosts: ['*.example.test']}],
      ['a partial wildcard host', {...FILE, hosts: ['build-*.SENTINEL']}],
      ['a question-mark host', {...FILE, hosts: ['build-bo?.SENTINEL']}],
      ['a host with a space inside', {...FILE, hosts: ['build box.SENTINEL']}],
      ['a host with a control character', {...FILE, hosts: ['build\nbox.SENTINEL']}],
      ['a host with a slash', {...FILE, hosts: ['build/box.SENTINEL']}],
      ['a host with a port', {...FILE, hosts: ['build-box.SENTINEL:22']}],
      ['a host over 253 characters', {...FILE, hosts: [`${'a'.repeat(254)}SENTINEL`]}],
    ])('resolves a file with %s to off, logging a fixed reason', (_label, content) => {
      // #given
      writeSettings(content)

      // #when / #then
      expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-invalid'})
      expect(lines).toEqual(['tracing off (settings-file-invalid)'])
      expect(lines.join('\n')).not.toMatch(/SENTINEL|host-0/)
    })

    it('accepts exactly 16 hosts and a 253-character name', () => {
      // #given the boundary values
      const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.com`
      expect(long.length).toBeLessThanOrEqual(253)
      const hosts = [...Array.from({length: 15}, (_, index) => `other-${index}`), long]
      writeSettings({...FILE, hosts})

      // #when / #then
      expect(resolve({}, {hostname: () => long})).toEqual(on)
    })

    it('judges the file before the machine: an invalid file is logged even on a machine it does not name', () => {
      // #given a file with a bad endpoint that also names another machine
      writeSettings({version: 1, endpoint: 'ftp://x', hosts: ['other-box']})

      // #when / #then
      expect(resolve()).toEqual({mode: 'off', reason: 'settings-file-invalid'})
    })
  })

  it('does not take settings from the project directory, whatever it holds', () => {
    // #given a project holding a settings file at the user-scope relative path, and no user file
    writeSettings(undefined, 0o600, path.join(project, '.config', 'fro-bot', 'opencode-plugin', 'tracing.json'))
    writeFileSync(
      path.join(project, 'opencode.json'),
      JSON.stringify({plugins: [{package: '@fro.bot/opencode-plugin', options: {endpoint: 'https://evil.example'}}]}),
    )

    // #when settings resolve with the user's real (empty) config directory
    const settings = resolve()

    // #then nothing in the checkout turned tracing on
    expect(settings).toEqual({mode: 'off', reason: 'no-settings-file'})
  })
})
