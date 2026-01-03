import {exec} from 'node:child_process'
import process from 'node:process'
import {promisify} from 'node:util'
import {expect, it} from 'vitest'

const execAsync = promisify(exec)

it('runs successfully with valid inputs', async () => {
  const {stderr} = await execAsync(`node dist/main.js`, {
    env: {...process.env, INPUT_MILLISECONDS: '500', GITHUB_OUTPUT: '/dev/null'},
  })
  expect(stderr).toBe('')
})
