import {describe, expect, it} from 'vitest'

it('healthy-test passes', () => {
  expect(1).toBe(1)
})

it('healthy-second-test passes', () => {
  expect(2).toBe(2)
})

describe.skip('healthy-skipped-suite', () => {
  it('healthy-skipped-test', () => {
    expect(1).toBe(2)
  })
})

it.todo('healthy-todo-test')
