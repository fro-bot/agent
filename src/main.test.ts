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

function assertDistBundle(): void {
  if (existsSync(distMainPath)) return
  throw new Error('dist/main.js is missing. Run pnpm build to generate the action bundle before testing.')
}

/**
 * Spawn node and import the main module, returning stdout/stderr.
 * Uses spawn instead of exec to avoid shell escaping issues with
 * environment variable names containing hyphens.
 *
 * Sets XDG_DATA_HOME to an isolated temp directory to prevent tests
 * from accessing or modifying local development OpenCode data.
 */
async function runMain(env: Record<string, string>): Promise<{stdout: string; stderr: string; code: number | null}> {
  assertDistBundle()

  const importTarget = pathToFileURL(distMainPath).href
  return new Promise((resolve, reject) => {
    // Prepend mock bin dir to PATH so opencode is found
    const pathEnv = mockBinDir + path.delimiter + (process.env.PATH ?? '')

    const child = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(importTarget)});`], {
      env: {...process.env, ...env, XDG_DATA_HOME: testDataDir, PATH: pathEnv},
      cwd: projectRoot,
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('error', reject)
    child.on('close', code => {
      resolve({stdout, stderr, code})
    })
  })
}

it('runs successfully with valid inputs', async () => {
  const {stdout, code} = await runMain({
    'INPUT_GITHUB-TOKEN': 'ghp_test123',
    'INPUT_AUTH-JSON': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
    'INPUT_SESSION-RETENTION': '50',
    GITHUB_OUTPUT: '/dev/null',
    GITHUB_REPOSITORY: 'test/repo',
    GITHUB_REF_NAME: 'main',
    GITHUB_RUN_ID: '12345',
    RUNNER_OS: 'Linux',
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
