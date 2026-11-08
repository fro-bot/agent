/**
 * Tests for the Discord approval transport's undeliverable-notification handling.
 *
 * Convention: `vi.fn()` for all injected side-effects. No real Discord.js
 * network calls — `DiscordAPIError` instances are constructed directly to
 * exercise the terminal/retryable classification. BDD `// #given/#when/#then`
 * per repo convention.
 *
 * ### Core scenarios
 *
 * 1. Happy path — a successful embed post leaves the request open (attaches
 *    the render function; never auto-rejects).
 * 2. Error path — a thread-not-found (`UnknownChannel`) failure auto-rejects
 *    the permission on the server.
 * 3. Error path — a rate-limit-shaped failure (plain `Error`, not a
 *    `DiscordAPIError`) does NOT auto-reject.
 * 4. Edge case — the registry entry is settled exactly once, whether the
 *    failure surfaces via the embed's `.then()` or its `.catch()`.
 * 5. Integration — a delivery-failure auto-reject is surfaced via a distinct
 *    `logger.error` call and a distinct thread note, not silently applied.
 */

import type {GatewayLogger} from '../discord/client.js'
import type {ReplySink} from '../execute/launch-types.js'
import type {PermissionRequest} from './coordinator.js'
import type {DiscordApprovalTransportDeps} from './discord-transport.js'
import type {ApprovalActor, ApprovalRegistry} from './registry.js'

import {DiscordAPIError, RESTJSONErrorCodes} from 'discord.js'
import {describe, expect, it, vi} from 'vitest'

import {createDiscordApprovalOnPending} from './discord-transport.js'

// ---------------------------------------------------------------------------
// Test-double helpers
// ---------------------------------------------------------------------------

function makeLogger(): GatewayLogger {
  return {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
}

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestID: 'per_1',
    sessionID: 'ses_1',
    permission: 'bash',
    patterns: [],
    title: 'Run command: rm -rf /tmp/x',
    command: 'rm -rf /tmp/x',
    ...overrides,
  }
}

interface SentCall {
  readonly target: string
  readonly options: {
    readonly content?: string
    readonly embeds?: readonly unknown[]
    readonly components?: readonly unknown[]
  }
}

/**
 * A fake `ReplySink` whose `send` resolves differently for the
 * waiting-status message vs the approval embed, so tests can control each
 * independently. Every call is recorded in `sentCalls` for assertions on the
 * operator-visible note posted after an auto-reject.
 */
function makeReplySink(
  overrides: {
    readonly embedResult?: unknown
    readonly embedRejection?: unknown
  } = {},
): ReplySink & {readonly sentCalls: SentCall[]} {
  const sentCalls: SentCall[] = []
  const embedResult = overrides.embedResult ?? {success: true, data: {id: 'msg_embed'}}

  const send = vi.fn(async (target: 'source' | 'thread', options: SentCall['options']): Promise<unknown> => {
    sentCalls.push({target, options})
    if (options.embeds !== undefined) {
      if (overrides.embedRejection !== undefined) {
        throw overrides.embedRejection
      }
      return embedResult
    }
    // Waiting-status message and the post-auto-reject notify message both
    // succeed by default — irrelevant to the classification under test.
    return {success: true, data: {id: 'msg_other'}}
  })

  return {
    sentCalls,
    send,
    append: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    buffered: vi.fn().mockReturnValue(''),
    hasVisibleOutput: vi.fn().mockReturnValue(false),
    markVisibleOutputSent: vi.fn(),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
  }
}

function makeApprovalRegistry(overrides: Partial<ApprovalRegistry> = {}): ApprovalRegistry {
  return {
    register: vi.fn(),
    attachMessage: vi.fn(),
    markMessagePostFailed: vi.fn(),
    has: vi.fn().mockReturnValue(true),
    pending: vi.fn().mockReturnValue([]),
    hasPendingForScope: vi.fn().mockReturnValue(true),
    describePendingForScope: vi.fn().mockReturnValue([]),
    describePendingForRun: vi.fn().mockReturnValue([]),
    handleDecision: vi.fn(),
    confirmReply: vi.fn(),
    applySettlement: vi.fn().mockResolvedValue(undefined),
    autoApprove: vi.fn().mockResolvedValue('not-found'),
    disposeRun: vi.fn().mockResolvedValue(undefined),
    disposeAll: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeDeps(
  overrides: {
    readonly logger?: GatewayLogger
    readonly approvalRegistry?: ApprovalRegistry
    readonly replySink?: ReplySink & {readonly sentCalls: SentCall[]}
    readonly onRegistered?: (request: PermissionRequest) => void
  } = {},
): DiscordApprovalTransportDeps & {readonly replySink: ReplySink & {readonly sentCalls: SentCall[]}} {
  return {
    approvalRegistry: overrides.approvalRegistry ?? makeApprovalRegistry(),
    replySink: overrides.replySink ?? makeReplySink(),
    threadId: 'thread_1',
    runId: 'run_1',
    onRegistered: overrides.onRegistered,
    directory: '/workspace/proj',
    approvalDeadlineMs: undefined,
    onDeadlineSettled: undefined,
    postReplyFactory: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ok: true})),
    logger: overrides.logger ?? makeLogger(),
  }
}

/** A terminal Discord REST error — matches the shape a real network failure produces. */
function makeUnknownChannelError(): DiscordAPIError {
  return new DiscordAPIError(
    {message: 'Unknown Channel', code: RESTJSONErrorCodes.UnknownChannel},
    RESTJSONErrorCodes.UnknownChannel,
    404,
    'POST',
    '/channels/thread_1/messages',
    {},
  )
}

// ---------------------------------------------------------------------------
// Scenario 1: happy path — successful post leaves the request open
// ---------------------------------------------------------------------------

describe('createDiscordApprovalOnPending — happy path', () => {
  it('attaches the render function and never auto-rejects on a successful embed post', async () => {
    // #given a transport whose embed post succeeds
    const approvalRegistry = makeApprovalRegistry()
    const deps = makeDeps({approvalRegistry})
    const onPending = createDiscordApprovalOnPending(deps)

    // #when a permission is requested
    onPending(makeRequest())

    // #then the render function is attached for a future human decision
    await vi.waitFor(() => {
      expect(approvalRegistry.attachMessage).toHaveBeenCalledOnce()
    })

    // #then the request was never auto-rejected or marked post-failed
    expect(approvalRegistry.applySettlement).not.toHaveBeenCalled()
    expect(approvalRegistry.markMessagePostFailed).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Run identity and the announce hook (#2115)
// ---------------------------------------------------------------------------

describe('createDiscordApprovalOnPending — run identity', () => {
  it('registers the request under the thread id AND the run that raised it', () => {
    // #given
    const approvalRegistry = makeApprovalRegistry()

    // #when
    createDiscordApprovalOnPending(makeDeps({approvalRegistry}))(makeRequest())

    // #then the thread id still scopes the Discord button; the run id lets the dashboard reach the request
    expect(approvalRegistry.register).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({approvalScopeId: 'thread_1', runId: 'run_1'}),
    )
  })

  it('announces the request once registered, before any Discord post', () => {
    // #given
    const order: string[] = []
    const approvalRegistry = makeApprovalRegistry({
      register: vi.fn(() => {
        order.push('register')
      }),
    })
    const replySink = makeReplySink()
    vi.mocked(replySink.send).mockImplementation(async () => {
      order.push('send')
      return {success: true, data: {id: 'm'}}
    })
    const onRegistered = vi.fn(() => {
      order.push('announce')
    })

    // #when
    createDiscordApprovalOnPending(makeDeps({approvalRegistry, replySink, onRegistered}))(makeRequest())

    // #then the dashboard frame never races ahead of the registry entry, and never waits for Discord
    expect(onRegistered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({requestID: 'per_1'}))
    expect(order.slice(0, 3)).toEqual(['register', 'announce', 'send'])
  })

  it('an announce hook that throws neither escapes nor stops the Discord card', async () => {
    // #given
    const logger = makeLogger()
    const replySink = makeReplySink()
    const onRegistered = vi.fn(() => {
      throw new Error('observer down')
    })
    const deps = makeDeps({replySink, onRegistered, logger})

    // #when / #then
    expect(() => createDiscordApprovalOnPending(deps)(makeRequest())).not.toThrow()
    await vi.waitFor(() => {
      expect(replySink.sentCalls.some(call => call.options.embeds !== undefined)).toBe(true)
    })
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Settled card — the decider line follows the actor's origin
// ---------------------------------------------------------------------------

/** Posts a card, then runs the attached render function for `actor` and returns the edited description. */
async function settleCardAs(actor: ApprovalActor): Promise<string | undefined> {
  const edit = vi.fn().mockResolvedValue({})
  const approvalRegistry = makeApprovalRegistry()
  const replySink = makeReplySink({embedResult: {success: true, data: {id: 'msg_embed', edit}}})
  const request = makeRequest()
  createDiscordApprovalOnPending(makeDeps({approvalRegistry, replySink}))(request)
  await vi.waitFor(() => {
    expect(approvalRegistry.attachMessage).toHaveBeenCalledOnce()
  })
  const render = vi.mocked(approvalRegistry.attachMessage).mock.calls[0]?.[1] as (
    req: PermissionRequest,
    decision: 'once',
    actor: ApprovalActor,
    reason: 'replied',
  ) => Promise<void>
  await render(request, 'once', actor, 'replied')
  const edited = edit.mock.calls[0]?.[0] as {embeds: readonly {toJSON: () => {description?: string}}[]}
  return edited.embeds[0]?.toJSON().description
}

describe('createDiscordApprovalOnPending — settled card decider', () => {
  it('mentions a Discord user who decided', async () => {
    // #given/#when
    const description = await settleCardAs({kind: 'discord-user', userId: '123456789'})
    // #then
    expect(description).toBe('Approved by <@123456789>')
  })

  it('shows a dashboard operator as a plain login, not a mention', async () => {
    // #given/#when
    const description = await settleCardAs({
      kind: 'web-operator',
      githubUserId: 1,
      login: 'octocat',
      sessionCorrelationId: 'corr_1',
    })
    // #then
    expect(description).toBe('Approved by octocat (dashboard)')
    expect(description).not.toContain('<@')
  })
})

// ---------------------------------------------------------------------------
// Reject-only cards — the Action would be clamped, so the card must not offer an approval
// ---------------------------------------------------------------------------

/** Posts the approval card for `request` through the real transport and reports the buttons it carried. */
async function postCard(request: PermissionRequest) {
  const approvalRegistry = makeApprovalRegistry()
  const deps = makeDeps({approvalRegistry})
  createDiscordApprovalOnPending(deps)(request)
  await vi.waitFor(() => {
    expect(approvalRegistry.attachMessage).toHaveBeenCalledOnce()
  })
  const card = deps.replySink.sentCalls.find(call => call.options.embeds !== undefined)
  const row = card?.options.components?.[0] as {toJSON: () => {components: readonly unknown[]}} | undefined
  const buttons = row?.toJSON().components ?? []
  return {approvalRegistry, buttons: JSON.stringify(buttons), buttonCount: buttons.length, card}
}

describe('createDiscordApprovalOnPending — requests the card cannot show in full', () => {
  it('posts Deny only, and registers the request reject-only, when the Action would be clamped', async () => {
    // #given — the reviewer's case: the second command sits past the 1024-character clamp
    const command = `${`echo ${'x'.repeat(1100)}`}; rm -rf important-directory`
    const request = makeRequest({command, title: `Run command: ${command}`})

    // #when
    const {approvalRegistry, buttons, buttonCount} = await postCard(request)

    // #then — no Approve button, and the registry will refuse an approve that arrives another way
    expect(buttonCount).toBe(1)
    expect(buttons).toContain('fb-deny:per_1')
    expect(buttons).not.toContain('fb-approve:')
    expect(approvalRegistry.register).toHaveBeenCalledWith(expect.objectContaining({rejectOnly: true}))
  })

  it('posts Approve and Deny, and registers the request approvable, when the Action fits', async () => {
    // #given/#when
    const {approvalRegistry, buttons, buttonCount} = await postCard(makeRequest())

    // #then
    expect(buttonCount).toBe(2)
    expect(buttons).toContain('fb-approve:per_1')
    expect(approvalRegistry.register).toHaveBeenCalledWith(expect.objectContaining({rejectOnly: false}))
  })
})

// ---------------------------------------------------------------------------
// Scenario 2: thread-not-found rejects the request on the server
// ---------------------------------------------------------------------------

describe('createDiscordApprovalOnPending — terminal delivery failure', () => {
  it('rejects the request on the server when the embed post fails with UnknownChannel', async () => {
    // #given a transport whose embed post fails because the thread is gone
    const approvalRegistry = makeApprovalRegistry()
    const replySink = makeReplySink({embedResult: {success: false, error: makeUnknownChannelError()}})
    const deps = makeDeps({approvalRegistry, replySink})
    const onPending = createDiscordApprovalOnPending(deps)
    const request = makeRequest()

    // #when a permission is requested and the embed post fails terminally
    onPending(request)

    // #then the permission is auto-rejected on the server
    await vi.waitFor(() => {
      expect(approvalRegistry.applySettlement).toHaveBeenCalledOnce()
    })
    expect(approvalRegistry.applySettlement).toHaveBeenCalledWith(
      expect.objectContaining({requestID: request.requestID, decision: 'reject'}),
    )

    // #then the entry is also marked post-failed (existing retryable-friendly bookkeeping)
    expect(approvalRegistry.markMessagePostFailed).toHaveBeenCalledWith(request.requestID)
  })
})

// ---------------------------------------------------------------------------
// Scenario 3: a rate-limit failure does not reject
// ---------------------------------------------------------------------------

describe('createDiscordApprovalOnPending — retryable delivery failure', () => {
  it('does not auto-reject when the embed post fails with a rate-limit-shaped error', async () => {
    // #given a transport whose embed post fails with a plain Error (not a DiscordAPIError) —
    // this is how discord.js surfaces rate limits: a distinct RateLimitError class,
    // never a DiscordAPIError, so classification on `instanceof DiscordAPIError` never
    // treats it as terminal regardless of its message text.
    const approvalRegistry = makeApprovalRegistry()
    const replySink = makeReplySink({
      embedResult: {success: false, error: new Error('You are being rate limited.')},
    })
    const deps = makeDeps({approvalRegistry, replySink})
    const onPending = createDiscordApprovalOnPending(deps)
    const request = makeRequest()

    // #when a permission is requested and the embed post fails with a retryable error
    onPending(request)

    // #then the entry is still marked post-failed (stays open for a later settlement)
    await vi.waitFor(() => {
      expect(approvalRegistry.markMessagePostFailed).toHaveBeenCalledWith(request.requestID)
    })

    // #then the permission is proven NOT rejected — the entry stays registered so a
    // human decision (or a later successful retry path) can still settle it.
    expect(approvalRegistry.applySettlement).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Scenario 4: the registry entry settles exactly once
// ---------------------------------------------------------------------------

describe('createDiscordApprovalOnPending — settles exactly once', () => {
  it('calls applySettlement exactly once when the terminal failure surfaces via the embed .catch() path', async () => {
    // #given a transport whose embed send promise rejects (network-level) with a terminal error
    const approvalRegistry = makeApprovalRegistry()
    const replySink = makeReplySink({embedRejection: makeUnknownChannelError()})
    const deps = makeDeps({approvalRegistry, replySink})
    const onPending = createDiscordApprovalOnPending(deps)
    const request = makeRequest()

    // #when a permission is requested and the embed send rejects terminally
    onPending(request)

    // #then applySettlement is called exactly once — not double-settled between
    // markMessagePostFailed's bookkeeping and the auto-reject.
    await vi.waitFor(() => {
      expect(approvalRegistry.applySettlement).toHaveBeenCalledOnce()
    })
    expect(approvalRegistry.markMessagePostFailed).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// Scenario 5: the auto-reject is surfaced in the run's observability output
// ---------------------------------------------------------------------------

describe('createDiscordApprovalOnPending — operator-visible auto-reject', () => {
  it('logs a distinct error and posts a distinct thread note, not a silent registry settlement', async () => {
    // #given a transport whose embed post fails terminally
    const approvalRegistry = makeApprovalRegistry()
    const logger = makeLogger()
    const replySink = makeReplySink({embedResult: {success: false, error: makeUnknownChannelError()}})
    const deps = makeDeps({approvalRegistry, replySink, logger})
    const onPending = createDiscordApprovalOnPending(deps)
    const request = makeRequest()

    // #when a permission is requested and the embed post fails terminally
    onPending(request)
    await vi.waitFor(() => {
      expect(approvalRegistry.applySettlement).toHaveBeenCalledOnce()
    })

    // #then a distinct error-level log line names the undeliverable-notification cause —
    // this is never emitted for a human decision (which logs at info via the registry).
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({requestID: request.requestID}),
      expect.stringContaining('undeliverable'),
    )

    // #then a thread note is posted whose wording is distinct from both a human denial
    // ("declined") and a deadline timeout ("timed out") — an operator scanning the
    // thread can tell this apart from a deliberate decision.
    await vi.waitFor(() => {
      const notifyCall = replySink.sentCalls.find(
        call => call.options.content?.includes('automatically denied') === true,
      )
      expect(notifyCall).toBeDefined()
    })
  })
})
