import type {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import {chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {createServer, type Server} from 'node:http'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {FRO_BOT_PLUGIN_VERSION} from '@fro-bot/runtime'
import {afterAll, beforeAll, expect, it} from 'vitest'
import {getPlatformInfo, RECORDED_V2_PIN, resolveStockV2Policy} from './services/setup/opencode.js'
import {pluginCacheDir, resolvePluginSpecsV2} from './services/setup/plugin-install-v2.js'
import {DEFAULT_OPENCODE_VERSION, DEFAULT_SYSTEMATIC_VERSION} from './shared/constants.js'

// The fake `opencode` binaries report this version. Setup runs on every invocation, so the bundle needs an install it can
// find without a download: `seedHermeticSetup` plants one in the tool cache under the digest-bound name setup looks up.
const MOCK_OPENCODE_VERSION = DEFAULT_OPENCODE_VERSION
/** A V2 version one minor above the pin, so it never equals the pin whatever Renovate moves it to. */
const NON_PIN_V2_VERSION = DEFAULT_OPENCODE_VERSION.replace(
  /^(\d+)\.(\d+)\..*$/,
  (_match, major: string, minor: string) => `${major}.${Number(minor) + 1}.0`,
)

// Isolated temp directories for test data and mock tools
let testDataDir: string
let mockBinDir: string
// Stands in for the services setup talks to, so the bundled Action completes setup offline and fast: the Actions cache
// (a lookup answers "no entry", 204; without a reachable service the cache client retries with backoff for longer than
// these tests run) and the GitHub API (the bot identity lookups behind gh auth and the git identity).
let runnerServices: Server
let runnerServicesUrl = ''

beforeAll(async () => {
  runnerServices = createServer((request, response) => {
    const url = request.url ?? ''
    if (url.startsWith('/user') || url.startsWith('/users/')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({login: 'fro-bot[bot]', id: 4242, type: 'Bot'}))
      return
    }
    response.statusCode = 204
    response.end()
  })
  await new Promise<void>(resolve => runnerServices.listen(0, '127.0.0.1', resolve))
  const address = runnerServices.address()
  if (address === null || typeof address === 'string') throw new Error('runner services stand-in did not bind a port')
  runnerServicesUrl = `http://127.0.0.1:${String(address.port)}`

  testDataDir = mkdtempSync(path.join(tmpdir(), 'fro-bot-test-'))
  mockBinDir = mkdtempSync(path.join(tmpdir(), 'fro-bot-mock-bin-'))

  // Create mock opencode binary that responds to --version
  mkdirSync(path.join(testDataDir, 'home'), {recursive: true})
  seedHermeticSetup()

  const mockOpenCode = path.join(mockBinDir, 'opencode')
  // MOCK_OPENCODE_LOG, when set, records every invocation, so a test can prove the binary was never executed.
  writeFileSync(
    mockOpenCode,
    `#!/bin/sh\nif [ -n "$MOCK_OPENCODE_LOG" ]; then echo "$@" >> "$MOCK_OPENCODE_LOG"; fi\necho "OpenCode \${MOCK_OPENCODE_VERSION:-${MOCK_OPENCODE_VERSION}}"`,
    'utf8',
  )
  chmodSync(mockOpenCode, 0o755)

  // `gh auth login --with-token` would otherwise validate the fake token against github.com. The stub must drain stdin:
  // setup writes the token to it, and a stub that exits first breaks the pipe. On Linux that surfaces as an unhandled
  // EPIPE on the child's stdin, which crashes the Action with exit 1 on a large share of runs.
  const mockGh = path.join(mockBinDir, 'gh')
  writeFileSync(mockGh, '#!/bin/sh\ncat >/dev/null\nexit 0\n', 'utf8')
  chmodSync(mockGh, 0o755)
})

afterAll(async () => {
  await new Promise<void>(resolve => runnerServices.close(() => resolve()))
  rmSync(testDataDir, {recursive: true, force: true})
  rmSync(mockBinDir, {recursive: true, force: true})
})

/**
 * The Action always runs setup, which restores OpenCode from the runner tool cache when the digest-bound entry is
 * there. Plant that entry (a script that reports the pin) and both plugin cache directories, so the bundled Action
 * under test completes setup offline instead of downloading a release.
 */
function seedHermeticSetup(): void {
  const {cacheVersion} = resolveStockV2Policy(DEFAULT_OPENCODE_VERSION, getPlatformInfo(), RECORDED_V2_PIN)
  const {arch} = getPlatformInfo()
  const versionDir = path.join(toolCacheDir(), 'opencode', cacheVersion)
  const installDir = path.join(versionDir, arch)
  mkdirSync(installDir, {recursive: true})
  const binary = path.join(installDir, 'opencode')
  writeFileSync(binary, `#!/bin/sh\necho "opencode v${DEFAULT_OPENCODE_VERSION}"`, 'utf8')
  chmodSync(binary, 0o755)
  writeFileSync(`${installDir}.complete`, '', 'utf8')

  const specs = resolvePluginSpecsV2(DEFAULT_SYSTEMATIC_VERSION)
  if (!specs.success) throw new Error(specs.error.message)
  for (const spec of specs.data.specs) {
    const dir = pluginCacheDir(path.join(testDataDir, 'xdg-cache'), spec)
    mkdirSync(dir, {recursive: true})
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: spec, version: FRO_BOT_PLUGIN_VERSION}), 'utf8')
  }
}

function toolCacheDir(): string {
  return path.join(testDataDir, 'toolcache')
}

function isolatedHomeEnv(): Record<string, string> {
  return {
    HOME: path.join(testDataDir, 'home'),
    XDG_CONFIG_HOME: path.join(testDataDir, 'xdg-config'),
    XDG_DATA_HOME: testDataDir,
    XDG_STATE_HOME: path.join(testDataDir, 'xdg-state'),
    XDG_CACHE_HOME: path.join(testDataDir, 'xdg-cache'),
    RUNNER_TOOL_CACHE: toolCacheDir(),
    ACTIONS_CACHE_URL: `${runnerServicesUrl}/`,
    ACTIONS_RUNTIME_TOKEN: 'test-runtime-token',
  }
}

const projectRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const distMainPath = path.join(projectRoot, 'dist', 'main.js')
const MAIN_CHILD_TIMEOUT_MS = 10_000

function assertDistBundle(): void {
  if (existsSync(distMainPath)) return
  throw new Error('dist/main.js is missing. Run bun run build to generate the action bundle before testing.')
}

/**
 * Spawn node with the given arguments, returning stdout/stderr.
 * Uses spawn instead of exec to avoid shell escaping issues with
 * environment variable names containing hyphens.
 *
 * The child runs the real bundled Action, which writes into the OpenCode config dir (the task-reuse guard) and data
 * dir, so HOME and every XDG dir point inside testDataDir: it must never touch the developer's real home.
 */
async function runNode(
  args: readonly string[],
  env: Record<string, string>,
  timeoutMs = MAIN_CHILD_TIMEOUT_MS,
): Promise<{stdout: string; stderr: string; code: number | null}> {
  return new Promise((resolve, reject) => {
    // Prepend mock bin dir to PATH so opencode is found
    const pathEnv = mockBinDir + path.delimiter + (process.env.PATH ?? '')

    const child = spawn(process.execPath, args, {
      env: {...process.env, ...env, ...isolatedHomeEnv(), PATH: pathEnv},
      cwd: projectRoot,
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const settle = (callback: () => void): void => {
      if (settled === true) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      callback()
    }

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('error', error => settle(() => reject(error)))
    child.on('close', code => {
      settle(() => resolve({stdout, stderr, code}))
    })
    timeout = setTimeout(() => {
      if (settled === true) return
      child.kill('SIGKILL')
      settle(() => {
        reject(new Error(`Child process timed out after ${timeoutMs}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      })
    }, timeoutMs)
  })
}

async function runMain(
  env: Record<string, string>,
  timeoutMs = MAIN_CHILD_TIMEOUT_MS,
): Promise<{stdout: string; stderr: string; code: number | null}> {
  assertDistBundle()

  const importTarget = pathToFileURL(distMainPath).href
  return runNode(
    ['--input-type=module', '-e', `import(${JSON.stringify(importTarget)});`],
    {
      'INPUT_OPENCODE-VERSION': MOCK_OPENCODE_VERSION,
      ...env,
      GITHUB_API_URL: runnerServicesUrl,
    },
    timeoutMs,
  )
}

// Setup now runs in the child on every invocation (offline, from the seeded cache), so allow for a loaded machine.
it('runs successfully with valid inputs', {timeout: 15000}, async () => {
  // Use 'push' event so routing skips — avoids unconditional bootstrap in test env
  const eventPayload = {ref: 'refs/heads/main'}
  const eventFile = path.join(testDataDir, 'push-event.json')
  writeFileSync(eventFile, JSON.stringify(eventPayload), 'utf8')

  const {stdout, stderr, code} = await runMain({
    'INPUT_GITHUB-TOKEN': 'ghp_test123',
    'INPUT_AUTH-JSON': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    'INPUT_SESSION-RETENTION': '50',
    GITHUB_OUTPUT: '/dev/null',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '12345',
    RUNNER_OS: 'Linux',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_EVENT_PATH: eventFile,
    SKIP_CACHE: 'true',
    SKIP_AGENT_EXECUTION: 'true',
  })

  // The message carries the child's output, so a non-zero exit explains itself instead of a bare `expected 1 to be 0`.
  expect(code, `child exited with code ${String(code)}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0)
  expect(stdout).toContain('Starting Fro Bot Agent')
})

it('fails gracefully with missing required inputs', async () => {
  // Missing INPUT_GITHUB-TOKEN and INPUT_AUTH-JSON should cause failure
  const {code} = await runMain({
    GITHUB_OUTPUT: '/dev/null',
  })

  expect(code).not.toBe(0)
})

it('fails when server bootstrap fails', {timeout: 15000}, async () => {
  // For workflow_dispatch, routing proceeds (has prompt) and acknowledge is no-op (no commentId/issueNumber)
  // The mock binary cannot start an SDK server → bootstrap fails → exit code 1
  const eventPayload = {inputs: {}}
  const eventFile = path.join(testDataDir, 'event.json')
  writeFileSync(eventFile, JSON.stringify(eventPayload), 'utf8')

  const {stdout, code} = await runMain({
    'INPUT_GITHUB-TOKEN': 'ghp_test123',
    'INPUT_AUTH-JSON': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    INPUT_PROMPT: 'test task',
    GITHUB_OUTPUT: '/dev/null',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '12345',
    RUNNER_OS: 'Linux',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_ACTOR: 'testuser',
    GITHUB_WORKSPACE: testDataDir,
    SKIP_CACHE: 'true',
  })

  expect(code).not.toBe(0)
  expect(stdout).toContain('bootstrap')
})

it('rejects a V1 opencode-version at input parsing, naming the value and the way back', async () => {
  // #given a workflow that still pins a V1 harness build
  const {stdout, stderr, code} = await runMain({
    'INPUT_GITHUB-TOKEN': 'ghp_test123',
    'INPUT_AUTH-JSON': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    'INPUT_OPENCODE-VERSION': '1.19.5+harness.bf7f7dfe',
    GITHUB_OUTPUT: '/dev/null',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '12345',
    RUNNER_OS: 'Linux',
    GITHUB_EVENT_NAME: 'push',
    SKIP_CACHE: 'true',
  })

  // #then the Action fails at parsing with the named error, before any setup or download
  expect(code).not.toBe(0)
  const output = `${stdout}\n${stderr}`
  expect(output).toContain("Input 'opencode-version'")
  expect(output).toContain('1.19.5+harness.bf7f7dfe')
  expect(output).toContain('no longer runs')
  expect(output).not.toContain('Downloading OpenCode')
})

it('never reaches a pre-installed non-pin V2 binary: the version is refused at parsing', async () => {
  // #given a non-pin V2 binary on PATH and a workflow that asks for exactly that version, which the Action would
  // otherwise reuse before setup could apply the pin policy
  const logFile = path.join(testDataDir, 'non-pin-binary-calls.log')

  const {stdout, stderr, code} = await runMain({
    'INPUT_GITHUB-TOKEN': 'ghp_test123',
    'INPUT_AUTH-JSON': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    'INPUT_OPENCODE-VERSION': NON_PIN_V2_VERSION,
    MOCK_OPENCODE_VERSION: NON_PIN_V2_VERSION,
    MOCK_OPENCODE_LOG: logFile,
    GITHUB_OUTPUT: '/dev/null',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '12345',
    RUNNER_OS: 'Linux',
    GITHUB_EVENT_NAME: 'push',
    SKIP_CACHE: 'true',
  })

  // #then the Action fails naming the value and the pin, and the binary was never executed (not even `--version`)
  expect(code).not.toBe(0)
  const output = `${stdout}\n${stderr}`
  expect(output).toContain("Input 'opencode-version'")
  expect(output).toContain(`"${NON_PIN_V2_VERSION}"`)
  expect(output).toContain(DEFAULT_OPENCODE_VERSION)
  expect(output).toContain('only the recorded release')
  expect(existsSync(logFile)).toBe(false)
})

it('kills a child that exceeds its timeout and preserves partial output', async () => {
  // #given a child that writes output and remains alive beyond the timeout.
  // The budget must clear Node's cold start so the writes land before SIGKILL;
  // the child stays alive 1000ms, so 500ms still exercises the kill path.
  const child = runNode(
    [
      '--input-type=module',
      '-e',
      "process.stdout.write('partial stdout'); process.stderr.write('partial stderr'); setTimeout(() => {}, 1000)",
    ],
    {},
    500,
  )

  // #when the child exceeds the per-call timeout
  // The same rejected promise is awaited three times on purpose — a settled
  // promise memoizes its result, so each assertion inspects the one rejection.
  await expect(child).rejects.toThrow(/timed out/i)

  // #then the rejection preserves the child's output for diagnostics
  await expect(child).rejects.toThrow('partial stdout')
  await expect(child).rejects.toThrow('partial stderr')
})
