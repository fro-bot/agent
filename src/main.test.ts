import {exec} from 'node:child_process'
import process from 'node:process'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

const execAsync = promisify(exec)

it('runs successfully with valid inputs', async () => {
  // Use environment variables directly instead of setting them in the -e script
  // to avoid shell escaping issues with JSON
  const {stdout} = await execAsync(`node -e "import('./dist/main.js');"`, {
    env: {
      ...process.env,
      'INPUT_GITHUB-TOKEN': 'ghp_test123',
      'INPUT_AUTH-JSON': '{"anthropic":{"type":"api","key":"sk-ant-test"}}',
      'INPUT_SESSION-RETENTION': '50',
      GITHUB_OUTPUT: '/dev/null',
    },
    cwd: process.cwd(),
  })
  // Success is indicated by the action completing without throwing
  expect(stdout).toContain('Starting Fro Bot Agent')
})

it('fails gracefully with missing required inputs', async () => {
  // Missing INPUT_GITHUB-TOKEN and INPUT_AUTH-JSON should cause failure
  await expect(
    execAsync(`node -e "import('./dist/main.js');"`, {
      env: {
        ...process.env,
        GITHUB_OUTPUT: '/dev/null',
      },
    }),
  ).rejects.toThrow()
})
