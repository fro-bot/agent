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
import type {GatewayLogger} from '../discord/client.js'
import type {DiscordStreamSink} from '../discord/streaming.js'

import {describe, expect, it, vi} from 'vitest'

import {RunCoreError, runOpenCodeCore} from './run-core.js'

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

/** `session.error` event for a given session. */
function sessionErrorEvent(sessionID: string, error = 'LLM error'): object {
  return {type: 'session.error', properties: {sessionID, error}}
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
  } = {},
): OpenCodeServerHandle {
  const sessionCreate = overrides.sessionCreate ?? (async () => sessionCreateOk())
  const promptAsync = overrides.promptAsync ?? (async () => promptAsyncOk())
  const subscribe = overrides.subscribe ?? (async () => subscribeOk([sessionIdleEvent('sess-123')]))
  const postPermissionReply = overrides.postPermissionReply ?? (async () => ({error: null}))

  const client = {
    session: {
      create: vi.fn().mockImplementation(sessionCreate),
      promptAsync: vi.fn().mockImplementation(promptAsync),
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

/** Build a fake PermissionCoordinator with vi.fn() methods. */
function makeCoordinator(): PermissionCoordinator {
  return {
    onPermissionAsked: vi.fn().mockResolvedValue('once'),
    onPermissionReplied: vi.fn(),
    pending: vi.fn().mockReturnValue([]),
    dispose: vi.fn(),
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
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partDeltaObjectEvent('partial answer'),
            // No sessionIdleEvent — stream ends prematurely
          ]),
      })
      const params = {...buildParams(handle), coordinator: makeCoordinator()}

      // #when / #then
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('stream-ended')
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
})
