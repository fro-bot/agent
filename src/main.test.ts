import type {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {afterAll, beforeAll, expect, it} from 'vitest'

// Isolated temp directory for test data (prevents access to local dev files)
let testDataDir: string

beforeAll(() => {
  testDataDir = mkdtempSync(join(tmpdir(), 'fro-bot-test-'))
})

afterAll(() => {
  rmSync(testDataDir, {recursive: true, force: true})
})

/**
 * Spawn node and import the main module, returning stdout/stderr.
 * Uses spawn instead of exec to avoid shell escaping issues with
 * environment variable names containing hyphens.
 *
 * Sets XDG_DATA_HOME to an isolated temp directory to prevent tests
 * from accessing or modifying local development OpenCode data.
 */
async function runMain(env: Record<string, string>): Promise<{stdout: string; stderr: string; code: number | null}> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', "import('./dist/main.js');"], {
      env: {...process.env, ...env, XDG_DATA_HOME: testDataDir},
      cwd: process.cwd(),
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
