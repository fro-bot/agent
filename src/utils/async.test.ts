import {describe, expect, it} from 'vitest'
import {sleep} from './async.js'

describe('sleep', () => {
  it('resolves after specified delay', async () => {
    // #given
    const delayMs = 50

    // #when
    const start = Date.now()
    await sleep(delayMs)
    const elapsed = Date.now() - start

    // #then
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10)
    expect(elapsed).toBeLessThan(delayMs + 50)
  })

  it('resolves immediately for 0ms', async () => {
    // #given
    const delayMs = 0

    // #when
    const start = Date.now()
    await sleep(delayMs)
    const elapsed = Date.now() - start

    // #then
    expect(elapsed).toBeLessThan(20)
  })
})
