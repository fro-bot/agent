import type {Guild, TextChannel} from 'discord.js'

import {ChannelType} from 'discord.js'
import {describe, expect, it, vi} from 'vitest'

import {createChannelWithCollisionSuffix} from './channels.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTextChannel(name: string, id = `id-${name}`): TextChannel {
  return {name, id, type: ChannelType.GuildText} as unknown as TextChannel
}

/**
 * Build a guild mock whose `channels.cache.find` reads from a live `channels` array.
 * Pass a mutable array so tests can push new channels after creation to simulate
 * the live-cache behaviour the race fix depends on.
 */
function makeGuildWithLiveCache(channels: TextChannel[], createResult?: TextChannel | Error): Guild {
  const cache = {
    // Re-read `channels` on every call — simulates the live Discord.js cache.
    find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
  }

  const create =
    createResult instanceof Error
      ? vi.fn().mockRejectedValue(createResult)
      : vi.fn().mockResolvedValue(createResult ?? makeTextChannel('new-channel'))

  return {
    channels: {cache, create},
  } as unknown as Guild
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createChannelWithCollisionSuffix', () => {
  describe('always creates — never returns existing channel', () => {
    it('creates a new channel even when exact name already exists (skips to name-2)', async () => {
      // #given — my-repo exists; my-repo-2 is free
      const existing = makeTextChannel('my-repo')
      const newChannel = makeTextChannel('my-repo-2')
      const channels = [existing]
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }
      const create = vi.fn().mockResolvedValue(newChannel)
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo')

      // #then — must NOT return the existing channel; creates my-repo-2
      expect(result.success).toBe(true)
      if (result.success === false) return
      expect(result.data.name).toBe('my-repo-2')
      expect(create).toHaveBeenCalledWith(expect.objectContaining({name: 'my-repo-2'}))
    })

    it('creates name-3 when name and name-2 both exist', async () => {
      // #given — my-repo and my-repo-2 exist; my-repo-3 is free
      const ch1 = makeTextChannel('my-repo')
      const ch2 = makeTextChannel('my-repo-2')
      const newChannel = makeTextChannel('my-repo-3')
      const channels = [ch1, ch2]
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }
      const create = vi.fn().mockResolvedValue(newChannel)
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo')

      // #then
      expect(result.success).toBe(true)
      if (result.success === false) return
      expect(result.data.name).toBe('my-repo-3')
      // create was called once (for my-repo-3 — my-repo and my-repo-2 were skipped via nameExists)
      expect(create).toHaveBeenCalledTimes(1)
    })
  })

  describe('create new channel', () => {
    it('creates a new channel when none exists with that name', async () => {
      // #given
      const newChannel = makeTextChannel('new-repo')
      const guild = makeGuildWithLiveCache([], newChannel)

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'new-repo')

      // #then
      expect(result.success).toBe(true)
      if (result.success === false) return
      expect(result.data.name).toBe('new-repo')
    })
  })

  describe('collision suffix logic (name-taken from Discord)', () => {
    it('uses name-2 suffix when Discord rejects name as duplicate (code 50035)', async () => {
      // #given — no existing channels in cache, but Discord rejects first create with 50035
      const newChannel = makeTextChannel('my-repo-2')
      const channels: TextChannel[] = []
      const nameTakenError = Object.assign(new Error('Invalid Form Body'), {code: 50035})
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }
      const create = vi
        .fn()
        .mockRejectedValueOnce(nameTakenError) // first attempt: Discord rejects as duplicate
        .mockResolvedValue(newChannel) // second attempt succeeds
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo')

      // #then
      expect(result.success).toBe(true)
      if (result.success === false) return
      expect(result.data.name).toBe('my-repo-2')
      // create was called twice (my-repo rejected by Discord, my-repo-2 succeeded)
      expect(create).toHaveBeenCalledTimes(2)
    })

    it('creates name-3 when name and name-2 are both rejected by Discord as duplicate', async () => {
      // #given — no existing channels match; first two creates rejected with 50035; third succeeds
      const newChannel = makeTextChannel('my-repo-3')
      const channels: TextChannel[] = []
      const nameTakenError = Object.assign(new Error('Invalid Form Body'), {code: 50035})
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }
      const create = vi
        .fn()
        .mockRejectedValueOnce(nameTakenError) // my-repo
        .mockRejectedValueOnce(nameTakenError) // my-repo-2
        .mockResolvedValue(newChannel) // my-repo-3
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo')

      // #then
      expect(result.success).toBe(true)
      if (result.success === false) return
      expect(result.data.name).toBe('my-repo-3')
      // create was called 3 times
      expect(create).toHaveBeenCalledTimes(3)
    })
  })

  describe('collision-exhausted', () => {
    it('returns collision-exhausted when all candidates (name through name-10) are taken', async () => {
      // #given — exact name and all suffix candidates exist
      const allChannels = [
        makeTextChannel('my-repo'),
        ...Array.from({length: 9}, (_, i) => makeTextChannel(`my-repo-${i + 2}`)),
      ]
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => allChannels.find(pred),
      }
      const create = vi.fn() // should never be called
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo', {maxSuffix: 10})

      // #then
      expect(result.success).toBe(false)
      if (result.success === true) return
      expect(result.error.kind).toBe('collision-exhausted')
      expect((result.error as {name: string}).name).toBe('my-repo')
      // create was never called — all candidates were skipped via nameExists
      expect(create).not.toHaveBeenCalled()
    })

    it('respects custom maxSuffix — collision-exhausted at -2', async () => {
      // #given — my-repo and my-repo-2 both exist; maxSuffix is 2
      const allChannels = [makeTextChannel('my-repo'), makeTextChannel('my-repo-2')]
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => allChannels.find(pred),
      }
      const create = vi.fn()
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo', {maxSuffix: 2})

      // #then
      expect(result.success).toBe(false)
      if (result.success === true) return
      expect(result.error.kind).toBe('collision-exhausted')
      expect(create).not.toHaveBeenCalled()
    })
  })

  describe('permission-denied', () => {
    it('returns permission-denied when channel creation fails with 403', async () => {
      // #given
      const permError = new Error('Missing Permissions (403)')
      const guild = makeGuildWithLiveCache([], permError)

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'new-repo')

      // #then
      expect(result.success).toBe(false)
      if (result.success === true) return
      expect(result.error.kind).toBe('permission-denied')
    })

    it('returns permission-denied immediately when Discord returns code 50013', async () => {
      // #given — Discord 50013 "Missing Permissions" numeric code
      const permError = Object.assign(new Error('Missing Permissions'), {code: 50013})
      const guild = makeGuildWithLiveCache([], permError)

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'new-repo')

      // #then
      expect(result.success).toBe(false)
      if (result.success === true) return
      expect(result.error.kind).toBe('permission-denied')
    })
  })

  describe('create-failed (non-transient errors)', () => {
    it('returns create-failed immediately on 429 rate-limit — does not burn through suffixes', async () => {
      // #given — all tryCreate calls throw a 429-shaped error (non-permission, non-name-taken)
      const rateLimitError = Object.assign(new Error('You are being rate limited.'), {code: 50007})
      const channels: TextChannel[] = []
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }
      // create is called at most once — create-failed must short-circuit immediately
      const create = vi.fn().mockRejectedValue(rateLimitError)
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'my-repo')

      // #then — returns create-failed after FIRST failure, not after burning all 10 suffixes
      expect(result.success).toBe(false)
      if (result.success === true) return
      expect(result.error.kind).toBe('create-failed')
      // create was called exactly once — did not burn through suffix candidates
      expect(create).toHaveBeenCalledTimes(1)
    })
  })

  describe('concurrent race — live cache re-read', () => {
    it('second concurrent invocation sees channel created by first and advances to suffix -2', async () => {
      // #given — shared mutable cache that reflects newly-created channels
      const channels: TextChannel[] = []
      const fooChannel = makeTextChannel('foo')
      const foo2Channel = makeTextChannel('foo-2')

      const cache = {
        // Re-reads `channels` on every call — simulates live Discord.js cache.
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }

      // First invocation's create: succeeds for 'foo', mutates shared cache.
      // Second invocation's create: succeeds for 'foo-2'.
      let createCallCount = 0
      const create = vi.fn().mockImplementation(async ({name}: {name: string}) => {
        createCallCount++
        if (name === 'foo') {
          // Simulate first invocation creating 'foo' and it becoming visible in cache.
          channels.push(fooChannel)
          return Promise.resolve(fooChannel)
        }
        if (name === 'foo-2') {
          channels.push(foo2Channel)
          return Promise.resolve(foo2Channel)
        }
        return Promise.reject(new Error(`Unexpected create call for ${name}`))
      })

      const guild = {channels: {cache, create}} as unknown as Guild

      // #when — two concurrent invocations with the same baseName
      const [result1, result2] = await Promise.all([
        createChannelWithCollisionSuffix(guild, 'foo'),
        createChannelWithCollisionSuffix(guild, 'foo'),
      ])

      // #then — both succeed, resolving to different channel names
      expect(result1.success).toBe(true)
      expect(result2.success).toBe(true)
      if (result1.success === false || result2.success === false) return

      const names = new Set([result1.data.name, result2.data.name])
      expect(names).toContain('foo')
      expect(names).toContain('foo-2')

      // create was called exactly twice — no wasted attempts
      expect(createCallCount).toBe(2)
    })
  })

  describe('maxSuffix: 1 boundary', () => {
    it('returns collision-exhausted immediately when maxSuffix:1 and base name already exists', async () => {
      // #given — 'foo' already exists; maxSuffix:1 means only 'foo' is tried (no 'foo-2')
      const existing = makeTextChannel('foo')
      const channels = [existing]
      const cache = {
        find: (pred: (ch: TextChannel) => boolean) => channels.find(pred),
      }
      const create = vi.fn() // should never be called
      const guild = {channels: {cache, create}} as unknown as Guild

      // #when
      const result = await createChannelWithCollisionSuffix(guild, 'foo', {maxSuffix: 1})

      // #then — collision-exhausted without trying foo-2
      expect(result.success).toBe(false)
      if (result.success === true) return
      expect(result.error.kind).toBe('collision-exhausted')
      expect(create).not.toHaveBeenCalled()
    })
  })
})
