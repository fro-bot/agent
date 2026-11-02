import type {ActionOpenCodeV2Client, V2CallError} from '@fro-bot/runtime'
import {
  EXECUTION_STARTED_FRAME,
  EXECUTION_SUCCEEDED_FRAME,
  SERVER_CONNECTED_FRAME,
  TEXT_DELTA_FRAME,
  TEXT_ENDED_FRAME,
  TEXT_SESSION_ID,
} from '@fro-bot/runtime/event-v2-fixtures'
import {vi} from 'vitest'

/**
 * A scripted OpenCode V2 server for the Action loop's tests: an in-memory `ActionOpenCodeV2Client` whose event stream
 * is pushed by the test. Every method is a `vi.fn`, so a test reads the calls it cares about.
 */

export const ROOT_SESSION_ID = TEXT_SESSION_ID
export const DIRECTORY = '/workspace/repo'

export function frame(type: string, data: unknown): {readonly type: string; readonly data: unknown} {
  return {type, data}
}

export const SUCCEEDED = EXECUTION_SUCCEEDED_FRAME
export const STARTED = EXECUTION_STARTED_FRAME
export const CONNECTED = SERVER_CONNECTED_FRAME
export const TEXT_FRAMES = [TEXT_DELTA_FRAME, TEXT_ENDED_FRAME] as const

export interface EventPipe {
  readonly iterable: AsyncIterable<unknown>
  readonly push: (value: unknown) => void
  readonly end: () => void
  readonly fail: (error: Error) => void
}

export function createEventPipe(signal?: AbortSignal): EventPipe {
  const queue: unknown[] = []
  let waiting: ((result: IteratorResult<unknown>) => void) | null = null
  let rejectWaiting: ((error: Error) => void) | null = null
  let ended = false
  let failure: Error | null = null

  const settle = (): void => {
    if (waiting === null) return
    if (failure !== null && queue.length === 0) {
      rejectWaiting?.(failure)
    } else if (queue.length > 0) {
      waiting({value: queue.shift(), done: false})
    } else if (ended) {
      waiting({value: undefined, done: true})
    } else {
      return
    }
    waiting = null
    rejectWaiting = null
  }

  signal?.addEventListener('abort', () => {
    ended = true
    settle()
  })

  return {
    iterable: {
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiting = resolve
            rejectWaiting = reject
            settle()
          }),
        return: async () => {
          ended = true
          return {value: undefined, done: true}
        },
      }),
    },
    push: value => {
      queue.push(value)
      settle()
    },
    end: () => {
      ended = true
      settle()
    },
    fail: error => {
      failure = error
      settle()
    },
  }
}

export interface FakeServerOptions {
  /** Called for each accepted prompt (1-based). Push frames from here. */
  readonly onPrompt?: (attempt: number, pipe: EventPipe) => void
  /** Do not announce `server.connected`; the stream stays open. */
  readonly neverConnect?: boolean
  /** The first subscribed stream never announces itself and never ends; later ones are healthy. */
  readonly silentFirstStream?: boolean
  /** Close the stream without announcing it. */
  readonly endWithoutConnect?: boolean
  /** Per-call prompt results; a missing entry succeeds. */
  readonly promptResults?: readonly (V2CallError | null)[]
  /** Called for each prompt call that FAILS (1-based), as the server's events would arrive while the connection broke. */
  readonly onFailedPrompt?: (attempt: number, pipe: EventPipe) => void
  /** Subscription results; a missing entry succeeds. */
  readonly subscribeResults?: readonly (V2CallError | null)[]
  /** `waitSession` resolves only when this resolves; default resolves at once. */
  readonly waitGate?: Promise<void>
  readonly interruptResult?: {readonly interrupted: boolean}
}

export interface FakeServerOptions {
  /** Called for each accepted prompt (1-based). Push frames from here. */
  readonly onPrompt?: (attempt: number, pipe: EventPipe) => void
  /** Do not announce `server.connected`; the stream stays open. */
  readonly neverConnect?: boolean
  /** The first subscribed stream never announces itself and never ends; later ones are healthy. */
  readonly silentFirstStream?: boolean
  /** Close the stream without announcing it. */
  readonly endWithoutConnect?: boolean
  /** Per-call prompt results; a missing entry succeeds. */
  readonly promptResults?: readonly (V2CallError | null)[]
  /**
   * Per-call: the server admitted the prompt (and ran `onPrompt`) even though the call reports `promptResults`' error,
   * which is what a connection lost after admission looks like.
   */
  readonly admittedDespiteError?: readonly boolean[]
  /** Subscription results; a missing entry succeeds. */
  readonly subscribeResults?: readonly (V2CallError | null)[]
  /** `waitSession` resolves only when this resolves; default resolves at once. */
  readonly waitGate?: Promise<void>
  /** Overrides `waitSession` entirely: the 1-based call number and the signal of the call. */
  readonly waitResponder?: (
    call: number,
    signal: AbortSignal | undefined,
  ) => Promise<
    {readonly success: true; readonly data: undefined} | {readonly success: false; readonly error: V2CallError}
  >
  readonly interruptResult?: {readonly interrupted: boolean}
  /**
   * What `GET /api/session/:id/message` answers, per call (the last entry repeats). A failed prompt whose request the
   * server admitted shows up here as a user message with the prompt's text.
   */
  readonly recentUserMessages?: readonly (readonly {id: string; text: string; createdAt: number}[] | V2CallError)[]
}

export interface FakeServer {
  readonly client: ActionOpenCodeV2Client
  readonly pipes: EventPipe[]
  readonly calls: {
    readonly createSession: ReturnType<typeof vi.fn>
    readonly prompt: ReturnType<typeof vi.fn>
    readonly subscribeEvents: ReturnType<typeof vi.fn>
    readonly replyPermission: ReturnType<typeof vi.fn>
    readonly cancelForm: ReturnType<typeof vi.fn>
    readonly interrupt: ReturnType<typeof vi.fn>
    readonly updateSession: ReturnType<typeof vi.fn>
    readonly switchAgent: ReturnType<typeof vi.fn>
    readonly switchModel: ReturnType<typeof vi.fn>
    readonly waitSession: ReturnType<typeof vi.fn>
  }
  /** Order in which routes were called, for sequencing assertions. */
  readonly order: string[]
  readonly getSession: ReturnType<typeof vi.fn>
  readonly sessionActive: ReturnType<typeof vi.fn>
}

async function* neverEndingStream(): AsyncGenerator<unknown> {
  await new Promise<never>(() => undefined)
}

export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const pipes: EventPipe[] = []
  const order: string[] = []
  let promptCount = 0
  let subscribeCount = 0
  let waitCount = 0

  const ok = <T>(data: T): {readonly success: true; readonly data: T} => ({success: true, data})
  const fail = (error: V2CallError): {readonly success: false; readonly error: V2CallError} => ({success: false, error})

  const calls = {
    createSession: vi.fn(async (_input: unknown) => {
      order.push('createSession')
      return ok({id: ROOT_SESSION_ID})
    }),
    subscribeEvents: vi.fn(async (input: {signal?: AbortSignal}) => {
      order.push('subscribe')
      subscribeCount += 1
      const failed = options.subscribeResults?.[subscribeCount - 1] ?? null
      if (failed !== null) return fail(failed)
      if (options.silentFirstStream === true && subscribeCount === 1) return ok(neverEndingStream())
      const pipe = createEventPipe(input.signal)
      pipes.push(pipe)
      if (options.endWithoutConnect === true) pipe.end()
      else if (options.neverConnect !== true) pipe.push(CONNECTED)
      return ok(pipe.iterable)
    }),
    prompt: vi.fn(async (_input: unknown) => {
      order.push('prompt')
      promptCount += 1
      const failed = options.promptResults?.[promptCount - 1] ?? null
      if (failed !== null) {
        // The events the server would emit while the connection broke arrive on the stream the attempt is watching.
        const failedPipe = pipes.at(-1)
        if (failedPipe !== undefined) options.onFailedPrompt?.(promptCount, failedPipe)
        // Let the attempt's event loop read what was just emitted before the failure is reported, as it would for events
        // that were already in flight when the connection broke.
        for (let tick = 0; tick < 20; tick++) await Promise.resolve()
        return fail(failed)
      }
      const pipe = pipes.at(-1)
      if (pipe !== undefined) options.onPrompt?.(promptCount, pipe)
      return ok(undefined)
    }),
    replyPermission: vi.fn(async (_input: unknown) => ok(undefined)),
    cancelForm: vi.fn(async (_input: unknown) => ok(undefined)),
    interrupt: vi.fn(async (_input: unknown) => {
      order.push('interrupt')
      return ok(options.interruptResult ?? {interrupted: true})
    }),
    updateSession: vi.fn(async (_input: unknown) => ok(undefined)),
    switchAgent: vi.fn(async (_input: unknown) => ok(undefined)),
    switchModel: vi.fn(async (_input: unknown) => ok(undefined)),
    waitSession: vi.fn(async (input: {signal?: AbortSignal}) => {
      waitCount += 1
      if (options.waitResponder !== undefined) return options.waitResponder(waitCount, input.signal)
      if (options.waitGate !== undefined) await options.waitGate
      return ok(undefined)
    }),
  }

  const sessionActive = vi.fn(async (_input?: unknown): Promise<Record<string, unknown>> => ({}))
  const getSession = vi.fn(async (_input?: unknown): Promise<unknown> => fail({kind: 'http', status: 404}))
  const client = {
    session: {active: sessionActive, list: vi.fn(async () => ({data: []}))},
    getSession,
    replyForm: vi.fn(async () => ok(undefined)),
    listSessionInbox: vi.fn(async () => ok({queued: 0})),
    listShells: vi.fn(async () => ok([])),
    getShell: vi.fn(async () => fail({kind: 'http', status: 404})),
    deleteShell: vi.fn(async () => ok(undefined)),
    addSyntheticMessage: vi.fn(async () => ok(undefined)),
    ...calls,
  } as unknown as ActionOpenCodeV2Client

  return {client, pipes, calls, order, getSession, sessionActive}
}

/** The frames of a plain successful turn (text, then root success). */
export function succeedWithText(pipe: EventPipe): void {
  pipe.push(STARTED)
  for (const item of TEXT_FRAMES) pipe.push(item)
  pipe.push(SUCCEEDED)
}
