/**
 * Unit tests for `createDrainCompletion`: request cancellation, listener hygiene, and late-result handling.
 *
 * The end-to-end drain scenarios live in `run-core.drain-completion.test.ts`; these pin the properties that need a
 * handle on the gate itself — what signal each REST request receives, what it leaves registered on the long-lived
 * run signal, and that a result arriving after the run ended can never admit success.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'

import {getEventListeners} from 'node:events'
import {createOwnershipLedger, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createDrainCompletion} from './drain-completion.js'

const ROOT = 'sess-root'
const CHILD = 'sess-child'
const CAP_MS = 5_000
const INTERVAL_MS = 1_000

const answeredTurns = [
  {info: {id: 'msg-prompt', role: 'user', sessionID: ROOT}, parts: []},
  {
    info: {id: 'msg-n1', role: 'user', sessionID: ROOT},
    parts: [{id: 'p1', type: 'text', synthetic: true, text: `<task id="${CHILD}" state="completed">`}],
  },
  {
    info: {id: 'msg-r1', role: 'assistant', sessionID: ROOT, parentID: 'msg-n1', time: {completed: 1}, finish: 'stop'},
    parts: [],
  },
]

interface SetupOptions {
  /** Root `session.messages` implementation. Default: the fully answered transcript, immediately. */
  readonly messages?: (args: {readonly signal?: AbortSignal}) => Promise<unknown>
  /** `liveSessionIds` implementation. Default: nothing live, immediately. */
  readonly liveSessionIds?: (signal?: AbortSignal) => ReturnType<typeof liveOk>
}

const liveOk = async (): Promise<ReturnType<typeof ok<ReadonlySet<string>>>> => ok(new Set<string>())

function setup(options: SetupOptions = {}) {
  vi.useFakeTimers()
  const ledger = createOwnershipLedger()
  ledger.adopt(CHILD, 'background task')
  ledger.settle(CHILD)
  const runController = new AbortController()
  const onAdmitted = vi.fn()
  const messages = vi.fn(async (args: {readonly signal?: AbortSignal}) =>
    options.messages === undefined ? {data: answeredTurns, error: null} : options.messages(args),
  )
  const liveSessionIds = vi.fn(async (signal?: AbortSignal) =>
    options.liveSessionIds === undefined ? liveOk() : options.liveSessionIds(signal),
  )
  const client = {session: {messages}} as unknown as OpenCodeServerHandle['client']
  const completion = createDrainCompletion({
    client,
    directory: '/workspace/repo',
    rootSessionId: ROOT,
    ledger,
    adapter: {children: async () => ok([]), liveSessionIds},
    signal: runController.signal,
    logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    onAdmitted,
    validationIntervalMs: INTERVAL_MS,
    requestTimeoutMs: CAP_MS,
  })
  return {completion, runController, onAdmitted, messages, liveSessionIds}
}

/** Everything the gate needs to start validating: a notice, a current idle, and a drain in progress. */
function startValidating(completion: ReturnType<typeof setup>['completion']): void {
  completion.noteNotice({childSessionId: CHILD, state: 'completed'}, 'msg-n1', 'p1')
  completion.noteRootIdle()
  completion.beginDrain()
  completion.requestValidation()
}

const hang = async () =>
  new Promise<never>(() => {
    /* never settles */
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('createDrainCompletion — request cancellation', () => {
  it('a hung liveness request is handed a signal that fires at the cap', async () => {
    // #given a liveness lookup that never answers
    let received: AbortSignal | undefined
    const {completion} = setup({
      liveSessionIds: async signal => {
        received ??= signal
        return hang()
      },
    })

    // #when validation starts
    startValidating(completion)
    await vi.advanceTimersByTimeAsync(1)

    // #then the request carries a live signal, still unaborted just before the cap
    expect(received).toBeInstanceOf(AbortSignal)
    await vi.advanceTimersByTimeAsync(CAP_MS - 2)
    expect(received?.aborted).toBe(false)

    // #and it fires at the cap
    await vi.advanceTimersByTimeAsync(2)
    expect(received?.aborted).toBe(true)
    completion.dispose()
  })

  it('a hung liveness request is aborted on dispose, well before the cap', async () => {
    // #given a liveness lookup that never answers
    let received: AbortSignal | undefined
    const {completion} = setup({
      liveSessionIds: async signal => {
        received ??= signal
        return hang()
      },
    })
    startValidating(completion)
    await vi.advanceTimersByTimeAsync(1)
    expect(received?.aborted).toBe(false)

    // #when the run ends
    completion.dispose()

    // #then the in-flight request is cancelled rather than left running
    expect(received?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a hung messages request gets the same signal: it fires at the cap and on dispose', async () => {
    // #given a messages read that never answers
    const signals: AbortSignal[] = []
    const {completion} = setup({
      messages: async args => {
        if (args.signal !== undefined) signals.push(args.signal)
        return hang()
      },
    })
    startValidating(completion)
    await vi.advanceTimersByTimeAsync(1)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)

    // #when the cap passes
    await vi.advanceTimersByTimeAsync(CAP_MS)

    // #then it fired
    expect(signals[0]?.aborted).toBe(true)

    // #when a retry starts another request and the run then ends
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)
    completion.dispose()

    // #then dispose cancelled that one too
    expect(signals[1]?.aborted).toBe(true)
  })
})

describe('createDrainCompletion — listener hygiene on the long-lived run signal', () => {
  it('across many failing retries, no abort listener accumulates on the run signal', async () => {
    // #given a gate whose validation keeps being rejected (an empty transcript), so it retries every second
    const {completion, runController, messages} = setup({messages: async () => ({data: [], error: null})})
    const baseline = getEventListeners(runController.signal, 'abort').length

    // #when it retries eight times
    startValidating(completion)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 8)

    // #then it really did retry, and left nothing registered behind
    expect(messages.mock.calls.length).toBeGreaterThanOrEqual(8)
    expect(getEventListeners(runController.signal, 'abort').length).toBe(baseline)
    completion.dispose()
  })

  it('across many retries, no abort listener accumulates on ANY long-lived signal (including the lifecycle signal)', async () => {
    // #given a spy on abort-listener registration, keyed by target — the lifecycle signal is not reachable
    // from outside, so net registrations per target are the only way to see it
    const net = new Map<EventTarget, number>()
    const add = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
    ) {
      if (type === 'abort') net.set(this, (net.get(this) ?? 0) + 1)
    })
    const remove = vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
    ) {
      if (type === 'abort') net.set(this, (net.get(this) ?? 0) - 1)
    })
    try {
      const {completion, messages} = setup({messages: async () => ({data: [], error: null})})

      // #when it retries eight times
      startValidating(completion)
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 8)
      expect(messages.mock.calls.length).toBeGreaterThanOrEqual(8)

      // #then no single signal holds more than the one listener a request's own private signal carries:
      // a parent (the run signal, the lifecycle signal) that kept one listener per request would hold eight
      expect(Math.max(0, ...net.values())).toBeLessThanOrEqual(1)
      completion.dispose()
    } finally {
      add.mockRestore()
      remove.mockRestore()
    }
  })

  it('across requests that hit the cap, no abort listener accumulates on the run signal', async () => {
    // #given requests that never answer, abandoned at the cap and retried
    const {completion, runController, liveSessionIds} = setup({liveSessionIds: async () => hang()})
    const baseline = getEventListeners(runController.signal, 'abort').length

    // #when four cap-and-retry cycles pass
    startValidating(completion)
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await vi.advanceTimersByTimeAsync(CAP_MS + INTERVAL_MS)
      // #then at most the one request currently in flight is registered — abandoned ones left nothing
      expect(getEventListeners(runController.signal, 'abort').length).toBeLessThanOrEqual(baseline + 1)
    }

    // #and each cycle did issue a fresh request, and ending the run leaves nothing at all
    expect(liveSessionIds.mock.calls.length).toBeGreaterThanOrEqual(4)
    completion.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(getEventListeners(runController.signal, 'abort').length).toBe(baseline)
  })
})

describe('createDrainCompletion — a result that arrives after the run ended never admits', () => {
  it('dispose with a held request, then an admissible response: onAdmitted is never called and the timers are gone', async () => {
    // #given a validation held on its messages read
    let release!: (value: unknown) => void
    const held = new Promise<unknown>(resolve => {
      release = resolve
    })
    const {completion, onAdmitted} = setup({messages: async () => held})
    startValidating(completion)
    await vi.advanceTimersByTimeAsync(1)

    // #when the run ends, and only then the held request answers with fully admissible data
    completion.dispose()
    release({data: answeredTurns, error: null})
    await vi.advanceTimersByTimeAsync(CAP_MS * 2)

    // #then no late admission, and nothing keeps ticking
    expect(onAdmitted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the run signal aborting with a held request, then an admissible response: onAdmitted is never called', async () => {
    // #given a validation held on its messages read
    let release!: (value: unknown) => void
    const held = new Promise<unknown>(resolve => {
      release = resolve
    })
    const {completion, runController, onAdmitted} = setup({messages: async () => held})
    startValidating(completion)
    await vi.advanceTimersByTimeAsync(1)

    // #when the run's signal aborts (deadline or cancel), and then the held request answers
    runController.abort()
    release({data: answeredTurns, error: null})
    await vi.advanceTimersByTimeAsync(CAP_MS * 2)
    completion.dispose()

    // #then no admission
    expect(onAdmitted).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  // The request's own abort already turns a late result into "no evidence", so the closed/aborted re-check after
  // the requests settle is only reachable when the run ends in the few microtasks between the last request
  // resolving and the validation continuing. Rather than depend on an exact hop count, end the run after k
  // microtask hops for every k in a range that straddles that window: whenever the run ended first, the gate
  // must not admit; when admission legitimately happened first, it is allowed.
  describe.each([
    ['dispose', (ctx: ReturnType<typeof setup>) => ctx.completion.dispose()],
    ['an aborted run signal', (ctx: ReturnType<typeof setup>) => ctx.runController.abort()],
  ])('ending the run via %s at every microtask offset around the response', (_label, endRun) => {
    it.each(Array.from({length: 24}, (_, hops) => hops))(
      'ended %i microtask hops after the response: never admitted once ended',
      async hops => {
        // #given a validation held on its messages read
        let release!: (value: unknown) => void
        const held = new Promise<unknown>(resolve => {
          release = resolve
        })
        let ended = false
        const ctx = setup({messages: async () => held})
        const admittedAfterEnd = vi.fn()
        ctx.onAdmitted.mockImplementation(() => {
          if (ended) admittedAfterEnd()
        })
        startValidating(ctx.completion)
        await vi.advanceTimersByTimeAsync(1)

        // #when the response arrives and the run ends `hops` microtask hops later
        release({data: answeredTurns, error: null})
        let chain: Promise<void> = Promise.resolve()
        for (let hop = 0; hop < hops; hop += 1) chain = chain.then(() => undefined)
        chain
          .then(() => {
            ended = true
            endRun(ctx)
          })
          .catch(() => undefined)
        await vi.advanceTimersByTimeAsync(CAP_MS)

        // #then success is never admitted after the run ended
        expect(admittedAfterEnd).not.toHaveBeenCalled()
        ctx.completion.dispose()
      },
    )
  })
})

describe('createDrainCompletion — a notice credits only the job it follows (#1753 probe)', () => {
  /** An upstream-shaped message id (`id/id.ts:51-70`): larger `n`, created later. */
  const mid = (n: number): string => `msg_${n.toString(16).padStart(12, '0')}AAAAAAAAAAAAAA`

  const turns = (...notices: readonly number[]) => [
    {info: {id: 'msg-prompt', role: 'user', sessionID: ROOT}, parts: []},
    ...notices.map(n => ({
      info: {id: mid(n), role: 'user', sessionID: ROOT, time: {created: n}},
      parts: [{id: `prt-${n}`, type: 'text', synthetic: true, text: `<task id="${CHILD}" state="completed">`}],
    })),
    {
      info: {
        id: 'msg-reply',
        role: 'assistant',
        sessionID: ROOT,
        parentID: mid(notices.at(-1) ?? 0),
        time: {completed: 1},
        finish: 'stop',
      },
      parts: [],
    },
  ]

  it("an extension, the original job's notice, then a new start: not admitted until the new job's own notice arrives", async () => {
    // #given the first sight of the child is an extension at t=1000 and the original job's notice (t=1500) is seen
    let transcript = turns(1_500)
    const {completion, onAdmitted} = setup({messages: async () => ({data: transcript, error: null})})
    completion.noteDispatch(CHILD, 'adopted-extension', 1_000, mid(1_000))
    completion.noteNotice({childSessionId: CHILD, state: 'completed'}, mid(1_500), 'prt-1500')

    // #when a genuine new start follows at t=2000 and the gate validates repeatedly
    completion.noteDispatch(CHILD, 'reused', 2_000, mid(2_000))
    completion.noteRootIdle()
    completion.beginDrain()
    completion.requestValidation()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)

    // #then the surplus notice does not credit the new job
    expect(onAdmitted).not.toHaveBeenCalled()

    // #when the new job's own notice (t=2500) arrives and the parent answers it
    transcript = turns(1_500, 2_500)
    completion.noteNotice({childSessionId: CHILD, state: 'completed'}, mid(2_500), 'prt-2500')
    completion.noteRootIdle()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

    // #then it is admitted exactly once
    expect(onAdmitted).toHaveBeenCalledTimes(1)
    completion.dispose()
  })

  it('two notices that both follow only the first job cannot cover two jobs', async () => {
    // #given jobs dispatched at t=1000 and t=2000, and two notices (t=1500, t=1600) that follow only the first
    const transcript = turns(1_500, 1_600)
    const {completion, onAdmitted} = setup({messages: async () => ({data: transcript, error: null})})
    completion.noteDispatch(CHILD, 'adopted', 1_000, mid(1_000))
    completion.noteDispatch(CHILD, 'reused', 2_000, mid(2_000))
    completion.noteNotice({childSessionId: CHILD, state: 'completed'}, mid(1_500), 'prt-1500')
    completion.noteNotice({childSessionId: CHILD, state: 'completed'}, mid(1_600), 'prt-1600')

    // #when the gate validates repeatedly
    completion.noteRootIdle()
    completion.beginDrain()
    completion.requestValidation()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)

    // #then the count alone (2 notices for 2 jobs) is not enough: the second job has no notice of its own
    expect(onAdmitted).not.toHaveBeenCalled()
    completion.dispose()
  })
})
