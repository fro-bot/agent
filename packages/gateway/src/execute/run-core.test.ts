/**
 * Tests for `runOpenCodeCore`.
 *
 * Convention: `as unknown as <Type>` for test doubles is permitted per gateway
 * test pattern (mirrors `streaming.test.ts` / `mentions.test.ts`).
 *
 * All network calls are faked via `OpenCodeServerHandle` test doubles — no real
 * SDK client is constructed in these tests.
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator} from '../approvals/coordinator.js'
import type {QuestionSideEffects} from '../approvals/question-registry.js'
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {createOwnershipLedger, DEFAULT_LEDGER_RECONCILE_INTERVAL_MS} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createQuestionCoordinator} from '../approvals/question-coordinator.js'
import {MAX_OPTIONS_PER_QUESTION, MAX_QUESTIONS_PER_REQUEST} from '../approvals/question-detail.js'
import {createQuestionRegistry} from '../approvals/question-registry.js'
import {createRequestGate} from '../approvals/request-gate.js'
import {createDiscordStreamSink} from '../discord/streaming.js'
import {createWebReplySink} from '../web/operator/web-sinks.js'
import {RunCoreError, runOpenCodeCore, wrapLedgerWithHooks} from './run-core.js'

// ---------------------------------------------------------------------------
// Test-double helpers
// ---------------------------------------------------------------------------

/** A fake sink that records appended text and always resolves flush. */
function makeSink(): DiscordStreamSink & {readonly _appended: string[]} {
  const appended: string[] = []
  let buffer = ''
  return {
    _appended: appended,
    append: (text: string) => {
      appended.push(text)
      buffer += text
    },
    flush: vi.fn().mockResolvedValue({kind: 'sent', charCount: buffer.length}),
    buffered: () => buffer,
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
  }
}

/** Silent logger for tests. */
function makeLogger(): GatewayLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

/** Build an async generator that yields the given events then terminates. */
async function* makeEventStream(events: readonly object[]): AsyncGenerator<object> {
  for (const event of events) {
    yield event
  }
}

/**
 * Async generator that yields one initial event then hangs forever.
 * Used by inactivity-timeout tests that need a stream that never completes.
 */
async function* hangingStreamAfterFirst(firstEvent: object): AsyncGenerator<object> {
  yield firstEvent
  await new Promise<void>(() => {
    /* never resolves */
  })
}

/** A controllable async event stream a test can push events onto one at a time. */
function makeControlledStream(): {
  readonly stream: AsyncGenerator<object>
  readonly emitNext: (event: object) => void
} {
  const eventQueue: object[] = []
  let resolveNext: (() => void) | null = null
  async function* controlledStream(): AsyncGenerator<object> {
    while (true) {
      if (eventQueue.length > 0) {
        const next = eventQueue.shift()
        if (next === undefined) break
        yield next
      } else {
        await new Promise<void>(resolve => {
          resolveNext = resolve
        })
      }
    }
  }
  const emitNext = (event: object) => {
    eventQueue.push(event)
    if (resolveNext !== null) {
      const r = resolveNext
      resolveNext = null
      r()
    }
  }
  return {stream: controlledStream(), emitNext}
}

/** Standard "session created" response. */
async function sessionCreateOk(id = 'sess-123') {
  return Promise.resolve({data: {id}, error: null})
}

/** Standard "prompt sent" response. */
async function promptAsyncOk() {
  return Promise.resolve({data: {}, error: null})
}

/** Standard "event subscribed" response wrapping an async event stream. */
async function subscribeOk(events: readonly object[]) {
  return Promise.resolve({stream: makeEventStream(events)})
}

// ---------------------------------------------------------------------------
// Event factory helpers — match the PROVEN action-tier event shapes
// ---------------------------------------------------------------------------

/** `message.part.delta` with object delta {type:'text', text:string} */
function partDeltaObjectEvent(text: string, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.delta',
    properties: {sessionID, delta: {type: 'text', text}, field: 'text'},
  }
}

/** `message.part.delta` with plain-string delta (field === 'text') */
function partDeltaStringEvent(text: string, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.delta',
    properties: {sessionID, delta: text, field: 'text'},
  }
}

/** `session.next.text.delta` with plain-string delta */
function nextTextDeltaStringEvent(text: string, sessionID = 'sess-123'): object {
  return {
    type: 'session.next.text.delta',
    properties: {sessionID, delta: text},
  }
}

/** `session.next.text.delta` with object delta {type:'text', text:string} */
function nextTextDeltaObjectEvent(text: string, sessionID = 'sess-123'): object {
  return {
    type: 'session.next.text.delta',
    properties: {sessionID, delta: {type: 'text', text}},
  }
}

/** `session.next.tool.called` */
function toolCalledEvent(callID: string, tool: string, input: object, sessionID = 'sess-123'): object {
  return {
    type: 'session.next.tool.called',
    properties: {sessionID, callID, tool, input},
  }
}

/** `session.next.tool.success` */
function toolSuccessEvent(callID: string, structured: object | null = null, sessionID = 'sess-123'): object {
  return {
    type: 'session.next.tool.success',
    properties: {
      sessionID,
      callID,
      ...(structured === null ? {} : {structured}),
    },
  }
}

/**
 * `message.part.updated` with partType:'tool' — current OpenCode event contract (tool progress via message.part.updated).
 * The session ID is embedded in the part (mirrors streaming.ts:242 guard).
 */
function partUpdatedToolEvent(tool: string, status: string, state: object, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {type: 'tool', tool, sessionID, state: {status, ...state}},
    },
  }
}

/**
 * `message.part.updated` with partType:'text' — must NOT produce a 🔧 line.
 * Text streaming is handled by `message.part.delta`; this guard test ensures
 * the new branch never double-renders text parts.
 */
function partUpdatedTextEvent(text: string, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {type: 'text', text, sessionID},
    },
  }
}

/** `session.idle` event for a given session. */
function sessionIdleEvent(sessionID: string): object {
  return {type: 'session.idle', properties: {sessionID}}
}

/**
 * Factory: `message.part.updated` with a reasoning part carrying an `id`.
 * Used to register a reasoning partID in the suppression set.
 */
function reasoningPartUpdatedEvent(partId: string, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        type: 'reasoning',
        id: partId,
        sessionID,
        text: 'I am thinking about this...',
      },
    },
  }
}

/**
 * Factory: `message.part.delta` with a specific `partID` in properties.
 * Used to simulate both reasoning deltas (suppressed) and text deltas (passed through).
 */
function partDeltaWithPartId(text: string, partId: string, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.delta',
    properties: {sessionID, partID: partId, delta: {type: 'text', text}, field: 'text'},
  }
}

/** `message.part.delta` carrying a message id and (optionally) a part id. */
function partDeltaInMessage(text: string, messageID: string, partID: string | null, sessionID = 'sess-123'): object {
  return {
    type: 'message.part.delta',
    properties: {sessionID, messageID, ...(partID === null ? {} : {partID}), delta: text, field: 'text'},
  }
}

/** Legacy `session.next.text.delta` with the identity the real event carries. */
function legacyTextDelta(text: string, assistantMessageID: string, textID: string, sessionID = 'sess-123'): object {
  return {
    type: 'session.next.text.delta',
    properties: {sessionID, assistantMessageID, textID, delta: text},
  }
}

async function runSegmentEvents(events: readonly object[], coordinator = makeCoordinator()) {
  const sink = makeSink()
  const handle = makeHandle({subscribe: async () => subscribeOk([...events, sessionIdleEvent('sess-123')])})
  await runOpenCodeCore({...buildParams(handle), sink, coordinator})
  return sink
}

/** `session.error` event for a given session. */
function sessionErrorEvent(sessionID: string, error = 'LLM error'): object {
  return {type: 'session.error', properties: {sessionID, error}}
}

/**
 * `message.part.updated` for a completed `task` tool call carrying
 * `metadata.background === true` and `metadata.jobId` — the observable signal
 * `runOpenCodeCore` uses to adopt a background dispatch into the ownership ledger.
 */
function backgroundTaskCompletedEvent(jobId: string, sessionID = 'sess-123', title = 'background task'): object {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        type: 'tool',
        tool: 'task',
        sessionID,
        state: {status: 'completed', title, metadata: {background: true, jobId}},
      },
    },
  }
}

/**
 * Upstream's injected background-task notice (`tool/task.ts` `inject`): a whole synthetic text part on a
 * root user message, rendered as `<task id="{childSessionId}" state="completed|error">`. No `part.time`.
 */
function taskNoticeEvent(
  childId: string,
  options: {
    readonly state?: 'completed' | 'error'
    readonly messageID?: string
    readonly partID?: string
    readonly sessionID?: string
  } = {},
): object {
  const {state = 'completed', messageID = 'msg-notice-1', partID = 'part-notice-1', sessionID = 'sess-123'} = options
  return {
    type: 'message.part.updated',
    properties: {
      sessionID,
      part: {
        id: partID,
        messageID,
        sessionID,
        type: 'text',
        synthetic: true,
        text: `<task id="${childId}" state="${state}">\n<summary>Background task ${state}</summary>\n</task>`,
      },
    },
  }
}

/** REST `session.messages` shape of a persisted root turn: the prompt answered, then an injected notice answered. */
function completedFollowUpMessages(
  childIds: readonly string[],
  noticeMessageId = 'msg-notice-1',
  sessionID = 'sess-123',
): readonly object[] {
  return [
    {info: {id: 'msg-prompt', role: 'user', sessionID}, parts: [{type: 'text', text: 'prompt'}]},
    {
      info: {
        id: 'msg-reply-1',
        role: 'assistant',
        sessionID,
        parentID: 'msg-prompt',
        time: {completed: 1},
        finish: 'stop',
      },
      parts: [],
    },
    {
      info: {id: noticeMessageId, role: 'user', sessionID},
      parts: childIds.map((childId, index) => ({
        id: `part-notice-${index + 1}`,
        type: 'text',
        synthetic: true,
        text: `<task id="${childId}" state="completed">`,
      })),
    },
    {
      info: {
        id: 'msg-reply-2',
        role: 'assistant',
        sessionID,
        parentID: noticeMessageId,
        time: {completed: 2},
        finish: 'stop',
      },
      parts: [],
    },
  ]
}

/** `session.messages` handler: the root's persisted turns, and nothing for any other session. */
function rootMessages(messages: readonly object[]): (args: unknown) => Promise<unknown> {
  return async args => {
    const id = (args as {readonly path?: {readonly id?: string}}).path?.id
    return {data: id === 'sess-123' ? messages : [], error: null}
  }
}

/**
 * Build a minimal `OpenCodeServerHandle` test double.
 * All SDK methods are vi.fn() by default; callers override what they need.
 *
 * `postPermissionReply` overrides `postSessionIdPermissionsPermissionId` — the
 * endpoint run-core calls to reject a permission ask in autonomous-low-risk mode.
 * Defaults to a resolved `{error: null}` response so tests that don't care about
 * it don't need to set it up.
 */
function makeHandle(
  overrides: {
    readonly sessionCreate?: () => Promise<unknown>
    readonly promptAsync?: (args: unknown) => Promise<unknown>
    readonly subscribe?: (args: unknown) => Promise<unknown>
    readonly postPermissionReply?: (args: unknown) => Promise<unknown>
    /** `client.session.children` — used by the ledger reconciler (drain tests). */
    readonly sessionChildren?: (args: unknown) => Promise<unknown>
    /** `client.session.status` — used by the ledger reconciler (drain tests). */
    readonly sessionStatus?: (args: unknown) => Promise<unknown>
    /** `client.session.abort` — used by the drain-deadline cancellation path. */
    readonly sessionAbort?: (args: unknown) => Promise<unknown>
    /** `client.session.messages` — used by the drain-completion REST validation. */
    readonly sessionMessages?: (args: unknown) => Promise<unknown>
  } = {},
): OpenCodeServerHandle {
  const sessionCreate = overrides.sessionCreate ?? (async () => sessionCreateOk())
  const promptAsync = overrides.promptAsync ?? (async () => promptAsyncOk())
  const subscribe = overrides.subscribe ?? (async () => subscribeOk([sessionIdleEvent('sess-123')]))
  const postPermissionReply = overrides.postPermissionReply ?? (async () => ({error: null}))
  const sessionChildren = overrides.sessionChildren ?? (async () => ({data: [], error: null}))
  const sessionStatus = overrides.sessionStatus ?? (async () => ({data: {}, error: null}))
  const sessionAbort = overrides.sessionAbort ?? (async () => ({data: {}, error: null}))
  const sessionMessages = overrides.sessionMessages ?? (async () => ({data: [], error: null}))

  const client = {
    session: {
      create: vi.fn().mockImplementation(sessionCreate),
      messages: vi.fn().mockImplementation(sessionMessages),
      promptAsync: vi.fn().mockImplementation(promptAsync),
      children: vi.fn().mockImplementation(sessionChildren),
      status: vi.fn().mockImplementation(sessionStatus),
      abort: vi.fn().mockImplementation(sessionAbort),
    },
    event: {
      subscribe: vi.fn().mockImplementation(subscribe),
    },
    postSessionIdPermissionsPermissionId: vi.fn().mockImplementation(postPermissionReply),
  }

  return {
    client,
    server: {url: 'http://workspace:9200', close: vi.fn()},
    shutdown: vi.fn(),
  } as unknown as OpenCodeServerHandle
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_PARAMS = {
  directory: '/workspace/repo',
  promptText: 'Fix the bug please',
}

function buildParams(
  handle: OpenCodeServerHandle,
  overrides: Partial<typeof BASE_PARAMS & {approvalMode: 'approval-required'}> = {},
): Parameters<typeof runOpenCodeCore>[0] {
  return {
    handle,
    directory: overrides.directory ?? BASE_PARAMS.directory,
    promptText: overrides.promptText ?? BASE_PARAMS.promptText,
    sink: makeSink(),
    signal: new AbortController().signal,
    logger: makeLogger(),
    ...(overrides.approvalMode === undefined ? {} : {approvalMode: overrides.approvalMode}),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Build a fake PermissionCoordinator with vi.fn() methods.
 *
 * `isOwned` models a real coordinator's ownership set: it starts empty and
 * grows via `addOwnedSession` calls (run-core registers the root session id
 * this way immediately after session creation). Pass `extraOwned` to
 * pre-adopt descendant session ids the way a future ledger-adoption unit
 * would, so tests can exercise descendant routing without that wiring.
 */
function makeCoordinator(extraOwned: readonly string[] = []): PermissionCoordinator {
  const owned = new Set<string>(extraOwned)
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
    addOwnedSession: vi.fn((sessionID: string) => {
      owned.add(sessionID)
    }),
    isOwned: vi.fn((sessionID: string) => owned.has(sessionID)),
  }
}

/** `permission.asked` event for a given session. */
function permissionAskedEvent(requestID: string, sessionID = 'sess-123', permission = 'bash'): object {
  return {
    type: 'permission.asked',
    properties: {
      id: requestID,
      sessionID,
      permission,
      patterns: [],
      tool: permission,
    },
  }
}

/** `permission.replied` event for a given session. */
function permissionRepliedEvent(
  requestID: string,
  reply: 'once' | 'always' | 'reject' = 'once',
  sessionID = 'sess-123',
): object {
  return {
    type: 'permission.replied',
    properties: {sessionID, requestID, reply},
  }
}

// Question-event helpers (module scope; used by the 'question events' tests)

function questionAskedEvent(requestID: string, sessionID = 'sess-123', text = 'Which environment?'): object {
  return {
    type: 'question.asked',
    properties: {
      id: requestID,
      sessionID,
      questions: [{question: text, header: 'Env', options: [{label: 'staging', description: 'Deploy to staging'}]}],
    },
  }
}

function questionRepliedEvent(requestID: string, sessionID = 'sess-123', answers = [['staging']]): object {
  return {type: 'question.replied', properties: {sessionID, requestID, answers}}
}

function questionRejectedEvent(requestID: string, sessionID = 'sess-123'): object {
  return {type: 'question.rejected', properties: {sessionID, requestID}}
}

function loggedText(logger: GatewayLogger): string {
  return [logger.debug, logger.info, logger.warn, logger.error]
    .flatMap(fn => vi.mocked(fn).mock.calls.map(call => JSON.stringify(call)))
    .join('\n')
}

describe('runOpenCodeCore', () => {
  describe('happy path — text deltas + session.idle', () => {
    it('resolves without throwing when session.idle is received', async () => {
      // #given — coordinator required (approval-required is the only supported mode)
      const handle = makeHandle()
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })

    it('appends text from message.part.delta (object delta)', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([partDeltaObjectEvent('Hello'), partDeltaObjectEvent(' world'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toEqual(['Hello', ' world'])
      expect(sink.buffered()).toBe('Hello world')
    })

    it('appends text from message.part.delta (plain string delta, field=text)', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([partDeltaStringEvent('Hi'), partDeltaStringEvent(' there'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toEqual(['Hi', ' there'])
    })

    it('appends text from session.next.text.delta (plain string)', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            nextTextDeltaStringEvent('Alpha'),
            nextTextDeltaStringEvent(' Beta'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toEqual(['Alpha', ' Beta'])
    })

    it('appends text from session.next.text.delta (object delta)', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([nextTextDeltaObjectEvent('Gamma'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toEqual(['Gamma'])
    })

    it('ignores message.part.delta from other sessions', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([partDeltaObjectEvent('ignored', 'other-session'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toHaveLength(0)
    })

    it('ignores session.next.text.delta from other sessions', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([nextTextDeltaStringEvent('ignored', 'other-session'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toHaveLength(0)
    })

    it('skips session.idle from a different session', async () => {
      // #given
      const sink = makeSink()
      const events = [
        {type: 'session.idle', properties: {sessionID: 'other-session'}},
        partDeltaObjectEvent('real text'),
        sessionIdleEvent('sess-123'),
      ]
      const handle = makeHandle({subscribe: async () => subscribeOk(events)})
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      const p = runOpenCodeCore(params).then(() => {
        // resolvedEarly check — should have appended before idle resolved
      })
      await p

      // #then — resolved only after receiving the matching session.idle
      expect(sink._appended).toContain('real text')
    })
  })

  describe('tool call progress (session.next.tool.called + session.next.tool.success)', () => {
    it('appends a progress line for a bash tool using input.command as title', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'bash', {command: 'pnpm test'}),
            toolSuccessEvent('call-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summarizer renders bash command inline (not raw 🔧 format)
      const combined = sink.buffered()
      expect(combined).toContain('pnpm test')
    })

    it('uses input.cmd as fallback for bash when command is absent (side-effecting command)', async () => {
      // #given — uses a side-effecting command so it is not hidden by read-only bash filtering
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'bash', {cmd: 'pnpm install'}),
            toolSuccessEvent('call-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('pnpm install')
    })

    it('bash tool: input.command is shown inline (summarizer uses command, not structured.title)', async () => {
      // #given — bash summarizer renders the command inline; structured.title is not used for bash
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'bash', {command: 'some command'}),
            toolSuccessEvent('call-1', {title: 'Structured Title'}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — bash summarizer renders the command inline
      expect(sink.buffered()).toContain('some command')
    })

    it('non-bash MCP tool: summarizer renders input fields as fallback', async () => {
      // #given — read_file is not in the hidden-tools list; MCP fallback renders input fields
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'read_file', {path: '/foo/bar.ts'}),
            toolSuccessEvent('call-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — MCP fallback renders input fields (not raw 🔧 format)
      expect(sink.buffered()).toContain('path')
      expect(sink.buffered()).not.toContain('🔧')
    })

    it('uses input.title when present for non-bash tools', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'edit_file', {title: 'Fix the handler', path: '/x.ts'}),
            toolSuccessEvent('call-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('Fix the handler')
    })

    it('ignores tool events from other sessions', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-x', 'bash', {command: 'rm -rf /'}, 'other-session'),
            toolSuccessEvent('call-x', null, 'other-session'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — no progress line appended
      expect(sink._appended).toHaveLength(0)
    })
  })

  describe('tool call progress (message.part.updated — current OpenCode event contract)', () => {
    it('appends a progress line for a bash tool using input.command (side-effecting command)', async () => {
      // #given — bash summarizer renders the command inline (not the tool name)
      // Uses a side-effecting command (pnpm build) so it is not hidden by read-only bash filtering
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'completed', {
              title: 'pnpm build',
              input: {command: 'pnpm build'},
              output: '',
            }),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summarizer renders command inline
      const combined = sink.buffered()
      expect(combined).toContain('pnpm build')
    })

    it('falls back to input.command when state.title is absent', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'completed', {input: {command: 'pnpm test'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('pnpm test')
    })

    it('falls back to input.cmd when command is absent (side-effecting command)', async () => {
      // #given — uses a side-effecting command so it is not hidden by read-only bash filtering
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'completed', {input: {cmd: 'pnpm install'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('pnpm install')
    })

    it('non-bash MCP tool: summarizer renders input fields as fallback when state.title is absent', async () => {
      // #given — read_file is not in the hidden-tools list; MCP fallback renders input fields
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('read_file', 'completed', {input: {path: '/foo/bar.ts'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — MCP fallback renders input fields (not raw 🔧 format)
      expect(sink.buffered()).toContain('path')
      expect(sink.buffered()).not.toContain('🔧')
    })

    it('does NOT emit a tool line for partType text (no double-render)', async () => {
      // #given — message.part.updated with type:'text' must not produce a 🔧 line
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([partUpdatedTextEvent('some text content'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — no 🔧 progress line; text part is handled by message.part.delta, not here
      expect(sink._appended).toHaveLength(0)
    })

    it('ignores tool events from other sessions', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent(
              'bash',
              'completed',
              {title: 'rm -rf /', input: {command: 'rm -rf /'}, output: ''},
              'other-session',
            ),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — no progress line appended
      expect(sink._appended).toHaveLength(0)
    })

    it('ignores tool parts that are not yet completed (pending/running)', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'running', {input: {command: 'sleep 1'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — no progress line for non-completed state
      expect(sink._appended).toHaveLength(0)
    })
  })

  describe('header + directory threading', () => {
    it('threads directory to promptAsync query', async () => {
      // #given
      const handle = makeHandle()
      const params = {...buildParams(handle, {directory: '/repos/myrepo'}), coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — promptAsync must receive directory in query
      const {session} = handle.client as unknown as {session: {promptAsync: ReturnType<typeof vi.fn>}}
      const callArgs = (session.promptAsync.mock.calls[0] as [{query?: {directory?: string}}])[0]
      expect(callArgs.query?.directory).toBe('/repos/myrepo')
    })

    it('threads directory to event.subscribe query', async () => {
      // #given
      const handle = makeHandle()
      const params = {...buildParams(handle, {directory: '/repos/myrepo'}), coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — subscribe must receive directory in query
      const {event} = handle.client as unknown as {event: {subscribe: ReturnType<typeof vi.fn>}}
      const callArgs = (event.subscribe.mock.calls[0] as [{query?: {directory?: string}}])[0]
      expect(callArgs.query?.directory).toBe('/repos/myrepo')
    })

    it('threads directory to session.create query', async () => {
      // #given
      const handle = makeHandle()
      const params = {...buildParams(handle, {directory: '/repos/myrepo'}), coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — session.create must receive directory in query so the SSE
      // publisher and subscriber are scoped to the same directory; without this
      // the event stream never delivers events for the created session.
      const {session} = handle.client as unknown as {session: {create: ReturnType<typeof vi.fn>}}
      const callArgs = (session.create.mock.calls[0] as [{query?: {directory?: string}}])[0]
      expect(callArgs.query?.directory).toBe('/repos/myrepo')
    })
  })

  describe('abort signal threading — SDK calls receive the timeout signal', () => {
    it('passes the AbortSignal to session.create', async () => {
      // #given — use a real AbortController so we can inspect the signal identity
      const controller = new AbortController()
      const handle = makeHandle()
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — session.create must have received the same signal object
      const {session} = handle.client as unknown as {session: {create: ReturnType<typeof vi.fn>}}
      const callArgs = (session.create.mock.calls[0] as [{signal?: AbortSignal}])[0]
      expect(callArgs.signal).toBe(controller.signal)
    })

    it('passes the AbortSignal to event.subscribe', async () => {
      // #given
      const controller = new AbortController()
      const handle = makeHandle()
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — event.subscribe must have received the same signal object
      const {event} = handle.client as unknown as {event: {subscribe: ReturnType<typeof vi.fn>}}
      const callArgs = (event.subscribe.mock.calls[0] as [{signal?: AbortSignal}])[0]
      expect(callArgs.signal).toBe(controller.signal)
    })

    it('passes the AbortSignal to session.promptAsync', async () => {
      // #given
      const controller = new AbortController()
      const handle = makeHandle()
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — promptAsync must have received the same signal object
      const {session} = handle.client as unknown as {session: {promptAsync: ReturnType<typeof vi.fn>}}
      const callArgs = (session.promptAsync.mock.calls[0] as [{signal?: AbortSignal}])[0]
      expect(callArgs.signal).toBe(controller.signal)
    })

    it('does NOT call session.create when signal is already aborted (signal not passed to a dead call)', async () => {
      // #given — pre-aborted signal; session.create must be skipped entirely
      const controller = new AbortController()
      controller.abort()
      const handle = makeHandle()
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params).catch(() => {
        /* expected timeout error */
      })

      // #then — session.create was never called, so signal was never passed to it
      const {session} = handle.client as unknown as {session: {create: ReturnType<typeof vi.fn>}}
      expect(session.create).not.toHaveBeenCalled()
    })
  })

  describe('error path — server unreachable', () => {
    it('throws RunCoreError with kind "unreachable" when session.create throws', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => Promise.reject(new TypeError('fetch failed')),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toThrow(RunCoreError)
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'unreachable'})
    })

    it('throws RunCoreError with kind "unreachable" when session.create returns an error', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => Promise.resolve({data: null, error: {message: 'ECONNREFUSED'}}),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'unreachable'})
    })

    it('throws RunCoreError with kind "unreachable" when promptAsync throws', async () => {
      // #given
      const handle = makeHandle({
        promptAsync: async () => Promise.reject(new TypeError('fetch failed')),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'unreachable'})
    })
  })

  describe('error path — proxy 401 (auth error)', () => {
    it('throws RunCoreError with kind "auth" when session.create returns 401 error', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => Promise.resolve({data: null, error: {status: 401, message: '401 Unauthorized'}}),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'auth'})
    })

    it('throws RunCoreError with kind "auth" when promptAsync returns 401 error', async () => {
      // #given
      const handle = makeHandle({
        promptAsync: async () => Promise.resolve({data: null, error: {status: 401, message: '401 Unauthorized'}}),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'auth'})
    })

    it('throws RunCoreError with kind "auth" on 403 forbidden response', async () => {
      // #given — 403 Forbidden with numeric status (after tightening isAuthError to numeric-only)
      const handle = makeHandle({
        sessionCreate: async () => Promise.resolve({data: null, error: {status: 403, message: 'Forbidden'}}),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'auth'})
    })
  })

  describe('error path — session.error event', () => {
    it('throws RunCoreError with kind "session-error" on session.error event', async () => {
      // #given
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123', 'LLM quota exceeded')]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'session-error'})
    })

    it('thrown RunCoreError is an instance of RunCoreError', async () => {
      // #given
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toBeInstanceOf(RunCoreError)
    })
  })

  describe('session.idle completion', () => {
    it('resolves after the matching session.idle event', async () => {
      // #given
      const handle = makeHandle({
        subscribe: async () => subscribeOk([partDeltaObjectEvent('Done!'), sessionIdleEvent('sess-123')]),
      })
      const sink = makeSink()
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toContain('Done!')
    })
  })

  describe('abort signal', () => {
    it('throws RunCoreError with kind "timeout" when signal is already aborted', async () => {
      // #given — signal pre-aborted simulates an expired AbortSignal.timeout()
      const controller = new AbortController()
      controller.abort()

      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([partDeltaObjectEvent('should not appear'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, signal: controller.signal, coordinator: makeCoordinator()}

      // #when — aborted signal → timeout kind thrown before any events processed
      await expect(runOpenCodeCore(params)).rejects.toThrow(RunCoreError)

      // #then — no content was appended
      expect(sink._appended).toHaveLength(0)
    })

    it('throws RunCoreError(timeout) before session.create when signal is already aborted', async () => {
      // #given — signal pre-aborted; session.create must NOT be called
      const controller = new AbortController()
      controller.abort()

      const handle = makeHandle()
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')

      // session.create must NOT have been called
      const {session} = handle.client as unknown as {session: {create: ReturnType<typeof vi.fn>}}
      expect(session.create).not.toHaveBeenCalled()
    })

    it('throws RunCoreError(timeout) when signal aborts after session.create but before subscribe', async () => {
      // #given — signal aborts synchronously after session.create resolves
      const controller = new AbortController()
      const handle = makeHandle({
        sessionCreate: async () => {
          // Abort the signal as part of session creation completing
          controller.abort()
          return sessionCreateOk()
        },
      })
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')

      // event.subscribe must NOT have been called
      const {event} = handle.client as unknown as {event: {subscribe: ReturnType<typeof vi.fn>}}
      expect(event.subscribe).not.toHaveBeenCalled()
    })

    it('throws RunCoreError(timeout) when signal aborts after subscribe but before promptAsync', async () => {
      // #given — signal aborts synchronously after subscribe resolves
      const controller = new AbortController()
      const handle = makeHandle({
        subscribe: async () => {
          controller.abort()
          return subscribeOk([sessionIdleEvent('sess-123')])
        },
      })
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')

      // promptAsync must NOT have been called
      const {session} = handle.client as unknown as {session: {promptAsync: ReturnType<typeof vi.fn>}}
      expect(session.promptAsync).not.toHaveBeenCalled()
    })

    it('throws RunCoreError(timeout) when signal aborts after promptAsync but before first event', async () => {
      // #given — signal aborts synchronously after promptAsync resolves; stream is silent
      const controller = new AbortController()
      const handle = makeHandle({
        promptAsync: async () => {
          controller.abort()
          return promptAsyncOk()
        },
        // Silent stream — never yields an event
        subscribe: async () => {
          return Promise.resolve({
            stream: (async function* () {
              // Yield nothing — simulates a silent/hanging stream
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          })
        },
      })
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when / #then — must not hang; abortable stream exits promptly
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')
    })

    it('event counters: hard-ceiling timeout signal carries counters when at least one event was processed', async () => {
      // #given — no inactivityTimeoutMs (so only the outer wall-clock signal can abort), a
      // stream that yields one activity event and then hangs, and an outer signal aborted
      // via a real timer AFTER that first event has already been processed. This exercises
      // the `combinedSignal.aborted && !inactivityController.signal.aborted` branch (here
      // inactivityController is null entirely) that logs 'stream ended due to timeout signal'.
      const controller = new AbortController()
      const logger = makeLogger()
      const handle = makeHandle({
        subscribe: async () =>
          Promise.resolve({
            stream: hangingStreamAfterFirst(partDeltaObjectEvent('hi')),
          }),
      })
      const params = {...buildParams(handle), signal: controller.signal, logger, coordinator: makeCoordinator()}
      // Abort on a real timer tick — the first event (yielded synchronously by the async
      // generator) is processed well before this fires, since the generator only blocks
      // on its *second* `next()` call.
      setTimeout(() => controller.abort(), 5)

      // #when
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — timeout kind (not inactivity-timeout, since no inactivity controller exists)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-123',
          totalEvents: 1,
          activityEvents: 1,
          lastEventType: 'message.part.delta',
        }),
        'run-core: stream ended due to timeout signal',
      )
    })
  })

  describe('isAuthError classification', () => {
    it('classifies numeric status 401 as auth error', async () => {
      // #given — session.create returns an error with status 401
      const handle = makeHandle({
        sessionCreate: async () => ({
          data: null,
          error: {status: 401, message: 'Unauthorized'},
        }),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then — RunCoreError with kind 'auth'
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('auth')
    })

    it('classifies numeric status 403 as auth error', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => ({
          data: null,
          error: {status: 403, message: 'Forbidden'},
        }),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('auth')
    })

    it('does NOT classify as auth when message contains "401" but status is not 401/403', async () => {
      // #given — error message happens to contain "401" but is not a real auth failure
      const handle = makeHandle({
        sessionCreate: async () => ({
          data: null,
          error: {status: 500, message: 'Internal error: connection pool 401-queue exhausted'},
        }),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then — should be 'unreachable', NOT 'auth'
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).not.toBe('auth')
      expect((err as RunCoreError).kind).toBe('unreachable')
    })

    it('does NOT classify as auth when message contains "unauthorized" but has no numeric auth status', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => ({
          data: null,
          error: {message: 'The token is unauthorized for this operation', status: 500},
        }),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).not.toBe('auth')
    })

    it('does NOT classify as auth when error has no status field at all', async () => {
      // #given — error object with no status (pure network failure)
      const handle = makeHandle({
        sessionCreate: async () => ({
          data: null,
          error: {message: 'ECONNREFUSED'},
        }),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then — falls through to 'unreachable'
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('unreachable')
    })
  })

  // ---------------------------------------------------------------------------
  // Session creation — no body.permission injection (autonomous-low-risk deferred)
  // ---------------------------------------------------------------------------

  describe('session creation', () => {
    it('session.create is called WITHOUT a body.permission field (approval-required mode)', async () => {
      // #given — approval-required mode (the only supported mode)
      const handle = makeHandle()
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — session.create must NOT receive a body with permission rules
      const {session} = handle.client as unknown as {session: {create: ReturnType<typeof vi.fn>}}
      const callArgs = (session.create.mock.calls[0] as [{query?: unknown; body?: unknown}])[0]
      // body should be absent (no session permission override in approval-required mode)
      expect(callArgs.body).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Permission event routing
  // ---------------------------------------------------------------------------

  describe('permission events', () => {
    it('calls coordinator.onPermissionAsked with parsed request on permission.asked for this session', async () => {
      // #given
      const coordinator = makeCoordinator()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([permissionAskedEvent('req-1'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(coordinator.onPermissionAsked).toHaveBeenCalledOnce()
      const calledWith = (coordinator.onPermissionAsked as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        requestID: string
        sessionID: string
      }
      expect(calledWith.requestID).toBe('req-1')
      expect(calledWith.sessionID).toBe('sess-123')
    })

    it('calls coordinator.onPermissionReplied with parsed event on permission.replied for this session', async () => {
      // #given
      const coordinator = makeCoordinator()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([permissionRepliedEvent('req-42', 'always'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(coordinator.onPermissionReplied).toHaveBeenCalledOnce()
      const calledWith = (coordinator.onPermissionReplied as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        requestID: string
        sessionID: string
        reply: string
      }
      expect(calledWith.requestID).toBe('req-42')
      expect(calledWith.sessionID).toBe('sess-123')
      expect(calledWith.reply).toBe('always')
    })

    it('does NOT call onPermissionAsked for permission.asked from a different session', async () => {
      // #given
      const coordinator = makeCoordinator()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([permissionAskedEvent('req-99', 'other-session'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(coordinator.onPermissionAsked).not.toHaveBeenCalled()
    })

    it('does NOT call onPermissionAsked for malformed permission.asked (missing id)', async () => {
      // #given — missing `id` field makes parsePermissionRequest return null
      const coordinator = makeCoordinator()
      const malformedAsked = {
        type: 'permission.asked',
        properties: {sessionID: 'sess-123', permission: 'bash', patterns: [], tool: 'bash'},
        // no `id`
      }
      const handle = makeHandle({
        subscribe: async () => subscribeOk([malformedAsked, sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when — must not throw
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then
      expect(coordinator.onPermissionAsked).not.toHaveBeenCalled()
    })

    it('invokes event.subscribe before promptAsync (subscribe-before-prompt ordering)', async () => {
      // #given — track call order via a shared array
      const callOrder: string[] = []

      const handle = makeHandle({
        promptAsync: async (_args: unknown) => {
          callOrder.push('promptAsync')
          return promptAsyncOk()
        },
        subscribe: async (_args: unknown) => {
          callOrder.push('subscribe')
          return subscribeOk([sessionIdleEvent('sess-123')])
        },
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — subscribe fires before prompt
      expect(callOrder).toEqual(['subscribe', 'promptAsync'])
    })
  })

  // ---------------------------------------------------------------------------
  // Reasoning suppression + tool summarizer wiring
  // ---------------------------------------------------------------------------

  describe('reasoning suppression regression (partID correlation)', () => {
    it('reasoning part registers its id; subsequent deltas with that partID → sink receives nothing', async () => {
      // #given — reasoning part arrives first, then its deltas
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            reasoningPartUpdatedEvent('part-reasoning-1'),
            partDeltaWithPartId('I am thinking step 1', 'part-reasoning-1'),
            partDeltaWithPartId('I am thinking step 2', 'part-reasoning-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — reasoning deltas must be fully suppressed
      expect(sink._appended).toHaveLength(0)
      expect(sink.buffered()).toBe('')
    })

    it('text delta whose partID is NOT a reasoning part → passes through unchanged', async () => {
      // #given — no reasoning part registered; text delta with any partID passes through
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([partDeltaWithPartId('Hello from the answer', 'part-text-1'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — text delta passes through
      expect(sink._appended).toEqual(['Hello from the answer'])
    })

    it('interleaved: reasoning deltas suppressed, text deltas from different partID pass through', async () => {
      // #given — realistic ordering: reasoning part registered, then interleaved deltas
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // Reasoning part arrives first (registers the ID)
            reasoningPartUpdatedEvent('part-reasoning-1'),
            // Reasoning delta — must be suppressed
            partDeltaWithPartId('chain of thought A', 'part-reasoning-1'),
            // Text delta from a different part — must pass through
            partDeltaWithPartId('real answer part 1', 'part-text-2'),
            // Another reasoning delta — suppressed
            partDeltaWithPartId('chain of thought B', 'part-reasoning-1'),
            // More real answer — passes through
            partDeltaWithPartId(' real answer part 2', 'part-text-2'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — only the text deltas reach the sink
      expect(sink._appended).toEqual(['real answer part 1', ' real answer part 2'])
      expect(sink.buffered()).toBe('real answer part 1 real answer part 2')
    })

    it('reasoning part from a different session does NOT register in the suppression set', async () => {
      // #given — reasoning part from other-session; text delta with same partID from our session passes through
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // Reasoning part from a DIFFERENT session — must not pollute our set
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'other-session',
                part: {type: 'reasoning', id: 'part-r-1', sessionID: 'other-session', text: 'thinking'},
              },
            },
            // Text delta from our session with the same partID — must NOT be suppressed
            partDeltaWithPartId('our answer', 'part-r-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — the text delta passes through (other-session reasoning didn't register)
      expect(sink._appended).toEqual(['our answer'])
    })
  })

  describe('segment boundaries (#1739) — separate text parts must not run together', () => {
    const DESCENDANT = 'sess-descendant-1'

    it(
      String.raw`two text parts → "a\n\nb" in the Discord sink, the web sink (live and final), and the final output`,
      async () => {
        // #given the real Discord and web sinks behind a fan-out, fed two parts of one message
        const discord = createDiscordStreamSink({send: vi.fn()})
        const observed: {text: string; final: boolean}[] = []
        const web = createWebReplySink({
          runId: 'run-1',
          observeOutput: (text, opts) => observed.push({text, final: opts?.final === true}),
        })
        const fanOut = {
          append: (text: string) => {
            discord.append(text)
            web.append(text)
          },
        }
        const handle = makeHandle({
          subscribe: async () =>
            subscribeOk([
              partDeltaInMessage('what the project can do.', 'msg-1', 'part-1'),
              partDeltaInMessage('The README', 'msg-1', 'part-2'),
              sessionIdleEvent('sess-123'),
            ]),
        })

        // #when
        await runOpenCodeCore({...buildParams(handle), sink: fanOut, coordinator: makeCoordinator()})
        await web.flush()

        // #then every consumer holds the same, separated text
        expect(discord.buffered()).toBe('what the project can do.\n\nThe README')
        expect(web.buffered()).toBe('what the project can do.\n\nThe README')
        const live = observed.filter(frame => !frame.final)
        const final = observed.filter(frame => frame.final)
        expect(live.map(frame => frame.text).join('')).toBe('what the project can do.\n\nThe README')
        expect(final).toEqual([{text: 'what the project can do.\n\nThe README', final: true}])
      },
    )

    it('parts in different messages are separated too', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaInMessage('first.', 'msg-1', 'part-1'),
        partDeltaInMessage('second.', 'msg-2', 'part-2'),
      ])

      // #then
      expect(sink.buffered()).toBe('first.\n\nsecond.')
    })

    it('no leading separator before the first text', async () => {
      // #given a run whose first visible text is a part (after a suppressed reasoning part)
      const sink = await runSegmentEvents([
        reasoningPartUpdatedEvent('part-r'),
        partDeltaWithPartId('thinking', 'part-r'),
        partDeltaWithPartId('hello', 'part-1'),
      ])

      // #then nothing precedes the text
      expect(sink._appended).toEqual(['hello'])
    })

    it('the same part id across many deltas gets no separators', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaWithPartId('hel', 'part-1'),
        partDeltaWithPartId('lo ', 'part-1'),
        partDeltaWithPartId('world', 'part-1'),
      ])

      // #then
      expect(sink._appended).toEqual(['hel', 'lo ', 'world'])
    })

    it('a part resumed after another part interleaved is not split mid-part', async () => {
      // #given deltas of two parts interleaving
      const sink = await runSegmentEvents([
        partDeltaWithPartId('A1 ', 'part-a'),
        partDeltaWithPartId('B1 ', 'part-b'),
        partDeltaWithPartId('A2', 'part-a'),
      ])

      // #then the return to the already-seen part-a opens no new boundary
      expect(sink.buffered()).toBe('A1 \n\nB1 A2')
    })

    it.each([
      ['no trailing newline', 'a', 'a\n\nb'],
      ['a single trailing newline is completed to a blank line', 'a\n', 'a\n\nb'],
      ['a trailing blank line is left alone', 'a\n\n', 'a\n\nb'],
      ['more than a blank line is left alone', 'a\n\n\n', 'a\n\n\nb'],
    ])('trailing newlines — %s', async (_label, first, expected) => {
      // #given
      const sink = await runSegmentEvents([partDeltaWithPartId(first, 'part-1'), partDeltaWithPartId('b', 'part-2')])

      // #then
      expect(sink.buffered()).toBe(expected)
    })

    it('a leading newline on the next part counts toward the blank line', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaWithPartId('a', 'part-1'),
        partDeltaWithPartId('\n', 'part-2'),
        partDeltaWithPartId('b', 'part-2'),
      ])

      // #then
      expect(sink.buffered()).toBe('a\n\nb')
    })

    it('a whitespace-only first delta of a new part does not trigger the boundary on its own', async () => {
      // #given
      const sink = await runSegmentEvents([partDeltaWithPartId('a', 'part-1'), partDeltaWithPartId('  ', 'part-2')])

      // #then no separator is spent on whitespace
      expect(sink.buffered()).toBe('a  ')
    })

    it('a whitespace-only lead-in of a new part followed by a continuation of an existing part does not split it', async () => {
      // #given part-b opens with whitespace, part-a resumes mid-word, then part-b becomes visible
      const sink = await runSegmentEvents([
        partDeltaWithPartId('hel', 'part-a'),
        partDeltaWithPartId(' ', 'part-b'),
        partDeltaWithPartId('lo', 'part-a'),
        partDeltaWithPartId('new', 'part-b'),
      ])

      // #then part-a's continuation is intact and the boundary lands before part-b's visible text
      expect(sink.buffered()).toBe('hel lo\n\nnew')
    })

    it('a whitespace-only lead-in of a new part followed by an anonymous delta does not hand it the boundary', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaWithPartId('hel', 'part-a'),
        partDeltaWithPartId(' ', 'part-b'),
        nextTextDeltaStringEvent('lo'),
      ])

      // #then the anonymous delta is appended untouched
      expect(sink.buffered()).toBe('hel lo')
    })

    it('a part that starts empty is separated when it becomes visible after another part', async () => {
      // #given part-a is announced empty, part-b is the first visible text, then part-a becomes visible
      const sink = await runSegmentEvents([
        partDeltaWithPartId('', 'part-a'),
        partDeltaWithPartId('two', 'part-b'),
        partDeltaWithPartId('one', 'part-a'),
      ])

      // #then
      expect(sink.buffered()).toBe('two\n\none')
    })

    it.each([
      ['one newline, together', ['\nb']],
      ['one newline, split', ['\n', 'b']],
      ['two newlines, together', ['\n\nb']],
      ['two newlines, split after both', ['\n\n', 'b']],
      ['two newlines, split between them', ['\n', '\nb']],
      ['two newlines, one per delta', ['\n', '\n', 'b']],
      ['three newlines, together', ['\n\n\nb']],
      ['three newlines, split', ['\n', '\n\n', 'b']],
    ])('leading newlines are chunking-independent — %s', async (_label, chunks) => {
      // #given the same part-2 text delivered in different chunkings after part-1's "a"
      const sink = await runSegmentEvents([
        partDeltaWithPartId('a', 'part-1'),
        ...chunks.map(chunk => partDeltaWithPartId(chunk, 'part-2')),
      ])

      // #then the separation depends only on the part's text, never on the chunking
      const lead = chunks.join('').length - 1
      expect(sink.buffered()).toBe(`a${'\n'.repeat(Math.max(2, lead))}b`)
      // and each chunk reached the sink unchanged (the separator is its own append)
      const separator = '\n'.repeat(Math.max(0, 2 - lead))
      expect(sink._appended).toEqual([
        'a',
        ...chunks.slice(0, -1),
        ...(separator.length > 0 ? [separator] : []),
        chunks.at(-1),
      ])
    })

    it('text part → tool summary → text part: one blank line after the summary, not two', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaWithPartId('before', 'part-1'),
        partUpdatedToolEvent('edit', 'completed', {input: {filePath: 'src/foo.ts', newString: 'x', oldString: 'y'}}),
        partDeltaWithPartId('after', 'part-2'),
      ])

      // #then the summary ends in a newline, so exactly one more completes the blank line
      const out = sink.buffered()
      expect(out).toMatch(/^before\n.*foo\.ts.*\n\nafter$/s)
      expect(out).not.toContain('\n\n\n')
    })

    it('the same part continuing after a tool summary adds no separator', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaWithPartId('before', 'part-1'),
        partUpdatedToolEvent('edit', 'completed', {input: {filePath: 'src/foo.ts', newString: 'x', oldString: 'y'}}),
        partDeltaWithPartId('more', 'part-1'),
      ])

      // #then
      expect(sink._appended.at(-1)).toBe('more')
      expect(sink._appended.filter(chunk => chunk.trim() === '')).toEqual([])
    })

    it('a message.part.delta without a part id falls back to its message id', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaInMessage('one', 'msg-1', null),
        partDeltaInMessage(' more', 'msg-1', null),
        partDeltaInMessage('two', 'msg-2', null),
      ])

      // #then
      expect(sink.buffered()).toBe('one more\n\ntwo')
    })

    it('legacy session.next.text.delta: separated by textID/assistantMessageID, contiguous within a text', async () => {
      // #given
      const sink = await runSegmentEvents([
        legacyTextDelta('one', 'msg-1', 'text-1'),
        legacyTextDelta(' more', 'msg-1', 'text-1'),
        legacyTextDelta('two', 'msg-1', 'text-2'),
        legacyTextDelta('three', 'msg-2', 'text-1'),
      ])

      // #then
      expect(sink.buffered()).toBe('one more\n\ntwo\n\nthree')
    })

    it('anonymous deltas with no identity at all are never separated', async () => {
      // #given
      const sink = await runSegmentEvents([
        nextTextDeltaStringEvent('tok'),
        nextTextDeltaStringEvent('en'),
        partDeltaObjectEvent('s'),
      ])

      // #then
      expect(sink._appended).toEqual(['tok', 'en', 's'])
    })

    it('routed descendant text behaves the same as root text', async () => {
      // #given an adopted descendant streaming its own part after the root's
      const sink = await runSegmentEvents(
        [partDeltaWithPartId('root says', 'part-root'), partDeltaWithPartId('child says', 'part-child', DESCENDANT)],
        makeCoordinator([DESCENDANT]),
      )

      // #then
      expect(sink.buffered()).toBe('root says\n\nchild says')
    })

    it('text from sessions this run does not own is dropped and never opens a boundary', async () => {
      // #given
      const sink = await runSegmentEvents([
        partDeltaWithPartId('a', 'part-1'),
        partDeltaWithPartId('foreign', 'part-x', 'sess-foreign'),
        partDeltaWithPartId('b', 'part-1'),
      ])

      // #then
      expect(sink._appended).toEqual(['a', 'b'])
    })
  })

  describe('tool summarizer wiring (replaces raw 🔧 format)', () => {
    it('edit tool via message.part.updated → sink receives summary line, NOT raw 🔧 format', async () => {
      // #given — edit tool with filePath and newString/oldString
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('edit', 'completed', {
              input: {filePath: 'src/foo.ts', newString: 'line1\nline2\nline3', oldString: 'old1\nold2'},
            }),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summary format, not raw 🔧
      const combined = sink.buffered()
      expect(combined).toContain('foo.ts')
      expect(combined).not.toContain('🔧')
      // Summary contains the file name in italic markdown
      expect(combined).toContain('*foo.ts*')
    })

    it('read tool via message.part.updated → sink receives nothing (hidden)', async () => {
      // #given — read tool is non-essential
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('read', 'completed', {input: {filePath: 'src/foo.ts'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — nothing appended for hidden tool
      expect(sink._appended).toHaveLength(0)
    })

    it('grep tool via message.part.updated → sink receives nothing (hidden)', async () => {
      // #given — grep tool is non-essential
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('grep', 'completed', {input: {pattern: 'foo', path: 'src/'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink._appended).toHaveLength(0)
    })

    it('write tool via message.part.updated → sink receives summary line', async () => {
      // #given — write tool with filePath and content
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('write', 'completed', {
              input: {filePath: 'src/bar.ts', content: 'line1\nline2\nline3\nline4\nline5'},
            }),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summary contains filename and line count
      const combined = sink.buffered()
      expect(combined).toContain('bar.ts')
      expect(combined).not.toContain('🔧')
    })

    it('read tool via session.next.tool.success → sink receives nothing (hidden)', async () => {
      // #given — read tool via legacy path
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-r1', 'read', {filePath: 'src/foo.ts'}),
            toolSuccessEvent('call-r1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — nothing appended for hidden tool
      expect(sink._appended).toHaveLength(0)
    })

    it('integration: session.next.tool.success and message.part.updated produce identical output for same edit tool', async () => {
      // #given — same edit tool input via both paths
      const editInput = {filePath: 'src/utils.ts', newString: 'a\nb\nc', oldString: 'x\ny'}

      const sinkA = makeSink()
      const handleA = makeHandle({
        subscribe: async () =>
          subscribeOk([partUpdatedToolEvent('edit', 'completed', {input: editInput}), sessionIdleEvent('sess-123')]),
      })
      const paramsA = {...buildParams(handleA), sink: sinkA, coordinator: makeCoordinator()}

      const sinkB = makeSink()
      const handleB = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-e1', 'edit', editInput),
            toolSuccessEvent('call-e1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const paramsB = {...buildParams(handleB), sink: sinkB, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(paramsA)
      await runOpenCodeCore(paramsB)

      // #then — both paths produce identical output
      expect(sinkA.buffered()).toBe(sinkB.buffered())
      // And neither contains the raw 🔧 format
      expect(sinkA.buffered()).not.toContain('🔧')
      expect(sinkB.buffered()).not.toContain('🔧')
    })

    it('no raw 🔧 format in any tool output — bash tool uses summarizer', async () => {
      // #given — bash tool via message.part.updated
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'completed', {input: {command: 'pnpm build'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summary format (backtick-wrapped command), not raw 🔧
      const combined = sink.buffered()
      expect(combined).toContain('pnpm build')
      expect(combined).not.toContain('🔧')
    })
  })

  // ---------------------------------------------------------------------------
  // Coordinator required — fail-closed before session creation
  // ---------------------------------------------------------------------------

  describe('coordinator required — fail-closed before session creation', () => {
    it('throws RunCoreError with kind "missing-coordinator" when no coordinator is provided', async () => {
      // #given — no coordinator (coordinator is required unconditionally)
      const handle = makeHandle()
      const params = buildParams(handle) // no coordinator

      // #when / #then — must fail closed before session.create
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'missing-coordinator'})
    })

    it('throws RunCoreError(missing-coordinator) BEFORE session.create is called', async () => {
      // #given — no coordinator
      const handle = makeHandle()
      const params = buildParams(handle)

      // #when
      await runOpenCodeCore(params).catch(() => {
        /* expected */
      })

      // #then — session.create must NOT have been called
      const {session} = handle.client as unknown as {session: {create: ReturnType<typeof vi.fn>}}
      expect(session.create).not.toHaveBeenCalled()
    })

    it('throws RunCoreError(missing-coordinator) BEFORE promptAsync is called', async () => {
      // #given — no coordinator
      const handle = makeHandle()
      const params = buildParams(handle)

      // #when
      await runOpenCodeCore(params).catch(() => {
        /* expected */
      })

      // #then — promptAsync must NOT have been called
      const {session} = handle.client as unknown as {session: {promptAsync: ReturnType<typeof vi.fn>}}
      expect(session.promptAsync).not.toHaveBeenCalled()
    })

    it('coordinator present proceeds normally', async () => {
      // #given — coordinator present
      const coordinator = makeCoordinator()
      const handle = makeHandle()
      const params = {...buildParams(handle), coordinator}

      // #when / #then — must resolve cleanly
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // P1.2: Fail-soft tool rendering — malformed tool input must not abort stream
  // ---------------------------------------------------------------------------

  describe('fail-soft tool rendering (P1.2) — malformed tool input does not abort stream', () => {
    it('message.part.updated: hostile/malformed tool input does not abort stream — subsequent text deltas still process', async () => {
      // #given — a tool part with a deeply hostile input that would cause formatToolPart to throw
      // We simulate this by passing a Proxy that throws on property access
      const sink = makeSink()
      const hostileInput = new Proxy(
        {},
        {
          get() {
            throw new Error('hostile property access')
          },
        },
      )
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // Hostile tool part — formatToolPart will throw when accessing input
            {
              type: 'message.part.updated',
              properties: {
                sessionID: 'sess-123',
                part: {
                  type: 'tool',
                  tool: 'bash',
                  sessionID: 'sess-123',
                  state: {status: 'completed', input: hostileInput},
                },
              },
            },
            // Subsequent text delta — must still be processed
            partDeltaObjectEvent('answer after hostile tool'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when — must NOT throw; stream continues
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then — text delta after the hostile tool still reached the sink
      expect(sink._appended).toContain('answer after hostile tool')
    })

    it('session.next.tool.success: hostile/malformed tool input does not abort stream', async () => {
      // #given — hostile input on the legacy tool success path
      // The tool is called with a Proxy that throws on property access, simulating a malformed input
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () => {
          // Build a hostile proxy that throws on any property access
          const hostileInput = new Proxy(
            {},
            {
              get() {
                throw new Error('hostile property access')
              },
            },
          )
          return subscribeOk([
            // Tool called with hostile input (stored in pendingToolCalls)
            {
              type: 'session.next.tool.called',
              properties: {sessionID: 'sess-123', callID: 'call-hostile', tool: 'bash', input: hostileInput},
            },
            // Tool success — formatToolPart will throw when accessing the hostile input
            {
              type: 'session.next.tool.success',
              properties: {sessionID: 'sess-123', callID: 'call-hostile'},
            },
            partDeltaObjectEvent('answer after hostile legacy tool'),
            sessionIdleEvent('sess-123'),
          ])
        },
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when — must NOT throw
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then — text delta still reached the sink
      expect(sink._appended).toContain('answer after hostile legacy tool')
    })
  })

  // ---------------------------------------------------------------------------
  // P1.3: R5 ordering + cross-run isolation
  // ---------------------------------------------------------------------------

  describe('R5 ordering + cross-run isolation (P1.3)', () => {
    it('out-of-order: reasoning delta AFTER its part.updated registration → suppressed', async () => {
      // #given — normal OpenCode order: reasoning part.updated first, then its deltas
      // This is the load-bearing ordering: part.updated registers the ID before deltas arrive
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // 1. Reasoning part registers its ID
            reasoningPartUpdatedEvent('part-r-order'),
            // 2. Reasoning delta with that partID → must be suppressed
            partDeltaWithPartId('chain of thought', 'part-r-order'),
            // 3. Text delta with a different partID → must stream
            partDeltaWithPartId('real answer', 'part-text-order'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — reasoning delta suppressed; text delta passes through
      expect(sink._appended).toEqual(['real answer'])
      expect(sink.buffered()).toBe('real answer')
    })

    it('out-of-order: delta whose partID was never registered as reasoning → streams (answer never eaten)', async () => {
      // #given — no reasoning part registered; text delta with any partID passes through
      // This verifies the suppression set is not over-eager
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // No reasoning part.updated — partID 'part-unknown' is not in the suppression set
            partDeltaWithPartId('this is the answer', 'part-unknown'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — unregistered partID passes through unchanged
      expect(sink._appended).toEqual(['this is the answer'])
    })

    it('cross-run isolation: reasoningPartIds is per-run, not shared across runs', async () => {
      // #given — run 1 registers reasoning partID 'part-shared'
      const sink1 = makeSink()
      const handle1 = makeHandle({
        subscribe: async () =>
          subscribeOk([
            reasoningPartUpdatedEvent('part-shared'),
            partDeltaWithPartId('run1 reasoning — suppressed', 'part-shared'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params1 = {...buildParams(handle1), sink: sink1, coordinator: makeCoordinator()}

      // #when — run 1 completes
      await runOpenCodeCore(params1)

      // #then — run 1: reasoning suppressed
      expect(sink1._appended).toHaveLength(0)

      // #given — run 2: fresh run, same partID 'part-shared' used for a TEXT delta
      const sink2 = makeSink()
      const handle2 = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // No reasoning part.updated in run 2 — 'part-shared' is NOT in the new run's set
            partDeltaWithPartId('run2 answer — must stream', 'part-shared'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params2 = {...buildParams(handle2), sink: sink2, coordinator: makeCoordinator()}

      // #when — run 2 completes
      await runOpenCodeCore(params2)

      // #then — run 2: text delta with previously-seen partID STREAMS (per-run isolation)
      expect(sink2._appended).toEqual(['run2 answer — must stream'])
    })
  })

  // ---------------------------------------------------------------------------
  // P2.6: Both tool event paths route through appendToolSummary
  // ---------------------------------------------------------------------------

  describe('tool render helper routing (P2.6) — both event paths produce output', () => {
    it('message.part.updated path produces tool summary line', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('edit', 'completed', {
              input: {filePath: 'src/helper.ts', newString: 'a\nb', oldString: 'c'},
            }),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summary line appended via message.part.updated path
      expect(sink.buffered()).toContain('helper.ts')
    })

    it('session.next.tool.success path produces tool summary line', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-p26', 'edit', {filePath: 'src/helper.ts', newString: 'a\nb', oldString: 'c'}),
            toolSuccessEvent('call-p26'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator()}

      // #when
      await runOpenCodeCore(params)

      // #then — summary line appended via session.next.tool.success path
      expect(sink.buffered()).toContain('helper.ts')
    })
  })

  // ---------------------------------------------------------------------------
  // Item 5: stream-ended error kind
  // ---------------------------------------------------------------------------

  describe('stream-ended error kind', () => {
    it('throws RunCoreError with kind "stream-ended" when event stream closes before session.idle', async () => {
      // #given — stream ends immediately with no events (no session.idle, no abort)
      const handle = makeHandle({
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              // Yields nothing — stream closes immediately without session.idle
            })(),
          }),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then — stream-ended kind thrown
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('stream-ended')
    })

    it('throws RunCoreError with kind "stream-ended" when stream closes after some events but before session.idle', async () => {
      // #given — stream yields some text deltas then closes without session.idle
      const logger = makeLogger()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partDeltaObjectEvent('partial answer'),
            // No sessionIdleEvent — stream ends prematurely
          ]),
      })
      const params = {...buildParams(handle), logger, coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('stream-ended')
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-123',
          totalEvents: 1,
          activityEvents: 1,
          lastEventType: 'message.part.delta',
        }),
        'run-core: event stream closed before session.idle',
      )
    })

    it('stream-ended error is NOT thrown when signal is aborted (timeout takes precedence)', async () => {
      // #given — signal aborts before stream ends; timeout kind should be thrown, not stream-ended
      const controller = new AbortController()
      const handle = makeHandle({
        promptAsync: async () => {
          controller.abort()
          return promptAsyncOk()
        },
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              // Silent stream — never yields
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          }),
      })
      const params = {...buildParams(handle), signal: controller.signal, coordinator: makeCoordinator()}

      // #when / #then — timeout kind, not stream-ended
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')
    })
  })

  // ---------------------------------------------------------------------------
  // Item 7: session.error with eventSessionID === null (global error path)
  // ---------------------------------------------------------------------------

  describe('session.error with null sessionID (global error path)', () => {
    it('throws RunCoreError with kind "session-error" when session.error has no sessionID (null)', async () => {
      // #given — session.error event with no sessionID in properties
      // The run-core code: `if (eventSessionID === null || eventSessionID === sessionId)`
      // A null sessionID is treated as a global error that applies to any session.
      const globalErrorEvent = {
        type: 'session.error',
        properties: {error: 'global LLM failure'},
        // no sessionID field → getEventSessionID returns null
      }
      const handle = makeHandle({
        subscribe: async () => subscribeOk([globalErrorEvent]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then — global session.error (null sessionID) surfaces as session-error
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('session-error')
    })

    it('session.error with null sessionID carries the error detail in the message', async () => {
      // #given — global session.error with a specific error message
      const globalErrorEvent = {
        type: 'session.error',
        properties: {error: 'quota exceeded globally'},
      }
      const handle = makeHandle({
        subscribe: async () => subscribeOk([globalErrorEvent]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — error message contains the detail from the event
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).message).toContain('quota exceeded globally')
    })

    it('session.error from a different (non-null) sessionID is ignored', async () => {
      // #given — session.error for a different session; our session continues to idle
      const otherSessionError = {
        type: 'session.error',
        properties: {sessionID: 'other-session', error: 'other session failed'},
      }
      const handle = makeHandle({
        subscribe: async () => subscribeOk([otherSessionError, sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then — other session's error is ignored; our session resolves normally
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // onActivity and onBusy hooks
  // ---------------------------------------------------------------------------

  describe('onActivity and onBusy hooks', () => {
    it('onBusy(true) called after prompt is sent successfully', async () => {
      // #given
      const onBusy = vi.fn()
      const handle = makeHandle()
      const params = {...buildParams(handle), coordinator: makeCoordinator(), onBusy}

      // #when
      await runOpenCodeCore(params)

      // #then — onBusy(true) called after prompt send
      expect(onBusy).toHaveBeenCalledWith(true)
    })

    it('onBusy(false) called when session.idle is received', async () => {
      // #given
      const onBusy = vi.fn()
      const handle = makeHandle()
      const params = {...buildParams(handle), coordinator: makeCoordinator(), onBusy}

      // #when
      await runOpenCodeCore(params)

      // #then — onBusy(false) called on session.idle
      expect(onBusy).toHaveBeenCalledWith(false)
    })

    it('onBusy call order: true (prompt sent) then false (session.idle)', async () => {
      // #given
      const callOrder: boolean[] = []
      const onBusy = vi.fn().mockImplementation((busy: boolean) => {
        callOrder.push(busy)
      })
      const handle = makeHandle()
      const params = {...buildParams(handle), coordinator: makeCoordinator(), onBusy}

      // #when
      await runOpenCodeCore(params)

      // #then — true before false
      expect(callOrder[0]).toBe(true)
      expect(callOrder.at(-1)).toBe(false)
    })

    it('onActivity called with tool summary when message.part.updated tool completes', async () => {
      // #given — edit tool via message.part.updated
      const onActivity = vi.fn()
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('edit', 'completed', {
              input: {filePath: 'src/foo.ts', newString: 'new\ncontent', oldString: 'old'},
            }),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator(), onActivity}

      // #when
      await runOpenCodeCore(params)

      // #then — onActivity called with the same summary appended to the sink
      expect(onActivity).toHaveBeenCalledOnce()
      const activitySummary = (onActivity as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
      expect(typeof activitySummary).toBe('string')
      expect(activitySummary.length).toBeGreaterThan(0)
      // The summary should contain the filename (same as what the sink received)
      expect(activitySummary).toContain('foo.ts')
    })

    it('onActivity called with tool summary when session.next.tool.success fires', async () => {
      // #given — bash tool via legacy path
      const onActivity = vi.fn()
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-act-1', 'bash', {command: 'pnpm build'}),
            toolSuccessEvent('call-act-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator(), onActivity}

      // #when
      await runOpenCodeCore(params)

      // #then — onActivity called with the bash summary
      expect(onActivity).toHaveBeenCalledOnce()
      const activitySummary = (onActivity as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string
      expect(activitySummary).toContain('pnpm build')
    })

    it('onActivity NOT called for hidden tools (read, grep)', async () => {
      // #given — read tool is non-essential; formatToolPart returns null → no append, no onActivity
      const onActivity = vi.fn()
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('read', 'completed', {input: {filePath: 'src/foo.ts'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator(), onActivity}

      // #when
      await runOpenCodeCore(params)

      // #then — onActivity NOT called (hidden tool produces no summary)
      expect(onActivity).not.toHaveBeenCalled()
    })

    it('onActivity called once per essential tool, not per text delta', async () => {
      // #given — two essential tools + text deltas
      const onActivity = vi.fn()
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partDeltaObjectEvent('text delta 1'),
            partUpdatedToolEvent('edit', 'completed', {input: {filePath: 'a.ts', newString: 'x', oldString: 'y'}}),
            partDeltaObjectEvent('text delta 2'),
            partUpdatedToolEvent('write', 'completed', {input: {filePath: 'b.ts', content: 'content'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator: makeCoordinator(), onActivity}

      // #when
      await runOpenCodeCore(params)

      // #then — onActivity called exactly twice (once per essential tool)
      expect(onActivity).toHaveBeenCalledTimes(2)
    })

    it('onBusy(false) called on permission.asked (approval wait pauses typing)', async () => {
      // #given — permission.asked event arrives
      const onBusy = vi.fn()
      const coordinator = makeCoordinator()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([permissionAskedEvent('req-busy-1'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator, onBusy}

      // #when
      await runOpenCodeCore(params)

      // #then — onBusy(false) called when approval wait starts
      const calls = (onBusy as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as boolean)
      expect(calls).toContain(false)
      // The false call should come after the initial true (prompt sent)
      const trueIdx = calls.indexOf(true)
      const falseIdx = calls.indexOf(false)
      expect(trueIdx).toBeGreaterThanOrEqual(0)
      expect(falseIdx).toBeGreaterThan(trueIdx)
    })

    it('onBusy(true) called on permission.replied (typing resumes after approval)', async () => {
      // #given — permission.asked then permission.replied
      const onBusy = vi.fn()
      const coordinator = makeCoordinator()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            permissionAskedEvent('req-resume-1'),
            permissionRepliedEvent('req-resume-1', 'once'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), coordinator, onBusy}

      // #when
      await runOpenCodeCore(params)

      // #then — onBusy(true) called after permission.replied (resume after approval)
      const calls = (onBusy as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as boolean)
      // Sequence: true (prompt), false (asked), true (replied), false (idle)
      expect(calls.filter(v => v === true).length).toBeGreaterThanOrEqual(2)
      expect(calls.filter(v => v === false).length).toBeGreaterThanOrEqual(2)
    })

    it('onActivity and onBusy are optional — omitting them does not throw', async () => {
      // #given — no onActivity or onBusy provided (backward compatibility)
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('edit', 'completed', {input: {filePath: 'x.ts', newString: 'a', oldString: 'b'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}
      // No onActivity or onBusy in params

      // #when / #then — must not throw
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Inactivity timeout
  // ---------------------------------------------------------------------------

  describe('inactivity timeout', () => {
    it('resolves normally when session.idle arrives before inactivity timeout fires', async () => {
      // #given — inactivityTimeoutMs set but session.idle arrives quickly
      const handle = makeHandle({
        subscribe: async () => subscribeOk([partDeltaObjectEvent('Hello'), sessionIdleEvent('sess-123')]),
      })
      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 60_000, // 60 s — won't fire in test
      }

      // #when / #then — resolves without throwing
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })

    it('throws RunCoreError with kind "inactivity-timeout" when no activity arrives within the window', async () => {
      // #given — silent stream; inactivity timer fires before any event
      // Use a very short inactivity timeout (10ms) — will fire almost immediately after prompt send
      const handle = makeHandle({
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              // Yield nothing — simulate a completely silent stream
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          }),
      })

      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 10, // fires almost immediately
      }

      // #when / #then — inactivity-timeout kind thrown
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('inactivity-timeout')
    }, 10_000)

    it('inactivity timer resets on text delta — does not fire when output is flowing', async () => {
      // #given — text deltas arrive steadily; inactivity timer resets each time
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partDeltaObjectEvent('chunk 1'),
            partDeltaObjectEvent('chunk 2'),
            partDeltaObjectEvent('chunk 3'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 60_000, // long enough not to fire during test
      }

      // #when / #then — resolves normally (timer never fires)
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })

    it('inactivity timer is cleared on session.idle — no dangling timer after completion', async () => {
      // #given — normal run that completes via session.idle
      const handle = makeHandle()
      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 60_000,
      }

      // #when — run completes normally
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then — no dangling timer (verified by test completing without hanging)
      // If the timer were not cleared, the test runner would hang waiting for it.
    })

    it('inactivity timer is paused on permission.asked and re-armed on permission.replied', async () => {
      // #given — permission.asked then permission.replied then session.idle
      // With a very short inactivity timeout, the timer would fire during the approval wait
      // if it were not paused. Since it IS paused, the run completes normally.
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            permissionAskedEvent('req-inact-1'),
            permissionRepliedEvent('req-inact-1', 'once'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 1, // very short — would fire during approval wait if not paused
      }

      // #when / #then — resolves normally because timer is paused during approval wait
      // (permission.asked clears the timer; permission.replied re-arms it; session.idle clears it)
      // Note: this test is timing-sensitive but works because the event stream is synchronous
      // in tests — all events are processed before any real timer fires.
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })

    it('event counters: zero events on inactivity timeout signal the silent-workspace case', async () => {
      // #given — a completely silent stream (no events at all) and a short inactivity window
      const logger = makeLogger()
      const handle = makeHandle({
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          }),
      })
      const params = {
        ...buildParams(handle),
        logger,
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 10,
      }

      // #when
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — inactivity-timeout thrown with totalEvents:0, activityEvents:0 (silent hang signature)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('inactivity-timeout')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({sessionId: 'sess-123', totalEvents: 0, activityEvents: 0}),
        'run-core: stream ended due to inactivity timeout',
      )
    }, 10_000)

    it('event counters: events arriving without activity signal the lost-event/routing-gap case', async () => {
      // #given — events arrive (a foreign-session delta and an unrecognized event type) but
      // none of them reset the inactivity timer, since none is a recognized same-session activity event.
      const logger = makeLogger()
      const handle = makeHandle({
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              yield partDeltaObjectEvent('should be ignored', 'other-session')
              yield {type: 'some.unrecognized.event', properties: {sessionID: 'sess-123'}}
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          }),
      })
      const params = {
        ...buildParams(handle),
        logger,
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 10,
      }

      // #when
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — totalEvents > 0 but activityEvents stays 0; lastEventType reflects the last processed event
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('inactivity-timeout')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-123',
          activityEvents: 0,
          lastEventType: 'some.unrecognized.event',
        }),
        'run-core: stream ended due to inactivity timeout',
      )
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[1] === 'run-core: stream ended due to inactivity timeout',
      )
      expect((warnCall?.[0] as {totalEvents: number}).totalEvents).toBeGreaterThan(0)
    }, 10_000)

    it('event counters: unrecognized event type logs at debug and increments totalEvents', async () => {
      // #given — a stream with one unrecognized event type followed by session.idle
      const logger = makeLogger()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            {type: 'some.unrecognized.event', properties: {sessionID: 'sess-123'}},
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {
        ...buildParams(handle),
        logger,
        coordinator: makeCoordinator(),
      }

      // #when
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then — debug log fired for the unrecognized event type
      expect(logger.debug).toHaveBeenCalledWith(
        {eventType: 'some.unrecognized.event', sessionId: 'sess-123'},
        'run-core: unrecognized event type',
      )
      // session.idle log carries totalEvents > 0 (counts the unrecognized event + session.idle itself)
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({sessionId: 'sess-123', totalEvents: 2}),
        'run-core: session.idle received — stream complete',
      )
    })

    it('event counters: a normal run reaching session.idle after activity has totalEvents and activityEvents > 0', async () => {
      // #given — a normal run with text delta activity before session.idle
      const logger = makeLogger()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([partDeltaObjectEvent('Hello'), sessionIdleEvent('sess-123')]),
      })
      const params = {
        ...buildParams(handle),
        logger,
        coordinator: makeCoordinator(),
      }

      // #when
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then — healthy-baseline signature: both counters > 0
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({sessionId: 'sess-123'}),
        'run-core: session.idle received — stream complete',
      )
      const idleCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => call[1] === 'run-core: session.idle received — stream complete',
      )
      const ctx = idleCall?.[0] as {totalEvents: number; activityEvents: number}
      expect(ctx.totalEvents).toBeGreaterThan(0)
      expect(ctx.activityEvents).toBeGreaterThan(0)
    })

    it('inactivity timeout does not fire when inactivityTimeoutMs is absent', async () => {
      // #given — no inactivityTimeoutMs; silent stream that never yields
      // Without inactivity timeout, the run would hang forever on a silent stream.
      // We use a pre-aborted wall-clock signal to terminate it.
      const controller = new AbortController()
      const handle = makeHandle({
        promptAsync: async () => {
          controller.abort()
          return promptAsyncOk()
        },
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          }),
      })
      const params = {
        ...buildParams(handle),
        signal: controller.signal,
        coordinator: makeCoordinator(),
        // No inactivityTimeoutMs
      }

      // #when / #then — timeout kind (wall-clock), NOT inactivity-timeout
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('timeout')
    })

    it('inactivity-timeout kind is distinct from timeout kind', async () => {
      // #given — inactivity fires (not wall-clock timeout)
      const handle = makeHandle({
        subscribe: async () =>
          Promise.resolve({
            stream: (async function* () {
              await new Promise<void>(() => {
                /* never resolves */
              })
            })(),
          }),
      })
      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 10, // fires almost immediately
      }

      // #when
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — kind is 'inactivity-timeout', not 'timeout'
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('inactivity-timeout')
      expect((err as RunCoreError).kind).not.toBe('timeout')
    }, 10_000)

    it('inactivity timer resets on tool completion (message.part.updated)', async () => {
      // #given — tool completion resets the inactivity timer; session.idle arrives after
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('edit', 'completed', {input: {filePath: 'x.ts', newString: 'a', oldString: 'b'}}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {
        ...buildParams(handle),
        coordinator: makeCoordinator(),
        inactivityTimeoutMs: 60_000, // long enough not to fire during test
      }

      // #when / #then — resolves normally (tool completion reset the timer)
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
    })

    // -------------------------------------------------------------------------
    // Fake-timer tests — verify time-advancing boundary behavior
    // -------------------------------------------------------------------------

    describe('fake-timer boundary tests', () => {
      afterEach(() => {
        vi.useRealTimers()
      })

      it('(a) continuous output does not abort: resets prevent inactivity-timeout over time', async () => {
        // #given — fake timers; inactivity window of 5000ms
        vi.useFakeTimers()
        const WINDOW = 5_000

        // Build a controlled async generator that yields events on demand
        const eventQueue: object[] = []
        let resolveNext: (() => void) | null = null

        async function* controlledStream(): AsyncGenerator<object> {
          while (true) {
            if (eventQueue.length > 0) {
              const next = eventQueue.shift()
              if (next === undefined) break
              yield next
            } else {
              await new Promise<void>(resolve => {
                resolveNext = resolve
              })
            }
          }
        }

        const emitNext = (event: object) => {
          eventQueue.push(event)
          if (resolveNext !== null) {
            const r = resolveNext
            resolveNext = null
            r()
          }
        }
        const streamDone = () => {
          // Signal end by emitting session.idle
          emitNext(sessionIdleEvent('sess-123'))
        }

        const handle = makeHandle({
          subscribe: async () => Promise.resolve({stream: controlledStream()}),
        })
        const params = {
          ...buildParams(handle),
          coordinator: makeCoordinator(),
          inactivityTimeoutMs: WINDOW,
        }

        // Start the run (don't await yet)
        const runPromise = runOpenCodeCore(params)

        // Emit first delta, advance time to just under the window, emit another, repeat
        emitNext(partDeltaObjectEvent('chunk 1'))
        await vi.advanceTimersByTimeAsync(WINDOW - 1000)
        emitNext(partDeltaObjectEvent('chunk 2'))
        await vi.advanceTimersByTimeAsync(WINDOW - 1000)
        emitNext(partDeltaObjectEvent('chunk 3'))
        await vi.advanceTimersByTimeAsync(WINDOW - 1000)

        // Now complete the run — session.idle
        streamDone()

        // #then — resolves successfully (no inactivity-timeout)
        await expect(runPromise).resolves.toBeUndefined()
      })

      it('(b) inactivity fires after the window with no further events', async () => {
        // #given — fake timers; inactivity window of 5000ms
        vi.useFakeTimers()
        const WINDOW = 5_000

        // Stream that yields one delta immediately, then hangs forever
        const handle = makeHandle({
          subscribe: async () =>
            Promise.resolve({stream: hangingStreamAfterFirst(partDeltaObjectEvent('initial chunk'))}),
        })
        const params = {
          ...buildParams(handle),
          coordinator: makeCoordinator(),
          inactivityTimeoutMs: WINDOW,
        }

        // Attach .catch() immediately so the rejection is handled before timers fire
        let capturedError: unknown
        const runPromise = runOpenCodeCore(params).catch((error: unknown) => {
          capturedError = error
        })

        // Let the run start and process the first delta (resets the timer), then advance past the window
        await vi.advanceTimersByTimeAsync(WINDOW + 1000)
        await runPromise

        // #then — inactivity-timeout thrown
        expect(capturedError).toBeInstanceOf(RunCoreError)
        expect((capturedError as RunCoreError).kind).toBe('inactivity-timeout')
      })

      it('(c) approval pause survives a long wait: timer cleared during approval, re-armed after', async () => {
        // #given — fake timers; inactivity window of 5000ms
        vi.useFakeTimers()
        const WINDOW = 5_000

        // Stream: permission.asked, then (after a long wait) permission.replied, then session.idle
        let emitReply!: () => void
        async function* controlledStream(): AsyncGenerator<object> {
          yield permissionAskedEvent('req-pause-1')
          // Simulate a long human approval wait — longer than the inactivity window
          await new Promise<void>(resolve => {
            emitReply = resolve
          })
          yield permissionRepliedEvent('req-pause-1', 'once')
          yield sessionIdleEvent('sess-123')
        }

        const handle = makeHandle({
          subscribe: async () => Promise.resolve({stream: controlledStream()}),
        })
        const params = {
          ...buildParams(handle),
          coordinator: makeCoordinator(),
          inactivityTimeoutMs: WINDOW,
        }

        const runPromise = runOpenCodeCore(params)

        // Advance past the inactivity window — timer should be cleared (paused) during approval
        await vi.advanceTimersByTimeAsync(WINDOW + 60_000)

        // Now the human approves
        emitReply()

        // #then — resolves successfully (no inactivity-timeout, because timer was paused)
        await expect(runPromise).resolves.toBeUndefined()
      })

      it('no dangling timer after successful run (vi.getTimerCount() === 0)', async () => {
        // #given — fake timers; normal run with inactivity timer set
        vi.useFakeTimers()

        const handle = makeHandle({
          subscribe: async () => subscribeOk([partDeltaObjectEvent('Hello'), sessionIdleEvent('sess-123')]),
        })
        const params = {
          ...buildParams(handle),
          coordinator: makeCoordinator(),
          inactivityTimeoutMs: 60_000,
        }

        // #when — run completes normally
        await runOpenCodeCore(params)

        // #then — no dangling timers remain
        expect(vi.getTimerCount()).toBe(0)
      })
    })

    // -------------------------------------------------------------------------
    // Human-wait gauge — the watchdog stays paused until every outstanding
    // approval has been released, not just the first one.
    // -------------------------------------------------------------------------

    describe('human-wait gauge', () => {
      const WINDOW = 5_000

      afterEach(() => {
        vi.useRealTimers()
      })

      type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: unknown}

      /** Starts a run over a hand-fed event stream under fake timers. */
      function startGaugeRun(): {
        readonly emit: (event: object) => Promise<void>
        readonly outcome: () => Outcome | undefined
        readonly done: Promise<void>
        readonly coordinator: ReturnType<typeof makeCoordinator>
      } {
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

        const coordinator = makeCoordinator()
        const handle = makeHandle({subscribe: async () => Promise.resolve({stream: stream()})})
        let settled: Outcome | undefined
        const done = runOpenCodeCore({...buildParams(handle), coordinator, inactivityTimeoutMs: WINDOW}).then(
          () => {
            settled = {ok: true}
          },
          (error: unknown) => {
            settled = {ok: false, error}
          },
        )

        return {
          emit: async event => {
            queue.push(event)
            if (wake !== null) {
              const resume: () => void = wake
              wake = null
              resume()
            }
            // Let the loop consume the event before the caller advances the clock.
            await vi.advanceTimersByTimeAsync(1)
          },
          outcome: () => settled,
          done,
          coordinator,
        }
      }

      function expectInactivityTimeout(outcome: Outcome | undefined): void {
        expect(outcome?.ok).toBe(false)
        if (outcome?.ok === false) {
          expect(outcome.error).toBeInstanceOf(RunCoreError)
          expect((outcome.error as RunCoreError).kind).toBe('inactivity-timeout')
        }
      }

      it('one approval asked then replied: paused while pending, then re-armed with a fresh window', async () => {
        // #given — one approval pending for far longer than the window
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))
        await vi.advanceTimersByTimeAsync(WINDOW * 4)
        expect(run.outcome()).toBeUndefined()

        // #when — the approval is replied
        await run.emit(permissionRepliedEvent('req-a', 'once'))

        // #then — the window restarts from the reply: not expired just before it, expired just after
        await vi.advanceTimersByTimeAsync(WINDOW - 10)
        expect(run.outcome()).toBeUndefined()
        await vi.advanceTimersByTimeAsync(20)
        await run.done
        expectInactivityTimeout(run.outcome())
      })

      it('two approvals, first replied: watchdog stays paused; re-arms only after the second is replied', async () => {
        // #given — two concurrent approvals
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))
        await run.emit(permissionAskedEvent('req-b'))

        // #when — the first is replied
        await run.emit(permissionRepliedEvent('req-a', 'once'))
        await vi.advanceTimersByTimeAsync(WINDOW * 4)

        // #then — still paused: the second approval is outstanding
        expect(run.outcome()).toBeUndefined()

        // #when — the second is replied
        await run.emit(permissionRepliedEvent('req-b', 'once'))
        await vi.advanceTimersByTimeAsync(WINDOW + 10)
        await run.done

        // #then — the watchdog is armed again and fires
        expectInactivityTimeout(run.outcome())
      })

      it('replied event for an unknown request id leaves the count unchanged while another item is pending', async () => {
        // #given — one approval pending
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))

        // #when — an echo arrives for an id that was never asked
        await run.emit(permissionRepliedEvent('req-ghost', 'once'))
        await vi.advanceTimersByTimeAsync(WINDOW * 4)

        // #then — no re-arm: the real approval is still outstanding
        expect(run.outcome()).toBeUndefined()

        // #when — the real approval is replied
        await run.emit(permissionRepliedEvent('req-a', 'once'))
        await vi.advanceTimersByTimeAsync(WINDOW + 10)
        await run.done

        // #then
        expectInactivityTimeout(run.outcome())
      })

      it('duplicate permission.asked for one id is counted once: a single reply re-arms', async () => {
        // #given — the same approval id asked twice
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))
        await run.emit(permissionAskedEvent('req-a'))

        // #when — one reply
        await run.emit(permissionRepliedEvent('req-a', 'once'))
        await vi.advanceTimersByTimeAsync(WINDOW + 10)
        await run.done

        // #then — the duplicate did not leave a phantom pending item
        expectInactivityTimeout(run.outcome())
      })

      it('repeated replied echo for the same id releases once: the other approval keeps the watchdog paused', async () => {
        // #given — two approvals, the first replied twice (echo repeated)
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))
        await run.emit(permissionAskedEvent('req-b'))
        await run.emit(permissionRepliedEvent('req-a', 'once'))

        // #when
        await run.emit(permissionRepliedEvent('req-a', 'once'))
        await vi.advanceTimersByTimeAsync(WINDOW * 4)

        // #then — the repeat did not drive the count below the outstanding second item
        expect(run.outcome()).toBeUndefined()

        // #when — second approval replied, then the run finishes
        await run.emit(permissionRepliedEvent('req-b', 'once'))
        await run.emit(sessionIdleEvent('sess-123'))
        await run.done

        // #then
        expect(run.outcome()).toEqual({ok: true})
      })

      it('replied echo from a session the run does not own does not release a pending approval', async () => {
        // #given — an owned approval pending
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))

        // #when — a foreign session replies with the same request id
        await run.emit(permissionRepliedEvent('req-a', 'once', 'sess-foreign'))
        await vi.advanceTimersByTimeAsync(WINDOW * 4)

        // #then — ownership gating keeps the approval outstanding
        expect(run.outcome()).toBeUndefined()
        expect(run.coordinator.onPermissionReplied).not.toHaveBeenCalled()

        await run.emit(permissionRepliedEvent('req-a', 'once'))
        await run.emit(sessionIdleEvent('sess-123'))
        await run.done
        expect(run.outcome()).toEqual({ok: true})
      })

      it('inactivity timeout does not fire during a single pending approval', async () => {
        // #given — one approval pending across many windows
        const run = startGaugeRun()
        await run.emit(permissionAskedEvent('req-a'))

        // #when
        await vi.advanceTimersByTimeAsync(WINDOW * 10)

        // #then — the run is still alive and completes once the approval resolves
        expect(run.outcome()).toBeUndefined()
        await run.emit(permissionRepliedEvent('req-a', 'once'))
        await run.emit(sessionIdleEvent('sess-123'))
        await run.done
        expect(run.outcome()).toEqual({ok: true})
      })
    })
  })

  // ---------------------------------------------------------------------------
  // Ownership-based event routing (Unit 4)
  //
  // `sess-123` is the root session (default in makeHandle/sessionCreateOk).
  // A "descendant" in these tests is any session id pre-adopted into the fake
  // coordinator via `makeCoordinator([...])`, modelling a ledger adoption a
  // later unit performs — Unit 4 only builds the routing that consults
  // ownership, not the adoption wiring itself.
  // ---------------------------------------------------------------------------
  describe('ownership-based event routing', () => {
    const DESCENDANT = 'sess-descendant-1'
    const DESCENDANT_2 = 'sess-descendant-2'
    const FOREIGN = 'sess-other-run'

    it('happy path: a descendant approval request is forwarded to the coordinator', async () => {
      // #given — DESCENDANT is pre-adopted (as a later unit's ledger-adoption would do)
      const coordinator = makeCoordinator([DESCENDANT])
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([permissionAskedEvent('req-desc-1', DESCENDANT), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then — the descendant's request reached the coordinator exactly as a root request would
      expect(coordinator.onPermissionAsked).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({requestID: 'req-desc-1', sessionID: DESCENDANT}),
      )
    })

    it('edge case: a session belonging to no run is ignored rather than routed', async () => {
      // #given — FOREIGN is never adopted; only the root is owned
      const coordinator = makeCoordinator()
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            permissionAskedEvent('req-foreign-1', FOREIGN),
            partDeltaObjectEvent('should not appear', FOREIGN),
            toolCalledEvent('call-1', 'bash', {command: 'ls'}, FOREIGN),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then — nothing from the foreign session reached a handler
      expect(coordinator.onPermissionAsked).not.toHaveBeenCalled()
      expect(sink._appended).toEqual([])
    })

    it('edge case: two descendants requesting approval concurrently are each forwarded independently', async () => {
      // #given
      const coordinator = makeCoordinator([DESCENDANT, DESCENDANT_2])
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            permissionAskedEvent('req-a', DESCENDANT),
            permissionAskedEvent('req-b', DESCENDANT_2),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then — both reached the coordinator, each with its own request/session pairing
      expect(coordinator.onPermissionAsked).toHaveBeenCalledTimes(2)
      expect(coordinator.onPermissionAsked).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'req-a', sessionID: DESCENDANT}),
      )
      expect(coordinator.onPermissionAsked).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'req-b', sessionID: DESCENDANT_2}),
      )
    })

    it('cross-run isolation: an event from a session owned by a different run is not handled by this one', async () => {
      // #given — FOREIGN represents a session that belongs to a wholly different
      // run's tree (e.g. another gateway invocation in the same workspace). It is
      // never adopted into this run's coordinator, so it must never reach this
      // run's handlers — proving the workspace-wide cross-run leak stays closed
      // rather than assuming it from the unowned-session case above.
      const coordinator = makeCoordinator([DESCENDANT])
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            // A permission ask from a totally different run's session.
            permissionAskedEvent('req-cross-run', FOREIGN),
            // Text and tool activity from that same foreign session.
            partDeltaObjectEvent('leaked output?', FOREIGN),
            toolCalledEvent('call-cross', 'bash', {command: 'rm -rf /'}, FOREIGN),
            toolSuccessEvent('call-cross', null, FOREIGN),
            // This run's own descendant activity, to prove the gate is selective
            // rather than blocking everything.
            partDeltaObjectEvent('legit output', DESCENDANT),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink, coordinator}

      // #when
      await runOpenCodeCore(params)

      // #then — the foreign session never reached the coordinator or the sink,
      // while the owned descendant's output did.
      expect(coordinator.onPermissionAsked).not.toHaveBeenCalled()
      expect(sink._appended).toEqual(['legit output'])
    })

    it('integration: a busy descendant keeps the run from reading as inactive while the root is idle', async () => {
      // #given — fake timers; inactivity window shorter than the descendant's
      // steady drumbeat of tool activity. The root session produces nothing
      // after the initial prompt (it "looks idle" from an activity standpoint)
      // but the descendant keeps sending tool events that must reset the
      // inactivity timer, because activity accounting now covers the owned tree.
      vi.useFakeTimers()
      const WINDOW = 5_000
      const coordinator = makeCoordinator([DESCENDANT])

      const eventQueue: object[] = []
      let resolveNext: (() => void) | null = null
      async function* controlledStream(): AsyncGenerator<object> {
        while (true) {
          if (eventQueue.length > 0) {
            const next = eventQueue.shift()
            if (next === undefined) break
            yield next
          } else {
            await new Promise<void>(resolve => {
              resolveNext = resolve
            })
          }
        }
      }
      const emitNext = (event: object) => {
        eventQueue.push(event)
        if (resolveNext !== null) {
          const r = resolveNext
          resolveNext = null
          r()
        }
      }

      const handle = makeHandle({subscribe: async () => Promise.resolve({stream: controlledStream()})})
      const params = {...buildParams(handle), coordinator, inactivityTimeoutMs: WINDOW}

      const runPromise = runOpenCodeCore(params)

      // Only the descendant produces activity; the root is silent the whole time.
      emitNext(toolCalledEvent('d-1', 'bash', {command: 'echo 1'}, DESCENDANT))
      emitNext(toolSuccessEvent('d-1', null, DESCENDANT))
      await vi.advanceTimersByTimeAsync(WINDOW - 1000)
      emitNext(toolCalledEvent('d-2', 'bash', {command: 'echo 2'}, DESCENDANT))
      emitNext(toolSuccessEvent('d-2', null, DESCENDANT))
      await vi.advanceTimersByTimeAsync(WINDOW - 1000)
      emitNext(toolCalledEvent('d-3', 'bash', {command: 'echo 3'}, DESCENDANT))
      emitNext(toolSuccessEvent('d-3', null, DESCENDANT))
      await vi.advanceTimersByTimeAsync(WINDOW - 1000)

      // Now the root itself goes idle — resolves the run.
      emitNext(sessionIdleEvent('sess-123'))

      // #then — resolves successfully; the descendant's activity prevented an
      // inactivity-timeout even though the root produced nothing on its own.
      await expect(runPromise).resolves.toBeUndefined()
      vi.useRealTimers()
    })
  })

  describe('drain (Unit 6) — holding the run through outstanding owned work', () => {
    const CHILD = 'sess-child-1'

    afterEach(() => {
      vi.useRealTimers()
    })

    it('happy path: a run with outstanding work drains, then completes and hands off the slot', async () => {
      // #given — a task tool completes carrying a background dispatch, then the root
      // goes idle while the child is still live. The reconcile adapter reports the
      // child live on the first check (still outstanding) and gone on the second
      // (settled), simulating the child finishing shortly after root idle.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      let statusCallCount = 0
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => {
          statusCallCount += 1
          // First reconcile pass (triggered immediately on root idle): child still live.
          // Second pass (triggered by the interval, or another idle) — no longer live.
          return {data: statusCallCount === 1 ? {[CHILD]: {}} : {}, error: null}
        },
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
      })

      const onOwnershipChange = vi.fn()
      const params = {...buildParams(handle), coordinator, ownershipLedger, onOwnershipChange}
      const runPromise = runOpenCodeCore(params)

      // Background dispatch observed, then root goes idle with the child still outstanding.
      emitNext(backgroundTaskCompletedEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))

      // Allow the immediate post-idle reconcile pass (still live) to land. The child then finishes: upstream
      // injects its completion notice into the parent, the parent answers it, and the root goes idle again.
      await new Promise(resolve => setTimeout(resolve, 10))
      emitNext(taskNoticeEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))

      // #then — resolves once the ledger drains; no drain-timeout, no throw.
      await expect(runPromise).resolves.toBeUndefined()

      // #and — the child was adopted (registered as owned) before it could be routed.
      expect(coordinator.addOwnedSession).toHaveBeenCalledWith(CHILD)
      // #and — the ledger ended up fully settled (nothing left outstanding or unknown).
      const finalSnapshot = ownershipLedger.snapshot()
      expect(finalSnapshot.find(e => e.sessionId === CHILD)?.state).toBe('settled')
    })

    it('edge case: the slot is not handed off while outstanding work remains (runOpenCodeCore does not resolve)', async () => {
      // #given — the child is adopted and never reported as gone; the run's own
      // deadline is far away, so nothing should resolve the promise.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        // Always live — the child never finishes from the reconciler's point of view.
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
      })

      const controller = new AbortController()
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        signal: controller.signal,
      }
      const runPromise = runOpenCodeCore(params)

      let settled = false
      runPromise
        .catch(() => {})
        .finally(() => {
          settled = true
        })

      emitNext(backgroundTaskCompletedEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))

      // Give every pending microtask/reconcile pass a chance to run.
      await new Promise(resolve => setTimeout(resolve, 50))

      // #then — still outstanding, so the promise has not settled — the slot has not
      // been handed off (run.ts's finally, which releases/hands off the slot, only
      // runs after runOpenCodeCore resolves).
      expect(settled).toBe(false)

      // Cleanup: force the deadline so the run resolves (drain-timeout) and the
      // reconciler's interval timer is disposed rather than leaking into later tests.
      controller.abort()
      await expect(runPromise).rejects.toThrow()
    })

    it('error path: the deadline expires mid-drain, cancellation runs, and the run reports incomplete', async () => {
      // #given — fake timers; a short deadline. The child is adopted but never settles
      // (always reported live), so the run enters drain and stays there until the
      // deadline fires.
      vi.useFakeTimers()
      const DEADLINE_MS = 5_000
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
        sessionAbort: abortSpy,
      })

      // A plain `setTimeout`-driven deadline — not `AbortSignal.timeout` — so it is
      // guaranteed to be governed by `vi.useFakeTimers()` (native AbortSignal.timeout
      // scheduling is not reliably fake-timer-controlled across environments).
      const controller = new AbortController()
      setTimeout(() => controller.abort(), DEADLINE_MS)
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        signal: controller.signal,
      }

      let capturedError: unknown
      const runPromise = runOpenCodeCore(params).catch((error: unknown) => {
        capturedError = error
      })

      emitNext(backgroundTaskCompletedEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))
      await vi.advanceTimersByTimeAsync(100) // let the immediate post-idle reconcile land (still live)

      // #when — the deadline fires with the child still outstanding.
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100)
      await runPromise

      // #then — drain-timeout, not a plain timeout: the run was draining, not merely executing.
      expect(capturedError).toBeInstanceOf(RunCoreError)
      expect((capturedError as RunCoreError).kind).toBe('drain-timeout')
      // #and — the outstanding child was cancelled individually.
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
      // #and — the entry is downgraded to unknown, not settled — cancellation was
      // requested but nothing here confirms the child actually stopped.
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('unknown')
    })

    it('edge case: a completion notification arriving during drain does not extend the deadline', async () => {
      // #given — fake timers; a short deadline. The child settles (reconcile observes
      // it gone) partway through the drain window, but the deadline itself must not
      // move — this test proves the deadline fires at the same relative time whether
      // or not a settlement event landed in between.
      vi.useFakeTimers()
      const DEADLINE_MS = 5_000
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      // The child never actually goes away (status always reports it live) — only the
      // root session ever goes idle again, which is what would (incorrectly) look like
      // a completion notification if it reset the clock. It must not: the deadline is
      // driven purely by the wall-clock signal below, untouched by drain-loop activity.
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
      })

      // A plain `setTimeout`-driven deadline (fake-timer-controlled) rather than
      // `AbortSignal.timeout` — see the deadline-expiry test above for why.
      const controller = new AbortController()
      setTimeout(() => controller.abort(), DEADLINE_MS)
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        signal: controller.signal,
      }

      let capturedError: unknown
      const runPromise = runOpenCodeCore(params).catch((error: unknown) => {
        capturedError = error
      })

      emitNext(backgroundTaskCompletedEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))
      await vi.advanceTimersByTimeAsync(1_000)
      // A second idle mid-drain — this is the closest thing to a "completion
      // notification" reaching the loop; it must not push the deadline out.
      emitNext(sessionIdleEvent('sess-123'))
      await vi.advanceTimersByTimeAsync(1_000)

      // #when — advance to just past the ORIGINAL deadline (2000ms already elapsed above).
      await vi.advanceTimersByTimeAsync(DEADLINE_MS - 2_000 + 100)
      await runPromise

      // #then — the deadline fired at its original time, not extended by the mid-drain event.
      expect(capturedError).toBeInstanceOf(RunCoreError)
      expect((capturedError as RunCoreError).kind).toBe('drain-timeout')
    })

    it('edge case: ownership is persisted onto run state as entries are adopted, not only at completion', async () => {
      // #given
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      let statusCallCount = 0
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => {
          statusCallCount += 1
          return {data: statusCallCount === 1 ? {[CHILD]: {}} : {}, error: null}
        },
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
      })

      const onOwnershipChange = vi.fn()
      const params = {...buildParams(handle), coordinator, ownershipLedger, onOwnershipChange}
      const runPromise = runOpenCodeCore(params)

      emitNext(backgroundTaskCompletedEvent(CHILD))

      // #then — adoption alone (before the root has even gone idle, let alone before
      // completion) already fired the persistence hook with the child included.
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(onOwnershipChange).toHaveBeenCalledWith({
        rootSessionId: 'sess-123',
        ownedSessionIds: [CHILD],
      })

      // Drive the run to completion so nothing leaks into the next test.
      emitNext(sessionIdleEvent('sess-123'))
      await new Promise(resolve => setTimeout(resolve, 10))
      emitNext(taskNoticeEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))
      await runPromise

      // #and — the final call omits the now-settled child (recovery has nothing left
      // to reconcile for a settled entry).
      const lastCall = onOwnershipChange.mock.calls.at(-1)?.[0] as {
        readonly rootSessionId: string
        readonly ownedSessionIds: readonly string[]
      }
      expect(lastCall.ownedSessionIds).not.toContain(CHILD)
    })

    it('root idle does not resolve while an entry is unknown, not only while outstanding', async () => {
      // #given — an entry already downgraded to unknown (e.g. a dropped event or a
      // failed reconciliation call) BEFORE the root goes idle. `unknown` is not proof
      // of completion, so root idle must not treat it as done.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      ownershipLedger.markUnknown(CHILD)
      const {stream, emitNext} = makeControlledStream()
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [], error: null}),
        sessionStatus: async () => ({data: {}, error: null}),
      })

      const controller = new AbortController()
      const params = {...buildParams(handle), coordinator, ownershipLedger, signal: controller.signal}
      const runPromise = runOpenCodeCore(params)

      let settled = false
      runPromise
        .catch(() => {})
        .finally(() => {
          settled = true
        })

      emitNext(sessionIdleEvent('sess-123'))

      // Give every pending microtask/reconcile pass a chance to run.
      await new Promise(resolve => setTimeout(resolve, 50))

      // #then — root idle received `ledger.isDrainComplete() === false` (one unknown
      // entry), so the promise has NOT settled — unlike the pre-fix behaviour, which
      // ignored `unknown` entirely and would have resolved here.
      expect(settled).toBe(false)

      // Cleanup: force the deadline so the run resolves and timers don't leak.
      controller.abort()
      await expect(runPromise).rejects.toThrow()
    })

    it('deadline expiry cancels an already-unknown entry, not only outstanding ones', async () => {
      // #given — fake timers; a short deadline. The child is unknown (not outstanding)
      // BEFORE the deadline fires — exactly the entry most likely still live, since
      // `unknown` means a dropped event or a failed reconciliation call, not a
      // confirmed finish.
      vi.useFakeTimers()
      const DEADLINE_MS = 5_000
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      ownershipLedger.markUnknown(CHILD)
      const {stream, emitNext} = makeControlledStream()

      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
        sessionAbort: abortSpy,
      })

      const controller = new AbortController()
      setTimeout(() => controller.abort(), DEADLINE_MS)
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        signal: controller.signal,
      }

      let capturedError: unknown
      const runPromise = runOpenCodeCore(params).catch((error: unknown) => {
        capturedError = error
      })

      emitNext(sessionIdleEvent('sess-123'))
      await vi.advanceTimersByTimeAsync(100) // let the immediate post-idle reconcile land

      // #when — the deadline fires with the child still unknown.
      await vi.advanceTimersByTimeAsync(DEADLINE_MS + 100)
      await runPromise

      // #then — drain-timeout, and the unknown entry was explicitly aborted, not skipped
      // because it was never `outstanding`.
      expect(capturedError).toBeInstanceOf(RunCoreError)
      expect((capturedError as RunCoreError).kind).toBe('drain-timeout')
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('unknown')
    })

    it('a run with no ledger behaves exactly as before — the drain path stays inert', async () => {
      // #given — no ownershipLedger provided at all.
      const coordinator = makeCoordinator()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), coordinator}

      // #when
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()

      // #then — none of the ledger-reconciliation SDK surface was ever touched.
      const client = handle.client as unknown as {
        readonly session: {
          readonly children: ReturnType<typeof vi.fn>
          readonly status: ReturnType<typeof vi.fn>
          readonly abort: ReturnType<typeof vi.fn>
        }
      }
      expect(client.session.children).not.toHaveBeenCalled()
      expect(client.session.status).not.toHaveBeenCalled()
      expect(client.session.abort).not.toHaveBeenCalled()
    })
  })

  describe('termination barrier (Unit 8) — settling owned work before a failure escapes', () => {
    const CHILD = 'sess-child-barrier'

    it('fast path: a child already settled before the failure — no abort call, error surfaces promptly with quarantined:false', async () => {
      // #given — the child settled BEFORE the root's session.error fires (the "same fixture
      // with B already settled" case): the barrier's fast path must not send any request.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      ownershipLedger.settle(CHILD)

      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123', 'LLM quota exceeded')]),
        sessionAbort: abortSpy,
      })
      const params = {...buildParams(handle), coordinator, ownershipLedger}

      // #when
      const thrown = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — the original causal error, promptly, unquarantined, and no wasted request.
      expect(thrown).toBeInstanceOf(RunCoreError)
      expect((thrown as RunCoreError).kind).toBe('session-error')
      expect((thrown as RunCoreError).quarantined).toBe(false)
      expect(abortSpy).not.toHaveBeenCalled()
    })

    it('outstanding child: cancelled and confirmed settled before the causal error escapes — quarantined:false', async () => {
      // #given — root dispatches child A (root) and B (CHILD); A errors while B is still
      // live. The barrier must cancel B (root too, as a safety net) and confirm it actually
      // stopped via reconciliation before letting the session-error escape.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')

      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123', 'LLM quota exceeded')]),
        sessionAbort: abortSpy,
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        // Confirmed gone after the abort round — reconciliation settles it.
        sessionStatus: async () => ({data: {}, error: null}),
      })
      const params = {...buildParams(handle), coordinator, ownershipLedger}

      // #when
      const thrown = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — the causal error is unchanged and unquarantined once settlement is confirmed.
      expect((thrown as RunCoreError).kind).toBe('session-error')
      expect((thrown as RunCoreError).quarantined).toBe(false)
      // #and — both the root AND the outstanding child were cancelled before the error escaped.
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: 'sess-123'}}))
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
      // #and — confirmed settled, not merely marked unknown.
      expect(ownershipLedger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('settled')
    })

    it('outstanding child cannot be confirmed settled — the causal error escapes quarantined:true, entry downgraded to unknown', async () => {
      // #given — the abort call succeeds (no envelope error, nothing thrown) but
      // reconciliation still reports the child live — confirmation, not delivery, is
      // what this barrier requires.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')

      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123', 'LLM quota exceeded')]),
        sessionAbort: abortSpy,
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}), // still live
      })
      const params = {...buildParams(handle), coordinator, ownershipLedger}

      // #when
      const thrown = await runOpenCodeCore(params).catch((error: unknown) => error)

      // #then — SAME kind and message as the original causal failure — quarantine is
      // additional evidence, never a replacement explanation.
      expect((thrown as RunCoreError).kind).toBe('session-error')
      expect((thrown as RunCoreError).message).toContain('LLM quota exceeded')
      expect((thrown as RunCoreError).quarantined).toBe(true)
      expect(ownershipLedger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('unknown')
    })

    it('an SDK error envelope on abort (no thrown exception) still results in quarantine when confirmation cannot proceed', async () => {
      // #given — session.abort resolves successfully at the transport level but carries an
      // error envelope (`{error: ...}`) — must be checked, not just a thrown exception.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')

      const abortSpy = vi.fn().mockResolvedValue({data: null, error: 'session not found'})
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123')]),
        sessionAbort: abortSpy,
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
      })
      const params = {...buildParams(handle), coordinator, ownershipLedger}

      // #when / #then
      const thrown = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect((thrown as RunCoreError).quarantined).toBe(true)
      expect(abortSpy).toHaveBeenCalled()
    })

    it('a non-session-error failure (stream-ended) with outstanding owned work also traverses the barrier', async () => {
      // #given — the stream closes before session.idle (no session.error at all) while a
      // child is still outstanding and unconfirmable — the barrier is not special-cased to
      // session.error; every failure path after ledger creation routes through it.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')

      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => subscribeOk([]),
        sessionAbort: abortSpy,
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
      })
      const params = {...buildParams(handle), coordinator, ownershipLedger}

      // #when / #then
      const thrown = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect((thrown as RunCoreError).kind).toBe('stream-ended')
      expect((thrown as RunCoreError).quarantined).toBe(true)
      expect(abortSpy).toHaveBeenCalledWith(expect.objectContaining({path: {id: CHILD}}))
    })

    it('an unowned session error is ignored and never reaches the barrier (regression guard — also covered above)', async () => {
      // #given — a stranger session's error must not cancel or quarantine THIS run's owned
      // work; the run continues to its own session.idle undisturbed.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      ownershipLedger.settle(CHILD)

      // The child's completion notice reaches the parent and is answered before the root's idle, so the
      // drain-completion gate has its evidence once the run reaches idle.
      const {stream, emitNext} = makeControlledStream()
      const abortSpy = vi.fn().mockResolvedValue({data: {}, error: null})
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionAbort: abortSpy,
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
      })
      const params = {...buildParams(handle), coordinator, ownershipLedger}
      const runPromise = runOpenCodeCore(params)

      emitNext(sessionErrorEvent('sess-someone-elses-session', 'unrelated failure'))
      emitNext(taskNoticeEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))

      // #when / #then — resolves normally; the barrier never runs at all.
      await expect(runPromise).resolves.toBeUndefined()
      expect(abortSpy).not.toHaveBeenCalled()
    })
  })

  describe('reconciliation settles what it tracks; it does not adopt what it cannot identify', () => {
    const CHILD = 'sess-reconciled-child'

    afterEach(() => {
      vi.useRealTimers()
    })

    it('regression guard: a live child the ledger never tracked is NOT adopted by reconciliation, and its events stay foreign to the coordinator', async () => {
      // #given — fake timers; the server reports CHILD as a live child of the root, but no
      // task-tool-completion event ever fires for it. This is exactly the shape of an ordinary
      // foreground `task` subagent mid-run — upstream creates its child session identically to a
      // background dispatch, so `children()`+`liveSessionIds()` alone cannot tell them apart.
      vi.useFakeTimers()
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
      })

      const sink = makeSink()
      const controller = new AbortController()
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        sink,
        signal: controller.signal,
      }
      const runPromise = runOpenCodeCore(params)

      // #when — no task-tool-completion event ever fires for CHILD; the reconciler's fixed
      // interval fires, with CHILD live and a child of the root per the server the whole time.
      expect(coordinator.isOwned(CHILD)).toBe(false)
      await vi.advanceTimersByTimeAsync(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)

      // #then — still not owned, still not tracked. There is no discriminant reconciliation
      // could use to adopt this session, so it never does.
      expect(coordinator.isOwned(CHILD)).toBe(false)
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)).toBeUndefined()

      // #and — a subsequent tool event for that child is dropped as foreign, not routed
      emitNext(toolCalledEvent('c-1', 'bash', {command: 'npm test'}, CHILD))
      emitNext(toolSuccessEvent('c-1', null, CHILD))
      await vi.advanceTimersByTimeAsync(0)
      expect(sink._appended.some(line => line.includes('npm test'))).toBe(false)

      // Cleanup: nothing is owned or outstanding, so root session.idle completes the run.
      emitNext(sessionIdleEvent('sess-123'))
      await runPromise
      controller.abort() // no-op safety net; run already resolved
    })

    it('a background dispatch observed via the real event path, whose settlement event is dropped, is still settled by reconciliation', async () => {
      // #given — CHILD is adopted the real way (a `task`-tool-completion event carrying
      // `metadata.background === true`), registering it with the coordinator. Its own
      // completion/settlement event then never arrives — simulating a dropped event — but the
      // server reports it no longer live.
      vi.useFakeTimers()
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()

      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        sessionStatus: async () => ({data: {}, error: null}), // CHILD absent — no longer live
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
      })

      const sink = makeSink()
      const controller = new AbortController()
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        sink,
        signal: controller.signal,
      }
      const runPromise = runOpenCodeCore(params)

      emitNext(backgroundTaskCompletedEvent(CHILD))
      await vi.advanceTimersByTimeAsync(0)
      expect(coordinator.isOwned(CHILD)).toBe(true)
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('outstanding')

      // #when — CHILD's own completion event never arrives, but the reconciler's fixed
      // interval fires and observes CHILD is no longer in liveSessionIds()
      await vi.advanceTimersByTimeAsync(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)

      // #then — settled without ever seeing a completion event for CHILD
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('settled')

      // Cleanup: nothing outstanding remains; the child's notice was answered, so root idle completes the run.
      emitNext(taskNoticeEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))
      await runPromise
    })

    it('the periodic reconciler is scoped to the run directory: a child busy in that directory stays outstanding', async () => {
      // #given — `session.status` is scoped per directory: it reports CHILD busy only for the
      // directory the run's sessions live in, and `{}` (200) for any other.
      vi.useFakeTimers()
      const directory = '/repos/myrepo'
      let childBusy = true
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()
      const sessionChildren = vi.fn().mockResolvedValue({data: [{id: CHILD}], error: null})
      const sessionStatus = vi.fn().mockImplementation(async (args?: {query?: {directory?: string}}) => ({
        data: childBusy && args?.query?.directory === directory ? {[CHILD]: {type: 'busy'}} : {},
        error: null,
      }))
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren,
        sessionStatus,
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
      })
      const params = {...buildParams(handle, {directory}), coordinator, ownershipLedger}
      const runPromise = runOpenCodeCore(params)

      emitNext(backgroundTaskCompletedEvent(CHILD))
      await vi.advanceTimersByTimeAsync(0)

      // #when — the reconciler's interval fires while CHILD is still busy
      await vi.advanceTimersByTimeAsync(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)

      // #then — both upstream calls carried the run's directory, so CHILD is not settled early
      expect(sessionChildren).toHaveBeenCalledWith({path: {id: 'sess-123'}, query: {directory}})
      expect(sessionStatus).toHaveBeenCalledWith({query: {directory}})
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('outstanding')

      // Cleanup: CHILD genuinely stops; the next pass settles it and root idle completes the run.
      childBusy = false
      await vi.advanceTimersByTimeAsync(DEFAULT_LEDGER_RECONCILE_INTERVAL_MS)
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('settled')
      emitNext(taskNoticeEvent(CHILD))
      emitNext(sessionIdleEvent('sess-123'))
      await runPromise
    })

    it("the Action's use of the reconciliation primitive is unaffected by the gateway's adoption callback (no coordinator exists there)", async () => {
      // #given — `reconcileLedgerOnce` invoked directly against a bare (unwrapped)
      // ownership ledger, exactly as `src/harness/phases/execute.ts` (the Action) does —
      // no gateway, no coordinator, no `wrapLedgerWithHooks` in the call path at all. CHILD is
      // adopted the real way first — reconciliation only ever settles what is already tracked.
      const {reconcileLedgerOnce} = await import('@fro-bot/runtime')
      const ledger = createOwnershipLedger()
      ledger.adopt(CHILD, 'background task')
      const adapter = {
        children: async () => ({success: true as const, data: [{id: CHILD}]}),
        liveSessionIds: async () => ({success: true as const, data: new Set<string>()}),
      }
      const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}

      // #when
      const result = await reconcileLedgerOnce({ledger, adapter, parentSessionId: 'root', logger})

      // #then — the tracked entry is settled; nothing about the gateway's coordinator-registration
      // hook is required or referenced by this call path.
      expect(result.success).toBe(true)
      expect(ledger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('settled')
    })
  })

  describe('idempotent ledger calls do not write to the object store (P2 fix)', () => {
    const CHILD = 'sess-idempotent-child'

    it('a repeated adopt of an already-tracked session fires no persistence write', async () => {
      // #given — CHILD already adopted before the duplicate task-tool-completion event arrives.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      const {stream, emitNext} = makeControlledStream()
      const handle = makeHandle({subscribe: async () => Promise.resolve({stream})})

      const onOwnershipChange = vi.fn()
      const controller = new AbortController()
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        onOwnershipChange,
        signal: controller.signal,
      }
      const runPromise = runOpenCodeCore(params)

      // #when — a duplicate completion notification for the already-tracked child arrives.
      emitNext(backgroundTaskCompletedEvent(CHILD))
      await new Promise(resolve => setTimeout(resolve, 10))

      // #then — the idempotent adopt() call fired no persistence write.
      expect(onOwnershipChange).not.toHaveBeenCalled()

      controller.abort()
      await expect(runPromise).rejects.toThrow()
    })

    it('a settle of an already-settled entry fires no persistence write', () => {
      // #given — a direct unit test of the wrapper itself. Through the real
      // `runOpenCodeCore` → `reconcileLedgerOnce` integration path, `settle()` can only
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

    it('a real state change still fires exactly one persistence write', async () => {
      // #given — CHILD adopted via the observed task-tool-completion path (a genuine,
      // first-time state transition from "untracked" to "outstanding").
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      const {stream, emitNext} = makeControlledStream()
      const handle = makeHandle({subscribe: async () => Promise.resolve({stream})})

      const onOwnershipChange = vi.fn()
      const controller = new AbortController()
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        onOwnershipChange,
        signal: controller.signal,
      }
      const runPromise = runOpenCodeCore(params)

      // #when
      emitNext(backgroundTaskCompletedEvent(CHILD))
      await new Promise(resolve => setTimeout(resolve, 10))

      // #then — exactly one persistence write for the one real transition.
      expect(onOwnershipChange).toHaveBeenCalledExactlyOnceWith({rootSessionId: 'sess-123', ownedSessionIds: [CHILD]})

      controller.abort()
      await expect(runPromise).rejects.toThrow()
    })

    it('an unknown entry reaches the persistence hook and appears in persisted run state', async () => {
      // #given — CHILD adopted (outstanding), then reconciliation observes it as belonging
      // to no known parent (not a child of this run) and downgrades it to unknown — a real
      // state transition distinct from the initial adopt.
      const coordinator = makeCoordinator()
      const ownershipLedger = createOwnershipLedger()
      ownershipLedger.adopt(CHILD, 'background task')
      const {stream, emitNext} = makeControlledStream()
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        // CHILD is not reported as a child of this parent at all — reconciliation downgrades
        // any such outstanding entry to unknown (see ledger-reconcile.ts).
        sessionChildren: async () => ({data: [], error: null}),
        sessionStatus: async () => ({data: {}, error: null}),
      })

      const onOwnershipChange = vi.fn()
      const controller = new AbortController()
      const params = {
        ...buildParams(handle),
        coordinator,
        ownershipLedger,
        onOwnershipChange,
        signal: controller.signal,
      }
      const runPromise = runOpenCodeCore(params)

      // #when — root goes idle; ledger is not drain-complete (CHILD outstanding), so an
      // immediate reconcile pass runs and downgrades CHILD to unknown.
      emitNext(sessionIdleEvent('sess-123'))
      await new Promise(resolve => setTimeout(resolve, 20))

      // #then — the transition to unknown reached the persistence hook, and the entry
      // still appears in persisted ownedSessionIds (unknown is not settled).
      expect(onOwnershipChange).toHaveBeenCalledWith({rootSessionId: 'sess-123', ownedSessionIds: [CHILD]})
      expect(ownershipLedger.snapshot().find(e => e.sessionId === CHILD)?.state).toBe('unknown')

      controller.abort()
      await expect(runPromise).rejects.toThrow()
    })
  })
  // ---------------------------------------------------------------------------
  // Question events (Unit 3)
  //
  // Real question coordinator, registry and request gate over a hand-fed event
  // stream and fake timers: these tests exercise run-core's gauge, drain, and
  // gate-subscription behavior against the actual settlement machinery.
  // ---------------------------------------------------------------------------
  describe('question events', () => {
    const WINDOW = 5_000
    const CHILD = 'sess-child-1'
    const FOREIGN = 'sess-other-run'
    const SECRET = 'SECRET-QUESTION-sk-live-abc123'
    const SCOPE = 'thread-1'

    afterEach(() => {
      vi.useRealTimers()
    })

    type Outcome = {readonly ok: true} | {readonly ok: false; readonly error: unknown}

    function expectInactivityTimeout(outcome: Outcome | undefined): void {
      expect(outcome?.ok).toBe(false)
      if (outcome?.ok === false) {
        expect(outcome.error).toBeInstanceOf(RunCoreError)
        expect((outcome.error as RunCoreError).kind).toBe('inactivity-timeout')
      }
    }

    /** Starts a run with the real question coordinator, registry and gate under fake timers. */
    function startQuestionRun(
      options: {
        readonly extraOwned?: readonly string[]
        /** Deadline for a question asked now; `'none'` models a run with no budget left for one. */
        readonly deadlineMs?: number | 'none'
        readonly effects?: Partial<QuestionSideEffects>
        readonly withQuestions?: boolean
        readonly ownershipLedger?: ReturnType<typeof createOwnershipLedger>
        readonly sessionStatus?: () => Promise<unknown>
        readonly sessionAbort?: () => Promise<unknown>
        readonly sessionMessages?: (args: unknown) => Promise<unknown>
        readonly onBusy?: (busy: boolean) => void
        readonly onRegistered?: () => void
        readonly signal?: AbortSignal
      } = {},
    ) {
      vi.useFakeTimers()
      const logger = makeLogger()
      const gate = createRequestGate({logger})
      const registry = createQuestionRegistry({logger, gate})
      const effects: QuestionSideEffects = {
        replyQuestion: vi.fn().mockResolvedValue({ok: true}),
        rejectQuestion: vi.fn().mockResolvedValue({ok: true}),
        ...options.effects,
      }
      const deadline = options.deadlineMs ?? 60_000
      const questions = createQuestionCoordinator({
        logger,
        registry,
        effects,
        scopeId: SCOPE,
        computeDeadlineMs: () => (deadline === 'none' ? undefined : deadline),
        ...(options.onRegistered === undefined ? {} : {onRegistered: options.onRegistered}),
      })
      const {stream, emitNext} = makeControlledStream()
      const coordinator = makeCoordinator(options.extraOwned)
      const handle = makeHandle({
        subscribe: async () => Promise.resolve({stream}),
        sessionChildren: async () => ({data: [{id: CHILD}], error: null}),
        ...(options.sessionStatus === undefined ? {} : {sessionStatus: options.sessionStatus}),
        ...(options.sessionAbort === undefined ? {} : {sessionAbort: options.sessionAbort}),
        ...(options.sessionMessages === undefined ? {} : {sessionMessages: options.sessionMessages}),
      })

      let settled: Outcome | undefined
      const done = runOpenCodeCore({
        ...buildParams(handle),
        logger,
        coordinator,
        ...(options.withQuestions === false ? {} : {questions}),
        onHumanWaitTerminal: gate.onTerminal,
        inactivityTimeoutMs: WINDOW,
        ...(options.ownershipLedger === undefined ? {} : {ownershipLedger: options.ownershipLedger}),
        ...(options.onBusy === undefined ? {} : {onBusy: options.onBusy}),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
      }).then(
        () => {
          settled = {ok: true}
        },
        (error: unknown) => {
          settled = {ok: false, error}
        },
      )

      return {
        logger,
        gate,
        registry,
        questions,
        effects,
        coordinator,
        done,
        outcome: () => settled,
        emit: async (event: object) => {
          emitNext(event)
          // Let the loop consume the event before the caller advances the clock.
          await vi.advanceTimersByTimeAsync(1)
        },
      }
    }

    it('root question asked: registered and the watchdog pauses; the replied echo confirms and re-arms', async () => {
      // #given a root-session question
      const run = startQuestionRun()
      await run.emit(questionAskedEvent('que_1'))

      // #then it is registered with the run's scope, and the watchdog stays paused far past the window
      expect(run.registry.describePendingForScope(SCOPE).map(dto => dto.requestID)).toEqual(['que_1'])
      await vi.advanceTimersByTimeAsync(WINDOW * 4)
      expect(run.outcome()).toBeUndefined()

      // #when OpenCode echoes the reply
      await run.emit(questionRepliedEvent('que_1'))

      // #then the entry is confirmed and the watchdog re-armed with a fresh window
      expect(run.registry.has('que_1')).toBe(false)
      await vi.advanceTimersByTimeAsync(WINDOW - 10)
      expect(run.outcome()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(20)
      await run.done
      expectInactivityTimeout(run.outcome())
    })

    it('a rejected echo releases the wait like a replied one: outside drain the watchdog re-arms', async () => {
      // #given a root-session question holding the watchdog
      const run = startQuestionRun()
      await run.emit(questionAskedEvent('que_1'))
      await vi.advanceTimersByTimeAsync(WINDOW * 4)
      expect(run.outcome()).toBeUndefined()

      // #when OpenCode echoes a rejection
      await run.emit(questionRejectedEvent('que_1'))

      // #then the entry is gone and the quiet run now times out on a fresh window
      expect(run.registry.has('que_1')).toBe(false)
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done
      expectInactivityTimeout(run.outcome())
    })

    it('an adopted child session question is registered with the run scope', async () => {
      // #given a child session the run owns
      const run = startQuestionRun({extraOwned: [CHILD]})

      // #when the child asks
      await run.emit(questionAskedEvent('que_child', CHILD))

      // #then
      expect(run.registry.describePendingForScope(SCOPE).map(dto => dto.requestID)).toEqual(['que_child'])
    })

    it('a question from a session the run does not own is ignored with a warning; the watchdog is unaffected', async () => {
      // #given
      const run = startQuestionRun()

      // #when a foreign session asks, carrying secret-shaped text
      await run.emit(questionAskedEvent('que_foreign', FOREIGN, SECRET))
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done

      // #then not registered, warned with ids and a reason code, and the watchdog was never paused
      expect(run.registry.pending()).toEqual([])
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_foreign', sessionID: FOREIGN, reason: 'unowned-session'}),
        expect.stringContaining('does not own'),
      )
      expectInactivityTimeout(run.outcome())
      expect(loggedText(run.logger)).not.toContain(SECRET)
    })

    it('approval and question pending together: the watchdog re-arms only after both settle', async () => {
      // #given an approval and a question outstanding
      const run = startQuestionRun()
      await run.emit(permissionAskedEvent('per_1'))
      await run.emit(questionAskedEvent('que_1'))

      // #when the approval is replied first
      await run.emit(permissionRepliedEvent('per_1', 'once'))
      await vi.advanceTimersByTimeAsync(WINDOW * 4)

      // #then the question still holds the watchdog
      expect(run.outcome()).toBeUndefined()

      // #when the question settles
      await run.emit(questionRepliedEvent('que_1'))
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done

      // #then the watchdog is armed again
      expectInactivityTimeout(run.outcome())
    })

    describe('activity does not undo the human-wait or drain pause', () => {
      it('(a) an owned child text delta while a question is pending does not re-arm the watchdog', async () => {
        // #given a pending question from an owned child, with a long question deadline
        const run = startQuestionRun({extraOwned: [CHILD]})
        await run.emit(questionAskedEvent('que_child', CHILD))

        // #when the child streams text, then everything goes quiet for longer than the window
        await run.emit(partDeltaWithPartId('still working', 'part-1', CHILD))
        await vi.advanceTimersByTimeAsync(WINDOW * 3)

        // #then no inactivity-timeout fired, and the question is still pending
        expect(run.outcome()).toBeUndefined()
        expect(run.registry.has('que_child')).toBe(true)
      })

      it('(b) a parallel root tool completion while a question is pending does not re-arm the watchdog', async () => {
        // #given a pending root question
        const run = startQuestionRun()
        await run.emit(questionAskedEvent('que_1'))

        // #when a parallel tool completes on the root, then silence longer than the window
        await run.emit(partUpdatedToolEvent('bash', 'completed', {input: {command: 'ls'}, title: 'ls'}))
        await vi.advanceTimersByTimeAsync(WINDOW * 3)

        // #then the run is still alive and the question is still pending
        expect(run.outcome()).toBeUndefined()
        expect(run.registry.has('que_1')).toBe(true)
      })

      it('(c) with two waits held and one settled, activity does not re-arm the watchdog', async () => {
        // #given a question and an approval outstanding
        const run = startQuestionRun()
        await run.emit(questionAskedEvent('que_1'))
        await run.emit(permissionAskedEvent('per_1'))

        // #when the approval settles, activity arrives, and the run goes quiet past the window
        await run.emit(permissionRepliedEvent('per_1', 'once'))
        await run.emit(partDeltaWithPartId('still working', 'part-1'))
        await vi.advanceTimersByTimeAsync(WINDOW * 3)

        // #then the question still holds the watchdog: no timeout
        expect(run.outcome()).toBeUndefined()
        expect(run.registry.has('que_1')).toBe(true)
      })

      it('(d) after the last wait settles outside drain, activity resets normally and silence still times out', async () => {
        // #given a question that has settled, re-arming the watchdog with a fresh window
        const run = startQuestionRun()
        await run.emit(questionAskedEvent('que_1'))
        await run.emit(questionRepliedEvent('que_1'))

        // #when activity arrives partway through the window
        await vi.advanceTimersByTimeAsync(WINDOW - 1_000)
        await run.emit(partDeltaWithPartId('output', 'part-1'))

        // #then the window restarted from the activity: alive just before it expires...
        await vi.advanceTimersByTimeAsync(WINDOW - 1_000)
        expect(run.outcome()).toBeUndefined()

        // #and silence past the window times out as before
        await vi.advanceTimersByTimeAsync(1_100)
        await run.done
        expectInactivityTimeout(run.outcome())
      })

      it('(e) activity while draining does not re-arm the watchdog: no inactivity timeout, no drain-timeout, no cancellation', async () => {
        // #given a live background child and the root gone idle (drain)
        const sessionAbort = vi.fn().mockResolvedValue({data: {}, error: null})
        const ownershipLedger = createOwnershipLedger()
        const run = startQuestionRun({
          extraOwned: [CHILD],
          ownershipLedger,
          sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
          sessionAbort,
        })
        await run.emit(backgroundTaskCompletedEvent(CHILD))
        await run.emit(sessionIdleEvent('sess-123'))
        expect(ownershipLedger.isDrainComplete()).toBe(false)

        // #when the child produces text and tool activity, then goes quiet past the window
        await run.emit(partDeltaWithPartId('child output', 'part-1', CHILD))
        await run.emit(partUpdatedToolEvent('bash', 'completed', {input: {command: 'ls'}, title: 'ls'}, CHILD))
        await vi.advanceTimersByTimeAsync(WINDOW * 4)

        // #then the run is still draining: no inactivity-timeout (which would surface as drain-timeout)
        expect(run.outcome()).toBeUndefined()
        // #and the owned work was not cancelled
        expect(sessionAbort).not.toHaveBeenCalled()
      })
    })

    it('#1736 drain: answering a question mid-drain neither completes the run, re-arms inactivity, nor cancels owned work', async () => {
      // #given a live background child, a pending question from it, and the root gone idle (drain)
      let childLive = true
      const sessionAbort = vi.fn().mockResolvedValue({data: {}, error: null})
      const onBusy = vi.fn()
      const ownershipLedger = createOwnershipLedger()
      const run = startQuestionRun({
        extraOwned: [CHILD],
        ownershipLedger,
        sessionStatus: async () => ({data: childLive ? {[CHILD]: {}} : {}, error: null}),
        sessionAbort,
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
        onBusy,
      })
      await run.emit(backgroundTaskCompletedEvent(CHILD))
      await run.emit(questionAskedEvent('que_child', CHILD))
      await run.emit(sessionIdleEvent('sess-123'))
      expect(ownershipLedger.isDrainComplete()).toBe(false)
      onBusy.mockClear()

      // #when the question is answered while draining
      await run.emit(questionRepliedEvent('que_child', CHILD))

      // #then the run is still draining and inactivity was not re-armed (typing stays off too)
      expect(run.outcome()).toBeUndefined()
      expect(onBusy).not.toHaveBeenCalledWith(true)

      // #and a quiet but valid child outlasts the inactivity window: no drain-timeout, no cancellation
      await vi.advanceTimersByTimeAsync(WINDOW * 4)
      expect(run.outcome()).toBeUndefined()
      expect(sessionAbort).not.toHaveBeenCalled()

      // #when the child settles through the ledger, its notice reaches the parent, and the parent answers it
      childLive = false
      await run.emit(taskNoticeEvent(CHILD))
      await run.emit(sessionIdleEvent('sess-123'))
      await run.done

      // #then the run completes normally, with the owned work settled rather than cancelled
      expect(run.outcome()).toEqual({ok: true})
      expect(ownershipLedger.snapshot().find(entry => entry.sessionId === CHILD)?.state).toBe('settled')
      expect(sessionAbort).not.toHaveBeenCalled()
    })

    it('#1736 drain: a question released by a failed deadline skip mid-drain does not complete the drain either', async () => {
      // #given a live child, its pending question with a short deadline whose skip reply fails, and drain
      const replyQuestion = vi.fn().mockResolvedValue({ok: false, error: 'down'})
      const sessionAbort = vi.fn().mockResolvedValue({data: {}, error: null})
      const run = startQuestionRun({
        deadlineMs: 1_000,
        effects: {replyQuestion},
        extraOwned: [CHILD],
        ownershipLedger: createOwnershipLedger(),
        sessionStatus: async () => ({data: {[CHILD]: {}}, error: null}),
        sessionAbort,
      })
      await run.emit(backgroundTaskCompletedEvent(CHILD))
      await run.emit(questionAskedEvent('que_child', CHILD))
      await run.emit(sessionIdleEvent('sess-123'))

      // #when the deadline passes and the terminal notification releases the wait
      await vi.advanceTimersByTimeAsync(1_000)
      expect(replyQuestion).toHaveBeenCalledExactlyOnceWith('que_child', [[]])
      expect(run.registry.has('que_child')).toBe(false)

      // #then the watchdog stays paused and the run keeps draining on the ledger
      await vi.advanceTimersByTimeAsync(WINDOW * 4)
      expect(run.outcome()).toBeUndefined()
      expect(sessionAbort).not.toHaveBeenCalled()
    })

    it('#1736 drain: root idle with a question pending and an empty ledger completes on the ledger alone; teardown rejects the question', async () => {
      // #given a question outstanding and nothing owned in the ledger
      const run = startQuestionRun({ownershipLedger: createOwnershipLedger()})
      await run.emit(questionAskedEvent('que_1'))
      expect(run.registry.has('que_1')).toBe(true)

      // #when the root goes idle
      await run.emit(sessionIdleEvent('sess-123'))
      await run.done

      // #then the run completed without waiting on the question, which nothing has settled
      expect(run.outcome()).toEqual({ok: true})
      expect(run.registry.has('que_1')).toBe(true)
      expect(run.effects.replyQuestion).not.toHaveBeenCalled()
      expect(run.effects.rejectQuestion).not.toHaveBeenCalled()

      // #when run teardown disposes the question
      await run.questions.dispose('run ended')

      // #then it is rejected through the existing teardown path
      expect(run.effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_1')
      expect(run.registry.has('que_1')).toBe(false)
    })

    it('#1736 drain: root idle with a question pending and a settled ledger completes on notice and root freshness, not the question; teardown rejects the question', async () => {
      // #given a background child that finishes (not live) while its question is still pending, and whose
      // completion notice the parent has already answered
      const ownershipLedger = createOwnershipLedger()
      const run = startQuestionRun({
        extraOwned: [CHILD],
        ownershipLedger,
        sessionStatus: async () => ({data: {}, error: null}),
        sessionMessages: rootMessages(completedFollowUpMessages([CHILD])),
      })
      await run.emit(backgroundTaskCompletedEvent(CHILD))
      await run.emit(questionAskedEvent('que_child', CHILD))
      await run.emit(taskNoticeEvent(CHILD))

      // #when the root goes idle and the reconcile pass settles the child
      await run.emit(sessionIdleEvent('sess-123'))
      await run.done

      // #then the ledger plus the notice and root freshness ended the drain; the question did not hold the run
      expect(ownershipLedger.isDrainComplete()).toBe(true)
      expect(run.outcome()).toEqual({ok: true})
      expect(run.registry.has('que_child')).toBe(true)
      expect(run.effects.rejectQuestion).not.toHaveBeenCalled()

      // #when run teardown disposes the question
      await run.questions.dispose('run ended')

      // #then it is rejected through the existing teardown path
      expect(run.effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_child')
      expect(run.registry.has('que_child')).toBe(false)
    })

    it('a pending approval alone does not hold root-idle completion (existing behavior)', async () => {
      // #given an approval pending when the root goes idle
      const run = startQuestionRun()
      await run.emit(permissionAskedEvent('per_1'))

      // #when
      await run.emit(sessionIdleEvent('sess-123'))
      await run.done

      // #then
      expect(run.outcome()).toEqual({ok: true})
    })

    it('malformed question.asked: warns with a reason code only, registers nothing, does not pause the watchdog', async () => {
      // #given a payload with a secret-shaped question but no options array
      const run = startQuestionRun()
      await run.emit({
        type: 'question.asked',
        properties: {id: 'que_bad', sessionID: 'sess-123', questions: [{question: SECRET, header: SECRET}]},
      })
      await run.emit({type: 'question.asked', properties: {sessionID: 'sess-123', questions: []}})

      // #when the run goes quiet
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done

      // #then nothing registered; the warnings carry reason codes; no secret in any log; watchdog fired
      expect(run.registry.pending()).toEqual([])
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({reason: 'invalid-question'}),
        expect.stringContaining('malformed'),
      )
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({reason: 'missing-request-id'}),
        expect.stringContaining('malformed'),
      )
      expect(loggedText(run.logger)).not.toContain(SECRET)
      expectInactivityTimeout(run.outcome())
    })

    it('malformed question.asked with a readable id is rejected so the agent does not wait for the timeout', async () => {
      // #given a payload whose questions are unparseable (secret-shaped) but whose id and session parse
      const run = startQuestionRun()

      // #when it arrives
      await run.emit({
        type: 'question.asked',
        properties: {id: 'que_bad', sessionID: 'sess-123', questions: [{question: SECRET, header: SECRET}]},
      })

      // #then the request is rejected through the question effects, and nothing is registered
      expect(run.effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_bad')
      expect(run.effects.replyQuestion).not.toHaveBeenCalled()
      expect(run.registry.pending()).toEqual([])
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_bad', reason: 'invalid-question'}),
        expect.stringContaining('rejected'),
      )
      expect(loggedText(run.logger)).not.toContain(SECRET)
    })

    it.each([
      ['more questions than the cap', MAX_QUESTIONS_PER_REQUEST + 1, 2],
      ['more options than the cap', 1, MAX_OPTIONS_PER_QUESTION + 1],
    ])('an ask with %s is rejected once and never stored or fanned out', async (_label, questionCount, optionCount) => {
      // #given an oversize ask with secret-shaped text and a readable id
      const onRegistered = vi.fn()
      const run = startQuestionRun({onRegistered})
      const oversizeQuestion = {
        question: SECRET,
        header: SECRET,
        options: Array.from({length: optionCount}, (_, index) => ({label: `${SECRET}-${index}`, description: ''})),
      }

      // #when it arrives
      await run.emit({
        type: 'question.asked',
        properties: {
          id: 'que_big',
          sessionID: 'sess-123',
          questions: Array.from({length: questionCount}, () => oversizeQuestion),
        },
      })

      // #then OpenCode is told to reject it, exactly once, and the gateway holds and announces nothing
      expect(run.effects.rejectQuestion).toHaveBeenCalledExactlyOnceWith('que_big')
      expect(run.effects.replyQuestion).not.toHaveBeenCalled()
      expect(run.registry.pending()).toEqual([])
      expect(run.registry.describePendingForScope(SCOPE)).toEqual([])
      expect(onRegistered).not.toHaveBeenCalled()
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_big', reason: 'oversize'}),
        expect.stringContaining('rejected'),
      )
      expect(loggedText(run.logger)).not.toContain(SECRET)
    })

    it('malformed question.asked whose reject fails is warned with a reason code and never throws', async () => {
      // #given the reject call fails
      const run = startQuestionRun({effects: {rejectQuestion: vi.fn().mockRejectedValue(new Error(SECRET))}})

      // #when a malformed ask with a readable id arrives
      await run.emit({
        type: 'question.asked',
        properties: {id: 'que_bad', sessionID: 'sess-123', questions: 'not-an-array'},
      })

      // #then the failure is a reason code in a warning, with no error text
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_bad', rejectOutcome: 'reject-threw'}),
        expect.stringContaining('could not be rejected'),
      )
      expect(loggedText(run.logger)).not.toContain(SECRET)
    })

    it('malformed question.asked with no parseable id is only warn-logged, never rejected', async () => {
      // #given a payload with no id
      const run = startQuestionRun()

      // #when it arrives
      await run.emit({type: 'question.asked', properties: {sessionID: 'sess-123', questions: []}})

      // #then nothing can be addressed: warn only, no reject
      expect(run.effects.rejectQuestion).not.toHaveBeenCalled()
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({reason: 'missing-request-id'}),
        expect.stringContaining('malformed'),
      )
    })

    it('malformed question.asked from an unowned session is never rejected', async () => {
      // #given a malformed ask from a session this run does not own
      const run = startQuestionRun()

      // #when it arrives
      await run.emit({
        type: 'question.asked',
        properties: {id: 'que_foreign', sessionID: FOREIGN, questions: 'not-an-array'},
      })

      // #then the run leaves another run's request alone
      expect(run.effects.rejectQuestion).not.toHaveBeenCalled()
    })

    it('without a question handler an owned question.asked is warned and does not pause the watchdog', async () => {
      // #given
      const run = startQuestionRun({withQuestions: false})

      // #when
      await run.emit(questionAskedEvent('que_1', 'sess-123', SECRET))
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done

      // #then
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({reason: 'no-question-handler'}),
        expect.any(String),
      )
      expect(loggedText(run.logger)).not.toContain(SECRET)
      expectInactivityTimeout(run.outcome())
    })

    it('budget below the deadline floor: skipped immediately with empty answers, never registered, gauge back to zero', async () => {
      // #given a run with no budget left for a deadline
      const run = startQuestionRun({deadlineMs: 'none'})

      // #when a question is asked (secret-shaped text)
      await run.emit(questionAskedEvent('que_late', 'sess-123', SECRET))

      // #then an empty reply for every question went out and nothing is registered
      expect(run.effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_late', [[]])
      expect(run.effects.rejectQuestion).not.toHaveBeenCalled()
      expect(run.registry.pending()).toEqual([])
      expect(run.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({requestID: 'que_late', reason: 'no-deadline-budget'}),
        expect.any(String),
      )
      expect(loggedText(run.logger)).not.toContain(SECRET)

      // #and the gauge returned to zero: the watchdog is armed again and root idle completes
      await run.emit(sessionIdleEvent('sess-123'))
      await run.done
      expect(run.outcome()).toEqual({ok: true})
    })

    it('budget below the floor with a failing skip reply: the gauge is still released', async () => {
      // #given the immediate skip fails (reported error) and then throws
      const replyQuestion = vi
        .fn()
        .mockResolvedValueOnce({ok: false, error: 'down'})
        .mockRejectedValueOnce(new Error(SECRET))
      const run = startQuestionRun({deadlineMs: 'none', effects: {replyQuestion}})

      // #when two questions are asked
      await run.emit(questionAskedEvent('que_a'))
      await run.emit(questionAskedEvent('que_b'))

      // #then the watchdog re-armed (nothing is held)
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done
      expectInactivityTimeout(run.outcome())
      expect(loggedText(run.logger)).not.toContain(SECRET)
    })

    it('deadline skip POST fails with no echo: the terminal notification releases the gauge and re-arms the watchdog', async () => {
      // #given a registered question whose skip reply will fail, and no echo will ever arrive
      const replyQuestion = vi.fn().mockResolvedValue({ok: false, error: 'down'})
      const run = startQuestionRun({deadlineMs: 1_000, effects: {replyQuestion}})
      await run.emit(questionAskedEvent('que_1'))

      // #when the deadline passes
      await vi.advanceTimersByTimeAsync(1_000)

      // #then the skip was attempted and the entry left the gate
      expect(replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[]])
      expect(run.registry.has('que_1')).toBe(false)

      // #and the watchdog was re-armed by the terminal notification alone: the quiet run times out
      expect(run.outcome()).toBeUndefined()
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done
      expectInactivityTimeout(run.outcome())
    })

    it('deadline skip with a throwing reply effect: contained, the watchdog re-arms', async () => {
      // #given
      const replyQuestion = vi.fn().mockRejectedValue(new Error(SECRET))
      const run = startQuestionRun({deadlineMs: 1_000, effects: {replyQuestion}})
      await run.emit(questionAskedEvent('que_1'))

      // #when the deadline passes and the run then goes quiet for a full window
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await run.done

      // #then nothing threw into the loop; the only failure is the (re-armed) inactivity timeout
      expectInactivityTimeout(run.outcome())
      expect(loggedText(run.logger)).not.toContain(SECRET)
    })

    it('#1736: a question with no further events is skipped at its deadline, not failed by the inactivity timeout', async () => {
      // #given the historical failure: a question is asked and OpenCode then goes quiet for far
      // longer than the inactivity window (5s here; 5 min in production)
      const run = startQuestionRun({deadlineMs: 60_000})
      await run.emit(questionAskedEvent('que_1', 'sess-123', SECRET))

      // #when the question deadline passes
      await vi.advanceTimersByTimeAsync(60_000)

      // #then it was skipped with an empty reply and the run is still alive
      expect(run.effects.replyQuestion).toHaveBeenCalledExactlyOnceWith('que_1', [[]])
      expect(run.outcome()).toBeUndefined()

      // #when OpenCode echoes the skip and the agent finishes
      await run.emit(questionRepliedEvent('que_1', 'sess-123', [[]]))
      await run.emit(sessionIdleEvent('sess-123'))
      await run.done

      // #then the run completed; it did not reach the inactivity timeout
      expect(run.outcome()).toEqual({ok: true})
    })

    it('an echo releases the wait even when the gate holds no entry for it', async () => {
      // #given a handler that accepts the question but never registers it with the gate
      vi.useFakeTimers()
      const logger = makeLogger()
      const questions = {
        onAsked: vi.fn().mockResolvedValue('registered'),
        onEcho: vi.fn(),
        onMalformed: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
      }
      const {stream, emitNext} = makeControlledStream()
      let settled: Outcome | undefined
      const done = runOpenCodeCore({
        ...buildParams(makeHandle({subscribe: async () => Promise.resolve({stream})})),
        logger,
        coordinator: makeCoordinator(),
        questions,
        inactivityTimeoutMs: WINDOW,
      }).then(
        () => {
          settled = {ok: true}
        },
        (error: unknown) => {
          settled = {ok: false, error}
        },
      )
      emitNext(questionAskedEvent('que_1'))
      await vi.advanceTimersByTimeAsync(WINDOW * 4)
      expect(settled).toBeUndefined()

      // #when OpenCode echoes the settlement
      emitNext(questionRepliedEvent('que_1'))
      await vi.advanceTimersByTimeAsync(WINDOW + 10)
      await done

      // #then the echo reached the handler and re-armed the watchdog
      expect(questions.onEcho).toHaveBeenCalledOnce()
      expectInactivityTimeout(settled)
    })

    it('a skip that finishes after the run ended does not re-arm a timer', async () => {
      // #given a question skipped for lack of budget whose reply is still in flight when the run is aborted
      const controller = new AbortController()
      let resolveReply!: (result: {ok: true}) => void
      const replyQuestion = vi.fn().mockReturnValue(
        new Promise<{ok: true}>(resolve => {
          resolveReply = resolve
        }),
      )
      const run = startQuestionRun({
        deadlineMs: 'none',
        effects: {replyQuestion},
        signal: controller.signal,
      })
      await run.emit(questionAskedEvent('que_1'))
      controller.abort()
      await vi.advanceTimersByTimeAsync(1)
      await run.done
      expect(run.outcome()?.ok).toBe(false)

      // #when the reply finally completes
      resolveReply({ok: true})
      await vi.advanceTimersByTimeAsync(1)

      // #then the late release did not resurrect the disposed watchdog
      expect(vi.getTimerCount()).toBe(0)
    })

    it('aborting the run with a question pending ends the run without hanging on the wait', async () => {
      // #given a pending question and an operator cancel
      const controller = new AbortController()
      const run = startQuestionRun({signal: controller.signal})
      await run.emit(questionAskedEvent('que_1'))

      // #when the run is aborted
      controller.abort()
      await vi.advanceTimersByTimeAsync(1)
      await run.done

      // #then run-core exits with the timeout-signal failure (run.ts rejects the pending question during teardown)
      expect(run.outcome()).toMatchObject({ok: false, error: {kind: 'timeout'}})
    })
  })
})
