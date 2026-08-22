import type {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import {chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {afterAll, beforeAll, expect, it} from 'vitest'

// Isolated temp directories for test data and mock tools
let testDataDir: string
let mockBinDir: string

beforeAll(() => {
  testDataDir = mkdtempSync(path.join(tmpdir(), 'fro-bot-test-'))
  mockBinDir = mkdtempSync(path.join(tmpdir(), 'fro-bot-mock-bin-'))

  // Create mock opencode binary that responds to --version
  const mockOpenCode = path.join(mockBinDir, 'opencode')
  writeFileSync(mockOpenCode, '#!/bin/sh\necho "OpenCode 1.1.2"', 'utf8')
  chmodSync(mockOpenCode, 0o755)
})

afterAll(() => {
  rmSync(testDataDir, {recursive: true, force: true})
  rmSync(mockBinDir, {recursive: true, force: true})
})

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
 * Sets XDG_DATA_HOME to an isolated temp directory to prevent tests
 * from accessing or modifying local development OpenCode data.
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
      env: {...process.env, ...env, XDG_DATA_HOME: testDataDir, PATH: pathEnv},
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
      ...env,
      GITHUB_API_URL: 'http://127.0.0.1:1',
    },
    timeoutMs,
  )
}

it('runs successfully with valid inputs', async () => {
  // Use 'push' event so routing skips — avoids unconditional bootstrap in test env
  const eventPayload = {ref: 'refs/heads/main'}
  const eventFile = path.join(testDataDir, 'push-event.json')
  writeFileSync(eventFile, JSON.stringify(eventPayload), 'utf8')

  const {stdout, code} = await runMain({
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

  expect(code).toBe(0)
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
    XDG_DATA_HOME: testDataDir,
  })

  expect(code).not.toBe(0)
  expect(stdout).toContain('bootstrap')
})

it('kills a child that exceeds its timeout and preserves partial output', async () => {
  // #given a child that writes output and remains alive beyond the timeout
  const child = runNode(
    [
      '--input-type=module',
      '-e',
      "process.stdout.write('partial stdout'); process.stderr.write('partial stderr'); setTimeout(() => {}, 1000)",
    ],
    {},
    50,
  )

  // #when the child exceeds the per-call timeout
  await expect(child).rejects.toThrow(/timed out/i)

  // #then the rejection preserves the child's output for diagnostics
  await expect(child).rejects.toThrow('partial stdout')
  await expect(child).rejects.toThrow('partial stderr')
})
