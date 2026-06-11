/**
 * Tests for the `makeGuildCommand` pipeline factory.
 *
 * Covers:
 * - Pipeline ordering: preDefer → guild-null guard → defer → auth → work
 * - preDefer short-circuit stops before guard/defer
 * - Guild-null guard replies ephemerally with serverOnlyCopy and never defers
 * - Defer failure fails the Effect without editReply
 * - Denial edits deferred reply with copy and work never runs
 * - Denial copy precedence: decision.copy > spec.denialCopy > default
 * - Work success completes without error edit
 * - Work failure → catchAll edits deferred reply with internal-error copy THEN re-fails
 * - Sync throw inside work construction funnels to the same catchAll
 * - All Discord sends through io.ts helpers (boundary contract)
 */

import type {ChatInputCommandInteraction, Guild} from 'discord.js'

import type {GuildCommandDeps, GuildCommandSpec, PreDeferCtx} from './guild-command.js'
import {Effect} from 'effect'
import {describe, expect, it, vi} from 'vitest'
import {makeGuildCommand} from './guild-command.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGatewayLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function makeDeps(overrides?: Partial<GuildCommandDeps>): GuildCommandDeps {
  return {
    gatewayLogger: makeGatewayLogger(),
    ...overrides,
  }
}

function makeGuild(): Guild {
  return {
    id: 'guild-123',
    members: {
      fetch: vi.fn().mockResolvedValue({
        roles: {cache: {has: vi.fn().mockReturnValue(false)}},
        permissions: {has: vi.fn().mockReturnValue(true)},
      }),
    },
  } as unknown as Guild
}

function makeInteraction(guild: Guild | null = makeGuild()): {
  interaction: ChatInputCommandInteraction
  reply: ReturnType<typeof vi.fn>
  deferReply: ReturnType<typeof vi.fn>
  editReply: ReturnType<typeof vi.fn>
} {
  const reply = vi.fn().mockResolvedValue(undefined)
  const deferReply = vi.fn().mockResolvedValue(undefined)
  const editReply = vi.fn().mockResolvedValue(undefined)
  const interaction = {
    commandName: 'fro-bot',
    channelId: 'ch-test-123',
    guild,
    user: {id: 'user-123'},
    reply,
    deferReply,
    editReply,
    options: {
      getSubcommand: vi.fn().mockReturnValue('test-cmd'),
    },
  } as unknown as ChatInputCommandInteraction
  return {interaction, reply, deferReply, editReply}
}

// ---------------------------------------------------------------------------
// Pipeline ordering
// ---------------------------------------------------------------------------

describe('makeGuildCommand — pipeline ordering', () => {
  it('happy path: defer called before authorize, authorize called before work', async () => {
    // #given — verify ordering by snapshotting deferReply.mock.calls.length inside each hook.
    // deferReply is called by Effect.tryPromise before authorize or work run.
    let deferCountWhenAuthorizeRan = -1
    let authorizeCountWhenWorkRan = -1
    let authorizeCallCount = 0

    const {interaction, deferReply} = makeInteraction()

    const authorize = vi.fn().mockImplementation(() => {
      deferCountWhenAuthorizeRan = deferReply.mock.calls.length
      authorizeCallCount++
      return Effect.succeed({authorized: true as const})
    })
    const work = vi.fn().mockImplementation(() => {
      authorizeCountWhenWorkRan = authorizeCallCount
      return Effect.succeed(undefined)
    })

    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const executor = makeGuildCommand(spec, makeDeps())

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — defer was called before authorize
    expect(deferCountWhenAuthorizeRan).toBe(1)
    // #and — authorize was called before work
    expect(authorizeCountWhenWorkRan).toBe(1)
  })

  it('preDefer runs before guard and defer', async () => {
    // #given — verify ordering by snapshotting call counts inside each hook
    let preDeferCountWhenDeferRan = -1
    let deferCountWhenAuthorizeRan = -1
    let authorizeCountWhenWorkRan = -1
    let preDeferCallCount = 0
    let authorizeCallCount = 0
    let capturedPreDeferCtx: unknown

    const {interaction, deferReply} = makeInteraction()

    const preDefer = vi.fn().mockImplementation((ctx: unknown) => {
      capturedPreDeferCtx = ctx
      preDeferCallCount++
      return Effect.succeed({continue: true as const})
    })
    const authorize = vi.fn().mockImplementation(() => {
      preDeferCountWhenDeferRan = preDeferCallCount
      deferCountWhenAuthorizeRan = deferReply.mock.calls.length
      authorizeCallCount++
      return Effect.succeed({authorized: true as const})
    })
    const work = vi.fn().mockImplementation(() => {
      authorizeCountWhenWorkRan = authorizeCallCount
      return Effect.succeed(undefined)
    })

    const spec: GuildCommandSpec = {name: 'test-cmd', preDefer, authorize, work}
    const executor = makeGuildCommand(spec, makeDeps())

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — preDefer ran before defer (defer count was 0 when authorize ran, preDefer count was 1)
    expect(preDeferCountWhenDeferRan).toBe(1)
    // #and — defer ran before authorize
    expect(deferCountWhenAuthorizeRan).toBe(1)
    // #and — authorize ran before work
    expect(authorizeCountWhenWorkRan).toBe(1)
    // #and — preDefer ctx has no guild property (runs before the guard)
    const preDeferCtx = capturedPreDeferCtx as PreDeferCtx & {guild?: unknown}
    expect(preDeferCtx.interaction).toBe(interaction)
    expect(preDeferCtx.log).toBeDefined()
    expect('guild' in preDeferCtx).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// preDefer short-circuit
// ---------------------------------------------------------------------------

describe('makeGuildCommand — preDefer short-circuit', () => {
  it('preDefer returning stop skips guard, defer, auth, and work', async () => {
    // #given — preDefer signals stop (e.g. rate limit already replied)
    const preDefer = vi.fn().mockReturnValue(Effect.succeed({continue: false as const}))
    const authorize = vi.fn()
    const work = vi.fn()

    const spec: GuildCommandSpec = {name: 'test-cmd', preDefer, authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction, reply, deferReply} = makeInteraction()

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — preDefer was called
    expect(preDefer).toHaveBeenCalledOnce()
    // #and — nothing else ran
    expect(deferReply).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })

  it('preDefer short-circuit does not fail the Effect', async () => {
    // #given — preDefer signals stop
    const preDefer = vi.fn().mockReturnValue(Effect.succeed({continue: false as const}))
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      preDefer,
      authorize: vi.fn(),
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction} = makeInteraction()

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — Effect succeeds (not a failure)
    expect(result._tag).toBe('Right')
  })
})

// ---------------------------------------------------------------------------
// Guild-null guard
// ---------------------------------------------------------------------------

describe('makeGuildCommand — guild-null guard', () => {
  it('null guild → immediate ephemeral reply with serverOnlyCopy, no defer, no auth, no work', async () => {
    // #given — interaction has no guild (DM context)
    const authorize = vi.fn()
    const work = vi.fn()
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction, reply, deferReply} = makeInteraction(null)

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — plain reply (not deferred) with server-only message
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ephemeral: true,
        content: expect.stringMatching(/server/i) as unknown as string,
      }),
    )
    // #and — deferReply NOT called
    expect(deferReply).not.toHaveBeenCalled()
    // #and — auth and work NOT called
    expect(authorize).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })

  it('null guild → uses spec.serverOnlyCopy when provided', async () => {
    // #given — spec provides custom server-only copy
    const customCopy = 'Custom server-only message for this command.'
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      serverOnlyCopy: customCopy,
      authorize: vi.fn(),
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, reply} = makeInteraction(null)

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — reply uses the custom copy
    expect(reply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({content: customCopy}))
  })

  it('null guild → Effect succeeds (guard reply is not a failure)', async () => {
    // #given — null guild
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      authorize: vi.fn(),
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction} = makeInteraction(null)

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — Effect succeeds
    expect(result._tag).toBe('Right')
  })

  it('null guild reply includes allowedMentions: {parse: []} (io.ts boundary)', async () => {
    // #given — null guild
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      authorize: vi.fn(),
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, reply} = makeInteraction(null)

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — allowedMentions injected by io.ts
    const replyArg = reply.mock.calls[0]?.[0] as {allowedMentions?: unknown}
    expect(replyArg.allowedMentions).toEqual({parse: []})
  })
})

// ---------------------------------------------------------------------------
// Defer failure
// ---------------------------------------------------------------------------

describe('makeGuildCommand — defer failure', () => {
  it('deferReply rejection fails the Effect; auth and work never run', async () => {
    // #given — deferReply rejects (Discord API down, token expired, etc.)
    // The catchAll fires and attempts editReply (which will fail silently via
    // io.ts since there is no deferred reply to edit), then re-fails with the
    // original defer error. Auth and work are never reached.
    const deferError = new Error('Discord API unavailable')
    const authorize = vi.fn()
    const work = vi.fn()
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction, deferReply} = makeInteraction()

    deferReply.mockRejectedValue(deferError)

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — Effect fails with the defer error (catchAll re-fails after editing)
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('Discord API unavailable')
    // #and — auth and work NOT called (defer failed before they ran)
    expect(authorize).not.toHaveBeenCalled()
    expect(work).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Authorization denial
// ---------------------------------------------------------------------------

describe('makeGuildCommand — authorization denial', () => {
  it('denial → edits deferred reply with default denial copy, work never runs', async () => {
    // #given — authorize returns denial without custom copy
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: false as const}))
    const work = vi.fn()
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction, editReply} = makeInteraction()

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — editReply called with denial copy
    expect(editReply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringMatching(/permission|not authorized/i) as unknown as string,
      }),
    )
    // #and — work NOT called
    expect(work).not.toHaveBeenCalled()
  })

  it('denial copy precedence: decision.copy > spec.denialCopy > default', async () => {
    // #given — all three levels of copy are present; decision.copy wins
    const decisionCopy = 'Decision-level denial message.'
    const specCopy = 'Spec-level denial message.'
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: false as const, copy: decisionCopy}))
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      denialCopy: specCopy,
      authorize,
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, editReply} = makeInteraction()

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — decision.copy wins
    expect(editReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({content: decisionCopy}))
  })

  it('denial copy precedence: spec.denialCopy > default when decision has no copy', async () => {
    // #given — decision has no copy; spec.denialCopy should be used
    const specCopy = 'Spec-level denial message.'
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: false as const}))
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      denialCopy: specCopy,
      authorize,
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, editReply} = makeInteraction()

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — spec.denialCopy wins over default
    expect(editReply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({content: specCopy}))
  })

  it('denial → Effect succeeds (denial is a handled outcome, not a failure)', async () => {
    // #given — denial
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: false as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work: vi.fn()}
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction} = makeInteraction()

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — Effect succeeds
    expect(result._tag).toBe('Right')
  })

  it('denial editReply includes allowedMentions: {parse: []} (io.ts boundary)', async () => {
    // #given — denial
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: false as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work: vi.fn()}
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, editReply} = makeInteraction()

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — allowedMentions injected by io.ts
    const replyArg = editReply.mock.calls[0]?.[0] as {allowedMentions?: unknown}
    expect(replyArg.allowedMentions).toEqual({parse: []})
  })
})

// ---------------------------------------------------------------------------
// Work success
// ---------------------------------------------------------------------------

describe('makeGuildCommand — work success', () => {
  it('work success → Effect succeeds, no error editReply', async () => {
    // #given — work succeeds
    const work = vi.fn().mockReturnValue(Effect.succeed(undefined))
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: true as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction} = makeInteraction()

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — Effect succeeds
    expect(result._tag).toBe('Right')
    // #and — work was called
    expect(work).toHaveBeenCalledOnce()
  })

  it('work receives ctx with non-null guild, interaction, and log', async () => {
    // #given — capture the ctx passed to work
    let capturedCtx: unknown
    const work = vi.fn().mockImplementation((ctx: unknown) => {
      capturedCtx = ctx
      return Effect.succeed(undefined)
    })
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: true as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const executor = makeGuildCommand(spec, makeDeps())
    const guild = makeGuild()
    const {interaction} = makeInteraction(guild)

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — ctx has the expected shape
    const ctx = capturedCtx as {interaction: unknown; guild: unknown; log: unknown}
    expect(ctx.interaction).toBe(interaction)
    expect(ctx.guild).toBe(guild)
    expect(ctx.log).toBeDefined()
  })

  it('authorize receives ctx with non-null guild, interaction, and log', async () => {
    // #given — capture the ctx passed to authorize
    let capturedCtx: unknown
    const authorize = vi.fn().mockImplementation((ctx: unknown) => {
      capturedCtx = ctx
      return Effect.succeed({authorized: true as const})
    })
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      authorize,
      work: vi.fn().mockReturnValue(Effect.succeed(undefined)),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const guild = makeGuild()
    const {interaction} = makeInteraction(guild)

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — ctx has the expected shape
    const ctx = capturedCtx as {interaction: unknown; guild: unknown; log: unknown}
    expect(ctx.interaction).toBe(interaction)
    expect(ctx.guild).toBe(guild)
    expect(ctx.log).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Work failure → catchAll
// ---------------------------------------------------------------------------

describe('makeGuildCommand — work failure (catchAll)', () => {
  it('work Effect.fail → catchAll edits deferred reply with internal-error copy THEN re-fails', async () => {
    // #given — work fails with an Error
    const workError = new Error('database connection lost')
    const work = vi.fn().mockReturnValue(Effect.fail(workError))
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: true as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction, editReply} = makeInteraction()

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — editReply called with internal-error copy
    expect(editReply).toHaveBeenCalledOnce()
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/internal error|please try again/i)

    // #and — Effect re-fails with the original error
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('database connection lost')
  })

  it('work failure catchAll editReply includes allowedMentions: {parse: []} (io.ts boundary)', async () => {
    // #given — work fails
    const work = vi.fn().mockReturnValue(Effect.fail(new Error('infra error')))
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: true as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, editReply} = makeInteraction()

    // #when
    await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — allowedMentions injected by io.ts
    const replyArg = editReply.mock.calls[0]?.[0] as {allowedMentions?: unknown}
    expect(replyArg.allowedMentions).toEqual({parse: []})
  })

  it('sync throw inside work construction funnels to the same catchAll', async () => {
    // #given — work throws synchronously during Effect construction
    // Effect.suspend wraps the work call so sync throws become Effect failures
    const syncError = new Error('sync construction error')
    const work = vi.fn().mockImplementation(() => {
      throw syncError
    })
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: true as const}))
    const spec: GuildCommandSpec = {name: 'test-cmd', authorize, work}
    const deps = makeDeps()
    const executor = makeGuildCommand(spec, deps)
    const {interaction, editReply} = makeInteraction()

    // #when
    const result = await Effect.runPromise(Effect.either(executor(interaction)))

    // #then — catchAll fired: editReply called with internal-error copy
    expect(editReply).toHaveBeenCalledOnce()
    const replyArg = editReply.mock.calls[0]?.[0] as {content: string}
    expect(replyArg.content).toMatch(/internal error|please try again/i)

    // #and — Effect re-fails with the original error
    expect(result._tag).toBe('Left')
    expect(((result as {_tag: 'Left'; left: unknown}).left as Error).message).toBe('sync construction error')
  })

  it('catchAll is scoped to defer-onward: guild-null guard reply does NOT trigger catchAll', async () => {
    // #given — null guild (guard fires before defer; catchAll must not double-reply)
    const spec: GuildCommandSpec = {
      name: 'test-cmd',
      authorize: vi.fn(),
      work: vi.fn(),
    }
    const executor = makeGuildCommand(spec, makeDeps())
    const {interaction, reply, editReply} = makeInteraction(null)

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — only the guard reply was sent (no editReply from catchAll)
    expect(reply).toHaveBeenCalledOnce()
    expect(editReply).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ctx.log is scoped to the command name
// ---------------------------------------------------------------------------

describe('makeGuildCommand — scoped log context', () => {
  it('log passed to work has command name in context', async () => {
    // #given — capture log calls from work
    const logCalls: [Record<string, unknown>, string][] = []
    const work = vi
      .fn()
      .mockImplementation((ctx: {log: {info: (meta: Record<string, unknown>, msg: string) => void}}) => {
        ctx.log.info({extra: 'data'}, 'test message')
        return Effect.succeed(undefined)
      })
    const authorize = vi.fn().mockReturnValue(Effect.succeed({authorized: true as const}))
    const gatewayLogger = {
      debug: vi.fn(),
      info: vi.fn().mockImplementation((meta: Record<string, unknown>, msg: string) => {
        logCalls.push([meta, msg])
      }),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const spec: GuildCommandSpec = {name: 'my-command', authorize, work}
    const executor = makeGuildCommand(spec, {gatewayLogger})
    const {interaction} = makeInteraction()

    // #when
    await Effect.runPromise(executor(interaction))

    // #then — log call includes command name in context
    expect(logCalls.length).toBeGreaterThan(0)
    const firstCall = logCalls[0]
    expect(firstCall).toBeDefined()
    const [meta] = firstCall ?? []
    expect(meta?.command).toBe('my-command')
  })
})

// ---------------------------------------------------------------------------
// Structural: no hand-rolled deferReply in migrated command files
// ---------------------------------------------------------------------------

describe('structural: guild-command.ts is the only permitted deferReply site', () => {
  it('migrated command files contain no hand-rolled deferReply calls', async () => {
    // #given — the three migrated guild commands; guild-command.ts is the only permitted site.
    // ping.ts has no deferReply by design (no guild/defer/auth skeleton).
    // This assertion fails if a future edit re-introduces a hand-rolled deferReply in any
    // migrated command, bypassing the pipeline's ownership of the interaction lifecycle.
    const {readFileSync} = await import('node:fs')
    const {fileURLToPath} = await import('node:url')
    const path = await import('node:path')

    const thisDir = path.dirname(fileURLToPath(import.meta.url))

    const migratedFiles = ['fro-bot.ts', 'add-project.ts']
    const violations: string[] = []

    for (const filename of migratedFiles) {
      const absPath = path.join(thisDir, filename)
      const content = readFileSync(absPath, 'utf8')
      for (const [i, line] of content.split('\n').entries()) {
        const trimmed = line.trimStart()
        // Skip line comments
        if (trimmed.startsWith('//')) continue
        if (line.includes('.deferReply(')) {
          violations.push(`${filename}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Hand-rolled deferReply calls found in migrated command files.\n` +
          `guild-command.ts is the only permitted deferReply site.\n\n` +
          `Violations:\n${violations.map(v => `  ${v}`).join('\n')}`,
      )
    }

    expect(violations).toHaveLength(0)
  })
})
