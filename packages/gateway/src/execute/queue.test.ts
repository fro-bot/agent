import {describe, expect, it} from 'vitest'

import {createChannelQueue, DEFAULT_MAX_QUEUE_DEPTH} from './queue.js'

describe('createChannelQueue', () => {
  it('exports DEFAULT_MAX_QUEUE_DEPTH', () => {
    expect(DEFAULT_MAX_QUEUE_DEPTH).toBeGreaterThan(0)
  })

  describe('happy path — FIFO enqueue and takeNext', () => {
    it('enqueues two tasks and returns them in FIFO order', () => {
      // #given
      const queue = createChannelQueue(5)
      const task1 = {id: 'task-1'}
      const task2 = {id: 'task-2'}

      // #when
      const r1 = queue.enqueue('ch-a', task1)
      const r2 = queue.enqueue('ch-a', task2)

      // #then
      expect(r1).toBe('queued')
      expect(r2).toBe('queued')
      expect(queue.takeNext('ch-a')).toBe(task1)
      expect(queue.takeNext('ch-a')).toBe(task2)
    })

    it('pendingCount reflects depth and decrements on each takeNext', () => {
      // #given
      const queue = createChannelQueue(5)
      const task1 = {id: 'task-1'}
      const task2 = {id: 'task-2'}

      // #when — enqueue two
      queue.enqueue('ch-a', task1)
      queue.enqueue('ch-a', task2)

      // #then — count is 2
      expect(queue.pendingCount('ch-a')).toBe(2)

      // #when — take one
      queue.takeNext('ch-a')

      // #then — count decrements
      expect(queue.pendingCount('ch-a')).toBe(1)

      // #when — take the last
      queue.takeNext('ch-a')

      // #then — count is 0
      expect(queue.pendingCount('ch-a')).toBe(0)
    })
  })

  describe('edge cases — empty / unknown channel', () => {
    it('takeNext on an empty channel returns undefined', () => {
      // #given
      const queue = createChannelQueue(5)

      // #when / #then
      expect(queue.takeNext('ch-unknown')).toBeUndefined()
    })

    it('takeNext on a channel that was drained returns undefined', () => {
      // #given
      const queue = createChannelQueue(5)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.takeNext('ch-a')

      // #when / #then
      expect(queue.takeNext('ch-a')).toBeUndefined()
    })

    it('pendingCount on an unknown channel returns 0', () => {
      // #given
      const queue = createChannelQueue(5)

      // #when / #then
      expect(queue.pendingCount('ch-unknown')).toBe(0)
    })

    it('clear on an empty / unknown channel returns 0', () => {
      // #given
      const queue = createChannelQueue(5)

      // #when / #then
      expect(queue.clear('ch-unknown')).toBe(0)
    })

    it('clear on a drained channel returns 0', () => {
      // #given
      const queue = createChannelQueue(5)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.takeNext('ch-a')

      // #when / #then
      expect(queue.clear('ch-a')).toBe(0)
    })
  })

  describe('channel isolation', () => {
    it('enqueue on channel A does not affect pendingCount for channel B', () => {
      // #given
      const queue = createChannelQueue(5)

      // #when
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.enqueue('ch-a', {id: 'task-2'})

      // #then — B is unaffected
      expect(queue.pendingCount('ch-b')).toBe(0)
    })

    it('takeNext on channel A does not affect channel B', () => {
      // #given
      const queue = createChannelQueue(5)
      const taskA = {id: 'task-a'}
      const taskB = {id: 'task-b'}
      queue.enqueue('ch-a', taskA)
      queue.enqueue('ch-b', taskB)

      // #when — drain A
      queue.takeNext('ch-a')

      // #then — B still has its task
      expect(queue.pendingCount('ch-b')).toBe(1)
      expect(queue.takeNext('ch-b')).toBe(taskB)
    })

    it('clear on channel A does not affect channel B', () => {
      // #given
      const queue = createChannelQueue(5)
      const taskA = {id: 'task-a'}
      const taskB = {id: 'task-b'}
      queue.enqueue('ch-a', taskA)
      queue.enqueue('ch-b', taskB)

      // #when
      queue.clear('ch-a')

      // #then — B is untouched
      expect(queue.pendingCount('ch-b')).toBe(1)
      expect(queue.takeNext('ch-b')).toBe(taskB)
    })
  })

  describe('required depth cap', () => {
    it('createChannelQueue(0) rejects the very first enqueue (cap is zero)', () => {
      // #given — maxDepth=0 means no tasks are ever accepted
      const queue = createChannelQueue(0)

      // #when
      const result = queue.enqueue('ch-a', {id: 'task-1'})

      // #then — first enqueue is rejected even though the channel is unknown
      expect(result).toBe('full')
      expect(queue.pendingCount('ch-a')).toBe(0)
    })

    it('enqueue at maxDepth returns full', () => {
      // #given
      const queue = createChannelQueue(2)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.enqueue('ch-a', {id: 'task-2'})

      // #when — channel is at cap
      const result = queue.enqueue('ch-a', {id: 'task-3'})

      // #then
      expect(result).toBe('full')
    })

    it('pending count is unchanged by a rejected enqueue', () => {
      // #given
      const queue = createChannelQueue(2)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.enqueue('ch-a', {id: 'task-2'})

      // #when — rejected
      queue.enqueue('ch-a', {id: 'task-3'})

      // #then — still 2, not 3
      expect(queue.pendingCount('ch-a')).toBe(2)
    })

    it('other channels are unaffected by a full channel', () => {
      // #given
      const queue = createChannelQueue(1)
      queue.enqueue('ch-a', {id: 'task-a'})

      // #when — ch-a is full; ch-b is independent
      const result = queue.enqueue('ch-b', {id: 'task-b'})

      // #then
      expect(result).toBe('queued')
      expect(queue.pendingCount('ch-b')).toBe(1)
    })

    it('after a takeNext frees a slot, enqueue succeeds again', () => {
      // #given
      const queue = createChannelQueue(2)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.enqueue('ch-a', {id: 'task-2'})
      expect(queue.enqueue('ch-a', {id: 'task-3'})).toBe('full')

      // #when — free a slot
      queue.takeNext('ch-a')

      // #then — enqueue succeeds
      const result = queue.enqueue('ch-a', {id: 'task-3'})
      expect(result).toBe('queued')
      expect(queue.pendingCount('ch-a')).toBe(2)
    })
  })

  describe('atomicity and FIFO correctness', () => {
    it('two sequential takeNext calls never return the same task object', () => {
      // #given
      const queue = createChannelQueue(5)
      const task1 = {id: 'task-1'}
      const task2 = {id: 'task-2'}
      queue.enqueue('ch-a', task1)
      queue.enqueue('ch-a', task2)

      // #when
      const first = queue.takeNext('ch-a')
      const second = queue.takeNext('ch-a')

      // #then — distinct objects, correct order
      expect(first).toBe(task1)
      expect(second).toBe(task2)
      expect(first).not.toBe(second)
    })

    it('interleaved enqueue + takeNext preserves FIFO and loses no task', () => {
      // #given
      const queue = createChannelQueue(5)
      const task1 = {id: 'task-1'}
      const task2 = {id: 'task-2'}
      const task3 = {id: 'task-3'}

      // #when — enqueue, take, enqueue two more, take all
      queue.enqueue('ch-a', task1)
      const first = queue.takeNext('ch-a')
      queue.enqueue('ch-a', task2)
      queue.enqueue('ch-a', task3)
      const second = queue.takeNext('ch-a')
      const third = queue.takeNext('ch-a')
      const fourth = queue.takeNext('ch-a')

      // #then — FIFO order, no loss, no phantom
      expect(first).toBe(task1)
      expect(second).toBe(task2)
      expect(third).toBe(task3)
      expect(fourth).toBeUndefined()
    })

    it('clear after a takeNext drops only the remaining tasks', () => {
      // #given
      const queue = createChannelQueue(5)
      const task1 = {id: 'task-1'}
      const task2 = {id: 'task-2'}
      const task3 = {id: 'task-3'}
      queue.enqueue('ch-a', task1)
      queue.enqueue('ch-a', task2)
      queue.enqueue('ch-a', task3)

      // #when — take one, then clear
      queue.takeNext('ch-a')
      const dropped = queue.clear('ch-a')

      // #then — only the 2 remaining were dropped
      expect(dropped).toBe(2)
      expect(queue.pendingCount('ch-a')).toBe(0)
    })

    it('clear returns the exact count of dropped tasks', () => {
      // #given
      const queue = createChannelQueue(5)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.enqueue('ch-a', {id: 'task-2'})
      queue.enqueue('ch-a', {id: 'task-3'})

      // #when
      const dropped = queue.clear('ch-a')

      // #then
      expect(dropped).toBe(3)
      expect(queue.pendingCount('ch-a')).toBe(0)
    })

    it('takeNext after clear returns undefined — no stale empty array', () => {
      // #given
      const queue = createChannelQueue(5)
      queue.enqueue('ch-a', {id: 'task-1'})
      queue.clear('ch-a')

      // #when / #then
      expect(queue.takeNext('ch-a')).toBeUndefined()
      expect(queue.pendingCount('ch-a')).toBe(0)
    })
  })
})
