import {beforeEach, describe, expect, it} from 'vitest'
import {repoMutexKey, resetRepoLocksForTesting, withRepoLock} from './repo-mutex.js'

beforeEach(() => {
  resetRepoLocksForTesting()
})

describe('withRepoLock — same-repo serialization', () => {
  it('serializes two operations on the same repo in arrival order, asserted deterministically (no timers)', async () => {
    // #given a "clone" holding the lock, and an "update" queued behind it for the same key
    const order: string[] = []
    const key = repoMutexKey('acme', 'widgets')

    let releaseClone!: () => void
    const clone = withRepoLock(key, async () => {
      order.push('clone-start')
      await new Promise<void>(resolve => {
        releaseClone = resolve
      })
      order.push('clone-end')
    })

    const update = withRepoLock(key, async () => {
      order.push('update-start')
      order.push('update-end')
    })

    // #when — flush microtasks; update must NOT have started while clone still holds the lock
    await Promise.resolve()
    await Promise.resolve()

    // #then
    expect(order).toEqual(['clone-start'])

    releaseClone()
    await clone
    await update

    expect(order).toEqual(['clone-start', 'clone-end', 'update-start', 'update-end'])
  })

  it('queues three operations on the same repo and runs them in strict arrival order', async () => {
    // #given — each operation signals when it actually starts, so ordering is asserted by
    // awaiting those explicit signals rather than by counting microtask ticks.
    const order: number[] = []
    const key = repoMutexKey('acme', 'widgets')
    const releases: (() => void)[] = []
    const startSignals = [0, 1, 2].map(() => {
      let resolve!: () => void
      const promise = new Promise<void>(res => {
        resolve = res
      })
      return {promise, resolve}
    })

    const operations = [1, 2, 3].map(async (n, i) =>
      withRepoLock(key, async () => {
        order.push(n)
        startSignals[i]!.resolve()
        await new Promise<void>(resolve => releases.push(resolve))
      }),
    )

    // #when — release strictly in arrival order, waiting on each operation's own start signal.
    await startSignals[0]!.promise
    expect(order).toEqual([1])

    releases[0]!()
    await startSignals[1]!.promise
    expect(order).toEqual([1, 2])

    releases[1]!()
    await startSignals[2]!.promise
    expect(order).toEqual([1, 2, 3])

    releases[2]!()

    // #then
    await Promise.all(operations)
    expect(order).toEqual([1, 2, 3])
  })
})

describe('withRepoLock — cross-repo concurrency', () => {
  it('runs operations on different repos concurrently — never serializing them', async () => {
    // #given repo A holds its lock, still in flight
    const order: string[] = []
    let releaseA!: () => void
    const a = withRepoLock(repoMutexKey('acme', 'a'), async () => {
      order.push('a-start')
      await new Promise<void>(resolve => {
        releaseA = resolve
      })
      order.push('a-end')
    })
    await Promise.resolve()
    expect(order).toEqual(['a-start'])

    // #when — repo B starts and finishes entirely while A is still held
    const b = withRepoLock(repoMutexKey('acme', 'b'), async () => {
      order.push('b-start')
      order.push('b-end')
    })
    await b

    // #then
    expect(order).toEqual(['a-start', 'b-start', 'b-end'])

    releaseA()
    await a
    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end'])
  })
})

describe('withRepoLock — rejection releases the lock', () => {
  it('releases the lock when the wrapped operation rejects, so a later operation on the same repo still runs', async () => {
    // #given
    const key = repoMutexKey('acme', 'widgets')
    const order: string[] = []

    // #when
    await expect(
      withRepoLock(key, async () => {
        order.push('failing-op')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await withRepoLock(key, async () => {
      order.push('next-op')
    })

    // #then
    expect(order).toEqual(['failing-op', 'next-op'])
  })

  it('lets a queued waiter proceed once the current holder rejects, in arrival order', async () => {
    // #given a holder that will reject, and a waiter queued behind it
    const key = repoMutexKey('acme', 'widgets')
    const order: string[] = []
    let rejectFirst!: (error: Error) => void

    const first = withRepoLock(key, async () => {
      order.push('first-start')
      await new Promise<void>((_resolve, reject) => {
        rejectFirst = reject
      })
    }).catch(() => {
      order.push('first-caught')
    })

    await Promise.resolve()
    const second = withRepoLock(key, async () => {
      order.push('second-start')
    })

    // #when
    expect(order).toEqual(['first-start'])
    rejectFirst(new Error('boom'))
    await first
    await second

    // #then — the lock is released (in the `finally` block) before the rejection propagates
    // out to `first`'s own `.catch`, so the queued waiter observably starts first; the failing
    // operation is never left holding the lock.
    expect(order).toEqual(['first-start', 'second-start', 'first-caught'])
  })
})

describe('repoMutexKey', () => {
  it('produces distinct keys for distinct owner/repo pairs, and the same key for the same pair', () => {
    expect(repoMutexKey('acme', 'widgets')).toBe('acme/widgets')
    expect(repoMutexKey('acme', 'widgets')).toBe(repoMutexKey('acme', 'widgets'))
    expect(repoMutexKey('acme', 'gadgets')).not.toBe(repoMutexKey('acme', 'widgets'))
    expect(repoMutexKey('other', 'widgets')).not.toBe(repoMutexKey('acme', 'widgets'))
  })
})
