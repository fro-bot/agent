import {exec} from 'node:child_process'
import process from 'node:process'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

const execAsync = promisify(exec)

it('runs successfully with valid inputs', async () => {
  // @actions/core.getInput('github-token') looks for INPUT_GITHUB-TOKEN
  // but shell doesn't allow hyphens in env var names, so we test via node
  const {stdout} = await execAsync(
    `node -e "
      process.env['INPUT_GITHUB-TOKEN'] = 'test-token';
      process.env['INPUT_OPENCODE-MODEL'] = 'claude-sonnet-4-20250514';
      process.env['INPUT_SESSION-RETENTION-DAYS'] = '30';
      process.env['INPUT_MAX-COMMENT-LENGTH'] = '65536';
      process.env['INPUT_SAFE-MODE'] = 'false';
      process.env['INPUT_DEBUG'] = 'false';
      process.env['GITHUB_OUTPUT'] = '/dev/null';
      import('./dist/main.js');
    "`,
    {
      env: {
        ...process.env,
        GITHUB_OUTPUT: '/dev/null',
      },
      cwd: process.cwd(),
    },
  )
  // Success is indicated by the action completing without throwing
  expect(stdout).toContain('Starting Fro Bot Agent')
})

it('fails gracefully with missing required inputs', async () => {
  // Missing INPUT_GITHUB-TOKEN should cause failure
  await expect(
    execAsync(
      `node -e "
        process.env['GITHUB_OUTPUT'] = '/dev/null';
        import('./dist/main.js');
      "`,
      {
        env: {
          ...process.env,
          GITHUB_OUTPUT: '/dev/null',
        },
      },
    ),
  ).rejects.toThrow()
})
