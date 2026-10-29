/**
 * Shared harness for the `run-core-v2*.test.ts` files.
 *
 * The frames are the real v2.2.0 captures from `@fro-bot/runtime/event-v2-fixtures` (probe run of 2026-10-28), moved
 * onto the session under test by `onSession`. Frames the probes could not capture are the runtime fixtures' derived
 * ones, built from the v2.2.0 schema. Nothing here is a V1 event.
 *
 * The fake server is a plain object satisfying `RemoteOpenCodeV2Client`: a scripted event stream the test pushes into,
 * an active set that `interrupt` empties by default, and call records. Every stream ends: tests close it or the run's
 * own bounds end it.
 */

import type {OwnershipLedger, RemoteOpenCodeV2Client, V2SessionOutcome} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {QuestionCoordinator} from '../approvals/question-coordinator.js'
import type {GatewayLogger} from '../discord/client.js'
import type {RunCoreV2Params} from './run-core-v2.js'
import type {RunCoreError} from './run-core.js'

import {err, ok} from '@fro-bot/runtime'
import {
  ENV_PERMISSION_ASKED_FRAME,
  EXECUTION_FAILED_FRAME,
  EXECUTION_INTERRUPTED_USER_FRAME,
  EXECUTION_STARTED_FRAME,
  EXECUTION_SUCCEEDED_FRAME,
  QUESTION_FORM_CREATED_FRAME,
  REASONING_FRAMES,
  RETRY_SCHEDULED_FRAME,
  SERVER_CONNECTED_FRAME,
  SESSION_MOVED_FRAME,
  SUBAGENT_BACKGROUND_SUCCESS_FRAME,
  SUBAGENT_NOTICE_ENQUEUED_FRAME,
  TEXT_DELTA_FRAME,
  TEXT_ENDED_FRAME,
  UNKNOWN_KIND_FORM_CREATED_FRAME,
} from '@fro-bot/runtime/event-v2-fixtures'
import {vi} from 'vitest'

import {runOpenCodeCoreV2} from './run-core-v2.js'

export const ROOT = 'ses_root'
export const CHILD = 'ses_child'
export const OTHER_CHILD = 'ses_other_child'
export const STRANGER = 'ses_stranger'
export const DIRECTORY = '/workspace/repos/o/r'

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

interface Frame {
  readonly type: string
  readonly data: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The same captured frame on another session. Rewrites every `sessionID` in `data`, including a form's. */
export function onSession<T extends Frame>(frame: T, sessionId: string): object {
  function retarget(value: unknown): unknown {
    if (!isRecord(value)) return value
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        key,
        key === 'sessionID' ? sessionId : key === 'form' ? retarget(inner) : inner,
      ]),
    )
  }
  return {...frame, data: retarget(frame.data)}
}

function withData<T extends Frame>(frame: T, data: Record<string, unknown>): object {
  return {...frame, data: {...(frame.data as Record<string, unknown>), ...data}}
}

export const SERVER_CONNECTED = SERVER_CONNECTED_FRAME
export const HEARTBEAT = {type: 'server.heartbeat'} as const

export const frames = {
  started: (session = ROOT) => onSession(EXECUTION_STARTED_FRAME, session),
  succeeded: (session = ROOT) => onSession(EXECUTION_SUCCEEDED_FRAME, session),
  failed: (session = ROOT, error: Record<string, unknown> = {}) => {
    const captured = EXECUTION_FAILED_FRAME.data as {error: Record<string, unknown>}
    return withData(onSession(EXECUTION_FAILED_FRAME, session) as Frame, {error: {...captured.error, ...error}})
  },
  interrupted: (session = ROOT, reason: 'inactivity' | 'shutdown' | 'superseded' | 'user' = 'user') =>
    withData(onSession(EXECUTION_INTERRUPTED_USER_FRAME, session) as Frame, {reason}),
  delta: (text: string, session = ROOT, ordinal = 0, messageId?: string) =>
    withData(onSession(TEXT_DELTA_FRAME, session) as Frame, {
      delta: text,
      ordinal,
      ...(messageId === undefined ? {} : {assistantMessageID: messageId}),
    }),
  textEnded: (text: string, session = ROOT, ordinal = 0, messageId?: string) =>
    withData(onSession(TEXT_ENDED_FRAME, session) as Frame, {
      text,
      ordinal,
      ...(messageId === undefined ? {} : {assistantMessageID: messageId}),
    }),
  reasoning: (session = ROOT) => REASONING_FRAMES.map(frame => onSession(frame, session)),
  retry: (session = ROOT) => onSession(RETRY_SCHEDULED_FRAME, session),
  moved: (session = ROOT) => onSession(SESSION_MOVED_FRAME, session),

  /** A direct tool call, in the captured envelope: input.started, called, success. */
  toolStarted: (name: string, id: string, session = ROOT) => ({
    type: 'session.tool.input.started',
    data: {sessionID: session, assistantMessageID: 'msg_tool', id, name},
  }),
  toolCalled: (id: string, input: Record<string, unknown>, session = ROOT) => ({
    type: 'session.tool.called',
    data: {sessionID: session, assistantMessageID: 'msg_tool', id, input, executed: false},
  }),
  toolSuccess: (id: string, session = ROOT, metadata: Record<string, unknown> = {}) => ({
    type: 'session.tool.success',
    data: {
      sessionID: session,
      assistantMessageID: 'msg_tool',
      id,
      content: [{type: 'text', text: 'ok'}],
      metadata,
      executed: false,
    },
  }),
  toolFailed: (id: string, session = ROOT) => ({
    type: 'session.tool.failed',
    data: {
      sessionID: session,
      assistantMessageID: 'msg_tool',
      id,
      error: {type: 'tool.execution', message: 'boom'},
      executed: false,
    },
  }),
  /** One `execute` call reporting its inner calls (shape of the P5 capture). */
  executeProgress: (id: string, calls: readonly {tool: string; status: string}[], session = ROOT) => ({
    type: 'session.tool.progress',
    data: {sessionID: session, assistantMessageID: 'msg_tool', id, metadata: {toolCalls: calls}},
  }),
  executeSuccess: (id: string, calls: readonly {tool: string; status: string}[], session = ROOT) => ({
    type: 'session.tool.success',
    data: {
      sessionID: session,
      assistantMessageID: 'msg_tool',
      id,
      content: [{type: 'text', text: '{}'}],
      metadata: {toolCalls: calls},
      executed: false,
    },
  }),
  /** The captured background `subagent` dispatch result, pointed at `child`. */
  dispatch: (child = CHILD, session = ROOT, id = 'call_dispatch') =>
    withData(onSession(SUBAGENT_BACKGROUND_SUCCESS_FRAME, session) as Frame, {
      id,
      metadata: {sessionID: child, status: 'running', truncated: false},
    }),

  permissionAsked: (requestId: string, session = ROOT, action = 'external_directory', resource = '/tmp/outside') =>
    withData(onSession(ENV_PERMISSION_ASKED_FRAME, session) as Frame, {
      id: requestId,
      action,
      resources: [resource],
      source: {type: 'tool', messageID: 'msg_tool', id: 'call_execute'},
    }),
  permissionReplied: (requestId: string, reply: 'always' | 'once' | 'reject', session = ROOT) => ({
    type: 'permission.replied',
    data: {sessionID: session, requestID: requestId, reply},
  }),
  questionForm: (formId = 'frm_1', session = ROOT) => {
    const created = onSession(QUESTION_FORM_CREATED_FRAME, session) as {data: {form: Record<string, unknown>}}
    return {...created, data: {form: {...created.data.form, id: formId}}}
  },
  unknownKindForm: (formId = 'frm_unknown', session = ROOT) => {
    const created = onSession(UNKNOWN_KIND_FORM_CREATED_FRAME, session) as {data: {form: Record<string, unknown>}}
    return {...created, data: {form: {...created.data.form, id: formId}}}
  },
  formReplied: (formId: string, answer: Record<string, unknown>, session = ROOT) => ({
    type: 'form.replied',
    data: {id: formId, sessionID: session, answer},
  }),
  formCancelled: (formId: string, session = ROOT) => ({type: 'form.cancelled', data: {id: formId, sessionID: session}}),

  /** The enqueued synthetic notice the parent receives when a child ends (derived from the P2 capture). */
  notice: (child = CHILD, state = 'completed', inboxId = 'msg_notice', session = ROOT) => ({
    ...SUBAGENT_NOTICE_ENQUEUED_FRAME,
    data: {
      inboxID: inboxId,
      sessionID: session,
      item: {
        type: 'synthetic',
        payload: {
          text: `<subagent sessionID="${child}" state="${state}">`,
          metadata: {source: 'subagent', childID: child, agent: 'General', state},
        },
        delivery: 'steer',
      },
    },
  }),
  delivered: (inboxId = 'msg_notice', session = ROOT) => ({
    type: 'session.inbox.delivered',
    data: {sessionID: session, inboxID: inboxId},
  }),
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

export function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

export interface SinkDouble {
  readonly append: (text: string) => void
  /** Everything appended so far. */
  readonly text: () => string
}

export function makeSink(onAppend: () => void = () => {}): SinkDouble {
  let buffer = ''
  return {
    append: vi.fn((text: string) => {
      onAppend()
      buffer += text
    }),
    text: () => buffer,
  }
}

export function makeCoordinator(): PermissionCoordinator {
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

export function makeQuestions(): QuestionCoordinator {
  return {
    onAsked: vi.fn().mockResolvedValue('registered'),
    onMalformed: vi.fn().mockResolvedValue(undefined),
    onEcho: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: RunCoreError}

export interface StartOptions {
  readonly controller?: AbortController
  readonly ownershipLedger?: OwnershipLedger
  readonly inactivityTimeoutMs?: number
  readonly streamSilenceTimeoutMs?: number
  readonly runId?: string
  readonly questions?: QuestionCoordinator
  readonly coordinator?: PermissionCoordinator
  readonly forms?: RunCoreV2Params['forms']
  readonly onActivity?: (summary: string) => void
  readonly onBusy?: (busy: boolean) => void
  readonly onOwnershipChange?: RunCoreV2Params['onOwnershipChange']
  readonly onHumanWaitTerminal?: RunCoreV2Params['onHumanWaitTerminal']
  /** Frames the server sends right after `server.connected`, before the test pushes more. */
  readonly initialFrames?: readonly object[]
  /** Called when `prompt` runs, before it resolves. */
  readonly onPrompt?: () => void
  /** The `prompt` call's reply. */
  readonly promptResult?: () => ReturnType<RemoteOpenCodeV2Client['prompt']>
  readonly createSessionResult?: () => ReturnType<RemoteOpenCodeV2Client['createSession']>
  readonly subscribeResult?: () => ReturnType<RemoteOpenCodeV2Client['subscribeEvents']>
  /** Sessions in the active list before any interrupt. Defaults to the root, so the interrupt has something to stop. */
  readonly active?: readonly string[]
  /** `session.active` reply per call, overriding the managed set (e.g. a root that turns up busy at a given time). */
  readonly activeReply?: () => Promise<Readonly<Record<string, {readonly type: string}>>>
  /** Children the list API reports for the root. */
  readonly children?: readonly string[]
  /** The persisted outcome `getSession` reports. Defaults to `interrupted` once an interrupt was sent, else none. */
  readonly outcome?: (interruptCalls: number) => V2SessionOutcome | null
  readonly interrupt?: (sessionId: string) => ReturnType<RemoteOpenCodeV2Client['interrupt']>
  /** Called by every `sink.append`; throwing from it makes the event loop body throw. */
  readonly onAppend?: () => void
}

export interface Run {
  readonly done: Promise<void>
  readonly outcome: () => Outcome | undefined
  readonly sink: SinkDouble
  readonly coordinator: PermissionCoordinator
  readonly logger: GatewayLogger
  readonly client: RemoteOpenCodeV2Client
  readonly emit: (...events: readonly object[]) => void
  readonly close: () => void
  /** Makes the open event stream reject with `error` on its next pull. */
  readonly failStream: (error: unknown) => void
  readonly prompt: ReturnType<typeof vi.fn>
  readonly interrupt: ReturnType<typeof vi.fn>
  readonly active: ReturnType<typeof vi.fn>
  readonly replyPermission: ReturnType<typeof vi.fn>
  readonly replyForm: ReturnType<typeof vi.fn>
  readonly cancelForm: ReturnType<typeof vi.fn>
  readonly subscribe: ReturnType<typeof vi.fn>
  readonly signalOfSubscription: () => AbortSignal | undefined
}

/** Starts the run under fake timers. The caller advances time. */
export function startRun(options: StartOptions = {}): Run {
  vi.useFakeTimers()
  const queue: object[] = [...(options.initialFrames ?? [])]
  let closed = false
  let streamFailure: {readonly error: unknown} | null = null
  let wake: (() => void) | null = null
  let subscriptionSignal: AbortSignal | undefined

  async function* stream(): AsyncGenerator<object> {
    // The server announces the stream first; the run sends its prompt only after reading it.
    yield SERVER_CONNECTED
    while (true) {
      if (streamFailure !== null) throw streamFailure.error
      const next = queue.shift()
      if (next !== undefined) {
        yield next
      } else if (closed) {
        return
      } else {
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    }
  }

  const active = new Set(options.active ?? [ROOT])
  const interrupt = vi.fn(async ({sessionId}: {sessionId: string}) => {
    if (options.interrupt !== undefined) return options.interrupt(sessionId)
    active.delete(sessionId)
    return ok({interrupted: true})
  })
  const prompt = vi.fn(async () => {
    options.onPrompt?.()
    return options.promptResult === undefined ? ok(undefined) : options.promptResult()
  })
  const activeFn = vi.fn(
    options.activeReply ?? (async () => Object.fromEntries([...active].map(id => [id, {type: 'running'}]))),
  )
  const subscribe = vi.fn(async (input: {readonly signal?: AbortSignal}) => {
    subscriptionSignal = input.signal
    return options.subscribeResult === undefined ? ok(stream() as AsyncIterable<unknown>) : options.subscribeResult()
  })
  const replyPermission = vi.fn().mockResolvedValue(ok(undefined))
  const replyForm = vi.fn().mockResolvedValue(ok(undefined))
  const cancelForm = vi.fn().mockResolvedValue(ok(undefined))

  const client = {
    session: {
      active: activeFn,
      list: vi.fn(async () => ({
        data: (options.children ?? []).map(id => ({id, parentID: ROOT, location: {directory: DIRECTORY}})),
      })),
    },
    createSession: vi.fn(options.createSessionResult ?? (async () => ok({id: ROOT}))),
    getSession: vi.fn(async () =>
      ok({
        id: ROOT,
        parentId: null,
        directory: DIRECTORY,
        outcome:
          options.outcome === undefined
            ? interrupt.mock.calls.length > 0
              ? ('interrupted' as const)
              : null
            : options.outcome(interrupt.mock.calls.length),
      }),
    ),
    prompt,
    interrupt,
    subscribeEvents: subscribe,
    replyPermission,
    replyForm,
    cancelForm,
  } as unknown as RemoteOpenCodeV2Client

  const logger = makeLogger()
  const sink = makeSink(options.onAppend)
  const coordinator = options.coordinator ?? makeCoordinator()
  let settled: Outcome | undefined
  const done = runOpenCodeCoreV2({
    client,
    directory: DIRECTORY,
    promptText: 'Fix the bug please',
    sink,
    signal: (options.controller ?? new AbortController()).signal,
    logger,
    coordinator,
    ...(options.runId === undefined ? {} : {runId: options.runId}),
    ...(options.questions === undefined ? {} : {questions: options.questions}),
    ...(options.forms === undefined ? {} : {forms: options.forms}),
    ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
    ...(options.inactivityTimeoutMs === undefined ? {} : {inactivityTimeoutMs: options.inactivityTimeoutMs}),
    ...(options.streamSilenceTimeoutMs === undefined ? {} : {streamSilenceTimeoutMs: options.streamSilenceTimeoutMs}),
    ...(options.onActivity === undefined ? {} : {onActivity: options.onActivity}),
    ...(options.onBusy === undefined ? {} : {onBusy: options.onBusy}),
    ...(options.onOwnershipChange === undefined ? {} : {onOwnershipChange: options.onOwnershipChange}),
    ...(options.onHumanWaitTerminal === undefined ? {} : {onHumanWaitTerminal: options.onHumanWaitTerminal}),
  }).then(
    () => {
      settled = {ok: true}
    },
    (error: unknown) => {
      settled = {ok: false, error: error as RunCoreError}
    },
  )

  function wakeStream(): void {
    if (wake !== null) {
      const resume: () => void = wake
      wake = null
      resume()
    }
  }

  return {
    done,
    outcome: () => settled,
    sink,
    coordinator,
    logger,
    client,
    emit: (...events) => {
      queue.push(...events)
      wakeStream()
    },
    close: () => {
      closed = true
      wakeStream()
    },
    failStream: error => {
      streamFailure = {error}
      wakeStream()
    },
    prompt,
    interrupt,
    active: activeFn,
    replyPermission,
    replyForm,
    cancelForm,
    subscribe,
    signalOfSubscription: () => subscriptionSignal,
  }
}

export function failure(run: Run): RunCoreError {
  const outcome = run.outcome()
  if (outcome === undefined || outcome.ok) throw new Error('expected the run to have failed')
  return outcome.error
}

export function succeeded(run: Run): boolean {
  return run.outcome()?.ok === true
}

export const authFailure = () => err({kind: 'auth', status: 401} as const)
