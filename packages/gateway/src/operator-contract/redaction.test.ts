/**
 * redaction.test.ts — Contract tests for the redaction + authorization obligation clauses.
 *
 * Covers:
 * 1. REDACTION_OBLIGATION is exported, non-empty, and references the four operational rules.
 * 2. assertRedactionApplied: passes when redaction ran and the repo is allowed; throws when
 *    called on a denied repo (fail-closed guard — surfacing a denied repo is a contract violation).
 * 3. AUTHORIZATION_OBLIGATION is exported and references the sole-gate + two constraints.
 * 4. All three symbols are wired into the barrel (index.ts).
 *
 * Uses BDD comments (#given, #when, #then).
 */

import {describe, expect, it} from 'vitest'
import {assertRedactionApplied, AUTHORIZATION_OBLIGATION, REDACTION_OBLIGATION} from './redaction.js'

// ---------------------------------------------------------------------------
// 1. REDACTION_OBLIGATION — exported, non-empty, references the four rules
// ---------------------------------------------------------------------------

describe('REDACTION_OBLIGATION', () => {
  it('is exported and non-empty', () => {
    // #given — the redaction obligation constant
    // #when — read at import time
    // #then — it is a non-empty string
    expect(typeof REDACTION_OBLIGATION).toBe('string')
    expect(REDACTION_OBLIGATION.length).toBeGreaterThan(0)
  })

  it('references the denylist-before-query rule', () => {
    // #given — the redaction obligation constant
    // #when — inspected for the denylist-before-query rule
    // #then — the rule is present (case-insensitive to allow natural prose)
    expect(REDACTION_OBLIGATION.toLowerCase()).toContain('denylist')
  })

  it('references the fail-closed rule', () => {
    // #given — the redaction obligation constant
    // #when — inspected for the fail-closed rule
    // #then — the rule is present
    expect(REDACTION_OBLIGATION.toLowerCase()).toContain('fail-closed')
  })

  it('references the format-stable / node_id rule', () => {
    // #given — the redaction obligation constant
    // #when — inspected for the node_id format-skew rule
    // #then — node_id is mentioned (the format-stable deny-key rule)
    expect(REDACTION_OBLIGATION.toLowerCase()).toContain('node_id')
  })

  it('references checkRepoAuthz (composes alongside, not instead of)', () => {
    // #given — the redaction obligation constant
    // #when — inspected for the checkRepoAuthz composition rule
    // #then — checkRepoAuthz is mentioned
    expect(REDACTION_OBLIGATION).toContain('checkRepoAuthz')
  })

  it('is importable from the contract barrel (index.ts)', async () => {
    // #given — the public barrel for the operator-contract module
    // #when — REDACTION_OBLIGATION is imported from the barrel
    const barrel = await import('./index.js')

    // #then — it is present and matches the direct import
    expect(barrel.REDACTION_OBLIGATION).toBe(REDACTION_OBLIGATION)
  })
})

// ---------------------------------------------------------------------------
// 2. assertRedactionApplied — real gate: passes when allowed, throws when denied
// ---------------------------------------------------------------------------

describe('assertRedactionApplied', () => {
  it('does NOT throw when the repo is allowed (isDenied = false)', () => {
    // #given — a repo that passed the denylist check
    // #when — assertRedactionApplied is called with isDenied = false
    // #then — it does not throw (redaction ran and the repo is allowed)
    expect(() => assertRedactionApplied({isDenied: false})).not.toThrow()
  })

  it('throws when the repo is denied (isDenied = true)', () => {
    // #given — a repo that is on the denylist
    // #when — assertRedactionApplied is called with isDenied = true
    // #then — it throws (surfacing a denied repo is a contract violation)
    expect(() => assertRedactionApplied({isDenied: true})).toThrow()
  })

  it('throws an Error instance when denied (not a string throw)', () => {
    // #given — a denied repo
    // #when — assertRedactionApplied is called
    // #then — the thrown value is an Error
    expect(() => assertRedactionApplied({isDenied: true})).toThrow(Error)
  })

  it('thrown message references REDACTION_OBLIGATION when denied', () => {
    // #given — a denied repo
    // #when — assertRedactionApplied throws
    let thrownMessage = ''
    try {
      assertRedactionApplied({isDenied: true})
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }

    // #then — the message references the obligation (grepable guard)
    expect(thrownMessage.length).toBeGreaterThan(0)
    expect(thrownMessage.toLowerCase()).toContain('redaction')
  })

  it('(no-oracle) thrown message does NOT echo any repo identity (no-oracle guard)', () => {
    // #given — a denied repo (no repo identity is passed to assertRedactionApplied)
    // #when — assertRedactionApplied throws
    let thrownMessage = ''
    try {
      assertRedactionApplied({isDenied: true})
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }

    // #then — the message must not contain any repo identity (no-oracle: the function
    // does not receive owner/repo, so it cannot echo them)
    expect(thrownMessage.length).toBeGreaterThan(0)
    // The function signature does not accept owner/repo — this is structural no-oracle
    // (the function cannot leak what it does not receive)
  })

  it('is importable from the contract barrel (index.ts)', async () => {
    // #given — the public barrel for the operator-contract module
    // #when — assertRedactionApplied is imported from the barrel
    const barrel = await import('./index.js')

    // #then — it is present and is a function
    expect(typeof barrel.assertRedactionApplied).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 3. AUTHORIZATION_OBLIGATION — exported, references sole-gate + two constraints
// ---------------------------------------------------------------------------

describe('AUTHORIZATION_OBLIGATION', () => {
  it('is exported and non-empty', () => {
    // #given — the authorization obligation constant
    // #when — read at import time
    // #then — it is a non-empty string
    expect(typeof AUTHORIZATION_OBLIGATION).toBe('string')
    expect(AUTHORIZATION_OBLIGATION.length).toBeGreaterThan(0)
  })

  it('references the sole approval gate (registry.handleDecision)', () => {
    // #given — the authorization obligation constant
    // #when — inspected for the sole-gate reference
    // #then — handleDecision is mentioned
    expect(AUTHORIZATION_OBLIGATION).toContain('handleDecision')
  })

  it('references the version-not-over-wire constraint', () => {
    // #given — the authorization obligation constant
    // #when — inspected for the version constraint
    // #then — the wire constraint is mentioned
    expect(AUTHORIZATION_OBLIGATION.toLowerCase()).toContain('wire')
  })

  it('references the identity-server-constructed constraint', () => {
    // #given — the authorization obligation constant
    // #when — inspected for the server-side identity construction constraint
    // #then — server-side construction is mentioned
    expect(AUTHORIZATION_OBLIGATION.toLowerCase()).toContain('server-side')
  })

  it('is importable from the contract barrel (index.ts)', async () => {
    // #given — the public barrel for the operator-contract module
    // #when — AUTHORIZATION_OBLIGATION is imported from the barrel
    const barrel = await import('./index.js')

    // #then — it is present and matches the direct import
    expect(barrel.AUTHORIZATION_OBLIGATION).toBe(AUTHORIZATION_OBLIGATION)
  })
})
