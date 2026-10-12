import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest'

import {
  cleanEnv,
  compileFixtureBinary,
  fileExists,
  isGone,
  killProcess,
  linkNativeShell,
  makeTempDir,
  readPid,
  reapPidFile,
  removeDir,
  stageHarnessPackage,
  startNodeEntry,
  waitFor,
  withTimeout,
  type RunningProcess,
  type StagedPackage,
} from './shim-test-kit.js'

// The suite builds the package and a native fixture once, then drives the real entry points as processes.
let root: string
let staged: StagedPackage
let fixture: string
let nativeShell: string

const running: RunningProcess[] = []
const pidFiles: string[] = []

beforeAll(() => {
  root = makeTempDir('harness-shim-')
  staged = stageHarnessPackage(root)
  fixture = compileFixtureBinary(root)
  nativeShell = linkNativeShell(root)
}, 120_000)

afterEach(async () => {
  for (const file of pidFiles.splice(0)) reapPidFile(file)
  await Promise.all(running.splice(0).map(killProcess))
})

afterAll(() => {
  removeDir(root)
})

function start(
  entry: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
  cwd?: string,
): RunningProcess {
  const proc = startNodeEntry(entry, args, cleanEnv(env), 'ignore', cwd)
  running.push(proc)
  return proc
}

/** Per-test paths the serve fixture reports through. */
function serveFiles(name: string): {ready: string; pid: string; receipts: string} {
  const files = {
    ready: path.join(root, `${name}.ready`),
    pid: path.join(root, `${name}.pid`),
    receipts: path.join(root, `${name}.receipts`),
  }
  pidFiles.push(files.pid)
  return files
}

function serveEnv(files: {ready: string; pid: string; receipts: string}, record: boolean): Record<string, string> {
  return {
    OPENCODE_PATH: fixture,
    FIXTURE_READY: files.ready,
    FIXTURE_PID: files.pid,
    FIXTURE_RECEIPTS: files.receipts,
    FIXTURE_RECORD_SIGNALS: record ? '1' : '0',
  }
}

describe('built layout', () => {
  it('emits a bin with a node shebang and the exec bit for both commands', () => {
    // #given the staged build
    // #when reading the entry points
    const opencode = readFileSync(staged.opencodeEntry, 'utf8')
    const cli = readFileSync(staged.cliEntry, 'utf8')

    // #then both start with the node shebang and are executable
    expect(opencode.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(cli.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(statSync(staged.opencodeEntry).mode & 0o111).not.toBe(0)
    expect(statSync(staged.cliEntry).mode & 0o111).not.toBe(0)
  })
})

describe('opencode shim: argv and exit passthrough', () => {
  it('passes every argument through unchanged, including would-be subcommands', async () => {
    // #given an argv-echo fixture behind OPENCODE_PATH
    const args = ['--version', 'info', 'doctor', 'upgrade', '--help', '-h', '--', '--port=1', 'two words', '']

    // #when the shim runs with those arguments
    const shim = start(staged.opencodeEntry, args, {OPENCODE_PATH: fixture})
    const exit = await withTimeout('shim exit', shim.exited)

    // #then the fixture saw exactly them, and nothing was reserved or consumed
    expect(exit).toEqual({code: 0, signal: null})
    expect(JSON.parse(shim.stdout()) as string[]).toEqual(args)
  })

  it("propagates the child's exit code", async () => {
    // #given a fixture that exits 3
    // #when the shim runs it
    const shim = start(staged.opencodeEntry, ['x'], {OPENCODE_PATH: fixture, FIXTURE_EXIT_CODE: '3'})

    // #then the shim exits 3
    expect(await withTimeout('shim exit', shim.exited)).toEqual({code: 3, signal: null})
  })

  it('hands the child an absolute OPENCODE_PATH even when the override was relative', async () => {
    // #given a RELATIVE OPENCODE_PATH, resolved against the shim's cwd
    const relative = `./${path.basename(fixture)}`

    // #when the shim runs a fixture that reports the OPENCODE_PATH it received
    const shim = start(
      staged.opencodeEntry,
      [],
      {OPENCODE_PATH: relative, FIXTURE_PRINT_ENV: '1'},
      path.dirname(fixture),
    )
    const exit = await withTimeout('shim exit', shim.exited)

    // #then the child saw the absolute path, not the relative spelling
    expect(exit).toEqual({code: 0, signal: null})
    // (macOS reports the cwd through its realpath: /var → /private/var)
    expect(JSON.parse(shim.stdout())).toEqual({OPENCODE_PATH: realpathSync(fixture)})
  })

  it('lets a nested shim started from another cwd resolve the same file', async () => {
    // #given a relative override and a child that launches the shim again from `/`
    const relative = `./${path.basename(fixture)}`

    // #when the outer shim runs it
    const shim = start(
      staged.opencodeEntry,
      [],
      {OPENCODE_PATH: relative, FIXTURE_NESTED_SHIM: staged.opencodeEntry, FIXTURE_NODE: process.execPath},
      path.dirname(fixture),
    )
    const exit = await withTimeout('shim exit', shim.exited)

    // #then the inner shim reached the same fixture (a relative path would not exist from `/`)
    expect(exit).toEqual({code: 0, signal: null})
    expect(JSON.parse(shim.stdout()) as string[]).toEqual(['inner'])
  })

  it('does not invent OPENCODE_PATH when the binary was not selected by it', async () => {
    // #given the PATH fallback resolves the fixture and OPENCODE_PATH is unset
    const walkDir = path.join(root, 'walk-bin')
    mkdirSync(walkDir, {recursive: true})
    copyFileSync(fixture, path.join(walkDir, 'opencode'))
    const shim = start(staged.opencodeEntry, [], {
      HARNESS_ALLOW_PATH_FALLBACK: '1',
      PATH: walkDir,
      FIXTURE_PRINT_ENV: '1',
    })

    // #then the child sees no OPENCODE_PATH
    const exit = await withTimeout('shim exit', shim.exited)
    expect(exit).toEqual({code: 0, signal: null})
    expect(JSON.parse(shim.stdout())).toEqual({OPENCODE_PATH: null})
  })

  it('exits 128 + SIGPIPE when the child dies by SIGPIPE', async () => {
    // #given a native shell as OPENCODE_PATH, asked to kill itself with SIGPIPE
    const args = ['-c', 'kill -s PIPE $$']

    // #when the shim runs it
    const shim = start(staged.opencodeEntry, args, {OPENCODE_PATH: nativeShell})
    const exit = await withTimeout('shim exit', shim.exited)

    // #then the shim exits with the shell convention for that signal (Node ignores SIGPIPE, so it cannot re-raise)
    expect(exit).toEqual({code: 128 + os.constants.signals.SIGPIPE, signal: null})
  })
})

describe('harness passthrough', () => {
  it('forwards a non-reserved command to the binary and propagates its exit code', async () => {
    // #given an echo fixture that exits 7
    // #when harness gets an argument it does not own
    const harness = start(staged.cliEntry, ['upgrade', '--flag'], {OPENCODE_PATH: fixture, FIXTURE_EXIT_CODE: '7'})
    const exit = await withTimeout('harness exit', harness.exited)

    // #then the fixture received it and its exit code came back
    expect(exit).toEqual({code: 7, signal: null})
    expect(JSON.parse(harness.stdout()) as string[]).toEqual(['upgrade', '--flag'])
  })

  it('keeps `info` harness-owned and never reaches the binary', async () => {
    // #given an echo fixture that would print JSON and exit 9 if it ran
    // #when harness runs its reserved `info` subcommand
    const harness = start(staged.cliEntry, ['info'], {OPENCODE_PATH: fixture, FIXTURE_EXIT_CODE: '9'})
    const exit = await withTimeout('harness exit', harness.exited)

    // #then harness printed its own provenance
    expect(exit).toEqual({code: 0, signal: null})
    expect(harness.stdout()).toContain('harness (patched OpenCode)')
  })

  it('reports a missing binary with exit 127 and remediation', async () => {
    // #given no override and no platform package next to the staged build
    // #when harness passes a command through
    const harness = start(staged.cliEntry, ['serve'], {})
    const exit = await withTimeout('harness exit', harness.exited)

    // #then it fails closed with the harness label
    expect(exit.code).toBe(127)
    expect(harness.stderr()).toContain('[harness] Platform binary not found')
  })

  it('forwards SIGTERM to the child and dies by SIGTERM itself', async () => {
    // #given harness running a serve fixture
    const files = serveFiles('harness-term')
    const harness = start(staged.cliEntry, ['serve'], serveEnv(files, false))
    await waitFor('fixture ready', () => fileExists(files.ready))

    // #when a real SIGTERM is sent to harness
    harness.proc.kill('SIGTERM')
    const exit = await withTimeout('harness exit', harness.exited)

    // #then the child (no handler) died by SIGTERM, which harness re-raised
    expect(exit).toEqual({code: null, signal: 'SIGTERM'})
  })
})

describe('opencode shim: signals', () => {
  it('forwards SIGTERM to the child; the child dies by SIGTERM and so does the shim', async () => {
    // #given the shim running a serve fixture with default signal dispositions (the SDK `proc.kill()` path)
    const files = serveFiles('term-default')
    const shim = start(staged.opencodeEntry, ['serve', '--port=4999'], serveEnv(files, false))
    await waitFor('fixture ready', () => fileExists(files.ready))
    const childPid = readPid(files.pid)
    expect(childPid).toBeDefined()

    // #when a real SIGTERM is sent to the shim only
    shim.proc.kill('SIGTERM')
    const exit = await withTimeout('shim exit', shim.exited)

    // #then the shim re-raised SIGTERM (so the child must have died by it) and left no child behind
    expect(exit).toEqual({code: null, signal: 'SIGTERM'})
    await waitFor('child to be gone', () => isGone(childPid as number))
  })

  it('delivers a PID-directed signal exactly once and exits with the code of a child that handled it', async () => {
    // #given a fixture that records signals, handles them and exits 0 after lingering
    const files = serveFiles('term-handled')
    const shim = start(staged.opencodeEntry, ['serve'], serveEnv(files, true))
    await waitFor('fixture ready', () => fileExists(files.ready))

    // #when SIGUSR2 (not re-raisable) is sent to the shim
    shim.proc.kill('SIGUSR2')
    const exit = await withTimeout('shim exit', shim.exited)

    // #then the child received it once and its clean exit is the shim's exit
    expect(exit).toEqual({code: 0, signal: null})
    expect(readFileSync(files.receipts, 'utf8')).toBe('SIGUSR2\n')
  })
})

describe('opencode shim: resolution failures', () => {
  it('exits 127 with remediation, and never runs a stock opencode from PATH', async () => {
    // #given no override, no platform package, and a decoy native `opencode` first on PATH
    const decoyDir = path.join(root, 'decoy-bin')
    const decoy = path.join(decoyDir, 'opencode')
    mkdirSync(decoyDir, {recursive: true})
    copyFileSync(fixture, decoy)

    // #when the shim runs
    const shim = start(staged.opencodeEntry, ['--version'], {
      PATH: `${decoyDir}${path.delimiter}${process.env.PATH ?? ''}`,
    })
    const exit = await withTimeout('shim exit', shim.exited)

    // #then it fails with remediation naming the platform package and the override, and the decoy never ran
    expect(exit.code).toBe(127)
    expect(shim.stderr()).toContain('[opencode] Platform binary not found')
    expect(shim.stderr()).toContain('@fro.bot/harness-')
    expect(shim.stderr()).toContain('OPENCODE_PATH')
    expect(shim.stdout()).toBe('')
  })

  it('exits 126 when OPENCODE_PATH is not executable', async () => {
    // #given a regular file without an exec bit
    const plain = path.join(root, 'not-exec')
    writeFileSync(plain, 'data')
    chmodSync(plain, 0o644)

    // #when the shim runs
    const shim = start(staged.opencodeEntry, ['--version'], {OPENCODE_PATH: plain})

    // #then it reports a permission problem
    expect((await withTimeout('shim exit', shim.exited)).code).toBe(126)
    expect(shim.stderr()).toContain('[opencode]')
  })

  it('refuses to exec itself through an OPENCODE_PATH symlink', async () => {
    // #given OPENCODE_PATH pointing at the shim through a symlink (the npm/bun `.bin` layout)
    const link = path.join(root, 'opencode-link')
    symlinkSync(staged.opencodeEntry, link)

    // #when the shim runs
    const shim = start(staged.opencodeEntry, ['--version'], {OPENCODE_PATH: link})
    const exit = await withTimeout('shim exit', shim.exited)

    // #then it fails fast instead of recursing
    expect(exit.code).toBe(127)
    expect(shim.stderr()).toContain('points back at a harness entry point')
  })

  it('prints the opencode label, not the harness label', async () => {
    // #given a missing override target
    // #when the shim runs
    const shim = start(staged.opencodeEntry, [], {OPENCODE_PATH: path.join(root, 'does-not-exist')})
    await withTimeout('shim exit', shim.exited)

    // #then the diagnostic carries no doubled prefix
    expect(shim.stderr().startsWith('[opencode] OPENCODE_PATH')).toBe(true)
    expect(shim.stderr()).not.toContain('[harness]')
  })
})
