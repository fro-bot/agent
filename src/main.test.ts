import * as cp from 'node:child_process'
import * as path from 'node:path'
import * as process from 'node:process'
import {expect, it} from 'vitest'

// shows how the runner will run a javascript action with env / stdout protocol
it('runs', () => {
  process.env.INPUT_MILLISECONDS = '500'
  const np = process.execPath
  const ip = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'main.js')
  const options: cp.ExecFileSyncOptions = {
    env: process.env,
  }
  expect(cp.execFileSync(np, [ip], options).toString()).toMatch(/::set-output name=time::/)
})
