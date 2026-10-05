import process from 'node:process'
import {expect, it} from 'vitest'

it('lost-before-crash passes then dies', () => {
  expect(1).toBe(1)
})

it('lost-crashing-test kills its worker', () => {
  // SIGKILL cannot be intercepted by Vitest the way process.exit() is, so the worker dies like an OOM.
  process.kill(process.pid, 'SIGKILL')
})

it('lost-after-crash never runs', () => {
  expect(1).toBe(1)
})
