/**
 * A Discord-started run's approvals, end to end between the real registry, the real Discord transport, and the real
 * web announcer (#2115). Only the edges are faked: the reply sink, the OpenCode reply POST, and the SSE observer
 * (a recorder standing in for `RunObservationManager.observeApproval`).
 *
 * Pins, for a run that started in Discord:
 *   - the dashboard gets the same open / settled frames a web run's subscribers get,
 *   - the settled frame is emitted on EVERY settlement path, including when the Discord card never posted,
 *   - a dashboard decision settles the Discord card as `Approved by <login> (dashboard)`,
 *   - a Discord click racing a dashboard decision settles exactly once.
 */

import type {ApprovalFrameData} from '../operator-contract/approval-frame.js'
import type {PermissionRequest} from './coordinator.js'
import type {ApprovalActor} from './registry.js'

import {DiscordAPIError, RESTJSONErrorCodes} from 'discord.js'
import {describe, expect, it, vi} from 'vitest'

import {createWebApprovalOnRegistered} from '../web/operator/web-approval.js'
import {createDiscordApprovalOnPending} from './discord-transport.js'
import {createApprovalRegistry} from './registry.js'

const RUN_ID = 'run-discord-1'
const THREAD_ID = 'thread-99'
const SESSION_ID = 'ses_1'

const WEB_OPERATOR: ApprovalActor = {
  kind: 'web-operator',
  githubUserId: 1001,
  login: 'alice',
  sessionCorrelationId: 'sess-abc',
}
const DISCORD_USER: ApprovalActor = {kind: 'discord-user', userId: '123456789'}

function makeLogger() {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(requestID = 'per_1'): PermissionRequest {
  return {requestID, sessionID: SESSION_ID, permission: 'bash', patterns: [], title: 'Run command: ls', command: 'ls'}
}

function terminalDiscordError(): DiscordAPIError {
  return new DiscordAPIError(
    {message: 'Unknown Channel', code: RESTJSONErrorCodes.UnknownChannel},
    RESTJSONErrorCodes.UnknownChannel,
    404,
    'POST',
    '/channels/thread-99/messages',
    {},
  )
}

type EmbedOutcome = 'posted' | 'retryable-failure' | 'terminal-failure'

/**
 * Wires one Discord-launched run exactly as `run.ts` + `program.ts` do: the registry is shared, the Discord
 * transport registers, and the web announcer is its `onRegistered` hook.
 */
function setup(embed: EmbedOutcome = 'posted', approvalDeadlineMs?: number) {
  const logger = makeLogger()
  const registry = createApprovalRegistry({logger})
  const frames: {runId: string; data: ApprovalFrameData}[] = []
  const edit = vi.fn().mockResolvedValue({})
  const postReply = vi.fn(async () => ({ok: true}))

  const send = vi.fn(async (_target: string, options: {embeds?: readonly unknown[]}) => {
    if (options.embeds === undefined) return {success: true, data: {id: 'msg_other'}}
    if (embed === 'posted') return {success: true, data: {id: 'msg_embed', edit}}
    return {success: false, error: embed === 'terminal-failure' ? terminalDiscordError() : new Error('rate limited')}
  })
  const replySink = {
    send,
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    buffered: vi.fn().mockReturnValue(''),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
  }

  const onRegistered = createWebApprovalOnRegistered({
    observeApproval: (runId, data) => {
      frames.push({runId, data})
    },
    logger,
  })({approvalRegistry: registry, runId: RUN_ID, repo: 'acme/widget'})

  const onPending = createDiscordApprovalOnPending({
    approvalRegistry: registry,
    replySink,
    threadId: THREAD_ID,
    runId: RUN_ID,
    onRegistered,
    directory: '/workspace/acme/widget',
    approvalDeadlineMs,
    onDeadlineSettled: undefined,
    postReplyFactory: () => postReply,
    logger,
  })

  /** The settled description of the card edit, if the card was edited. */
  const cardDescription = (): string | undefined => {
    const edited = edit.mock.calls[0]?.[0] as {embeds: readonly {toJSON: () => {description?: string}}[]} | undefined
    return edited?.embeds[0]?.toJSON().description
  }
  const settledFrames = (requestID: string) =>
    frames.filter(f => f.data.requestID === requestID && f.data.settled === true)
  const openFrames = (requestID: string) =>
    frames.filter(f => f.data.requestID === requestID && f.data.settled === false)

  return {registry, frames, edit, postReply, onPending, cardDescription, settledFrames, openFrames}
}

const flush = async () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('Discord-launched run: dashboard frames', () => {
  it('emits the open frame to the run when a request is raised', async () => {
    // #given/#when
    const {onPending, frames} = setup()
    onPending(makeRequest())
    await flush()

    // #then
    expect(frames).toEqual([
      {runId: RUN_ID, data: {requestID: 'per_1', permission: 'bash', command: 'ls', settled: false}},
    ])
  })

  it('lists the request for the run and lets the dashboard decide it, settling the card as a dashboard decision', async () => {
    // #given an open request
    const {onPending, registry, postReply, cardDescription, settledFrames} = setup()
    onPending(makeRequest())
    await flush()
    expect(registry.describePendingForRun(RUN_ID).map(a => a.requestID)).toEqual(['per_1'])

    // #when the dashboard approves it, and OpenCode echoes the reply
    const outcome = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: RUN_ID,
      runId: RUN_ID,
      decision: 'once',
      actor: WEB_OPERATOR,
    })
    registry.confirmReply({requestID: 'per_1', sessionID: SESSION_ID, reply: 'once'})
    await flush()

    // #then the reply went upstream once, the card says who decided and from where, and the dashboard got one settle
    expect(outcome).toBe('ok')
    expect(postReply).toHaveBeenCalledTimes(1)
    expect(cardDescription()).toBe('Approved by alice (dashboard)')
    expect(settledFrames('per_1')).toHaveLength(1)
    expect(registry.describePendingForRun(RUN_ID)).toEqual([])
  })

  it('a Discord click settles it too, and the dashboard still gets the settle frame', async () => {
    // #given
    const {onPending, registry, cardDescription, settledFrames} = setup()
    onPending(makeRequest())
    await flush()

    // #when the Discord button is clicked from the thread
    await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: THREAD_ID,
      decision: 'once',
      actor: DISCORD_USER,
    })
    registry.confirmReply({requestID: 'per_1', sessionID: SESSION_ID, reply: 'once'})
    await flush()

    // #then
    expect(cardDescription()).toBe('Approved by <@123456789>')
    expect(settledFrames('per_1')).toHaveLength(1)
  })

  it('a Discord click racing a dashboard decision settles exactly once', async () => {
    // #given a request, with the upstream reply held in flight
    const {onPending, registry, postReply, cardDescription, settledFrames} = setup()
    let release: () => void = () => undefined
    postReply.mockImplementation(
      async () =>
        new Promise(resolve => {
          release = () => resolve({ok: true})
        }),
    )
    onPending(makeRequest())
    await flush()

    // #when both decide at once
    const dashboard = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: RUN_ID,
      runId: RUN_ID,
      decision: 'once',
      actor: WEB_OPERATOR,
    })
    const click = registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: THREAD_ID,
      decision: 'reject',
      actor: DISCORD_USER,
    })
    await expect(click).resolves.toBe('already-claimed')
    release()
    await expect(dashboard).resolves.toBe('ok')
    registry.confirmReply({requestID: 'per_1', sessionID: SESSION_ID, reply: 'once'})
    await flush()

    // #then one upstream reply, one card edit naming the winner, one settle frame
    expect(postReply).toHaveBeenCalledTimes(1)
    expect(cardDescription()).toBe('Approved by alice (dashboard)')
    expect(settledFrames('per_1')).toHaveLength(1)
  })

  it('a dashboard decision for another run is not found and leaves the request open for both surfaces', async () => {
    // #given
    const {onPending, registry, postReply, settledFrames} = setup()
    onPending(makeRequest())
    await flush()

    // #when
    const outcome = await registry.handleDecision({
      requestID: 'per_1',
      approvalScopeId: 'run-other',
      runId: 'run-other',
      decision: 'once',
      actor: WEB_OPERATOR,
    })

    // #then
    expect(outcome).toBe('not-found')
    expect(postReply).not.toHaveBeenCalled()
    expect(settledFrames('per_1')).toHaveLength(0)
    expect(registry.describePendingForRun(RUN_ID)).toHaveLength(1)
  })
})

describe('Discord-launched run: the settle frame on every path', () => {
  it('teardown settles the open frame', async () => {
    // #given an open request
    const {onPending, registry, openFrames, settledFrames} = setup()
    onPending(makeRequest())
    await flush()
    expect(openFrames('per_1')).toHaveLength(1)

    // #when the run ends
    await registry.disposeRun(SESSION_ID, 'run ended')

    // #then
    expect(settledFrames('per_1')).toHaveLength(1)
    expect(registry.has('per_1')).toBe(false)
  })

  it('teardown settles the open frame when the Discord card failed to post', async () => {
    // #given a retryable embed failure: the request stays open with no card, only the dashboard can see it
    const {onPending, registry, edit, settledFrames} = setup('retryable-failure')
    onPending(makeRequest())
    await flush()
    expect(registry.has('per_1')).toBe(true)

    // #when the run ends
    await registry.disposeRun(SESSION_ID, 'run ended')

    // #then the settle frame still went out, and no card was edited
    expect(settledFrames('per_1')).toHaveLength(1)
    expect(edit).not.toHaveBeenCalled()
  })

  it('an undeliverable card is auto-rejected and the dashboard gets the settle frame', async () => {
    // #given the thread is gone, so the embed post fails terminally
    const {onPending, registry, postReply, openFrames, settledFrames} = setup('terminal-failure')

    // #when
    onPending(makeRequest())
    await vi.waitFor(() => {
      expect(registry.has('per_1')).toBe(false)
    })

    // #then the permission was rejected upstream, and the dashboard saw it open and then settled
    expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/acme/widget', 'reject')
    expect(openFrames('per_1')).toHaveLength(1)
    expect(settledFrames('per_1')).toHaveLength(1)
  })

  it('the deadline settles the open frame', async () => {
    vi.useFakeTimers()
    try {
      // #given a request with a deadline and no card
      const {onPending, registry, settledFrames} = setup('retryable-failure', 5_000)
      onPending(makeRequest())
      await vi.advanceTimersByTimeAsync(0)

      // #when the deadline passes
      await vi.advanceTimersByTimeAsync(6_000)

      // #then
      expect(registry.has('per_1')).toBe(false)
      expect(settledFrames('per_1')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an OpenCode-initiated reject settles it, and a sibling is settled by the cascade', async () => {
    // #given two open requests in one session
    const {onPending, registry, settledFrames} = setup()
    onPending(makeRequest('per_1'))
    onPending(makeRequest('per_2'))
    await flush()

    // #when OpenCode rejects the first
    registry.confirmReply({requestID: 'per_1', sessionID: SESSION_ID, reply: 'reject'})
    await flush()
    await flush()

    // #then both are settled for the dashboard
    expect(settledFrames('per_1')).toHaveLength(1)
    expect(settledFrames('per_2')).toHaveLength(1)
  })
})
