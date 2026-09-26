/**
 * Tests for the recover-entry button primitives — no network, no Discord client, no side effects.
 */

import type {CoordinationConfig} from '@fro-bot/runtime'
import type {Guild} from 'discord.js'
import type {DispatchWorkflow} from '../github/dispatch.js'
import type {FroBotDeps} from './commands/fro-bot.js'

import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {
  buildRecoverEntryButton,
  buildRecoverEntryCustomId,
  handleRecoverEntryButtonClick,
  parseRecoverEntryCustomId,
  RECOVER_ENTRY_PREFIX,
} from './recover-checkout-button.js'

const mockAcquireMaintenanceRun = vi.fn()
vi.mock('./maintenance-run.js', () => ({
  acquireMaintenanceRun: (...args: unknown[]): unknown => mockAcquireMaintenanceRun(...args) as unknown,
}))

describe('RECOVER_ENTRY_PREFIX', () => {
  it('is namespaced', () => {
    expect(RECOVER_ENTRY_PREFIX).toBe('fb-recover-entry:')
  })
})

describe('buildRecoverEntryCustomId', () => {
  it('encodes the channelId after the prefix', () => {
    const id = buildRecoverEntryCustomId({channelId: '123456789012345678'})
    expect(id).toBe(`${RECOVER_ENTRY_PREFIX}123456789012345678`)
  })

  it('throws when the encoded id would exceed the 100-char Discord limit', () => {
    const longChannelId = 'x'.repeat(100)
    expect(() => buildRecoverEntryCustomId({channelId: longChannelId})).toThrow()
  })

  it('does not throw for a real Discord channel-ID snowflake', () => {
    expect(() => buildRecoverEntryCustomId({channelId: '123456789012345678'})).not.toThrow()
  })
})

describe('parseRecoverEntryCustomId', () => {
  it('round-trips the channelId', () => {
    const data = {channelId: '123456789012345678'}
    expect(parseRecoverEntryCustomId(buildRecoverEntryCustomId(data))).toEqual(data)
  })

  it('returns null for an unrelated custom_id', () => {
    expect(parseRecoverEntryCustomId('fb-approve:per_abc123')).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseRecoverEntryCustomId('')).toBeNull()
  })

  it('returns null when the channelId is empty', () => {
    expect(parseRecoverEntryCustomId(RECOVER_ENTRY_PREFIX)).toBeNull()
  })
})

describe('buildRecoverEntryButton', () => {
  it('builds a single-button action row with the encoded custom_id', () => {
    const data = {channelId: '123456789012345678'}
    const row = buildRecoverEntryButton(data)
    const json = row.toJSON() as {components: readonly {custom_id: string; label: string}[]}
    expect(json.components).toHaveLength(1)
    expect(json.components[0]?.custom_id).toBe(buildRecoverEntryCustomId(data))
    expect(json.components[0]?.label).toBe('Recover checkout')
  })

  it('never leaks the channelId anywhere except the custom_id', () => {
    const data = {channelId: '123456789012345678'}
    const row = buildRecoverEntryButton(data)
    const json = row.toJSON() as {components: readonly {custom_id: string; label: string}[]}
    expect(json.components[0]?.label).not.toContain(data.channelId)
  })
})

function makeGuild(hasManageChannels = true): Guild {
  const member = {permissions: {has: vi.fn().mockReturnValue(hasManageChannels)}}
  return {id: 'guild-1', members: {fetch: vi.fn().mockResolvedValue(member)}} as unknown as Guild
}

function makeDeps(): FroBotDeps {
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
      previewRecovery: vi.fn().mockResolvedValue({success: true, data: {kind: 'no-checkout'}}),
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
  }
}

describe('handleRecoverEntryButtonClick', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a user without ManageChannels gets an ephemeral refusal; the shared flow never runs', async () => {
    const guild = makeGuild(false)
    const deferReply = vi.fn().mockResolvedValue(undefined)
    const editReply = vi.fn().mockResolvedValue(undefined)
    const interaction = {
      customId: buildRecoverEntryCustomId({channelId: 'ch-1'}),
      user: {id: 'user-1'},
      guild,
      channelId: 'ch-1',
      deferReply,
      editReply,
    }
    await handleRecoverEntryButtonClick(interaction as never, makeDeps())
    expect(deferReply).toHaveBeenCalledWith({ephemeral: true})
    expect(editReply).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
      expect.objectContaining({content: expect.stringContaining('ManageChannels')}),
    )
  })

  it('an authorized click runs the shared flow (acquires the maintenance run)', async () => {
    const guild = makeGuild(true)
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'lock-held', holderId: null}))
    const interaction = {
      customId: buildRecoverEntryCustomId({channelId: 'ch-1'}),
      user: {id: 'user-1'},
      guild,
      channelId: 'ch-1',
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    }
    await handleRecoverEntryButtonClick(interaction as never, makeDeps())
    expect(mockAcquireMaintenanceRun).toHaveBeenCalledOnce()
  })

  it('after a restart: the entry button carries no server-side state, so it still works identically', async () => {
    // #given — a "restart" is simulated by simply calling the handler fresh, with no prior nonce
    // or in-memory state referenced anywhere in its parameters (proving there is none to lose).
    const guild = makeGuild(true)
    mockAcquireMaintenanceRun.mockReturnValue(Effect.succeed({outcome: 'lock-held', holderId: 'someone'}))
    const editReply = vi.fn().mockResolvedValue(undefined)
    const interaction = {
      customId: buildRecoverEntryCustomId({channelId: 'ch-1'}),
      user: {id: 'user-1'},
      guild,
      channelId: 'ch-1',
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply,
    }
    await handleRecoverEntryButtonClick(interaction as never, makeDeps())
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- vitest asymmetric matcher typing
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({content: expect.stringContaining('someone')}))
  })
})
