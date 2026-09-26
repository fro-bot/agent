import type {CoordinationConfig} from '@fro-bot/runtime'
import type {Guild} from 'discord.js'
import type {DispatchWorkflow} from '../../github/dispatch.js'
import type {FroBotDeps} from './fro-bot.js'

import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const mockAcquireMaintenanceRun = vi.fn()
vi.mock('../maintenance-run.js', () => ({
  acquireMaintenanceRun: (...args: unknown[]): unknown => mockAcquireMaintenanceRun(...args) as unknown,
}))

const {
  createRecoverCheckoutCommand,
  handleRecoverConfirmOrCancelClick,
  NOT_ACTIVE_REPLY,
  getRecoverNonceRegistryForTesting,
} = await import('./recover-checkout.js')
const {dispatchCommand, getCommandRegistry} = await import('./index.js')

function makeGuild(hasManageChannels = true): Guild {
  const member = {permissions: {has: vi.fn().mockReturnValue(hasManageChannels)}}
  return {id: 'guild-1', members: {fetch: vi.fn().mockResolvedValue(member)}} as unknown as Guild
}

function makeReleaseHandle() {
  const release = vi.fn().mockReturnValue(Effect.succeed(undefined))
  return {runId: 'maint-run-1', release}
}

function makeDeps(overrides?: Partial<FroBotDeps>): FroBotDeps {
  return {
    bindingsStore: {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn().mockResolvedValue({success: true, data: {owner: 'acme', repo: 'widget'}}),
      listBindings: vi.fn(),
    },
    appClient: {
      authForRepo: vi.fn().mockResolvedValue({success: true, data: {token: 'ghs_test'}}),
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
    installUrl: 'https://github.com/apps/fro-bot-agent/installations/new',
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    queue: {enqueue: vi.fn(), pendingCount: vi.fn(), takeNext: vi.fn(), clear: vi.fn(), removeBy: vi.fn()},
    triggerRoleId: null,
    gatewayLogger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    coordinationConfig: {} as CoordinationConfig,
    identity: 'discord-gateway',
    forceReleaseStaleLock: vi.fn(),
    dispatchWorkflow: vi.fn<DispatchWorkflow>(),
    ...overrides,
  }
}

function makeSlashInteraction(guild: Guild | null, channelId = 'ch-1', userId = 'user-1') {
  const reply = vi.fn().mockResolvedValue(undefined)
  const deferReply = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn(async (_options: {content: string; components?: unknown[]}): Promise<{id: string}> => ({
    id: 'msg-1',
  }))
  const interaction = {
    commandName: 'fro-bot',
    channelId,
    guild,
    user: {id: userId},
    reply,
    deferReply,
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue('recover-checkout'),
      getSubcommandGroup: vi.fn().mockReturnValue(null),
    },
  }
  return {interaction, reply, deferReply, editReply}
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('/fro-bot recover-checkout — authorization', () => {
  it('a user without ManageChannels is denied and the flow never runs', async () => {
    const guild = makeGuild(false)
    const {interaction, editReply} = makeSlashInteraction(guild)
    const deps = makeDeps()
    const executor = createRecoverCheckoutCommand(deps)

    await Effect.runPromise(executor(interaction as never))

    expect(editReply).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      expect.objectContaining({content: expect.stringContaining('ManageChannels')}),
    )
    expect(mockAcquireMaintenanceRun).not.toHaveBeenCalled()
  })

  it('lock-held: refuses immediately, names the holder, no preview is fetched', async () => {
    const guild = makeGuild(true)
    const {interaction, editReply} = makeSlashInteraction(guild)
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'lock-held', holderId: 'other-gw'}))
    const deps = makeDeps()
    const executor = createRecoverCheckoutCommand(deps)

    await Effect.runPromise(executor(interaction as never))

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('other-gw')}))
    expect(deps.workspaceClient.previewRecovery).not.toHaveBeenCalled()
  })

  it('registration: the real /fro-bot dispatch path exposes recover-checkout', async () => {
    const guild = makeGuild(true)
    const {interaction} = makeSlashInteraction(guild)
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'lock-held', holderId: null}))
    const deps = makeDeps()
    const registry = getCommandRegistry(deps)

    await Effect.runPromise(dispatchCommand(interaction as never, registry))

    expect(mockAcquireMaintenanceRun).toHaveBeenCalledOnce()
  })
})

describe('/fro-bot recover-checkout — preview rendering', () => {
  it('an informational preview (no-checkout) shows no buttons and completes the maintenance run', async () => {
    const guild = makeGuild(true)
    const {interaction, editReply} = makeSlashInteraction(guild)
    const handle = makeReleaseHandle()
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'acquired', handle}))
    const deps = makeDeps()
    vi.mocked(deps.workspaceClient.previewRecovery).mockResolvedValue({success: true, data: {kind: 'no-checkout'}})
    const executor = createRecoverCheckoutCommand(deps)

    await Effect.runPromise(executor(interaction as never))

    const lastCall = editReply.mock.calls.at(-1)?.[0] as {content: string; components?: unknown[]}
    expect(lastCall.content).toContain('There is no checkout')
    expect(lastCall.components).toBeUndefined()
    expect(handle.release).toHaveBeenCalledWith('COMPLETED', expect.objectContaining({outcome: 'preview-only'}))
  })

  it('a confirmable preview (ok) shows Preserve-and-replace + Cancel buttons and does NOT release the run yet', async () => {
    const guild = makeGuild(true)
    const {interaction, editReply} = makeSlashInteraction(guild)
    const handle = makeReleaseHandle()
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'acquired', handle}))
    const deps = makeDeps()
    vi.mocked(deps.workspaceClient.previewRecovery).mockResolvedValue({
      success: true,
      data: {
        kind: 'ok',
        preview: {
          inspectionSafe: true,
          headSha: 'a'.repeat(40),
          branch: 'main',
          dirty: {staged: 0, unstaged: 0, untracked: 0, conflicted: 0},
          operationInProgress: 'none',
          ignoredCount: 0,
          estimatedSizeBytes: 1024,
          entryCount: 10,
          sizeMeasurementComplete: true,
          retention: {
            generationCount: 1,
            hasUnknownSize: false,
            totalBytes: 1024,
            maxGenerations: 5,
            maxBytes: 10 * 1024 ** 3,
          },
          fingerprint: 'fp-1',
        },
      },
    })
    const executor = createRecoverCheckoutCommand(deps)

    await Effect.runPromise(executor(interaction as never))

    const lastCall = editReply.mock.calls.at(-1)?.[0] as {content: string; components?: unknown[]}
    expect(lastCall.content).toContain('Confirm to preserve')
    expect(lastCall.components).toHaveLength(1)
    expect(handle.release).not.toHaveBeenCalled()
    expect(getRecoverNonceRegistryForTesting()._pendingCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Confirm / Cancel button flow
// ---------------------------------------------------------------------------

function makeConfirmableDeps(): FroBotDeps {
  const deps = makeDeps()
  vi.mocked(deps.workspaceClient.previewRecovery).mockResolvedValue({
    success: true,
    data: {
      kind: 'ok',
      preview: {
        inspectionSafe: true,
        headSha: 'a'.repeat(40),
        branch: 'main',
        dirty: {staged: 0, unstaged: 0, untracked: 0, conflicted: 0},
        operationInProgress: 'none',
        ignoredCount: 0,
        estimatedSizeBytes: 1024,
        entryCount: 10,
        sizeMeasurementComplete: true,
        retention: {
          generationCount: 1,
          hasUnknownSize: false,
          totalBytes: 1024,
          maxGenerations: 5,
          maxBytes: 10 * 1024 ** 3,
        },
        fingerprint: 'fp-1',
      },
    },
  })
  return deps
}

async function postConfirmablePreview(deps: FroBotDeps, guild: Guild, handle: ReturnType<typeof makeReleaseHandle>) {
  mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'acquired', handle}))
  const {interaction, editReply} = makeSlashInteraction(guild)
  const executor = createRecoverCheckoutCommand(deps)
  await Effect.runPromise(executor(interaction as never))
  const lastCall = editReply.mock.calls.at(-1)?.[0] as {
    components: {toJSON: () => {components: {custom_id: string}[]}}[]
  }
  const customId = lastCall.components[0]?.toJSON().components[0]?.custom_id ?? ''
  return customId
}

function makeButtonInteraction(
  customId: string,
  opts: {guild?: Guild | null; userId?: string; channelId?: string} = {},
) {
  const {guild = makeGuild(true), userId = 'user-1', channelId = 'ch-1'} = opts
  const deferUpdate = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    customId,
    user: {id: userId},
    guild,
    guildId: guild?.id ?? null,
    channelId,
    message: {id: 'msg-1'},
    deferUpdate,
    editReply,
  }
  return {interaction, deferUpdate, editReply}
}

describe('/fro-bot recover-checkout — confirm/cancel buttons', () => {
  it('confirm happy path: mints a token, calls recover, reports success, releases the run COMPLETED', async () => {
    const guild = makeGuild(true)
    const handle = makeReleaseHandle()
    const deps = makeConfirmableDeps()
    const customId = await postConfirmablePreview(deps, guild, handle)
    vi.mocked(deps.workspaceClient.recover).mockResolvedValue({
      success: true,
      data: {kind: 'ok', recoveryId: 'gen-1', sha: 'b'.repeat(40), branch: 'main'},
    })

    const {interaction, editReply} = makeButtonInteraction(customId, {guild})
    await handleRecoverConfirmOrCancelClick(interaction as never, deps)

    expect(deps.workspaceClient.recover).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widget',
      token: 'ghs_test',
      fingerprint: 'fp-1',
    })
    expect(editReply).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      expect.objectContaining({content: expect.stringContaining('Recovered'), components: []}),
    )
    expect(handle.release).toHaveBeenCalledWith('COMPLETED', expect.objectContaining({outcome: 'ok'}))
  })

  it('cancel: releases the run COMPLETED, reports cancelled, never calls recover', async () => {
    const guild = makeGuild(true)
    const handle = makeReleaseHandle()
    const deps = makeConfirmableDeps()
    const customId = await postConfirmablePreview(deps, guild, handle)
    const cancelCustomId = customId.replace('fb-recover-confirm:', 'fb-recover-cancel:')

    const {interaction, editReply} = makeButtonInteraction(cancelCustomId, {guild})
    await handleRecoverConfirmOrCancelClick(interaction as never, deps)

    expect(deps.workspaceClient.recover).not.toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('Cancelled')}))
    expect(handle.release).toHaveBeenCalledWith('COMPLETED', expect.objectContaining({outcome: 'cancelled'}))
  })

  it('wrong user: claim fails, gets the "no longer active" reply, the real user can still confirm afterward', async () => {
    const guild = makeGuild(true)
    const handle = makeReleaseHandle()
    const deps = makeConfirmableDeps()
    const customId = await postConfirmablePreview(deps, guild, handle)

    const wrongClick = makeButtonInteraction(customId, {guild, userId: 'intruder'})
    await handleRecoverConfirmOrCancelClick(wrongClick.interaction as never, deps)
    expect(wrongClick.editReply).toHaveBeenCalledWith(expect.objectContaining({content: NOT_ACTIVE_REPLY}))
    expect(deps.workspaceClient.recover).not.toHaveBeenCalled()

    vi.mocked(deps.workspaceClient.recover).mockResolvedValue({
      success: true,
      data: {kind: 'ok', recoveryId: 'gen-1', sha: 'b'.repeat(40), branch: 'main'},
    })
    const rightClick = makeButtonInteraction(customId, {guild, userId: 'user-1'})
    await handleRecoverConfirmOrCancelClick(rightClick.interaction as never, deps)
    expect(deps.workspaceClient.recover).toHaveBeenCalledOnce()
  })

  it('a second click (duplicate) after a successful confirm gets the "no longer active" reply', async () => {
    const guild = makeGuild(true)
    const handle = makeReleaseHandle()
    const deps = makeConfirmableDeps()
    const customId = await postConfirmablePreview(deps, guild, handle)
    vi.mocked(deps.workspaceClient.recover).mockResolvedValue({
      success: true,
      data: {kind: 'ok', recoveryId: 'gen-1', sha: 'b'.repeat(40), branch: 'main'},
    })

    const first = makeButtonInteraction(customId, {guild})
    await handleRecoverConfirmOrCancelClick(first.interaction as never, deps)
    const second = makeButtonInteraction(customId, {guild})
    await handleRecoverConfirmOrCancelClick(second.interaction as never, deps)

    expect(deps.workspaceClient.recover).toHaveBeenCalledOnce()
    expect(second.editReply).toHaveBeenCalledWith(expect.objectContaining({content: NOT_ACTIVE_REPLY}))
  })

  it('expired: after 60s, the preview is edited to "no longer active" and the run is released without a click', async () => {
    const guild = makeGuild(true)
    const handle = makeReleaseHandle()
    const deps = makeConfirmableDeps()
    const {interaction, editReply} = makeSlashInteraction(guild)
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'acquired', handle}))
    const executor = createRecoverCheckoutCommand(deps)
    await Effect.runPromise(executor(interaction as never))

    await vi.advanceTimersByTimeAsync(60_000)

    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({content: NOT_ACTIVE_REPLY, components: []}))
    expect(handle.release).toHaveBeenCalledWith('COMPLETED', expect.objectContaining({outcome: 'expired'}))
  })

  it('after a restart (unknown nonce): a stale customId claims nothing, gets "no longer active"', async () => {
    const guild = makeGuild(true)
    const deps = makeConfirmableDeps()
    const {interaction, editReply} = makeButtonInteraction('fb-recover-confirm:stale-nonce-from-before-restart', {
      guild,
    })

    await handleRecoverConfirmOrCancelClick(interaction as never, deps)

    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({content: NOT_ACTIVE_REPLY}))
    expect(deps.workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('permission revoked between preview and confirm: denied at confirm, run released FAILED, recover never called', async () => {
    const guild = makeGuild(true)
    const handle = makeReleaseHandle()
    const deps = makeConfirmableDeps()
    const customId = await postConfirmablePreview(deps, guild, handle)

    const revokedGuild = makeGuild(false)
    const {interaction, editReply} = makeButtonInteraction(customId, {guild: revokedGuild})
    await handleRecoverConfirmOrCancelClick(interaction as never, deps)

    expect(deps.workspaceClient.recover).not.toHaveBeenCalled()
    expect(editReply).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      expect.objectContaining({content: expect.stringContaining('no longer have permission')}),
    )
    expect(handle.release).toHaveBeenCalledWith('FAILED', expect.objectContaining({outcome: 'unauthorized-at-confirm'}))
  })
})
