/**
 * A terminal `session.error` from an OWNED CHILD marks that child `unknown` and the run continues: the root sees
 * the child's outcome through the task-completion notice, and drain settles or cancels the unknown entry. Only a
 * root (or session-less) error fails the run.
 */

import type {OpenCodeServerHandle, OwnershipEntryState} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {createOwnershipLedger} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {RunCoreError, runOpenCodeCore} from './run-core.js'

const ROOT = 'sess-123'
const CHILD = 'sess-child'
const STRAY = 'sess-stray'

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeSink(): DiscordStreamSink {
  return {
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: 0}),
    buffered: () => '',
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

function makeCoordinator(): PermissionCoordinator {
  const owned = new Set<string>()
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((id: string) => {
      owned.add(id)
    }),
    isOwned: vi.fn((id: string) => owned.has(id)),
  }
}

const taskNotice = {
  type: 'message.part.updated',
  properties: {
    sessionID: ROOT,
    part: {
      id: 'part-notice-1',
      messageID: 'msg-notice-1',
      sessionID: ROOT,
      type: 'text',
      synthetic: true,
      text: `<task id="${CHILD}" state="completed">\n<summary>Background task completed</summary>\n</task>`,
    },
  },
}
const completedFollowUp = [
  {info: {id: 'msg-prompt', role: 'user', sessionID: ROOT}, parts: [{type: 'text', text: 'prompt'}]},
  {
    info: {
      id: 'msg-reply-1',
      role: 'assistant',
      sessionID: ROOT,
      parentID: 'msg-prompt',
      time: {completed: 1},
      finish: 'stop',
    },
    parts: [],
  },
  {
    info: {id: 'msg-notice-1', role: 'user', sessionID: ROOT},
    parts: [{id: 'part-notice-1', type: 'text', synthetic: true, text: `<task id="${CHILD}" state="completed">`}],
  },
  {
    info: {
      id: 'msg-reply-2',
      role: 'assistant',
      sessionID: ROOT,
      parentID: 'msg-notice-1',
      time: {completed: 2},
      finish: 'stop',
    },
    parts: [],
  },
]

interface Run {
  readonly ledger: ReturnType<typeof createOwnershipLedger>
  readonly controller: AbortController
  readonly emit: (event: object) => void
  readonly outcome: () => 'pending' | 'resolved' | 'rejected'
  readonly error: () => unknown
  readonly onOwnershipChange: ReturnType<typeof vi.fn>
}

/** `status()` reports nothing live, so a reconcile pass settles any tracked direct child. */
function startRun(): Run {
  vi.useFakeTimers()
  const queue: object[] = []
  let wake: (() => void) | null = null
  async function* stream(): AsyncGenerator<object> {
    while (true) {
      const next = queue.shift()
      if (next === undefined) {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      } else {
        yield next
      }
    }
  }
  const client = {
    session: {
      create: vi.fn().mockResolvedValue({data: {id: ROOT}, error: null}),
      messages: vi.fn(async (args: {path: {id: string}}) => ({
        data: args.path.id === ROOT ? completedFollowUp : [],
        error: null,
      })),
      promptAsync: vi.fn().mockResolvedValue({data: {}, error: null}),
      children: vi.fn().mockResolvedValue({data: [{id: CHILD}], error: null}),
      status: vi.fn().mockResolvedValue({data: {}, error: null}),
      abort: vi.fn().mockResolvedValue({data: {}, error: null}),
    },
    event: {subscribe: vi.fn().mockResolvedValue({stream: stream()})},
    postSessionIdPermissionsPermissionId: vi.fn().mockResolvedValue({error: null}),
  }
  const handle = {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle

  const ledger = createOwnershipLedger()
  const controller = new AbortController()
  const onOwnershipChange = vi.fn()
  let state: 'pending' | 'resolved' | 'rejected' = 'pending'
  let failure: unknown
  runOpenCodeCore({
    handle,
    directory: '/workspace/repo',
    promptText: 'Fix the bug please',
    sink: makeSink(),
    signal: controller.signal,
    logger: makeLogger(),
    coordinator: makeCoordinator(),
    ownershipLedger: ledger,
    onOwnershipChange,
  }).then(
    () => {
      state = 'resolved'
    },
    (error: unknown) => {
      state = 'rejected'
      failure = error
    },
  )

  return {
    ledger,
    controller,
    emit: event => {
      queue.push(event)
      if (wake !== null) {
        const resume: () => void = wake
        wake = null
        resume()
      }
    },
    outcome: () => state,
    error: () => failure,
    onOwnershipChange,
  }
}

const adoptChild = {
  type: 'message.part.updated',
  properties: {
    sessionID: ROOT,
    part: {
      type: 'tool',
      tool: 'task',
      sessionID: ROOT,
      state: {status: 'completed', title: 'background task', metadata: {background: true, jobId: CHILD}},
    },
  },
}
const rootIdle = {type: 'session.idle', properties: {sessionID: ROOT}}
const authError = {name: 'ProviderAuthError', data: {providerID: 'p', message: 'x'}}
const abortedError = {name: 'MessageAbortedError', data: {message: 'Aborted'}}

function sessionError(error: unknown, sessionID?: string): object {
  return {type: 'session.error', properties: {...(sessionID === undefined ? {} : {sessionID}), error}}
}

function childState(run: Run): OwnershipEntryState | undefined {
  return run.ledger.snapshot().find(entry => entry.sessionId === CHILD)?.state
}

async function adopted(): Promise<Run> {
  const run = startRun()
  run.emit(adoptChild)
  await vi.advanceTimersByTimeAsync(100)
  return run
}

async function cancel(run: Run): Promise<void> {
  run.controller.abort()
  await vi.advanceTimersByTimeAsync(20_000)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a session.error on a session the run owns', () => {
  it('marks an owned child unknown on a terminal provider error and lets the run finish once drain settles it', async () => {
    // #given an adopted background child
    const run = await adopted()
    expect(childState(run)).toBe('outstanding')

    // #when the child fails terminally
    run.emit(sessionError(authError, CHILD))
    await vi.advanceTimersByTimeAsync(100)

    // #then the run goes on and the child is unconfirmed, with that claim persisted
    expect(run.outcome()).toBe('pending')
    expect(childState(run)).toBe('unknown')
    expect(run.onOwnershipChange).toHaveBeenLastCalledWith({rootSessionId: ROOT, ownedSessionIds: [CHILD]})

    // #when the root goes idle, reconciliation finds the child gone, and the completion turn arrives
    run.emit(rootIdle)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(childState(run)).toBe('settled')
    run.emit(taskNotice)
    run.emit(rootIdle)
    await vi.advanceTimersByTimeAsync(10_000)

    // #then the run completes instead of failing on the child's error
    expect(run.outcome()).toBe('resolved')
  })

  it('marks an owned child unknown when another client aborts it', async () => {
    // #given
    const run = await adopted()

    // #when the child's turn is aborted by a client other than the gateway
    run.emit(sessionError(abortedError, CHILD))
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(run.outcome()).toBe('pending')
    expect(childState(run)).toBe('unknown')

    await cancel(run)
  })

  it('still fails the run on a terminal error from the root', async () => {
    // #given
    const run = await adopted()

    // #when
    run.emit(sessionError(authError, ROOT))
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(run.outcome()).toBe('rejected')
    expect(run.error()).toBeInstanceOf(RunCoreError)
    expect((run.error() as RunCoreError).kind).toBe('session-error')
  })

  it('still fails the run on a terminal error that names no session', async () => {
    // #given
    const run = await adopted()

    // #when
    run.emit(sessionError(authError))
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(run.outcome()).toBe('rejected')
    expect((run.error() as RunCoreError).kind).toBe('session-error')
  })

  it('ignores an error from a session the run does not own', async () => {
    // #given
    const run = await adopted()

    // #when
    run.emit(sessionError(authError, STRAY))
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(run.outcome()).toBe('pending')
    expect(childState(run)).toBe('outstanding')

    await cancel(run)
  })

  it('keeps the overflow handling for a child: an unrecovered overflow still fails the run when the child goes idle', async () => {
    // #given
    const run = await adopted()

    // #when the child overflows its context; nothing compacts it, and it goes idle
    run.emit(sessionError({name: 'ContextOverflowError', data: {message: 'x'}}, CHILD))
    await vi.advanceTimersByTimeAsync(100)
    expect(run.outcome()).toBe('pending')
    expect(childState(run)).toBe('outstanding')
    run.emit({type: 'session.idle', properties: {sessionID: CHILD}})
    await vi.advanceTimersByTimeAsync(100)

    // #then
    expect(run.outcome()).toBe('rejected')
    expect((run.error() as RunCoreError).kind).toBe('session-error')
  })
})
