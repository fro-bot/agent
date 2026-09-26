/**
 * Tests for the recover-entry button primitives — no network, no Discord client, no side effects.
 */

import {describe, expect, it} from 'vitest'

import {
  buildRecoverEntryButton,
  buildRecoverEntryCustomId,
  parseRecoverEntryCustomId,
  RECOVER_ENTRY_PREFIX,
} from './recover-checkout-button.js'

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
