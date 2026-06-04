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
 * `message.part.updated` with partType:'tool' — OpenCode 1.15.13 contract.
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

/** `session.error` event for a given session. */
function sessionErrorEvent(sessionID: string, error = 'LLM error'): object {
  return {type: 'session.error', properties: {sessionID, error}}
}

/**
 * Build a minimal `OpenCodeServerHandle` test double.
 * All SDK methods are vi.fn() by default; callers override what they need.
 */
function makeHandle(
  overrides: {
    readonly sessionCreate?: () => Promise<unknown>
    readonly promptAsync?: (args: unknown) => Promise<unknown>
    readonly subscribe?: (args: unknown) => Promise<unknown>
  } = {},
): OpenCodeServerHandle {
  const sessionCreate = overrides.sessionCreate ?? (async () => sessionCreateOk())
  const promptAsync = overrides.promptAsync ?? (async () => promptAsyncOk())
  const subscribe = overrides.subscribe ?? (async () => subscribeOk([sessionIdleEvent('sess-123')]))

  const client = {
    session: {
      create: vi.fn().mockImplementation(sessionCreate),
      promptAsync: vi.fn().mockImplementation(promptAsync),
    },
    event: {
      subscribe: vi.fn().mockImplementation(subscribe),
    },
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
  overrides: Partial<typeof BASE_PARAMS> = {},
): Parameters<typeof runOpenCodeCore>[0] {
  return {
    handle,
    directory: overrides.directory ?? BASE_PARAMS.directory,
    promptText: overrides.promptText ?? BASE_PARAMS.promptText,
    sink: makeSink(),
    signal: new AbortController().signal,
    logger: makeLogger(),
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
      // #given
      const handle = makeHandle()
      const params = buildParams(handle)

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      const combined = sink.buffered()
      expect(combined).toContain('pnpm test')
      expect(combined).toContain('bash')
    })

    it('uses input.cmd as fallback for bash when command is absent', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'bash', {cmd: 'ls -la'}),
            toolSuccessEvent('call-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('ls -la')
    })

    it('uses structured.title when present (wins over input.command)', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'bash', {command: 'some command'}),
            toolSuccessEvent('call-1', {title: 'Structured Title'}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('Structured Title')
      // Should NOT fall through to the raw command
      expect(sink.buffered()).not.toContain('some command')
    })

    it('uses tool name as title for non-bash tools', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            toolCalledEvent('call-1', 'read_file', {path: '/foo/bar.ts'}),
            toolSuccessEvent('call-1'),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('read_file')
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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then — no progress line appended
      expect(sink._appended).toHaveLength(0)
    })
  })

  describe('tool call progress (message.part.updated — OpenCode 1.15.13 contract)', () => {
    it('appends a progress line for a bash tool using state.title', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'completed', {title: 'echo hi', input: {command: 'echo hi'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      const combined = sink.buffered()
      expect(combined).toContain('bash')
      expect(combined).toContain('echo hi')
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
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('pnpm test')
    })

    it('falls back to input.cmd when command is absent', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('bash', 'completed', {input: {cmd: 'ls -la'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('ls -la')
    })

    it('uses tool name as title for non-bash tools when state.title is absent', async () => {
      // #given
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () =>
          subscribeOk([
            partUpdatedToolEvent('read_file', 'completed', {input: {path: '/foo/bar.ts'}, output: ''}),
            sessionIdleEvent('sess-123'),
          ]),
      })
      const params = {...buildParams(handle), sink}

      // #when
      await runOpenCodeCore(params)

      // #then
      expect(sink.buffered()).toContain('read_file')
    })

    it('does NOT emit a tool line for partType text (no double-render)', async () => {
      // #given — message.part.updated with type:'text' must not produce a 🔧 line
      const sink = makeSink()
      const handle = makeHandle({
        subscribe: async () => subscribeOk([partUpdatedTextEvent('some text content'), sessionIdleEvent('sess-123')]),
      })
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink}

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
      const params = buildParams(handle, {directory: '/repos/myrepo'})

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
      const params = buildParams(handle, {directory: '/repos/myrepo'})

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
      const params = buildParams(handle, {directory: '/repos/myrepo'})

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

  describe('error path — server unreachable', () => {
    it('throws RunCoreError with kind "unreachable" when session.create throws', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => Promise.reject(new TypeError('fetch failed')),
      })
      const params = buildParams(handle)

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toThrow(RunCoreError)
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'unreachable'})
    })

    it('throws RunCoreError with kind "unreachable" when session.create returns an error', async () => {
      // #given
      const handle = makeHandle({
        sessionCreate: async () => Promise.resolve({data: null, error: {message: 'ECONNREFUSED'}}),
      })
      const params = buildParams(handle)

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'unreachable'})
    })

    it('throws RunCoreError with kind "unreachable" when promptAsync throws', async () => {
      // #given
      const handle = makeHandle({
        promptAsync: async () => Promise.reject(new TypeError('fetch failed')),
      })
      const params = buildParams(handle)

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
      const params = buildParams(handle)

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'auth'})
    })

    it('throws RunCoreError with kind "auth" when promptAsync returns 401 error', async () => {
      // #given
      const handle = makeHandle({
        promptAsync: async () => Promise.resolve({data: null, error: {status: 401, message: '401 Unauthorized'}}),
      })
      const params = buildParams(handle)

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'auth'})
    })

    it('throws RunCoreError with kind "auth" on 403 forbidden response', async () => {
      // #given — 403 Forbidden with numeric status (after tightening isAuthError to numeric-only)
      const handle = makeHandle({
        sessionCreate: async () => Promise.resolve({data: null, error: {status: 403, message: 'Forbidden'}}),
      })
      const params = buildParams(handle)

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
      const params = buildParams(handle)

      // #when / #then
      await expect(runOpenCodeCore(params)).rejects.toMatchObject({kind: 'session-error'})
    })

    it('thrown RunCoreError is an instance of RunCoreError', async () => {
      // #given
      const handle = makeHandle({
        subscribe: async () => subscribeOk([sessionErrorEvent('sess-123')]),
      })
      const params = buildParams(handle)

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
      const params = {...buildParams(handle), sink}

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
      const params = {...buildParams(handle), sink, signal: controller.signal}

      // #when — aborted signal → timeout kind thrown before any events processed
      await expect(runOpenCodeCore(params)).rejects.toThrow(RunCoreError)

      // #then — no content was appended
      expect(sink._appended).toHaveLength(0)
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
      const params = buildParams(handle)

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
      const params = buildParams(handle)

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
      const params = buildParams(handle)

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
      const params = buildParams(handle)

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
      const params = buildParams(handle)

      // #when / #then — falls through to 'unreachable'
      const err = await runOpenCodeCore(params).catch((error: unknown) => error)
      expect(err).toBeInstanceOf(RunCoreError)
      expect((err as RunCoreError).kind).toBe('unreachable')
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

    it('does NOT throw when coordinator is absent and permission.asked arrives', async () => {
      // #given — no coordinator param (back-compat)
      const handle = makeHandle({
        subscribe: async () => subscribeOk([permissionAskedEvent('req-1'), sessionIdleEvent('sess-123')]),
      })
      const params = buildParams(handle) // no coordinator

      // #when / #then — must resolve cleanly
      await expect(runOpenCodeCore(params)).resolves.toBeUndefined()
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
      const params = buildParams(handle)

      // #when
      await runOpenCodeCore(params)

      // #then — subscribe fires before prompt
      expect(callOrder).toEqual(['subscribe', 'promptAsync'])
    })
  })
})
