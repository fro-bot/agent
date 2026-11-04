/**
 * Tests for `/fro-bot cancel`: routing, authorization, targeting, and the reply for every `cancelRun` outcome.
 *
 * `cancelRun` itself is mocked here (its behaviour is pinned in `execute/cancel.test.ts`); what matters at this seam
 * is WHICH run the command asks it to cancel, as WHOM, and what the user is told.
 */

import type {RunPhase, RunState} from '@fro-bot/runtime'
import type {ChatInputCommandInteraction, Guild} from 'discord.js'
import type {CancelOutcome} from '../../execute/cancel.js'
import type {FroBotDeps} from './fro-bot.js'

import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import {cancelRun} from '../../execute/cancel.js'
import {createFroBotCommand} from './fro-bot.js'

vi.mock('../../execute/cancel.js', () => ({cancelRun: vi.fn()}))

const cancelRunMock = vi.mocked(cancelRun)

const BOUND_CHANNEL = 'ch-bound'
const THREAD = 'thread-1'
const USER_ID = '111222333444555666'

function makeRun(
  overrides: Partial<Omit<RunState, 'details'>> & {readonly channelId?: string; readonly phase?: RunPhase} = {},
): RunState {
  const {channelId = BOUND_CHANNEL, ...rest} = overrides
  return {
    run_id: 'run-1',
    surface: 'discord',
    thread_id: THREAD,
    entity_ref: 'acme/widget',
    phase: 'EXECUTING',
    started_at: '2026-07-03T00:00:00.000Z',
    last_heartbeat: '2026-07-03T00:00:00.000Z',
    holder_id: 'discord-gateway',
    details: {channelId},
    ...rest,
  }
}

function makeGuild(opts: {hasRole?: boolean; hasManageChannels?: boolean} = {}): Guild {
  const {hasRole = true, hasManageChannels = true} = opts
  const member = {
    roles: {cache: {has: vi.fn().mockReturnValue(hasRole)}},
    permissions: {has: vi.fn().mockReturnValue(hasManageChannels)},
  }
  return {members: {fetch: vi.fn().mockResolvedValue(member)}} as unknown as Guild
}

function makeDeps(runs: readonly RunState[] = [makeRun()], overrides: Partial<FroBotDeps> = {}): FroBotDeps {
  const queue = {
    enqueue: vi.fn(),
    pendingCount: vi.fn().mockReturnValue(2),
    takeNext: vi.fn(),
    clear: vi.fn(),
    removeBy: vi.fn(),
  }
  return {
    bindingsStore: {
      createBinding: vi.fn(),
      getBindingByRepo: vi.fn(),
      getBindingByChannelId: vi.fn().mockImplementation(async (channelId: string) => ({
        success: true,
        data: channelId === BOUND_CHANNEL ? {owner: 'acme', repo: 'widget', channelId} : null,
      })),
      listBindings: vi.fn(),
    },
    appClient: {
      authForRepo: vi.fn(),
      authForWorkflowDispatch: vi.fn(),
      getRepoIdentity: vi.fn(),
      invalidateCache: vi.fn(),
    },
    workspaceClient: {} as FroBotDeps['workspaceClient'],
    installUrl: 'https://github.com/apps/fro-bot-agent/installations/new',
    logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    queue,
    triggerRoleId: null,
    gatewayLogger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
    coordinationConfig: {} as FroBotDeps['coordinationConfig'],
    identity: 'discord-gateway',
    checkRepoQuiescence: vi.fn(),
    forceReleaseStaleLock: vi.fn(),
    dispatchWorkflow: vi.fn(),
    cancelRunDeps: {sentinel: 'cancel-run-deps'} as unknown as FroBotDeps['cancelRunDeps'],
    // The live set is what the process still runs (past the queue, not ended); the scan lists every record.
    runIndex: {
      listRunsForRepo: vi.fn().mockResolvedValue(runs),
      readRun: vi.fn().mockImplementation(async (_repo: string, runId: string) => runs.find(r => r.run_id === runId)),
    },
    listLiveRuns: vi
      .fn()
      .mockReturnValue(
        runs
          .filter(run => run.phase === 'ACKNOWLEDGED' || run.phase === 'EXECUTING')
          .map(run => ({runId: run.run_id, repo: 'acme/widget'})),
      ),
    ...overrides,
  }
}

type ChannelFixture = {readonly isThread: () => boolean; readonly parentId: string | null} | null

const PLAIN_CHANNEL: ChannelFixture = {isThread: () => false, parentId: null}
const RUN_THREAD: ChannelFixture = {isThread: () => true, parentId: BOUND_CHANNEL}

function makeInteraction(opts: {
  readonly channelId: string
  readonly channel: ChannelFixture
  readonly guild?: Guild | null
  readonly fetchedChannel?: ChannelFixture
}): {
  interaction: ChatInputCommandInteraction
  deferReply: ReturnType<typeof vi.fn>
  editReply: ReturnType<typeof vi.fn>
} {
  const deferReply = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    commandName: 'fro-bot',
    channelId: opts.channelId,
    channel: opts.channel,
    client: {channels: {fetch: vi.fn().mockResolvedValue(opts.fetchedChannel ?? null)}},
    guild: opts.guild === undefined ? makeGuild() : opts.guild,
    user: {id: USER_ID},
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply,
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue('cancel'),
      getSubcommandGroup: vi.fn().mockReturnValue(null),
    },
  } as unknown as ChatInputCommandInteraction
  return {interaction, deferReply, editReply}
}

async function run(deps: FroBotDeps, interaction: ChatInputCommandInteraction): Promise<void> {
  await Effect.runPromise(createFroBotCommand(deps).execute(interaction))
}

function replyText(editReply: ReturnType<typeof vi.fn>): string {
  expect(editReply).toHaveBeenCalledOnce()
  return (editReply.mock.calls[0]?.[0] as {content: string}).content
}

beforeEach(() => {
  cancelRunMock.mockReset()
})

describe('/fro-bot cancel — registration and routing', () => {
  it('registers a cancel subcommand with no options', () => {
    // #given / #when
    const json = createFroBotCommand(makeDeps()).data.toJSON()

    // #then
    const cancel = (json.options ?? []).find((o: {name: string}) => o.name === 'cancel') as
      {options?: unknown[]} | undefined
    expect(cancel).toBeDefined()
    expect(cancel?.options ?? []).toEqual([])
  })

  it('routes cancel to its handler: defers ephemerally, then edits the reply', async () => {
    // #given
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const {interaction, deferReply, editReply} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(makeDeps(), interaction)

    // #then
    expect(deferReply).toHaveBeenCalledExactlyOnceWith({ephemeral: true})
    expect(editReply).toHaveBeenCalledOnce()
  })
})

describe('/fro-bot cancel — authorization', () => {
  it.each([
    ['no trigger role configured and no ManageChannels', null, {hasRole: true, hasManageChannels: false}],
    ['trigger role configured and the member lacks it', 'role-1', {hasRole: false, hasManageChannels: false}],
    [
      'trigger role configured, member has ManageChannels but not the role (the role is the only way in)',
      'role-1',
      {hasRole: false, hasManageChannels: true},
    ],
  ])('denies: %s', async (_label, triggerRoleId, memberOpts) => {
    // #given
    const deps = makeDeps([makeRun()], {triggerRoleId})
    const {interaction, editReply} = makeInteraction({
      channelId: BOUND_CHANNEL,
      channel: PLAIN_CHANNEL,
      guild: makeGuild(memberOpts),
    })

    // #when
    await run(deps, interaction)

    // #then — refused before any lookup or cancel
    expect(replyText(editReply)).toBe('You do not have permission to cancel runs.')
    expect(cancelRunMock).not.toHaveBeenCalled()
    expect(deps.listLiveRuns).not.toHaveBeenCalled()
  })

  it('denies when member resolution fails (fail closed)', async () => {
    // #given
    const guild = {members: {fetch: vi.fn().mockRejectedValue(new Error('discord 500'))}} as unknown as Guild
    const deps = makeDeps()
    const {interaction, editReply} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL, guild})

    // #when
    await run(deps, interaction)

    // #then
    expect(replyText(editReply)).toBe('You do not have permission to cancel runs.')
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('allows the trigger-role holder when a role is configured', async () => {
    // #given
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const deps = makeDeps([makeRun()], {triggerRoleId: 'role-1'})
    const {interaction} = makeInteraction({
      channelId: BOUND_CHANNEL,
      channel: PLAIN_CHANNEL,
      guild: makeGuild({hasRole: true, hasManageChannels: false}),
    })

    // #when
    await run(deps, interaction)

    // #then
    expect(cancelRunMock).toHaveBeenCalledOnce()
  })

  it('refuses outside a server', async () => {
    // #given
    const deps = makeDeps()
    const {interaction} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL, guild: null})

    // #when
    await run(deps, interaction)

    // #then
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ephemeral: true}))
    expect(cancelRunMock).not.toHaveBeenCalled()
  })
})

describe('/fro-bot cancel — targeting', () => {
  it('in a bound channel, cancels the executing run as the invoking Discord user', async () => {
    // #given
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const deps = makeDeps()
    const {interaction} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(deps, interaction)

    // #then
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith(
      {runId: 'run-1', actor: {kind: 'discord-user', discordUserId: USER_ID}, logger: expect.anything() as unknown},
      deps.cancelRunDeps,
    )
  })

  it('in a run thread, cancels that thread run via the parent channel binding', async () => {
    // #given — the thread id is not a binding key; its parent is
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const deps = makeDeps([makeRun({run_id: 'run-other', thread_id: 'thread-2'}), makeRun()])
    const {interaction} = makeInteraction({channelId: THREAD, channel: RUN_THREAD})

    // #when
    await run(deps, interaction)

    // #then
    expect(deps.bindingsStore.getBindingByChannelId).toHaveBeenCalledWith(BOUND_CHANNEL)
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({runId: 'run-1'}), deps.cancelRunDeps)
  })

  it('resolves an uncached thread through the client before deciding', async () => {
    // #given — interaction.channel is null; the client can fetch the thread
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const deps = makeDeps()
    const {interaction} = makeInteraction({channelId: THREAD, channel: null, fetchedChannel: RUN_THREAD})

    // #when
    await run(deps, interaction)

    // #then
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({runId: 'run-1'}), deps.cancelRunDeps)
  })

  it('refuses when the channel cannot be resolved at all', async () => {
    // #given
    const deps = makeDeps()
    const {interaction, editReply} = makeInteraction({channelId: THREAD, channel: null, fetchedChannel: null})

    // #when
    await run(deps, interaction)

    // #then
    expect(replyText(editReply)).toContain('Something went wrong looking up the run')
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it.each<[string, string, ChannelFixture, RunState[], string]>([
    ['an unbound channel', 'ch-unbound', PLAIN_CHANNEL, [makeRun()], 'No repo is bound'],
    ['a thread that is not a run thread', 'thread-x', RUN_THREAD, [makeRun()], 'not a run thread'],
    [
      'a thread whose run belongs to another channel',
      THREAD,
      RUN_THREAD,
      [makeRun({channelId: 'ch-other'})],
      'different channel',
    ],
    [
      'a channel whose run has finished',
      BOUND_CHANNEL,
      PLAIN_CHANNEL,
      [makeRun({phase: 'COMPLETED'})],
      'No run is executing',
    ],
    ['a run thread whose run has finished', THREAD, RUN_THREAD, [makeRun({phase: 'FAILED'})], 'already finished'],
    [
      'a channel with only a queued run',
      BOUND_CHANNEL,
      PLAIN_CHANNEL,
      [makeRun({phase: 'PENDING', thread_id: ''})],
      'clear-queue',
    ],
    [
      'a dashboard-launched run in the same repo',
      BOUND_CHANNEL,
      PLAIN_CHANNEL,
      [makeRun({surface: 'web', thread_id: '', channelId: 'web:acme/widget'})],
      'No run is executing',
    ],
    [
      'a run in another channel of the repo',
      BOUND_CHANNEL,
      PLAIN_CHANNEL,
      [makeRun({channelId: 'ch-other'})],
      'No run is executing',
    ],
  ])(
    'refuses %s with a clear ephemeral reply and cancels nothing',
    async (_label, channelId, channel, runs, expected) => {
      // #given
      const deps = makeDeps(runs)
      const {interaction, editReply} = makeInteraction({channelId, channel})

      // #when
      await run(deps, interaction)

      // #then
      expect(replyText(editReply)).toContain(expected)
      expect(cancelRunMock).not.toHaveBeenCalled()
    },
  )

  it('targets the executing run even when the capped run scan cannot list it', async () => {
    // #given — the repo has so many newer records that the newest-200 scan no longer includes the live run
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const deps = makeDeps([makeRun()])
    vi.mocked(deps.runIndex.listRunsForRepo).mockResolvedValue([])
    const {interaction} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(deps, interaction)

    // #then
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({runId: 'run-1'}), deps.cancelRunDeps)
  })

  it('reports a lookup failure, not "nothing is executing", when a live run cannot be read', async () => {
    // #given
    const deps = makeDeps([makeRun()])
    vi.mocked(deps.runIndex.readRun).mockResolvedValue(undefined)
    const {interaction, editReply} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(deps, interaction)

    // #then
    expect(replyText(editReply)).toContain('Something went wrong looking up the run')
    expect(cancelRunMock).not.toHaveBeenCalled()
  })

  it('cancelling the current run never touches queued work', async () => {
    // #given — an executing run plus two queued siblings in the channel
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const deps = makeDeps([
      makeRun({run_id: 'run-queued-1', phase: 'PENDING', thread_id: ''}),
      makeRun(),
      makeRun({run_id: 'run-queued-2', phase: 'PENDING', thread_id: ''}),
    ])
    const {interaction} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(deps, interaction)

    // #then — only the executing run is cancelled; the command itself never drains or clears the queue
    expect(cancelRunMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({runId: 'run-1'}), deps.cancelRunDeps)
    expect(deps.queue.clear).not.toHaveBeenCalled()
    expect(deps.queue.removeBy).not.toHaveBeenCalled()
    expect(deps.queue.takeNext).not.toHaveBeenCalled()
  })
})

describe('/fro-bot cancel — outcome replies', () => {
  it.each<[CancelOutcome, string]>([
    [{outcome: 'cancelled', wasQueued: false}, 'Cancel requested'],
    [{outcome: 'cancelled', wasQueued: true}, 'Cancelled the run before it started'],
    [{outcome: 'already-terminal', phase: 'COMPLETED'}, 'already finished (completed)'],
    [{outcome: 'quarantined'}, 'already failed and is being held while its work is confirmed stopped'],
    [{outcome: 'not-found'}, 'could not find that run'],
    [{outcome: 'retry'}, 'just starting'],
  ])('maps %j to an ephemeral reply', async (outcome, expected) => {
    // #given
    cancelRunMock.mockResolvedValue(outcome)
    const {interaction, editReply} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(makeDeps(), interaction)

    // #then
    expect(replyText(editReply).toLowerCase()).toContain(expected.toLowerCase())
  })

  it('says "requested", not "cancelled", for an executing run (settlement is asynchronous)', async () => {
    // #given
    cancelRunMock.mockResolvedValue({outcome: 'cancelled', wasQueued: false})
    const {interaction, editReply} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(makeDeps(), interaction)

    // #then
    expect(replyText(editReply)).toMatch(/^Cancel requested\./)
  })

  it('replies with a retryable error when cancelRun throws, without failing the command', async () => {
    // #given
    cancelRunMock.mockRejectedValue(new Error('s3 unavailable'))
    const deps = makeDeps()
    const {interaction, editReply} = makeInteraction({channelId: BOUND_CHANNEL, channel: PLAIN_CHANNEL})

    // #when
    await run(deps, interaction)

    // #then
    expect(replyText(editReply)).toBe('Something went wrong requesting the cancel. Please try again.')
    expect(deps.gatewayLogger.error).toHaveBeenCalled()
  })
})
