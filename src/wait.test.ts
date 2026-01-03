import {expect, it} from 'vitest'
import {wait} from './wait.js'

it('throws invalid number', async () => {
  const input = Number.parseInt('foo', 10)
  await expect(wait(input)).rejects.toThrow('milliseconds not a number')
})

it('wait 500 ms', async () => {
  const start = new Date()
  await wait(500)
  const end = new Date()
  const delta = Math.abs(end.getTime() - start.getTime())
  expect(delta).toBeGreaterThan(450)
})
