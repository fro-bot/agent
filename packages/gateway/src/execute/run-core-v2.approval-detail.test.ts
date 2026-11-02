/**
 * fro-bot/agent#2002: a V2 `permission.asked` carries no `metadata`, so the command or path being approved reached no
 * operator surface. These tests run real V2 frames through the whole chain — the event mapper, the run loop, the real
 * permission coordinator, the real approval registry, the web transport that builds the operator frame, and the
 * Discord card — and assert what the operator is shown.
 *
 * The frames are captures except where marked `derived`; a derived frame is built from the cited line of the OpenCode
 * 2.2.5 source (`packages/core/src`), as no wire capture exists for it.
 */

import type {ApprovalTransportContext, ReplySink} from '../execute/launch-types.js'
import type {ApprovalFrameData} from '../operator-contract/approval-frame.js'

import {
  ENV_PERMISSION_ASKED_FRAME,
  NESTED_PERMISSION_ASKED_FRAMES,
  SHELL_PERMISSION_ASKED_FRAME,
} from '@fro-bot/runtime/event-v2-fixtures'
import {afterEach, describe, expect, it, vi} from 'vitest'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {createDiscordApprovalOnPending} from '../approvals/discord-transport.js'
import {createApprovalRegistry} from '../approvals/registry.js'
import {buildApprovalEmbed} from '../discord/approvals.js'
import {createWebApprovalOnPending} from '../web/operator/web-approval.js'
import {makeLogger, onSession, ROOT, startRun} from './run-core-v2.fixture.js'

afterEach(() => {
  vi.useRealTimers()
})

const RUN_ID = 'run-2002'

type OpenApprovalFrame = Extract<ApprovalFrameData, {readonly settled: false}>

/** Pushes `frame` through the run and reports what each operator surface was shown for it. */
async function askThroughRun(frame: object) {
  const logger = makeLogger()
  const registry = createApprovalRegistry({logger})
  const observed: OpenApprovalFrame[] = []
  const requests: Parameters<typeof buildApprovalEmbed>[0][] = []
  const context = {
    approvalRegistry: registry,
    directory: '/workspace/o/r',
    approvalDeadlineMs: 60_000,
    runId: RUN_ID,
    repo: 'o/r',
    postReplyFactory: () => async () => ({ok: true as const}),
  } as unknown as ApprovalTransportContext
  const onPending = createWebApprovalOnPending({
    observeApproval: (_runId, data) => {
      if (!data.settled) observed.push(data)
    },
    logger,
  })(context)
  const coordinator = createPermissionCoordinator({
    logger,
    onPending: request => {
      requests.push(request)
      onPending(request)
    },
  })

  const run = startRun({coordinator})
  await vi.advanceTimersByTimeAsync(10)
  run.emit(onSession(frame as {type: string; data: unknown}, ROOT))
  await vi.advanceTimersByTimeAsync(10)
  run.close()
  await vi.advanceTimersByTimeAsync(20_000)

  const request = requests[0]
  if (request === undefined) throw new Error('the ask never reached the coordinator')
  return {
    request,
    frame: observed[0],
    pending: registry.describePendingForScope(RUN_ID),
    card: JSON.stringify(buildApprovalEmbed(request).toJSON()),
    logs: JSON.stringify(vi.mocked(logger.info).mock.calls),
  }
}

describe('what the operator is shown for a V2 approval', () => {
  it('shows the command of the captured shell ask on the operator frame, the pending list and the Discord card', async () => {
    // #given — the verbatim 2.2.5 frame: action `shell`, resources ['echo hi'], no metadata
    // #when
    const shown = await askThroughRun(SHELL_PERMISSION_ASKED_FRAME)

    // #then
    expect(shown.request.permission).toBe('bash')
    expect(shown.request.command).toBe('echo hi')
    expect(shown.frame).toEqual({
      requestID: 'per_19a156a17001C9xQjJpLtxVww1',
      permission: 'bash',
      command: 'echo hi',
      settled: false,
    })
    expect(shown.pending).toEqual([
      {requestID: 'per_19a156a17001C9xQjJpLtxVww1', permission: 'bash', command: 'echo hi'},
    ])
    expect(shown.card).toContain('Run command: echo hi')
  })

  it('shows every command of a multi-command shell ask', async () => {
    // #given — derived: shell.ts:133-134 raises one resource per parsed command of `cd src && rg todo`
    const frame = {
      type: 'permission.asked',
      data: {
        ...(SHELL_PERMISSION_ASKED_FRAME.data as object),
        resources: ['cd src', 'rg todo'],
        save: ['cd *', 'rg *'],
      },
    }

    // #when
    const shown = await askThroughRun(frame)

    // #then
    expect(shown.frame?.command).toBe('cd src; rg todo')
    expect(shown.card).toContain('Run command: cd src; rg todo')
  })

  it('shows the path of the captured read ask', async () => {
    // #given — the real 2.2.5-family capture: action `read`, resources ['.env'] (file-access.ts:155-156)
    // #when
    const shown = await askThroughRun(ENV_PERMISSION_ASKED_FRAME)

    // #then
    expect(shown.request.filepath).toBe('.env')
    expect(shown.frame).toMatchObject({permission: 'read', filepath: '.env'})
    expect(shown.frame?.command).toBeUndefined()
    expect(shown.card).toContain('read: .env')
  })

  it('shows the path of the captured edit ask', async () => {
    // #given — a real capture: action `edit`, one target path (the shape of edit.ts:329-330)
    const [capture] = NESTED_PERMISSION_ASKED_FRAMES
    const path = (capture.data as {resources: readonly string[]}).resources[0]

    // #when
    const shown = await askThroughRun(capture)

    // #then
    expect(path).toContain('probe-wt-d1')
    expect(shown.frame).toMatchObject({permission: 'edit', filepath: path})
    expect(shown.card).toContain(`edit: ${path}`)
  })

  it('shows the directory of an outside-checkout ask', async () => {
    // #given — derived: file-access.ts:136-137 asks `external_directory` over the directory glob (built at :119)
    const frame = {
      type: 'permission.asked',
      data: {
        ...(ENV_PERMISSION_ASKED_FRAME.data as object),
        action: 'external_directory',
        resources: ['/etc/*'],
        save: ['/etc/*'],
      },
    }

    // #when
    const shown = await askThroughRun(frame)

    // #then
    expect(shown.frame).toMatchObject({permission: 'external_directory', filepath: '/etc/*'})
    expect(shown.card).toContain('Access outside workspace: /etc/*')
  })

  it('leaves an ask whose resources are not paths without a command or path', async () => {
    // #given — derived: grep.ts:88-89 asks `grep` over the search pattern, which is neither
    const frame = {
      type: 'permission.asked',
      data: {...(ENV_PERMISSION_ASKED_FRAME.data as object), action: 'grep', resources: ['TODO|FIXME'], save: ['*']},
    }

    // #when
    const shown = await askThroughRun(frame)

    // #then — `patterns` stays the detail, and the Discord title still falls back to it
    expect(shown.frame).toEqual({
      requestID: 'per_183893b940016SU8uCIJklSPOY',
      permission: 'grep',
      settled: false,
    })
    expect(shown.request.patterns).toEqual(['TODO|FIXME'])
    expect(shown.card).toContain('grep: TODO|FIXME')
  })

  it('does not log the command', async () => {
    // #given
    const shown = await askThroughRun(SHELL_PERMISSION_ASKED_FRAME)

    // #then — the permission and ids only, as on V1
    expect(shown.logs).not.toContain('echo hi')
  })

  it('bounds an oversized command on the operator frame as it does a V1 one', async () => {
    // #given
    const frame = {
      type: 'permission.asked',
      data: {...(SHELL_PERMISSION_ASKED_FRAME.data as object), resources: [`echo ${'x'.repeat(6000)}`]},
    }

    // #when
    const shown = await askThroughRun(frame)

    // #then — the 4 KB cap lives at the frame build, so it covers a synthesized command too
    expect(shown.frame?.command).toHaveLength(4096)
  })
})

/**
 * Pushes `frame` through one run whose ask reaches both operator surfaces, each with its own real registry: the web
 * transport (scope = the run) and the Discord transport (scope = the thread, with a recording reply sink). Then drives
 * a decision through each surface's registry, the path its button or route takes.
 */
async function askAndDecideOnBothSurfaces(frame: object) {
  const logger = makeLogger()
  const webRegistry = createApprovalRegistry({logger})
  const discordRegistry = createApprovalRegistry({logger})
  const webReply = vi.fn(async () => ({ok: true as const}))
  const discordReply = vi.fn(async () => ({ok: true as const}))
  const cards: {
    embeds?: readonly unknown[]
    components?: readonly {toJSON: () => {components: readonly unknown[]}}[]
  }[] = []
  const replySink = {
    send: vi.fn(async (_target: string, options: (typeof cards)[number]) => {
      cards.push(options)
      return {success: true, data: {id: 'msg_1', edit: vi.fn()}}
    }),
    markVisibleOutputPending: vi.fn().mockReturnValue(vi.fn()),
  } as unknown as ReplySink

  const onWebPending = createWebApprovalOnPending({observeApproval: () => {}, logger})({
    approvalRegistry: webRegistry,
    directory: '/workspace/o/r',
    approvalDeadlineMs: 60_000,
    runId: RUN_ID,
    repo: 'o/r',
    postReplyFactory: () => webReply,
  } as unknown as ApprovalTransportContext)
  const onDiscordPending = createDiscordApprovalOnPending({
    approvalRegistry: discordRegistry,
    replySink,
    threadId: 'thread_1',
    directory: '/workspace/o/r',
    approvalDeadlineMs: 60_000,
    onDeadlineSettled: undefined,
    postReplyFactory: () => discordReply,
    logger,
  })
  let requestID = ''
  const coordinator = createPermissionCoordinator({
    logger,
    onPending: request => {
      requestID = request.requestID
      onWebPending(request)
      onDiscordPending(request)
    },
  })

  const run = startRun({coordinator})
  await vi.advanceTimersByTimeAsync(10)
  run.emit(onSession(frame as {type: string; data: unknown}, ROOT))
  await vi.advanceTimersByTimeAsync(10)
  run.close()
  await vi.advanceTimersByTimeAsync(20_000)
  if (requestID === '') throw new Error('the ask never reached the coordinator')

  const card = cards.find(options => options.embeds !== undefined)
  const buttons = JSON.stringify(card?.components?.[0]?.toJSON().components ?? [])
  const decide = {
    web: async (decision: 'once' | 'always' | 'reject') =>
      webRegistry.handleDecision({
        requestID,
        approvalScopeId: RUN_ID,
        decision,
        actor: {kind: 'web-operator', githubUserId: 1, login: 'alice', sessionCorrelationId: 'sess'},
      }),
    discord: async (decision: 'once' | 'always' | 'reject') =>
      discordRegistry.handleDecision({
        requestID,
        approvalScopeId: 'thread_1',
        decision,
        actor: {kind: 'discord-user', userId: 'u1'},
      }),
  }
  return {buttons, card: JSON.stringify(card?.embeds), decide, webReply, discordReply}
}

function shellAsk(resources: readonly string[]) {
  return {type: 'permission.asked', data: {...(SHELL_PERMISSION_ASKED_FRAME.data as object), resources}}
}

describe('a V2 approval whose command the operator cannot see in full', () => {
  it('offers Deny only on Discord and refuses an approve that reaches it, when a later command is past the clamp', async () => {
    // #given — the review finding: the second command sits past the 1024-character Action clamp
    const shown = await askAndDecideOnBothSurfaces(shellAsk([`echo ${'x'.repeat(1100)}`, 'rm -rf important-directory']))

    // #then — the card posts, with no Approve button, and says why
    expect(shown.buttons).toContain('fb-deny:')
    expect(shown.buttons).not.toContain('fb-approve:')
    expect(shown.card).toContain('Too long to show here. Review it on the operator dashboard, or reject.')

    // #when an approve reaches the registry anyway (a stale or forged button id)
    // #then it is refused and nothing goes upstream
    expect(await shown.decide.discord('once')).toBe('reject-only')
    expect(shown.discordReply).not.toHaveBeenCalled()

    // #and a reject still settles it
    expect(await shown.decide.discord('reject')).toBe('ok')
    expect(shown.discordReply).toHaveBeenCalledExactlyOnceWith(expect.any(String), '/workspace/o/r', 'reject')
  })

  it('refuses approve on both the web route and Discord when the command is cut at 4 KB', async () => {
    // #given — the second command is hidden by the frame's own 4 KB cut, on every surface
    const shown = await askAndDecideOnBothSurfaces(shellAsk([`echo ${'x'.repeat(5000)}`, 'rm -rf important-directory']))

    // #when/#then
    for (const decision of ['once', 'always'] as const) {
      expect(await shown.decide.web(decision)).toBe('reject-only')
      expect(await shown.decide.discord(decision)).toBe('reject-only')
    }
    expect(shown.webReply).not.toHaveBeenCalled()
    expect(shown.discordReply).not.toHaveBeenCalled()
    expect(shown.buttons).not.toContain('fb-approve:')
    expect(shown.card).toContain('Too long to review, so it can only be rejected.')
    expect(shown.card).not.toContain('operator dashboard')

    // #and the web operator can still reject
    expect(await shown.decide.web('reject')).toBe('ok')
  })

  it('offers the normal buttons for a command under 1024 characters', async () => {
    // #given/#when
    const shown = await askAndDecideOnBothSurfaces(shellAsk(['echo hi']))

    // #then
    expect(shown.buttons).toContain('fb-approve:')
    expect(shown.buttons).toContain('fb-deny:')
    expect(shown.card).not.toContain('Too long to show here')
    expect(await shown.decide.discord('once')).toBe('ok')
    expect(await shown.decide.web('once')).toBe('ok')
  })

  it('shows Deny only on Discord but lets the web operator approve a command between 1024 characters and 4 KB', async () => {
    // #given — the web frame carries the whole 2000-character command; the Discord Action cannot
    const shown = await askAndDecideOnBothSurfaces(shellAsk([`echo ${'x'.repeat(2000)}`]))

    // #then
    expect(shown.buttons).not.toContain('fb-approve:')
    expect(await shown.decide.discord('once')).toBe('reject-only')
    expect(await shown.decide.web('once')).toBe('ok')
    expect(shown.webReply).toHaveBeenCalledOnce()
  })
})
