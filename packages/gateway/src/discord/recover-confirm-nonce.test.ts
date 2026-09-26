import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createNonceRegistry} from './recover-confirm-nonce.js'

const BINDING = {userId: 'u1', guildId: 'g1', channelId: 'c1', messageId: 'm1'}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createNonceRegistry', () => {
  it('claim with the exact matching binding returns the payload exactly once', () => {
    const registry = createNonceRegistry<{owner: string}>()
    const nonce = registry.create(BINDING, {owner: 'acme'}, () => {})
    expect(registry.claim(nonce, BINDING)).toEqual({owner: 'acme'})
  })

  it('a second claim of the same nonce returns null (no double-processing)', () => {
    const registry = createNonceRegistry<string>()
    const nonce = registry.create(BINDING, 'payload', () => {})
    expect(registry.claim(nonce, BINDING)).toBe('payload')
    expect(registry.claim(nonce, BINDING)).toBeNull()
  })

  it.each<[string, Partial<typeof BINDING>]>([
    ['wrong user', {userId: 'other'}],
    ['wrong guild', {guildId: 'other'}],
    ['wrong channel', {channelId: 'other'}],
    ['wrong message', {messageId: 'other'}],
  ])('%s is rejected (payload untouched, still claimable by the right binding)', (_label, override) => {
    const registry = createNonceRegistry<string>()
    const nonce = registry.create(BINDING, 'payload', () => {})
    expect(registry.claim(nonce, {...BINDING, ...override})).toBeNull()
    expect(registry.claim(nonce, BINDING)).toBe('payload')
  })

  it('an unknown nonce returns null', () => {
    const registry = createNonceRegistry<string>()
    expect(registry.claim('does-not-exist', BINDING)).toBeNull()
  })

  it('expires after 60s, invoking onExpire exactly once with the payload', () => {
    const registry = createNonceRegistry<string>()
    const onExpire = vi.fn()
    registry.create(BINDING, 'payload', onExpire)
    vi.advanceTimersByTime(59_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledExactlyOnceWith('payload')
  })

  it('a claim after expiry returns null and does not re-fire onExpire', () => {
    const registry = createNonceRegistry<string>()
    const onExpire = vi.fn()
    const nonce = registry.create(BINDING, 'payload', onExpire)
    vi.advanceTimersByTime(60_000)
    expect(registry.claim(nonce, BINDING)).toBeNull()
    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('cancel removes the nonce without invoking onExpire, even after the TTL elapses', () => {
    const registry = createNonceRegistry<string>()
    const onExpire = vi.fn()
    const nonce = registry.create(BINDING, 'payload', onExpire)
    registry.cancel(nonce)
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
    expect(registry.claim(nonce, BINDING)).toBeNull()
  })

  it('cancel on an unknown nonce is a safe no-op', () => {
    const registry = createNonceRegistry<string>()
    expect(() => registry.cancel('does-not-exist')).not.toThrow()
  })

  it('_pendingCount reflects create/claim/cancel/expire', () => {
    const registry = createNonceRegistry<string>()
    expect(registry._pendingCount()).toBe(0)
    const a = registry.create(BINDING, 'a', () => {})
    const b = registry.create({...BINDING, messageId: 'm2'}, 'b', () => {})
    expect(registry._pendingCount()).toBe(2)
    registry.claim(a, BINDING)
    expect(registry._pendingCount()).toBe(1)
    registry.cancel(b)
    expect(registry._pendingCount()).toBe(0)
  })

  it('two separate registries never share nonce strings', () => {
    const recoverRegistry = createNonceRegistry<string>()
    const backupRegistry = createNonceRegistry<string>()
    const nonce = recoverRegistry.create(BINDING, 'recover-payload', () => {})
    expect(backupRegistry.claim(nonce, BINDING)).toBeNull()
    expect(recoverRegistry.claim(nonce, BINDING)).toBe('recover-payload')
  })
})
