/**
 * Teardown of an approval whose claimant reply is still in flight.
 *
 * Mirrors the question family's "teardown while the claimant reply is still in flight" suite:
 * dispose marks a claimed entry `disposed`, the gate never reopens it, and a reply that then
 * fails sends exactly one deny so the permission does not stay pending in OpenCode.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {PermissionRequest} from './coordinator.js'
import type {ApprovalActor, ApprovalSideEffects, RenderFn} from './registry.js'
import type {TerminalEvent} from './request-gate.js'

import {describe, expect, it, vi} from 'vitest'

import {createApprovalRegistry} from './registry.js'
import {createRequestGate} from './request-gate.js'

interface ReplyResult {
  readonly ok: boolean
  readonly error?: string
}

const ACTOR: ApprovalActor = {kind: 'discord-user', userId: 'user_A'}

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(): PermissionRequest {
  return {
    requestID: 'per_1',
    sessionID: 'ses_1',
    permission: 'external_directory',
    patterns: ['/tmp/x/*'],
    title: 'Access outside workspace',
  }
}

function setup() {
  const logger = makeLogger()
  const gate = createRequestGate({logger})
  const registry = createApprovalRegistry({logger, gate})
  const terminals: TerminalEvent[] = []
  gate.onTerminal(event => {
    terminals.push(event)
  })
  return {registry, terminals}
}

function deferred() {
  let settle!: (result: ReplyResult) => void
  let fail!: (error: Error) => void
  const promise = new Promise<ReplyResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  return {promise, settle, fail}
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** First postReply (the claimant's) stays in flight; any later call resolves ok. */
function registerWithDelayedClaimantReply(
  registry: ReturnType<typeof setup>['registry'],
  claimant: Promise<ReplyResult>,
) {
  const postReply = vi
    .fn<ApprovalSideEffects['postReply']>()
    .mockReturnValueOnce(claimant)
    .mockResolvedValue({ok: true})
  const render = vi.fn().mockResolvedValue(undefined) as unknown as RenderFn
  const request = makeRequest()
  registry.register({
    requestID: request.requestID,
    sessionID: request.sessionID,
    approvalScopeId: 'chan_1',
    directory: '/workspace/proj',
    request,
    effects: {postReply},
  })
  registry.attachMessage(request.requestID, render)
  return {postReply, render}
}

async function decideOnce(registry: ReturnType<typeof setup>['registry']) {
  return registry.handleDecision({requestID: 'per_1', approvalScopeId: 'chan_1', decision: 'once', actor: ACTOR})
}

/** Registers with a short deadline. Replies in order: claimant (held), deadline reject (held), then ok. */
function registerWithDeadline(
  registry: ReturnType<typeof setup>['registry'],
  claimant: Promise<ReplyResult>,
  deadlineReject: Promise<ReplyResult>,
  render: RenderFn,
) {
  const postReply = vi
    .fn<ApprovalSideEffects['postReply']>()
    .mockReturnValueOnce(claimant)
    .mockReturnValueOnce(deadlineReject)
    .mockResolvedValue({ok: true})
  const request = makeRequest()
  registry.register({
    requestID: request.requestID,
    sessionID: request.sessionID,
    approvalScopeId: 'chan_1',
    directory: '/workspace/proj',
    request,
    effects: {postReply},
    deadlineMs: 5,
  })
  registry.attachMessage(request.requestID, render)
  return postReply
}

describe('teardown while the claimant reply is still in flight', () => {
  it('the reply fails after teardown: one deny is sent, and the entry is never reopened or re-rendered', async () => {
    // #given an approve whose reply POST is still in flight, on an approval with a rendered embed
    const {registry, terminals} = setup()
    const reply = deferred()
    const {postReply, render} = registerWithDelayedClaimantReply(registry, reply.promise)
    const decision = decideOnce(registry)
    await flush()
    expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'once')

    // #when the run is torn down mid-flight, and then the reply fails
    await registry.disposeRun('ses_1', 'run-ended')
    expect(postReply).toHaveBeenCalledOnce()
    reply.settle({ok: false, error: 'down'})
    const outcome = await decision

    // #then the orphaned permission is denied exactly once and the claimant sees the failure
    expect(outcome).toBe('reply-failed')
    expect(postReply).toHaveBeenCalledTimes(2)
    expect(postReply).toHaveBeenNthCalledWith(2, 'per_1', '/workspace/proj', 'reject')
    // #and the entry stayed gone: not pending, not actionable, rendered once, one terminal event
    expect(registry.has('per_1')).toBe(false)
    expect(registry.pending()).toEqual([])
    expect(registry.hasPendingForScope('chan_1')).toBe(false)
    expect(registry.describePendingForScope('chan_1')).toEqual([])
    expect(render).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'reject', ACTOR, 'disposed')
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })

  it('the reply throws after teardown: one deny is sent, with no reopen and one terminal event', async () => {
    // #given
    const {registry, terminals} = setup()
    const reply = deferred()
    const {postReply, render} = registerWithDelayedClaimantReply(registry, reply.promise)
    const decision = decideOnce(registry)
    await flush()

    // #when
    await registry.disposeRun('ses_1', 'run-ended')
    reply.fail(new Error('boom'))
    const outcome = await decision

    // #then
    expect(outcome).toBe('reply-failed')
    expect(postReply).toHaveBeenCalledTimes(2)
    expect(postReply).toHaveBeenNthCalledWith(2, 'per_1', '/workspace/proj', 'reject')
    expect(registry.has('per_1')).toBe(false)
    expect(render).toHaveBeenCalledOnce()
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })

  it('the reply succeeds after teardown: no deny is sent', async () => {
    // #given
    const {registry, terminals} = setup()
    const reply = deferred()
    const {postReply} = registerWithDelayedClaimantReply(registry, reply.promise)
    const decision = decideOnce(registry)
    await flush()

    // #when the run is torn down and then the reply lands
    await registry.disposeRun('ses_1', 'run-ended')
    reply.settle({ok: true})
    const outcome = await decision

    // #then OpenCode got the approval; no deny follows it
    expect(outcome).toBe('ok')
    expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'once')
    expect(registry.has('per_1')).toBe(false)
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })

  it('a failed deny after teardown is logged and does not throw or emit another terminal event', async () => {
    // #given a claimant reply and a deny that both fail
    const {registry, terminals} = setup()
    const reply = deferred()
    const {postReply} = registerWithDelayedClaimantReply(registry, reply.promise)
    postReply.mockReset()
    postReply.mockReturnValueOnce(reply.promise).mockRejectedValueOnce(new Error('deny down'))
    const decision = decideOnce(registry)
    await flush()

    // #when
    await registry.disposeRun('ses_1', 'run-ended')
    reply.settle({ok: false, error: 'down'})

    // #then the claimant still sees reply-failed; one deny was attempted; one terminal event
    await expect(decision).resolves.toBe('reply-failed')
    expect(postReply).toHaveBeenCalledTimes(2)
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })

  it('disposing an open approval still sends a best-effort reject and renders once (unchanged)', async () => {
    // #given an open approval
    const {registry, terminals} = setup()
    const postReply = vi.fn<ApprovalSideEffects['postReply']>().mockResolvedValue({ok: true})
    const render = vi.fn().mockResolvedValue(undefined) as unknown as RenderFn
    const request = makeRequest()
    registry.register({
      requestID: 'per_1',
      sessionID: 'ses_1',
      approvalScopeId: 'chan_1',
      directory: '/workspace/proj',
      request,
      effects: {postReply},
    })
    registry.attachMessage('per_1', render)

    // #when
    await registry.disposeRun('ses_1', 'run-ended')

    // #then
    expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'reject')
    expect(render).toHaveBeenCalledExactlyOnceWith(request, 'reject', null, 'disposed')
    expect(registry.has('per_1')).toBe(false)
    expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
  })
  describe('recovery is owned once: the deadline fail-close and teardown never both reply', () => {
    it('(a) the deadline expires during the claim, the claimant fails, teardown is queued first: exactly one recovery reject and one terminal event', async () => {
      // #given an approve in flight, then a deadline that expires while it is claimed
      const {registry, terminals} = setup()
      const claimant = deferred()
      const deadlineReject = deferred() // the deadline fail-close's reject stays unresolved
      const render = vi.fn().mockResolvedValue(undefined) as unknown as RenderFn
      const postReply = registerWithDeadline(registry, claimant.promise, deadlineReject.promise, render)
      const decision = decideOnce(registry)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(postReply).toHaveBeenCalledExactlyOnceWith('per_1', '/workspace/proj', 'once')

      // #when the claimant fails and teardown is queued before the decision continuation resumes
      claimant.settle({ok: false, error: 'down'})
      let teardown!: Promise<void>
      queueMicrotask(() => {
        teardown = registry.disposeRun('ses_1', 'run-ended')
      })
      const outcome = await decision
      await teardown

      // #then the gate's fail-close reject is the only recovery: no second reject from the family
      expect(outcome).toBe('reply-failed')
      expect(postReply.mock.calls.map(call => call[2])).toEqual(['once', 'reject'])
      // #and one terminal event, one render, and the entry is gone
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
      expect(render).toHaveBeenCalledOnce()
      expect(registry.pending()).toEqual([])
    })

    it('(a2) the deadline reject resolving while teardown rendering is still open does not render or terminate again', async () => {
      // #given the same race, with the teardown render held open
      const {registry, terminals} = setup()
      const claimant = deferred()
      const deadlineReject = deferred()
      let finishRender!: () => void
      const render = vi.fn().mockReturnValue(
        new Promise<void>(resolve => {
          finishRender = resolve
        }),
      ) as unknown as RenderFn
      const postReply = registerWithDeadline(registry, claimant.promise, deadlineReject.promise, render)
      const decision = decideOnce(registry)
      await new Promise(resolve => setTimeout(resolve, 20))
      claimant.settle({ok: false, error: 'down'})
      let teardown!: Promise<void>
      queueMicrotask(() => {
        teardown = registry.disposeRun('ses_1', 'run-ended')
      })
      await decision

      // #when the deadline reject lands while the teardown render is still open
      deadlineReject.settle({ok: true})
      await flush()

      // #then teardown still owns the single render and the single terminal event
      expect(render).toHaveBeenCalledOnce()
      expect(terminals).toEqual([])
      finishRender()
      await teardown
      expect(render).toHaveBeenCalledOnce()
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
      expect(postReply.mock.calls.map(call => call[2])).toEqual(['once', 'reject'])
    })

    it('(b) the claimant fails while teardown rendering is open, then the permission.replied echo arrives: one render, one terminal event, one recovery reply', async () => {
      // #given an approve in flight and a teardown whose render is held open
      const {registry, terminals} = setup()
      const claimant = deferred()
      let finishRender!: () => void
      const render = vi.fn().mockReturnValue(
        new Promise<void>(resolve => {
          finishRender = resolve
        }),
      ) as unknown as RenderFn
      const {postReply} = registerWithDelayedClaimantReply(registry, claimant.promise)
      registry.attachMessage('per_1', render)
      const decision = decideOnce(registry)
      await flush()
      const teardown = registry.disposeRun('ses_1', 'run-ended')
      await flush()
      expect(render).toHaveBeenCalledOnce()

      // #when the claimant fails, then OpenCode echoes the recovery reject
      claimant.settle({ok: false, error: 'down'})
      await decision
      registry.confirmReply({requestID: 'per_1', sessionID: 'ses_1', reply: 'reject'})
      await flush()

      // #then the echo found nothing to settle: no second render, no terminal event yet
      expect(render).toHaveBeenCalledOnce()
      expect(terminals).toEqual([])

      // #and when teardown finishes, it emits the only terminal event
      finishRender()
      await teardown
      expect(render).toHaveBeenCalledOnce()
      expect(terminals.map(event => event.outcome)).toEqual(['disposed'])
      expect(postReply.mock.calls.map(call => call[2])).toEqual(['once', 'reject'])
    })
  })
})
