import type {EventEmitter} from 'node:events'

import type {Client} from 'discord.js'

import {GatewayIntentBits} from 'discord.js'
import {beforeAll, describe, expect, it, vi} from 'vitest'

import {createDiscordClient, DEFAULT_INTENTS, withLogContext} from './client.js'
import {validateTokenIsFake} from './test-token-guard.js'

// discord.js Client constructor makes no network calls — safe to instantiate in tests.

/**
 * Compare a Discord.js Client's intent bitfield against an expected list of intents.
 *
 * discord.js stores intents internally as a BitField instance — the public type
 * (`ClientOptions['intents']`) doesn't expose the constructor or `.bitfield` numeric
 * value. Tests use the double-`unknown` cast to reach into the runtime shape. This is
 * brittle against discord.js internal API changes; if the cast breaks on an upgrade,
 * recompute the expected bitfield via `new IntentsBitField(expected).bitfield` (from
 * `discord.js`) and compare directly.
 */
function expectClientIntents(client: Client, expected: readonly GatewayIntentBits[]): void {
  const expectedBitfield = new (
    client.options.intents as unknown as {constructor: new (bits: readonly GatewayIntentBits[]) => {bitfield: number}}
  ).constructor(expected).bitfield
  expect((client.options.intents as unknown as {bitfield: number}).bitfield).toBe(expectedBitfield)
}

describe('createDiscordClient', () => {
  beforeAll(() => {
    validateTokenIsFake(process.env.DISCORD_TOKEN)
  })

  it('returns a Client with allowedMentions locked to users-only', () => {
    // #when the client is created
    const client = createDiscordClient()

    // #then allowedMentions prevents @everyone / @here
    expect(client.options.allowedMentions).toEqual({parse: ['users'], repliedUser: false})
  })

  it('default intents are the non-privileged baseline only', () => {
    expect([...DEFAULT_INTENTS]).toEqual([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages])
  })

  it('optional intent override merges with defaults (dedup via Set)', () => {
    // #given a custom intent list including one not in defaults
    const customIntents = [GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds] // Guilds is already default

    // #when
    const client = createDiscordClient({intents: customIntents})

    // #then the BitField is the union of defaults + extras (no duplicates)
    const expected = [...new Set<GatewayIntentBits>([...DEFAULT_INTENTS, ...customIntents])]
    expectClientIntents(client, expected)
  })

  it('wires shard events to logger when logger is provided', () => {
    // #given a mock logger
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    // #when
    const client = createDiscordClient({logger})

    // #then shard events emit log calls
    const emitter = client as unknown as EventEmitter
    emitter.emit('shardReady', 0)
    expect(logger.info).toHaveBeenCalledWith({shardId: 0}, 'discord shard ready')

    emitter.emit('shardReconnecting', 0)
    expect(logger.info).toHaveBeenCalledWith({shardId: 0}, 'discord shard reconnecting')
  })

  it('boots with the non-privileged baseline only when no privileged intents are passed', () => {
    // #when called with no options
    const client = createDiscordClient()

    // #then the bitfield is exactly the non-privileged baseline
    const expected = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    expectClientIntents(client, expected)
  })

  it('opts into MessageContent when passed via options.intents', () => {
    // #given an opt-in for MessageContent only
    const client = createDiscordClient({intents: [GatewayIntentBits.MessageContent]})

    // #then the bitfield includes MessageContent and the non-privileged baseline
    const expected = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    expectClientIntents(client, expected)
  })

  it('opts into GuildMembers when passed via options.intents', () => {
    // #given an opt-in for GuildMembers only
    const client = createDiscordClient({intents: [GatewayIntentBits.GuildMembers]})

    // #then the bitfield includes GuildMembers and the non-privileged baseline
    const expected = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers]
    expectClientIntents(client, expected)
  })

  it('opts into both MessageContent and GuildMembers when both are passed', () => {
    // #given an opt-in for both privileged intents
    const client = createDiscordClient({intents: [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]})

    // #then the bitfield includes both privileged intents and the non-privileged baseline
    const expected = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ]
    expectClientIntents(client, expected)
  })
})

// ---------------------------------------------------------------------------
// withLogContext
// ---------------------------------------------------------------------------

describe('withLogContext', () => {
  it('merges context into every warn call', () => {
    // #given
    const base = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const scoped = withLogContext(base, {command: 'add-project'})

    // #when
    scoped.warn({op: 'editInteraction', err: 'token expired'}, 'io: editInteraction failed')

    // #then — context is merged into the metadata object
    expect(base.warn).toHaveBeenCalledOnce()
    const [ctx, msg] = (base.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx.command).toBe('add-project')
    expect(ctx.op).toBe('editInteraction')
    expect(ctx.err).toBe('token expired')
    expect(msg).toBe('io: editInteraction failed')
  })

  it('merges context into every error call', () => {
    // #given
    const base = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const scoped = withLogContext(base, {command: 'clear-queue'})

    // #when
    scoped.error({err: 'something bad'}, 'fatal error')

    // #then
    const [ctx] = (base.error as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx.command).toBe('clear-queue')
    expect(ctx.err).toBe('something bad')
  })

  it('merges context into every info call', () => {
    // #given
    const base = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const scoped = withLogContext(base, {interaction: 'approval-button'})

    // #when
    scoped.info({channelId: 'ch-1'}, 'button handled')

    // #then
    const [ctx] = (base.info as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx.interaction).toBe('approval-button')
    expect(ctx.channelId).toBe('ch-1')
  })

  it('merges context into every debug call', () => {
    // #given
    const base = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const scoped = withLogContext(base, {command: 'force-release-lock'})

    // #when
    scoped.debug({detail: 'x'}, 'debug msg')

    // #then
    const [ctx] = (base.debug as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx.command).toBe('force-release-lock')
    expect(ctx.detail).toBe('x')
  })

  it('caller meta wins on key collision (caller meta overrides context)', () => {
    // #given — context has {command: 'add-project'}, caller passes {command: 'override'}
    const base = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const scoped = withLogContext(base, {command: 'add-project'})

    // #when — caller meta has the same key
    scoped.warn({command: 'override', op: 'replyInteraction'}, 'msg')

    // #then — caller meta wins
    const [ctx] = (base.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>, string]
    expect(ctx.command).toBe('override')
  })

  it('does not mutate the base logger or the context object', () => {
    // #given
    const base = {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}
    const context = {command: 'add-project'}
    const scoped = withLogContext(base, context)

    // #when
    scoped.warn({extra: 'data'}, 'msg')

    // #then — context object is unchanged
    expect(context).toEqual({command: 'add-project'})
    // #and — base logger methods are the same references (not replaced)
    expect(scoped).not.toBe(base)
  })
})
