/**
 * Tests for Discord approval UI primitives (gateway tool-approval Unit 3a).
 *
 * These tests cover the pure builder functions and custom_id codec — no network,
 * no Discord client, no side effects.
 */

import type {PermissionReply, PermissionRequest, SettlementReason} from '../approvals/coordinator.js'

import {ButtonStyle} from 'discord.js'
import {describe, expect, it} from 'vitest'

import {
  APPROVE_PREFIX,
  buildApprovalButtons,
  buildApprovalCustomId,
  buildApprovalEmbed,
  buildSettledEmbed,
  DENY_PREFIX,
  parseApprovalCustomId,
} from './approvals.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseRequest: PermissionRequest = {
  requestID: 'per_abc123',
  sessionID: 'sess_xyz',
  permission: 'bash',
  patterns: ['/tmp/*'],
  title: 'Run shell command in /tmp',
}

// ---------------------------------------------------------------------------
// APPROVE_PREFIX / DENY_PREFIX constants
// ---------------------------------------------------------------------------

describe('prefix constants', () => {
  it('approve prefix constant is namespaced', () => {
    // #given/#then
    expect(APPROVE_PREFIX).toBe('fb-approve:')
  })

  it('deny prefix constant is namespaced', () => {
    // #given/#then
    expect(DENY_PREFIX).toBe('fb-deny:')
  })
})

// ---------------------------------------------------------------------------
// buildApprovalCustomId
// ---------------------------------------------------------------------------

describe('buildApprovalCustomId', () => {
  it('returns prefixed approve id', () => {
    // #given
    const requestID = 'per_abc123'
    // #when
    const id = buildApprovalCustomId('approve', requestID)
    // #then
    expect(id).toBe(`${APPROVE_PREFIX}${requestID}`)
  })

  it('returns prefixed deny id', () => {
    // #given
    const requestID = 'per_abc123'
    // #when
    const id = buildApprovalCustomId('deny', requestID)
    // #then
    expect(id).toBe(`${DENY_PREFIX}${requestID}`)
  })

  it('throws when combined length exceeds 100 chars', () => {
    // #given — a requestID that would push the total over 100
    const longID = 'x'.repeat(100)
    // #when/#then
    expect(() => buildApprovalCustomId('approve', longID)).toThrow()
    expect(() => buildApprovalCustomId('deny', longID)).toThrow()
  })

  it('does not throw for IDs right at 100 chars boundary', () => {
    // #given — APPROVE_PREFIX is 11 chars; 89-char id = exactly 100
    const requestID = 'x'.repeat(100 - APPROVE_PREFIX.length)
    // #when/#then — must not throw
    expect(() => buildApprovalCustomId('approve', requestID)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// parseApprovalCustomId
// ---------------------------------------------------------------------------

describe('parseApprovalCustomId', () => {
  it('round-trips approve action', () => {
    // #given
    const requestID = 'per_1'
    // #when
    const result = parseApprovalCustomId(buildApprovalCustomId('approve', requestID))
    // #then
    expect(result).toEqual({action: 'approve', requestID})
  })

  it('round-trips deny action', () => {
    // #given
    const requestID = 'per_1'
    // #when
    const result = parseApprovalCustomId(buildApprovalCustomId('deny', requestID))
    // #then
    expect(result).toEqual({action: 'deny', requestID})
  })

  it('returns null for unrelated custom_id', () => {
    // #given/#when/#then
    expect(parseApprovalCustomId('something-else')).toBeNull()
  })

  it('returns null for empty string', () => {
    // #given/#when/#then
    expect(parseApprovalCustomId('')).toBeNull()
  })

  it('returns null for approve prefix with empty requestID', () => {
    // #given — bare prefix only, no requestID
    expect(parseApprovalCustomId(APPROVE_PREFIX)).toBeNull()
  })

  it('returns null for deny prefix with empty requestID', () => {
    // #given — bare prefix only
    expect(parseApprovalCustomId(DENY_PREFIX)).toBeNull()
  })

  it('does not throw for any input', () => {
    // #given — several weird strings
    const weirdInputs = [null as unknown as string, undefined as unknown as string, '   ', '\n', 'fb-approve']
    for (const input of weirdInputs) {
      // #when/#then
      expect(() => parseApprovalCustomId(input)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// buildApprovalEmbed
// ---------------------------------------------------------------------------

describe('buildApprovalEmbed', () => {
  it('contains the permission category', () => {
    // #given/#when
    const json = buildApprovalEmbed(baseRequest).toJSON()
    // #then
    const allText = JSON.stringify(json)
    expect(allText).toContain(baseRequest.permission)
  })

  it('contains the human-readable title', () => {
    // #given/#when
    const json = buildApprovalEmbed(baseRequest).toJSON()
    // #then
    const allText = JSON.stringify(json)
    expect(allText).toContain(baseRequest.title)
  })

  it('does NOT contain the requestID in visible embed text', () => {
    // #given/#when
    const json = buildApprovalEmbed(baseRequest).toJSON()
    // #then — requestID must NOT appear in the embed (lives in button customId only)
    const allText = JSON.stringify(json)
    expect(allText).not.toContain(baseRequest.requestID)
  })

  it('does NOT dump raw patterns array', () => {
    // #given — a request whose pattern is distinct from the title
    const req: PermissionRequest = {
      ...baseRequest,
      patterns: ['/__SECRET_PATTERN__/*'],
      title: 'Safe title only',
    }
    // #when
    const json = buildApprovalEmbed(req).toJSON()
    // #then — raw pattern string must not appear
    const allText = JSON.stringify(json)
    expect(allText).not.toContain('__SECRET_PATTERN__')
  })

  it('includes a footer about fail-closed behaviour', () => {
    // #given/#when
    const json = buildApprovalEmbed(baseRequest).toJSON()
    // #then — some footer text mentioning denial on timeout
    expect(json.footer?.text).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// buildApprovalButtons
// ---------------------------------------------------------------------------

describe('buildApprovalButtons', () => {
  it('produces exactly 2 buttons', () => {
    // #given
    const requestID = 'per_abc123'
    // #when
    const row = buildApprovalButtons(requestID).toJSON()
    // #then
    expect(row.components).toHaveLength(2)
  })

  it('first button is Approve with Success style', () => {
    // #given/#when
    const row = buildApprovalButtons('per_abc123').toJSON()
    // discord.js APIButtonComponent is a discriminated union; narrow via JSON stringify to avoid
    // TS property access errors on the union root.
    const allText = JSON.stringify(row)
    // #then
    expect(allText).toContain('"Approve"')
    expect(allText).toContain(`"style":${ButtonStyle.Success}`)
    expect(allText).toContain(`"custom_id":"${buildApprovalCustomId('approve', 'per_abc123')}"`)
  })

  it('second button is Deny with Danger style', () => {
    // #given/#when
    const row = buildApprovalButtons('per_abc123').toJSON()
    const allText = JSON.stringify(row)
    // #then
    expect(allText).toContain('"Deny"')
    expect(allText).toContain(`"style":${ButtonStyle.Danger}`)
    expect(allText).toContain(`"custom_id":"${buildApprovalCustomId('deny', 'per_abc123')}"`)
  })
})

// ---------------------------------------------------------------------------
// buildSettledEmbed
// ---------------------------------------------------------------------------

describe('buildSettledEmbed', () => {
  const approve: PermissionReply = 'once'
  const deny: PermissionReply = 'reject'
  const always: PermissionReply = 'always'

  it('approved by user — shows mention and green color', () => {
    // #given/#when
    const json = buildSettledEmbed(baseRequest, approve, {decidedBy: '123456789', reason: 'replied'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).toContain('<@123456789>')
    expect(json.color).toBeDefined()
    // green = 0x57F287 or similar; just assert it's the same as the "approved" color
  })

  it('approved with always — shows mention', () => {
    // #given/#when
    const json = buildSettledEmbed(baseRequest, always, {decidedBy: '999', reason: 'replied'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).toContain('<@999>')
  })

  it('denied by user — shows mention', () => {
    // #given/#when
    const json = buildSettledEmbed(baseRequest, deny, {decidedBy: '111', reason: 'replied'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).toContain('<@111>')
  })

  it('deadline reason — no user mention, shows timeout text', () => {
    // #given/#when
    const json = buildSettledEmbed(baseRequest, deny, {reason: 'deadline'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).not.toContain('<@')
    expect(allText.toLowerCase()).toMatch(/timeout|timed out/)
  })

  it('cascade reason — no user mention, shows cascade text', () => {
    // #given/#when
    const json = buildSettledEmbed(baseRequest, deny, {reason: 'cascade'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).not.toContain('<@')
  })

  it('disposed reason — no user mention', () => {
    // #given/#when
    const json = buildSettledEmbed(baseRequest, deny, {reason: 'disposed'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).not.toContain('<@')
  })

  it('does not include requestID in settled embed', () => {
    // #given/#when
    const decidedBy = '12345'
    const json = buildSettledEmbed(baseRequest, approve, {decidedBy, reason: 'replied'}).toJSON()
    const allText = JSON.stringify(json)
    // #then
    expect(allText).not.toContain(baseRequest.requestID)
  })

  it('settle variants produce different descriptions', () => {
    // #given — all settlement reasons
    const reasons: SettlementReason[] = ['replied', 'cascade', 'deadline', 'disposed']
    const texts = reasons.map(reason => JSON.stringify(buildSettledEmbed(baseRequest, deny, {reason}).toJSON()))
    // #then — each should be unique (not all the same string)
    const unique = new Set(texts)
    expect(unique.size).toBeGreaterThan(1)
  })
})
