import process from 'node:process'
import {afterAll, describe, expect, it} from 'vitest'

afterAll(() => {
  process.kill(process.pid, 'SIGKILL')
})

describe('lost-suite', () => {
  it('lost-genuine-pass-one', () => {
    expect(1).toBe(1)
  })

  it('lost-genuine-pass-two', () => {
    expect(2).toBe(2)
  })
})
