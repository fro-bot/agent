import type {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import process from 'node:process'
import {expect, it} from 'vitest'

/**
 * Spawn node and import the main module, returning stdout/stderr.
 * Uses spawn instead of exec to avoid shell escaping issues with
 * environment variable names containing hyphens.
 */
async function runMain(env: Record<string, string>): Promise<{stdout: string; stderr: string; code: number | null}> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--input-type=module', '-e', "import('./dist/main.js');"], {
      env: {...process.env, ...env},
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
