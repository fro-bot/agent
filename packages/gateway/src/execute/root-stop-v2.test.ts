import type {LedgerReconcileAdapter, V2CallError, V2SessionOutcome} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {RootStopClientV2, StreamTerminal} from './root-stop-v2.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {interruptSession, probeRootStopV2, startQuarantineRootWatchV2} from './root-stop-v2.js'

const ROOT = 'ses_root'
const DIRECTORY = '/workspace/repos/o/r'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

type Live = readonly string[] | 'fail'

interface Setup {
  /** Active-list reading per call (the last entry repeats). */
  readonly live?: readonly Live[]
  /** The persisted outcome `getSession` reports; `'fail'` makes the lookup fail. */
  readonly outcome?: V2SessionOutcome | null | 'fail'
  readonly interrupt?: () => ReturnType<RootStopClientV2['interrupt']>
}

function makeProbe(setup: Setup = {}) {
  const readings = setup.live ?? [[]]
  let call = 0
  const adapter: LedgerReconcileAdapter = {
    children: vi.fn(async () => ok([])),
    liveSessionIds: vi.fn(async () => {
      const reading = readings[Math.min(call, readings.length - 1)] ?? []
      call += 1
      return reading === 'fail' ? err(new Error('active failed')) : ok(new Set(reading))
    }),
  }
  const getSession = vi.fn<RootStopClientV2['getSession']>(async () => {
    if (setup.outcome === 'fail') return err({kind: 'http', status: 500} satisfies V2CallError)
    return ok({id: ROOT, parentId: null, directory: DIRECTORY, outcome: setup.outcome ?? null})
  })
  const interrupt = vi.fn<RootStopClientV2['interrupt']>(setup.interrupt ?? (async () => ok({interrupted: true})))
  const client: RootStopClientV2 = {getSession, interrupt}
  return {client, adapter, getSession, interrupt}
}

function probe(setup: Setup, extra: {terminal?: StreamTerminal | null; followUpPossible?: boolean} = {}) {
  const made = makeProbe(setup)
  const result = probeRootStopV2({
    client: made.client,
    adapter: made.adapter,
    rootSessionId: ROOT,
    signal: new AbortController().signal,
    streamTerminal: () => extra.terminal ?? null,
    ...(extra.followUpPossible === undefined ? {} : {followUpPossible: extra.followUpPossible}),
  })
  return {result, ...made}
}

afterEach(() => {
  vi.useRealTimers()
})

describe('probeRootStopV2', () => {
  it.each<[string, StreamTerminal]>([
    ['an interrupt with reason user', 'user'],
    ['a terminal success', 'succeeded'],
    ['a terminal failure', 'failed'],
  ])(
    'confirms the root on %s from the stream when the root is absent from the active list',
    async (_label, terminal) => {
      // #given / #when
      const {result, getSession} = probe({}, {terminal})

      // #then — the stream was evidence enough; nothing more was asked of the server
      await expect(result).resolves.toBe('confirmed')
      expect(getSession).not.toHaveBeenCalled()
    },
  )

  it('never accepts an interrupt with reason shutdown, whatever the persisted outcome says', async () => {
    // #given — a shutdown interrupt releases nothing and leaves the claim held (probe P11)
    const {result} = probe({outcome: 'interrupted'}, {terminal: 'shutdown'})

    // #then
    await expect(result).resolves.toBe('unconfirmed')
  })

  it('is busy while the root is in the active list, whatever else it shows', async () => {
    // #given
    const {result} = probe({live: [[ROOT]], outcome: 'succeeded'}, {terminal: 'user'})

    // #then
    await expect(result).resolves.toBe('busy')
  })

  it('does not read an interrupt reply of false as a stop', async () => {
    // #given — the root is absent, nothing was seen on the stream, and no execution has ended: a root whose prompt is
    // not admitted yet looks exactly like this (probe P1)
    const {result} = probe({outcome: null})

    // #then
    await expect(result).resolves.toBe('unconfirmed')
  })

  it.each<V2SessionOutcome>(['succeeded', 'failed', 'interrupted'])(
    'confirms from a persisted outcome of %s when the stream showed nothing',
    async outcome => {
      // #given — the stream was closed before the end; the server's own record of the last execution is evidence
      const {result} = probe({outcome})

      // #then
      await expect(result).resolves.toBe('confirmed')
    },
  )

  it('is unconfirmed when the persisted outcome cannot be read', async () => {
    // #given
    const {result} = probe({outcome: 'fail'})

    // #then
    await expect(result).resolves.toBe('unconfirmed')
  })

  it('is unconfirmed when the active list cannot be read, before or after the evidence', async () => {
    // #then
    await expect(probe({live: ['fail']}, {terminal: 'user'}).result).resolves.toBe('unconfirmed')
    await expect(probe({live: [[], 'fail']}, {terminal: 'user'}).result).resolves.toBe('unconfirmed')
  })

  it('is busy when a cold root starts between the first reading and the evidence', async () => {
    // #given — absent first, listed on the second reading
    const {result} = probe({live: [[], [ROOT]]}, {terminal: 'succeeded'})

    // #then
    await expect(result).resolves.toBe('busy')
  })

  it('never confirms while background work can still start a root turn', async () => {
    // #given — a finished or cancelled child makes the server prepare a notice turn that is not on the stream yet
    const {result, getSession} = probe({outcome: 'succeeded'}, {terminal: 'succeeded', followUpPossible: true})

    // #then
    await expect(result).resolves.toBe('unconfirmed')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('is still busy, not unconfirmed, when follow-up is possible and the root is live', async () => {
    // #given
    const {result} = probe({live: [[ROOT]]}, {followUpPossible: true})

    // #then
    await expect(result).resolves.toBe('busy')
  })
})

describe('interruptSession', () => {
  it('reports nothing and never throws when the interrupt fails', async () => {
    // #given
    const logger = makeLogger()
    const client = makeProbe({interrupt: async () => err({kind: 'network', message: 'down'})}).client

    // #when / #then
    await expect(interruptSession(client, ROOT, new AbortController().signal, logger, 'root')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT, role: 'root', error: 'network'}),
      expect.stringContaining('interrupt'),
    )
  })

  it('treats an interrupt reply of false as a no-op worth a debug line, not a warning', async () => {
    // #given
    const logger = makeLogger()
    const client = makeProbe({interrupt: async () => ok({interrupted: false})}).client

    // #when
    await interruptSession(client, ROOT, new AbortController().signal, logger, 'owned')

    // #then
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: ROOT, interrupted: false}),
      expect.stringContaining('interrupt'),
    )
  })

  it('swallows a thrown interrupt', async () => {
    // #given
    const logger = makeLogger()
    const client = makeProbe({
      interrupt: async () => {
        throw new Error('boom')
      },
    }).client

    // #when / #then
    await expect(interruptSession(client, ROOT, new AbortController().signal, logger, 'root')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})

function startWatch(setup: Setup, extra: {windowMs?: number; followUpPossible?: boolean} = {}) {
  vi.useFakeTimers()
  const made = makeProbe(setup)
  const logger = makeLogger()
  const stop = startQuarantineRootWatchV2({
    client: made.client,
    adapter: made.adapter,
    rootSessionId: ROOT,
    streamTerminal: () => null,
    logger,
    pollIntervalMs: 500,
    ...(extra.windowMs === undefined ? {} : {windowMs: extra.windowMs}),
    ...(extra.followUpPossible === undefined ? {} : {followUpPossible: extra.followUpPossible}),
  })
  return {...made, logger, stop}
}

describe('startQuarantineRootWatchV2', () => {
  it('interrupts the root on every busy observation during the hold', async () => {
    // #given — the root keeps showing up live
    const watch = startWatch({live: [[ROOT]]})

    // #when
    await vi.advanceTimersByTimeAsync(2_100)

    // #then
    expect(watch.interrupt.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(watch.interrupt).toHaveBeenCalledWith(expect.objectContaining({sessionId: ROOT}))
    watch.stop()
  })

  it('ends at the first confirmation', async () => {
    // #given — busy once, then stopped with a persisted outcome
    const watch = startWatch({live: [[ROOT], []], outcome: 'interrupted'})

    // #when
    await vi.advanceTimersByTimeAsync(5_000)

    // #then
    expect(watch.interrupt).toHaveBeenCalledTimes(1)
    expect(watch.logger.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('confirmed stopped'))
    const probesAfterEnd = watch.adapter.liveSessionIds as ReturnType<typeof vi.fn>
    const callsAtEnd = probesAfterEnd.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(probesAfterEnd.mock.calls.length).toBe(callsAtEnd)
  })

  it('ends when the hold window closes even if the root is never confirmed', async () => {
    // #given
    const watch = startWatch({outcome: null}, {windowMs: 3_000})

    // #when
    await vi.advanceTimersByTimeAsync(10_000)

    // #then
    expect(watch.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({rootSessionId: ROOT}),
      expect.stringContaining('hold ended'),
    )
  })

  it('keeps aborting for the whole window while follow-up work is open, since nothing can confirm the root', async () => {
    // #given
    const watch = startWatch({live: [[ROOT]], outcome: 'succeeded'}, {followUpPossible: true, windowMs: 3_000})

    // #when
    await vi.advanceTimersByTimeAsync(2_900)

    // #then
    expect(watch.interrupt.mock.calls.length).toBeGreaterThan(1)
    watch.stop()
  })

  it('does not stall on an interrupt that never answers', async () => {
    // #given — the first interrupt hangs; the probe keeps seeing the root busy
    const watch = startWatch({live: [[ROOT]], interrupt: async () => new Promise(() => undefined)})

    // #when — past the per-request cap and a few polls
    await vi.advanceTimersByTimeAsync(20_000)

    // #then
    expect(watch.interrupt.mock.calls.length).toBeGreaterThan(1)
    watch.stop()
  })
})
