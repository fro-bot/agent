/**
 * Test kit for suites that exercise the BUILT `opencode` shim / `harness` cli as real processes.
 *
 * Nothing here ships: tsdown bundles from its entry points only, and this file is imported by tests alone.
 *
 * Why a build per suite: the shim runs under plain Node, where the source's `.js` import specifiers do not resolve to
 * `.ts` files. Each suite therefore builds the package into its own temp dir (no shared `dist/`, so no staleness or
 * parallel-worker races) and runs that — which is also exactly the layout that gets published.
 */

import {spawn, spawnSync, type ChildProcess} from 'node:child_process'
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

const WAIT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 10

// Behaves like a tiny `opencode`: `serve ...` prints the SDK's readiness line and stays alive; anything else echoes
// argv as JSON and exits with FIXTURE_EXIT_CODE. Compiled by `bun build --compile`, so it is a NATIVE executable that
// receives every argument verbatim (the resolver rejects `#!` scripts and node itself would eat `--version`).
const FIXTURE_SOURCE = String.raw`
import {spawnSync} from 'node:child_process'
import {appendFileSync, writeFileSync} from 'node:fs'

const env = process.env
const args = process.argv.slice(2)

function writeIfSet(key: string, value: string): void {
  const target = env[key]
  if (target !== undefined && target !== '') writeFileSync(target, value)
}

if (args[0] === 'serve') {
  const portArg = args.find(arg => arg.startsWith('--port='))
  const port = portArg === undefined ? '4096' : portArg.slice('--port='.length)
  const receiptsPath = env.FIXTURE_RECEIPTS
  if (env.FIXTURE_RECORD_SIGNALS === '1' && receiptsPath !== undefined) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'] as const) {
      process.on(sig, () => {
        appendFileSync(receiptsPath, sig + '\n')
        // Linger so a duplicate delivery would land (and be recorded) before the process is gone.
        setTimeout(() => process.exit(0), 300)
      })
    }
  }
  setInterval(() => {}, 1000)
  writeIfSet('FIXTURE_PID', String(process.pid))
  console.log('opencode server listening on http://127.0.0.1:' + port)
  writeIfSet('FIXTURE_READY', 'ready')
} else if (env.FIXTURE_NESTED_SHIM !== undefined && env.FIXTURE_NODE !== undefined) {
  // Behaves like a tool that launches \`opencode\` again from somewhere else: runs the shim from a different cwd,
  // with the environment this process received.
  const nestedEnv = {...env}
  delete nestedEnv.FIXTURE_NESTED_SHIM
  const nested = spawnSync(env.FIXTURE_NODE, [env.FIXTURE_NESTED_SHIM, 'inner'], {cwd: '/', env: nestedEnv, stdio: 'inherit'})
  process.exit(nested.status ?? 1)
} else if (env.FIXTURE_PRINT_ENV === '1') {
  console.log(JSON.stringify({OPENCODE_PATH: env.OPENCODE_PATH ?? null}))
} else {
  console.log(JSON.stringify(args))
  process.exit(Number.parseInt(env.FIXTURE_EXIT_CODE ?? '0', 10))
}
`

export interface StagedPackage {
  /** Root of the staged package (contains package.json, dist/, harness.config.json). */
  readonly dir: string
  readonly opencodeEntry: string
  readonly cliEntry: string
}

/** A throwaway directory; the caller removes it. */
export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function removeDir(dir: string): void {
  rmSync(dir, {recursive: true, force: true})
}

function runOrThrow(
  command: string,
  args: readonly string[],
  options: {cwd?: string; env?: NodeJS.ProcessEnv},
): string {
  const result = spawnSync(command, [...args], {encoding: 'utf8', ...options})
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (status ${String(result.status)}): ` +
        `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`,
    )
  }
  return result.stdout
}

/**
 * Build the harness package with tsdown into `<root>/pkg/dist` and stage the files a published package carries
 * around it. Fails loudly: a suite that needs the build must never skip because it is missing.
 */
export function stageHarnessPackage(root: string): StagedPackage {
  const dir = path.join(root, 'pkg')
  mkdirSync(dir, {recursive: true})
  runOrThrow('bun', ['x', 'tsdown', '--out-dir', path.join(dir, 'dist')], {cwd: PACKAGE_ROOT})
  for (const file of ['package.json', 'LICENSE', 'harness.config.json']) {
    copyFileSync(path.join(PACKAGE_ROOT, file), path.join(dir, file))
  }
  return {
    dir,
    opencodeEntry: path.join(dir, 'dist', 'opencode.mjs'),
    cliEntry: path.join(dir, 'dist', 'cli.mjs'),
  }
}

/** Compile the fixture into a native executable at `<root>/fixture-opencode`. */
export function compileFixtureBinary(root: string): string {
  const source = path.join(root, 'fixture-opencode.ts')
  const output = path.join(root, 'fixture-opencode')
  writeFileSync(source, FIXTURE_SOURCE)
  runOrThrow('bun', ['build', '--compile', source, '--outfile', output], {})
  return output
}

/** A symlink to the system shell: a native binary that runs whatever `-c` script the test passes through the shim. */
export function linkNativeShell(root: string): string {
  const link = path.join(root, 'native-sh')
  symlinkSync('/bin/sh', link)
  return link
}

// --- waiting / reaping ---------------------------------------------------------------------------------------------

export async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (predicate() === false) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await new Promise<void>(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

export function readPid(file: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, 'utf8'), 10)
    return Number.isNaN(pid) ? undefined : pid
  } catch {
    return undefined
  }
}

export function fileExists(file: string): boolean {
  try {
    readFileSync(file)
    return true
  } catch {
    return false
  }
}

export function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** SIGKILL a pid recorded by a fixture, ignoring "already gone". */
export function reapPidFile(file: string): void {
  const pid = readPid(file)
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

// --- running the shim ------------------------------------------------------------------------------------------------

export interface ExitInfo {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface RunningProcess {
  readonly proc: ChildProcess
  readonly stdout: () => string
  readonly stderr: () => string
  readonly exited: Promise<ExitInfo>
  readonly hasExited: () => boolean
}

/** Spawn `node <entry> <args>` with piped stdio and capture its output. Callers reap via {@link killProcess}. */
export function startNodeEntry(
  entry: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: 'ignore' | 'pipe' = 'ignore',
  cwd?: string,
): RunningProcess {
  const proc = spawn(process.execPath, [entry, ...args], {env, cwd, stdio: [stdin, 'pipe', 'pipe']})
  let out = ''
  let err = ''
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    out += chunk
  })
  proc.stderr?.on('data', (chunk: string) => {
    err += chunk
  })
  let done = false
  const exited = new Promise<ExitInfo>((resolve, reject) => {
    proc.once('error', reject)
    proc.once('close', (code, signal) => {
      done = true
      resolve({code, signal})
    })
  })
  return {proc, stdout: () => out, stderr: () => err, exited, hasExited: () => done}
}

/** Unconditional reap: SIGKILL if still running, then wait for the exit event (bounded). */
export async function killProcess(running: RunningProcess): Promise<void> {
  if (running.hasExited() === false) {
    running.proc.kill('SIGKILL')
    await Promise.race([running.exited, new Promise<void>(resolve => setTimeout(resolve, WAIT_TIMEOUT_MS))])
  }
}

/** Race a promise against a bounded wait so a hang fails the test instead of the run. */
export async function withTimeout<T>(description: string, promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** An environment for spawning the shim: the current one, minus anything that could steer resolution, plus overrides. */
export function cleanEnv(overrides: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env}
  delete env.OPENCODE_PATH
  delete env.HARNESS_ALLOW_PATH_FALLBACK
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}
