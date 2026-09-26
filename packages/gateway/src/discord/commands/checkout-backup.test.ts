import type {CoordinationConfig} from '@fro-bot/runtime'
import type {Guild} from 'discord.js'
import type {DispatchWorkflow} from '../../github/dispatch.js'
import type {FroBotDeps} from './fro-bot.js'

import {Effect} from 'effect'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const {createCheckoutBackupCommand, handleBackupDeleteConfirmOrCancelClick, getBackupDeleteNonceRegistryForTesting} =
  await import('./checkout-backup.js')

function makeGuild(hasManageChannels = true): Guild {
  const member = {permissions: {has: vi.fn().mockReturnValue(hasManageChannels)}}
  return {id: 'guild-1', members: {fetch: vi.fn().mockResolvedValue(member)}} as unknown as Guild
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

function makeSlashInteraction(
  guild: Guild | null,
  subcommand: 'list' | 'delete',
  id?: string,
  channelId = 'ch-1',
  userId = 'user-1',
) {
  const editReply = vi.fn(async (_o: {content: string; components?: unknown[]}): Promise<{id: string}> => ({
    id: 'msg-1',
  }))
  const interaction = {
    commandName: 'fro-bot',
    channelId,
    guild,
    user: {id: userId},
    reply: vi.fn(),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue(subcommand),
      getSubcommandGroup: vi.fn().mockReturnValue('checkout-backup'),
      getString: vi.fn().mockReturnValue(id ?? null),
    },
  }
  return {interaction, editReply}
}

function makeButtonInteraction(
  customId: string,
  opts: {guild?: Guild | null; userId?: string; channelId?: string} = {},
) {
  const {guild = makeGuild(true), userId = 'user-1', channelId = 'ch-1'} = opts
  const editReply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    customId,
    user: {id: userId},
    guild,
    guildId: guild?.id ?? null,
    channelId,
    message: {id: 'msg-1'},
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply,
  }
  return {interaction, editReply}
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('/fro-bot checkout-backup list', () => {
  it("empty list uses the plan's exact wording", async () => {
    const deps = makeDeps()
    vi.mocked(deps.workspaceClient.listBackups).mockResolvedValue({
      success: true,
      data: {kind: 'ok', backups: [], totalBytes: 0},
    })
    const {interaction, editReply} = makeSlashInteraction(makeGuild(true), 'list')
    await Effect.runPromise(createCheckoutBackupCommand(deps)(interaction as never))
    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'No preserved checkouts for `acme/widget`.'}),
    )
  })

  it("a populated list renders one row per backup with the plan's exact separator", async () => {
    const deps = makeDeps()
    vi.mocked(deps.workspaceClient.listBackups).mockResolvedValue({
      success: true,
      data: {
        kind: 'ok',
        totalBytes: 100,
        backups: [
          {
            id: 'gen-1',
            metadataOk: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            sizeBytes: 100,
            sizeComplete: true,
            originalHeadSha: 'a'.repeat(40),
            originalBranch: 'main',
          },
        ],
      },
    })
    const {interaction, editReply} = makeSlashInteraction(makeGuild(true), 'list')
    await Effect.runPromise(createCheckoutBackupCommand(deps)(interaction as never))
    const call = editReply.mock.calls.at(-1)?.[0] as {content: string}
    expect(call.content).toContain('`gen-1`')
    expect(call.content).toContain('·')
    expect(call.content).toContain('from branch `main` at `aaaaaaa`')
  })
})

describe('/fro-bot checkout-backup delete', () => {
  it('an unknown id reports not found, never shows a confirm dialog', async () => {
    const deps = makeDeps()
    vi.mocked(deps.workspaceClient.listBackups).mockResolvedValue({
      success: true,
      data: {kind: 'ok', backups: [], totalBytes: 0},
    })
    const {interaction, editReply} = makeSlashInteraction(makeGuild(true), 'delete', 'gen-missing')
    await Effect.runPromise(createCheckoutBackupCommand(deps)(interaction as never))
    const call = editReply.mock.calls.at(-1)?.[0] as {content: string; components?: unknown[]}
    expect(call.content).toContain('No backup')
    expect(call.components).toBeUndefined()
  })

  it("delete confirmation uses the plan's exact wording, then confirming deletes and reports success", async () => {
    const deps = makeDeps()
    const entry = {
      id: 'gen-1',
      metadataOk: true,
      createdAt: '2026-02-02T00:00:00.000Z',
      sizeBytes: 2048,
      sizeComplete: true,
      originalHeadSha: 'b'.repeat(40),
      originalBranch: 'main',
    }
    vi.mocked(deps.workspaceClient.listBackups).mockResolvedValue({
      success: true,
      data: {kind: 'ok', backups: [entry], totalBytes: 2048},
    })
    const guild = makeGuild(true)
    const {interaction, editReply} = makeSlashInteraction(guild, 'delete', 'gen-1')
    await Effect.runPromise(createCheckoutBackupCommand(deps)(interaction as never))
    const confirmContent = editReply.mock.calls.at(-1)?.[0] as {
      content: string
      components: {toJSON: () => {components: {custom_id: string}[]}}[]
    }
    expect(confirmContent.content).toBe(
      "Delete backup `gen-1` from 2026-02-02T00:00:00.000Z, 2.0 KiB? This can't be undone.",
    )
    const customId = confirmContent.components[0]?.toJSON().components[0]?.custom_id ?? ''

    vi.mocked(deps.workspaceClient.deleteBackup).mockResolvedValue({success: true, data: {kind: 'ok'}})
    const click = makeButtonInteraction(customId, {guild})
    await handleBackupDeleteConfirmOrCancelClick(click.interaction as never, deps)
    expect(deps.workspaceClient.deleteBackup).toHaveBeenCalledWith('acme', 'widget', 'gen-1')
    expect(click.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Deleted backup `gen-1`.', components: []}),
    )
  })

  it("cancel uses the plan's exact wording and never deletes", async () => {
    const deps = makeDeps()
    const entry = {
      id: 'gen-1',
      metadataOk: true,
      createdAt: '2026-02-02T00:00:00.000Z',
      sizeBytes: 2048,
      sizeComplete: true,
      originalHeadSha: 'b'.repeat(40),
      originalBranch: 'main',
    }
    vi.mocked(deps.workspaceClient.listBackups).mockResolvedValue({
      success: true,
      data: {kind: 'ok', backups: [entry], totalBytes: 2048},
    })
    const guild = makeGuild(true)
    const {interaction, editReply} = makeSlashInteraction(guild, 'delete', 'gen-1')
    await Effect.runPromise(createCheckoutBackupCommand(deps)(interaction as never))
    const confirmContent = editReply.mock.calls.at(-1)?.[0] as {
      components: {toJSON: () => {components: {custom_id: string}[]}}[]
    }
    const confirmId = confirmContent.components[0]?.toJSON().components[0]?.custom_id ?? ''
    const cancelId = confirmId.replace('fb-backup-delete-confirm:', 'fb-backup-delete-cancel:')

    const click = makeButtonInteraction(cancelId, {guild})
    await handleBackupDeleteConfirmOrCancelClick(click.interaction as never, deps)
    expect(deps.workspaceClient.deleteBackup).not.toHaveBeenCalled()
    expect(click.editReply).toHaveBeenCalledWith(
      expect.objectContaining({content: 'Cancelled. Backup `gen-1` was not deleted.', components: []}),
    )
  })

  it("expiry uses the plan's exact wording", async () => {
    const deps = makeDeps()
    const entry = {
      id: 'gen-1',
      metadataOk: true,
      createdAt: '2026-02-02T00:00:00.000Z',
      sizeBytes: 2048,
      sizeComplete: true,
      originalHeadSha: 'b'.repeat(40),
      originalBranch: 'main',
    }
    vi.mocked(deps.workspaceClient.listBackups).mockResolvedValue({
      success: true,
      data: {kind: 'ok', backups: [entry], totalBytes: 2048},
    })
    const {interaction, editReply} = makeSlashInteraction(makeGuild(true), 'delete', 'gen-1')
    await Effect.runPromise(createCheckoutBackupCommand(deps)(interaction as never))

    await vi.advanceTimersByTimeAsync(60_000)

    expect(editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'This confirmation expired. Run `/fro-bot checkout-backup delete gen-1` again.',
        components: [],
      }),
    )
    expect(getBackupDeleteNonceRegistryForTesting()._pendingCount()).toBe(0)
  })
})
