/**
 * Direct unit tests for the helpers the V1 and V2 gateway loops share (`run-core-shared.ts`). They sat in the V1
 * loop's test files, which are the only place a direct test of these two existed.
 */
import {getEventListeners} from 'node:events'
import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {awaitFirstEvent, wrapLedgerWithHooks} from './run-core-shared.js'

const connected = (): object => ({type: 'server.connected', properties: {}})

describe('wrapLedgerWithHooks — a call that changes nothing fires no persistence write', () => {
  const CHILD = 'sess-reconciled-child'

  it('a settle of an already-settled entry fires no persistence write', () => {
    // #given — a direct unit test of the wrapper itself. Through the real
    // `runOpenCodeCoreV2` → `reconcileLedgerOnce` integration path, `settle()` can only
    // ever be called once per entry per genuine transition (see `wrapLedgerWithHooks`'s
    // doc comment for why that path cannot force a true duplicate deterministically) —
    // exercising the wrapper directly is the reliable way to prove its no-op branch.
    const rawLedger = createOwnershipLedger()
    rawLedger.adopt(CHILD, 'background task')
    rawLedger.settle(CHILD)
    const onChange = vi.fn()
    const onAdopted = vi.fn()
    const wrapped = wrapLedgerWithHooks(rawLedger, onChange, onAdopted)

    // #when — settle() is called again on an entry that is already settled.
    wrapped.settle(CHILD)

    // #then — no persistence write for a call that changed nothing.
    expect(onChange).not.toHaveBeenCalled()
    expect(rawLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('settled')
  })

  it('a markUnknown of an already-unknown entry fires no persistence write', () => {
    // #given — same rationale as the settle test above: unit-test the wrapper directly.
    // This is the path the drain-deadline cancellation loop actually exercises in
    // practice (`ledger.markUnknown(entry.sessionId)` for every unsettled entry,
    // including ones already `unknown`).
    const rawLedger = createOwnershipLedger()
    rawLedger.adopt(CHILD, 'background task')
    rawLedger.markUnknown(CHILD)
    const onChange = vi.fn()
    const onAdopted = vi.fn()
    const wrapped = wrapLedgerWithHooks(rawLedger, onChange, onAdopted)

    // #when
    wrapped.markUnknown(CHILD)

    // #then
    expect(onChange).not.toHaveBeenCalled()
    expect(rawLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('unknown')
  })
})

describe('awaitFirstEvent — hygiene on the run signal', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves no abort listener and no timer behind, whichever way the wait ends', async () => {
    // #given a long-lived signal
    vi.useFakeTimers()
    const controller = new AbortController()
    const frame = (): AsyncIterator<unknown> => ({next: async () => ({done: false, value: connected()})})
    const ended = (): AsyncIterator<unknown> => ({next: async () => ({done: true, value: undefined})})
    const failing = (): AsyncIterator<unknown> => ({
      next: async () => {
        throw new Error('boom')
      },
    })
    const silent = (): AsyncIterator<unknown> => ({next: async () => new Promise<never>(() => {})})

    // #when the wait ends by a frame, an end, an error and a timeout
    expect(await awaitFirstEvent(frame(), controller.signal, 1_000)).toMatchObject({kind: 'frame'})
    expect(await awaitFirstEvent(ended(), controller.signal, 1_000)).toEqual({kind: 'ended'})
    expect(await awaitFirstEvent(failing(), controller.signal, 1_000)).toMatchObject({kind: 'error'})
    const pending = awaitFirstEvent(silent(), controller.signal, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toEqual({kind: 'timeout'})

    // #then nothing is left on the signal, and no timer is armed
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles at once on a signal that is already aborted, without reading', async () => {
    // #given
    const controller = new AbortController()
    controller.abort()
    const next = vi.fn(async () => ({done: false as const, value: connected()}))

    // #when / #then
    expect(await awaitFirstEvent({next}, controller.signal, 1_000)).toEqual({kind: 'aborted'})
    expect(next).not.toHaveBeenCalled()
  })
})
