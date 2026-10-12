import {spawnSync} from 'node:child_process'
import {lstatSync, mkdirSync, readdirSync, realpathSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {afterAll, beforeAll, describe, expect, it} from 'vitest'

import {
  cleanEnv,
  compileFixtureBinary,
  makeTempDir,
  removeDir,
  stageHarnessPackage,
  startNodeEntry,
  withTimeout,
} from './shim-test-kit.js'

// Mandatory packaging smoke (never skipped): the package.json `bin` map and the built output are only proven by
// installing a real `npm pack` tarball the way users do, with lifecycle scripts off (mise's npm backend and Bun both
// skip them by default, so the JS shim is the code that actually runs), and calling the installed `opencode`.
//
// No registry is involved: the staged package has no dependencies (the publish step adds the platform
// optionalDependencies), so installing the tarball is fully offline.

let root: string
let tarball: string
let fixture: string
let npmPrefix: string

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): string {
  const result = spawnSync(command, [...args], {encoding: 'utf8', env, cwd, timeout: 120_000})
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (status ${String(result.status)}): ` +
        `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout
}

beforeAll(() => {
  root = makeTempDir('harness-pack-')
  const staged = stageHarnessPackage(root)
  fixture = compileFixtureBinary(root)

  const packDir = path.join(root, 'packed')
  mkdirSync(packDir)
  run('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], process.env, staged.dir)
  const files = readdirSync(packDir).filter(name => name.endsWith('.tgz'))
  if (files.length !== 1) throw new Error(`Expected exactly one tarball in ${packDir}, found: ${files.join(', ')}`)
  tarball = path.join(packDir, files[0] as string)

  npmPrefix = path.join(root, 'npm-prefix')
  run(
    'npm',
    ['install', '-g', '--prefix', npmPrefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    process.env,
  )
}, 180_000)

afterAll(() => {
  removeDir(root)
})

async function runInstalledOpencode(binPath: string, args: readonly string[], overrides: Record<string, string>) {
  const shim = startNodeEntry(binPath, args, cleanEnv(overrides))
  try {
    const exit = await withTimeout('installed opencode exit', shim.exited)
    return {exit, stdout: shim.stdout(), stderr: shim.stderr()}
  } finally {
    if (shim.hasExited() === false) shim.proc.kill('SIGKILL')
  }
}

describe('packed @fro.bot/harness, installed with lifecycle scripts disabled', () => {
  it('npm install -g links both bins, and the installed opencode reaches the native binary', async () => {
    // #given the tarball installed into an isolated global prefix (beforeAll)
    const prefix = npmPrefix

    // #when the installed `opencode` runs with OPENCODE_PATH aimed at the fixture
    const opencode = path.join(prefix, 'bin', 'opencode')
    const result = await runInstalledOpencode(opencode, ['--version'], {OPENCODE_PATH: fixture})

    // #then it is a link into the installed package, and the call reached the fixture with argv intact
    expect(lstatSync(opencode).isSymbolicLink()).toBe(true)
    expect(realpathSync(opencode)).toBe(
      realpathSync(path.join(prefix, 'lib', 'node_modules', '@fro.bot', 'harness', 'dist', 'opencode.mjs')),
    )
    expect(lstatSync(path.join(prefix, 'bin', 'harness')).isSymbolicLink()).toBe(true)
    expect(result.exit).toEqual({code: 0, signal: null})
    expect(JSON.parse(result.stdout) as string[]).toEqual(['--version'])
  })

  it('npm install -g: the installed opencode refuses OPENCODE_PATH pointing back at itself', async () => {
    // #given the isolated global prefix
    const opencode = path.join(npmPrefix, 'bin', 'opencode')

    // #when the installed shim is told its own bin link is the binary
    const result = await runInstalledOpencode(opencode, ['--version'], {OPENCODE_PATH: opencode})

    // #then it exits 127 instead of recursing
    expect(result.exit.code).toBe(127)
    expect(result.stderr).toContain('points back at a harness entry point')
  })

  it('npm install -g: without a platform package or override it fails closed', async () => {
    // #given the global prefix (the staged package has no platform optionalDependency)
    const opencode = path.join(npmPrefix, 'bin', 'opencode')

    // #when the installed opencode runs with no override
    const result = await runInstalledOpencode(opencode, ['--version'], {})

    // #then it exits non-zero with remediation and no stock fallback
    expect(result.exit.code).toBe(127)
    expect(result.stderr).toContain('OPENCODE_PATH')
    expect(result.stdout).toBe('')
  })

  it('project-local npm install (the node_modules/.bin layout mise uses) reaches the native binary', async () => {
    // #given the tarball installed under a plain prefix, as mise's npm backend lays out a tool
    const prefix = path.join(root, 'npm-local')
    mkdirSync(prefix)
    run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], process.env)

    // #when node_modules/.bin/opencode runs
    const result = await runInstalledOpencode(path.join(prefix, 'node_modules', '.bin', 'opencode'), ['info'], {
      OPENCODE_PATH: fixture,
    })

    // #then the fixture saw the argument
    expect(result.exit).toEqual({code: 0, signal: null})
    expect(JSON.parse(result.stdout) as string[]).toEqual(['info'])
  })

  it('bun add -g links both bins, and the installed opencode reaches the native binary', async () => {
    // #given the tarball installed with Bun into an isolated BUN_INSTALL
    const bunInstall = path.join(root, 'bun-install')
    const bunEnv = cleanEnv({BUN_INSTALL: bunInstall, BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache')})
    run('bun', ['add', '-g', tarball], bunEnv)

    // #when the installed `opencode` runs
    const opencode = path.join(bunInstall, 'bin', 'opencode')
    const result = await runInstalledOpencode(opencode, ['--version'], {OPENCODE_PATH: fixture})

    // #then both bins exist and the call reached the fixture
    expect(lstatSync(path.join(bunInstall, 'bin', 'harness')).isSymbolicLink()).toBe(true)
    expect(result.exit).toEqual({code: 0, signal: null})
    expect(JSON.parse(result.stdout) as string[]).toEqual(['--version'])
  })

  // mise's `npm:` backend installs from a registry, never from a local tarball, so this suite cannot drive it offline.
  // The project-local npm layout above is the closest offline proxy; mise itself stays a manual check (see the plan).
  it.todo('mise npm: backend (registry-only; verified manually, not by this suite)')
})
