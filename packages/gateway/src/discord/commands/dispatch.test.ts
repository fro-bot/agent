import type {CoordinationConfig} from '@fro-bot/runtime'
import type {ChatInputCommandInteraction, Guild} from 'discord.js'
import type {ChannelQueue} from '../../execute/queue.js'
import type {RunTask} from '../../execute/run.js'
import type {DispatchOutcome, DispatchWorkflow} from '../../github/dispatch.js'
import type {RepoKey} from '../../redaction/denylist.js'
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

function makeBindingRecord(binding: {readonly owner: string; readonly repo: string}) {
  return {
    owner: binding.owner,
    repo: binding.repo,
    channelId: 'channel-1',
    channelName: 'widget',
    workspacePath: '/workspace/repos/acme/widget',
    createdAt: new Date().toISOString(),
    createdByDiscordId: 'user-1',
    databaseId: 42,
    nodeId: 'R_node_42',
  }
}

function makeDenylistCache(denied = false): FroBotDeps['denylistCache'] {
  return {
    getDenylistState: vi.fn(async () => undefined),
    isRepoDenied: vi.fn((_key: RepoKey) => denied),
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
      getBindingByRepo: vi
        .fn()
        .mockResolvedValue({success: true, data: binding === null ? null : makeBindingRecord(binding)}),
      getBindingByChannelId: vi
        .fn()
        .mockResolvedValue({success: true, data: binding === null ? null : makeBindingRecord(binding)}),
      listBindings: vi.fn(),
    },
    denylistCache: makeDenylistCache(),
    appClient: {
      authForRepo: vi.fn(),
      authForWorkflowDispatch: vi.fn(),
      getRepoIdentity: vi.fn(),
      invalidateCache: vi.fn(),
    },
    workspaceClient: {
      clone: vi.fn(),
      readyz: vi.fn(),
      inspect: vi.fn(),
      update: vi.fn(),
      previewRecovery: vi.fn(),
      recover: vi.fn(),
      listBackups: vi.fn(),
      deleteBackup: vi.fn(),
    },
    installUrl: INSTALL_URL,
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    queue: makeQueue(),
    triggerRoleId: 'trigger-role',
    gatewayLogger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    coordinationConfig: {} as CoordinationConfig,
    identity: 'discord-gateway',
    checkRepoQuiescence: vi.fn(),
    forceReleaseStaleLock: vi.fn(),
    dispatchWorkflow,
    cancelRunDeps: {} as FroBotDeps['cancelRunDeps'],
    runIndex: {listRunsForRepo: vi.fn().mockResolvedValue([]), readRun: vi.fn().mockResolvedValue(undefined)},
    listLiveRuns: vi.fn().mockReturnValue([]),
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

  describe('repo access gate', () => {
    const REFUSAL = /not available for dispatch/i

    it('dispatches against the stored binding after a single access check', async () => {
      // #given — a bound, non-denylisted repo whose stored case differs from nothing the user typed
      const dispatchWorkflow = vi
        .fn<DispatchWorkflow>()
        .mockResolvedValue({outcome: 'dispatch-rejected', owner: 'acme', repo: 'widget'})
      const deps = makeDeps(dispatchWorkflow)
      const {interaction} = makeInteraction('run it')

      // #when
      await Effect.runPromise(executeDispatch(interaction, deps))

      // #then — the policy was consulted with the binding's deny keys, then the dispatch ran
      expect(deps.bindingsStore.getBindingByRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
      expect(deps.denylistCache.isRepoDenied).toHaveBeenCalledExactlyOnceWith({databaseId: 42, nodeId: 'R_node_42'})
      expect(dispatchWorkflow).toHaveBeenCalledExactlyOnceWith('acme', 'widget', 'run it')
    })

    it('refuses a denylisted repo without dispatching or disclosing it', async () => {
      // #given
      const dispatchWorkflow = vi.fn<DispatchWorkflow>()
      const deps = makeDeps(dispatchWorkflow, {owner: 'acme', repo: 'widget'}, {denylistCache: makeDenylistCache(true)})
      const {interaction, deferReply, editReply} = makeInteraction('run it')

      // #when
      await Effect.runPromise(executeDispatch(interaction, deps))

      // #then — ephemeral refusal that names neither the repo nor the denylist
      expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
      expect(dispatchWorkflow).not.toHaveBeenCalled()
      const content = getReplyContent(editReply)
      expect(content).toMatch(REFUSAL)
      expect(content).not.toMatch(/acme|widget|denylist|denied/i)
    })

    it('refuses a channel binding that has no current repo binding', async () => {
      // #given — the channel resolves, but the repo-keyed read finds nothing
      const dispatchWorkflow = vi.fn<DispatchWorkflow>()
      const deps = makeDeps(dispatchWorkflow)
      vi.mocked(deps.bindingsStore.getBindingByRepo).mockResolvedValue({success: true, data: null})
      const {interaction, editReply} = makeInteraction('run it')

      // #when
      await Effect.runPromise(executeDispatch(interaction, deps))

      // #then
      expect(dispatchWorkflow).not.toHaveBeenCalled()
      expect(getReplyContent(editReply)).toMatch(REFUSAL)
    })

    it.each([
      [
        'the binding store returns an error',
        (deps: FroBotDeps) =>
          vi.mocked(deps.bindingsStore.getBindingByRepo).mockResolvedValue({
            success: false,
            error: Object.assign(new Error('s3 down'), {code: 'BINDING_STORE_ERROR' as const}),
          }),
      ],
      [
        'the binding store throws',
        (deps: FroBotDeps) => vi.mocked(deps.bindingsStore.getBindingByRepo).mockRejectedValue(new Error('boom')),
      ],
      [
        'the denylist cannot be read',
        (deps: FroBotDeps) =>
          vi.mocked(deps.denylistCache.getDenylistState).mockRejectedValue(new Error('metadata down')),
      ],
    ] as const)('fails closed without dispatching when %s', async (_label, breakPolicy) => {
      // #given
      const dispatchWorkflow = vi.fn<DispatchWorkflow>()
      const deps = makeDeps(dispatchWorkflow)
      breakPolicy(deps)
      const {interaction, editReply} = makeInteraction('run it')

      // #when
      await Effect.runPromise(executeDispatch(interaction, deps))

      // #then — same refusal as a denied repo: the two cannot be told apart
      expect(dispatchWorkflow).not.toHaveBeenCalled()
      expect(getReplyContent(editReply)).toMatch(REFUSAL)
    })

    it('logs one shared label for denied and unavailable without the repo or task', async () => {
      // #given
      const denied = makeDeps(
        vi.fn<DispatchWorkflow>(),
        {owner: 'acme', repo: 'widget'},
        {denylistCache: makeDenylistCache(true)},
      )
      const unavailable = makeDeps(vi.fn<DispatchWorkflow>())
      vi.mocked(unavailable.bindingsStore.getBindingByRepo).mockRejectedValue(new Error('boom'))
      const logs: unknown[] = []
      for (const deps of [denied, unavailable]) {
        vi.mocked(deps.gatewayLogger.warn).mockImplementation((ctx: unknown) => {
          logs.push(ctx)
        })
        // #when
        await Effect.runPromise(executeDispatch(makeInteraction('secret task').interaction, deps))
      }

      // #then
      expect(logs).toEqual([
        {command: 'dispatch', channelId: 'channel-1', gate: 'repo-denied'},
        {command: 'dispatch', channelId: 'channel-1', gate: 'repo-unavailable'},
      ])
    })
  })
})
