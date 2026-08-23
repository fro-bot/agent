import type {CoordinationConfig} from '@fro-bot/runtime'
import type {ChatInputCommandInteraction, Guild} from 'discord.js'
import type {ChannelQueue} from '../../execute/queue.js'
import type {RunTask} from '../../execute/run.js'
import type {DispatchOutcome, DispatchWorkflow} from '../../github/dispatch.js'
import type {FroBotDeps} from './fro-bot.js'

import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'

import {executeDispatch} from './dispatch.js'

const INSTALL_URL = 'https://github.com/apps/fro-bot-agent/installations/new'

function makeGuild(opts: {hasRole?: boolean; hasManageChannels?: boolean} = {}): Guild {
  const {hasRole = true, hasManageChannels = true} = opts
  return {
    members: {
      fetch: vi.fn().mockResolvedValue({
        roles: {cache: {has: vi.fn().mockReturnValue(hasRole)}},
        permissions: {has: vi.fn().mockReturnValue(hasManageChannels)},
      }),
    },
  } as unknown as Guild
}

function makeQueue(): ChannelQueue<RunTask> {
  return {
    enqueue: vi.fn(),
    pendingCount: vi.fn(),
    takeNext: vi.fn(),
    clear: vi.fn(),
    removeBy: vi.fn(),
  }
}

function makeDeps(
  dispatchWorkflow: DispatchWorkflow,
  binding: {readonly owner: string; readonly repo: string} | null = {owner: 'acme', repo: 'widget'},
  overrides: Partial<FroBotDeps> = {},
): FroBotDeps {
  return {
    bindingsStore: {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn().mockResolvedValue(
        binding === null
          ? {success: true, data: null}
          : {
              success: true,
              data: {
                owner: binding.owner,
                repo: binding.repo,
                channelId: 'channel-1',
                channelName: 'widget',
                workspacePath: '/workspace/repos/acme/widget',
                createdAt: new Date().toISOString(),
                createdByDiscordId: 'user-1',
              },
            },
      ),
      listBindings: vi.fn(),
    },
    appClient: {
      authForRepo: vi.fn(),
      authForWorkflowDispatch: vi.fn(),
      getRepoIdentity: vi.fn(),
      invalidateCache: vi.fn(),
    },
    workspaceClient: {clone: vi.fn(), readyz: vi.fn()},
    installUrl: INSTALL_URL,
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    queue: makeQueue(),
    triggerRoleId: 'trigger-role',
    gatewayLogger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    coordinationConfig: {} as CoordinationConfig,
    identity: 'discord-gateway',
    forceReleaseStaleLock: vi.fn(),
    dispatchWorkflow,
    ...overrides,
  }
}

function makeInteraction(
  task: string,
  guild: Guild = makeGuild(),
  channelId = 'channel-1',
): {
  readonly interaction: ChatInputCommandInteraction
  readonly deferReply: ReturnType<typeof vi.fn>
  readonly editReply: ReturnType<typeof vi.fn>
} {
  const deferReply = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn().mockResolvedValue(undefined)
  return {
    interaction: {
      channelId,
      guild,
      user: {id: 'user-1'},
      deferReply,
      editReply,
      options: {getString: vi.fn().mockReturnValue(task)},
    } as unknown as ChatInputCommandInteraction,
    deferReply,
    editReply,
  }
}

function getReplyContent(editReply: ReturnType<typeof vi.fn>): string {
  const firstCall = editReply.mock.calls[0]
  const options: unknown = firstCall?.[0]
  if (typeof options !== 'object' || options === null || 'content' in options === false) return ''
  const content = options.content
  return typeof content === 'string' ? content : ''
}

describe('executeDispatch', () => {
  it('reports GitHub acceptance and the run link without claiming the run succeeded', async () => {
    // #given — an authorized user in a bound channel and an accepted workflow dispatch
    const dispatchWorkflow = vi.fn().mockResolvedValue({
      outcome: 'accepted',
      owner: 'acme',
      repo: 'widget',
      runId: 1234,
      runUrl: 'https://github.com/acme/widget/actions/runs/1234',
    } satisfies DispatchOutcome)
    const deps = makeDeps(dispatchWorkflow)
    const {interaction, deferReply, editReply} = makeInteraction('run the checks')

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    expect(dispatchWorkflow).toHaveBeenCalledExactlyOnceWith('acme', 'widget', 'run the checks')
    const content = getReplyContent(editReply)
    expect(content).toContain('accepted')
    expect(content).toContain('https://github.com/acme/widget/actions/runs/1234')
    expect(content).not.toMatch(/succeeded|completed|finished/i)
    expect(deps.queue.enqueue).not.toHaveBeenCalled()
    expect(deps.queue.takeNext).not.toHaveBeenCalled()
    expect(deps.forceReleaseStaleLock).not.toHaveBeenCalled()
  })

  it('reports acceptance without inventing a run link when GitHub omits run details', async () => {
    // #given — GitHub accepted the dispatch but returned no run details
    const dispatchWorkflow = vi.fn<DispatchWorkflow>().mockResolvedValue({
      outcome: 'accepted',
      owner: 'acme',
      repo: 'widget',
    })
    const deps = makeDeps(dispatchWorkflow)
    const {interaction, editReply} = makeInteraction('run the checks')

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    const content = getReplyContent(editReply)
    expect(content).toContain('accepted')
    expect(content).toContain('run link is unavailable')
    expect(content).not.toContain('undefined')
  })

  it('reports an unbound channel without calling the dispatch adapter', async () => {
    // #given
    const dispatchWorkflow = vi.fn()
    const deps = makeDeps(dispatchWorkflow, null)
    const {interaction, editReply} = makeInteraction('run it')

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    expect(dispatchWorkflow).not.toHaveBeenCalled()
    expect(getReplyContent(editReply)).toMatch(/not bound|add-project/i)
  })

  it('reports invalid-task without calling the dispatch adapter for whitespace-only input', async () => {
    // #given
    const dispatchWorkflow = vi.fn()
    const deps = makeDeps(dispatchWorkflow)
    const {interaction, editReply} = makeInteraction(' \n\t ')

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    expect(dispatchWorkflow).not.toHaveBeenCalled()
    expect(getReplyContent(editReply)).toMatch(/task|empty|provide/i)
  })

  it('denies an unauthorized user before binding lookup or dispatch', async () => {
    // #given
    const dispatchWorkflow = vi.fn()
    const deps = makeDeps(dispatchWorkflow)
    const getBindingByChannelId = deps.bindingsStore.getBindingByChannelId as ReturnType<typeof vi.fn>
    const {interaction, editReply} = makeInteraction('run it', makeGuild({hasRole: false, hasManageChannels: false}))

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    expect(getBindingByChannelId).not.toHaveBeenCalled()
    expect(dispatchWorkflow).not.toHaveBeenCalled()
    expect(getReplyContent(editReply)).toMatch(/permission|authorized/i)
  })

  it('uses ManageChannels when no trigger role is configured', async () => {
    // #given
    const dispatchWorkflow = vi.fn().mockResolvedValue({outcome: 'dispatch-rejected', owner: 'acme', repo: 'widget'})
    const deps = makeDeps(dispatchWorkflow, {owner: 'acme', repo: 'widget'}, {triggerRoleId: null})
    const {interaction} = makeInteraction('run it', makeGuild({hasRole: false, hasManageChannels: true}))

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    expect(dispatchWorkflow).toHaveBeenCalledOnce()
  })

  it.each([
    ['app-not-installed', INSTALL_URL],
    ['missing-actions-permission', `Actions: write`],
    ['missing-permissions', 'permissions'],
    ['workflow-not-found', 'repository or workflow'],
    ['repo-not-found', 'repository'],
    ['dispatch-rejected', 'rejected'],
    ['github-unavailable', 'Please try again'],
  ] as const)('maps %s to safe user-facing copy', async (outcome, expectedCopy) => {
    // #given
    const dispatchWorkflow = vi.fn().mockResolvedValue(
      outcome === 'app-not-installed' || outcome === 'missing-actions-permission' || outcome === 'missing-permissions'
        ? {
            outcome,
            owner: 'acme',
            repo: 'widget',
            installUrl: INSTALL_URL,
            ...(outcome === 'missing-permissions' ? {missingPermissions: ['contents: read']} : {}),
          }
        : {outcome, owner: 'acme', repo: 'widget'},
    )
    const deps = makeDeps(dispatchWorkflow)
    const {interaction, editReply} = makeInteraction('run it')

    // #when
    await Effect.runPromise(executeDispatch(interaction, deps))

    // #then
    expect(getReplyContent(editReply)).toContain(expectedCopy)
  })
})
