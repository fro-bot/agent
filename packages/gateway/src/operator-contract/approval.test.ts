/**
 * approval.test.ts — Contract tests for the approval-decision module.
 *
 * Covers:
 * 1. PermissionReply is the sole definer (importable from the contract).
 * 2. DecisionOutcome → OperatorDecisionState mapping (table-driven, all 5 variants).
 * 3. Exhaustiveness: all 5 known DecisionOutcome variants are handled.
 * 4. Security (R7): structural scan — no `decidedBy: string` parameter in
 *    approval-decision source files.
 */

import type {DecisionOutcome} from '../approvals/registry.js'
import type {DecisionInput, OperatorDecisionState, PermissionReply} from './approval.js'

import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'
import {toOperatorDecisionState} from './approval.js'

// ---------------------------------------------------------------------------
// 1. PermissionReply — sole definer, importable from the contract
// ---------------------------------------------------------------------------

describe('PermissionReply', () => {
  it('is importable from the contract module', () => {
    // #given — the contract module exports PermissionReply
    // #when — we import it (type-level; runtime check via assignability)
    // #then — the three valid verbs are assignable to PermissionReply
    const once: PermissionReply = 'once'
    const always: PermissionReply = 'always'
    const reject: PermissionReply = 'reject'

    // Runtime non-vacuousness: the values are what they say they are
    expect(once).toBe('once')
    expect(always).toBe('always')
    expect(reject).toBe('reject')
  })

  it('is also importable from the contract barrel (index.ts)', async () => {
    // #given — the barrel re-exports approval symbols
    // #when — we import PermissionReply-related exports from the barrel
    const barrel = await import('./index.js')

    // #then — toOperatorDecisionState is exported (proves the barrel wires approval.ts)
    expect(typeof barrel.toOperatorDecisionState).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 2. DecisionOutcome → OperatorDecisionState mapping (table-driven)
// ---------------------------------------------------------------------------

describe('toOperatorDecisionState', () => {
  const cases: readonly {readonly outcome: DecisionOutcome; readonly expected: OperatorDecisionState}[] = [
    {outcome: 'ok', expected: 'claimed'},
    {outcome: 'channel-mismatch', expected: 'scope_mismatch'},
    // CRITICAL: 'already-claimed' maps to 'already_claimed', NOT 'already_settled'.
    // The first POST is still in-flight; the entry has NOT settled yet.
    {outcome: 'already-claimed', expected: 'already_claimed'},
    {outcome: 'reply-failed', expected: 'failed_to_settle'},
    {outcome: 'not-found', expected: 'unavailable'},
  ]

  for (const {outcome, expected} of cases) {
    it(`maps '${outcome}' → '${expected}'`, () => {
      // #given — a DecisionOutcome from the registry
      // #when — mapped to the operator-facing state
      const result = toOperatorDecisionState(outcome)

      // #then — the operator state matches the documented mapping
      expect(result).toBe(expected)
    })
  }

  it("explicitly asserts 'already-claimed' → 'already_claimed' (NOT 'already_settled')", () => {
    // #given — the 'already-claimed' outcome (first POST still in-flight, not settled)
    // #when — mapped
    const result = toOperatorDecisionState('already-claimed')

    // #then — must be 'already_claimed', never 'already_settled'
    expect(result).toBe('already_claimed')
    expect(result).not.toBe('already_settled')
  })

  it("'pending' is NOT produced by the mapping function (it is the pre-decision state)", () => {
    // #given — all 5 DecisionOutcome variants
    // #when — each is mapped
    const results = cases.map(({outcome}) => toOperatorDecisionState(outcome))

    // #then — none of the mapped states is 'pending' (pending has no DecisionOutcome)
    for (const result of results) {
      expect(result).not.toBe('pending')
    }
  })

  it('handles all 5 known DecisionOutcome variants (exhaustiveness coverage)', () => {
    // #given — the complete set of DecisionOutcome variants
    const allOutcomes: readonly DecisionOutcome[] = [
      'ok',
      'channel-mismatch',
      'already-claimed',
      'reply-failed',
      'not-found',
    ]

    // #when — each is mapped
    // #then — no variant throws (the never guard only fires on unknown variants)
    for (const outcome of allOutcomes) {
      expect(() => toOperatorDecisionState(outcome)).not.toThrow()
    }

    // Non-vacuousness: all 5 variants are covered
    expect(allOutcomes).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// 3. DecisionInput — structural shape (R7 load-bearing)
// ---------------------------------------------------------------------------

describe('DecisionInput', () => {
  it('requires an actor field (not a free-form decidedBy string)', () => {
    // #given — a valid DecisionInput with a typed actor
    const input: DecisionInput = {
      requestID: 'req-123',
      approvalScopeId: 'scope-abc',
      decision: 'once',
      actor: {kind: 'discord-user', userId: 'u-456'},
    }

    // #when / #then — the shape is structurally valid
    expect(input.requestID).toBe('req-123')
    expect(input.approvalScopeId).toBe('scope-abc')
    expect(input.decision).toBe('once')
    expect(input.actor).toEqual({kind: 'discord-user', userId: 'u-456'})
  })
})

// ---------------------------------------------------------------------------
// 4. Security (R7): structural scan — no `decidedBy: string` in approval source
// ---------------------------------------------------------------------------

describe('R7 structural boundary: no decidedBy:string in approval-decision source', () => {
  const thisDir = path.dirname(fileURLToPath(import.meta.url))
  // This file lives at packages/gateway/src/operator-contract/ — go up 1 to reach src/
  const gatewaySrcRoot = path.resolve(thisDir, '..')

  /**
   * Files to scan for the `decidedBy: string` anti-pattern.
   * Covers the approval internals and the contract module itself.
   */
  const SCAN_TARGETS: readonly string[] = [
    'approvals/coordinator.ts',
    'approvals/registry.ts',
    'approvals/discord-transport.ts',
    'operator-contract/approval.ts',
  ]

  /**
   * Pattern that would indicate a free-form string actor bypassing the
   * ApprovalActor discriminated union (the R7 anti-pattern).
   *
   * Matches `decidedBy` (with optional `?` for optional params) followed by
   * optional whitespace, a colon, optional whitespace, and `string` — i.e. a
   * parameter or property typed as `string` (required or optional).
   */
  const DECIDED_BY_PATTERN = /decidedBy\??\s*:\s*string/

  it('no approval-decision source file contains a decidedBy: string parameter', () => {
    // #given — the approval-decision source files
    const violations: {file: string; line: number; text: string}[] = []

    for (const relPath of SCAN_TARGETS) {
      const absPath = path.join(gatewaySrcRoot, relPath)

      // Existence guard: fail loudly if a scanned file has been renamed or deleted
      // so a rename cannot silently drop coverage.
      // Read directly and surface a missing/renamed target from the read error
      // itself — a single read avoids a check-then-read race.
      let content: string
      try {
        content = readFileSync(absPath, 'utf8')
      } catch {
        throw new Error(
          `R7 scan target no longer exists or is unreadable: ${relPath}\n` +
            `Update SCAN_TARGETS in approval.test.ts to reflect the rename.`,
        )
      }
      const lines = content.split('\n')

      for (const [i, line] of lines.entries()) {
        const trimmed = line.trimStart()
        // Skip line comments and JSDoc/block comment lines
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue

        if (DECIDED_BY_PATTERN.test(line)) {
          violations.push({file: relPath, line: i + 1, text: line.trim()})
        }
      }
    }

    // #when / #then — zero violations; any match means a free-form string actor
    // has bypassed the ApprovalActor discriminated union (R7 violation)
    if (violations.length > 0) {
      const report = violations.map(v => `  ${v.file}:${v.line}: ${v.text}`).join('\n')
      throw new Error(
        `R7 violation: 'decidedBy: string' found in approval-decision source.\n` +
          `Use 'actor: ApprovalActor' (discriminated union) instead — see DecisionInput.\n\n` +
          `Violations:\n${report}`,
      )
    }

    expect(violations).toHaveLength(0)
  })

  it('self-test: scanner WOULD flag a decidedBy: string parameter (required)', () => {
    // #given — a fixture string containing the anti-pattern (required param)
    const fixtureContent = [
      '// some-handler.ts',
      'async function handleApproval(requestID: string, decidedBy: string, decision: string) {',
      '  // ...',
      '}',
    ].join('\n')

    // #when — scan the fixture
    const violations: {line: number; text: string}[] = []
    for (const [i, line] of fixtureContent.split('\n').entries()) {
      if (line.trimStart().startsWith('//')) continue
      if (DECIDED_BY_PATTERN.test(line)) {
        violations.push({line: i + 1, text: line.trim()})
      }
    }

    // #then — the scanner must flag the anti-pattern
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]?.text).toContain('decidedBy: string')
  })

  it('self-test: scanner WOULD flag a decidedBy?: string optional parameter', () => {
    // #given — a fixture string containing the anti-pattern (optional param variant)
    const fixtureContent = [
      '// some-handler.ts',
      'interface ApprovalOpts { requestID: string; decidedBy?: string }',
    ].join('\n')

    // #when — scan the fixture
    const violations: {line: number; text: string}[] = []
    for (const [i, line] of fixtureContent.split('\n').entries()) {
      if (line.trimStart().startsWith('//')) continue
      if (DECIDED_BY_PATTERN.test(line)) {
        violations.push({line: i + 1, text: line.trim()})
      }
    }

    // #then — the scanner must flag the optional variant too
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]?.text).toContain('decidedBy?: string')
  })

  it('self-test: scanner does NOT flag a line comment or JSDoc comment containing decidedBy: string', () => {
    // #given — a fixture where the pattern only appears in comments
    const fixtureContent = [
      '// Previously: decidedBy: string — replaced with actor: ApprovalActor',
      '/**',
      ' * Use actor: ApprovalActor instead of decidedBy: string.',
      ' */',
      'async function handleApproval(requestID: string, actor: ApprovalActor) {',
      '  // ...',
      '}',
    ].join('\n')

    // #when — scan the fixture
    const violations: {line: number; text: string}[] = []
    for (const [i, line] of fixtureContent.split('\n').entries()) {
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      if (DECIDED_BY_PATTERN.test(line)) {
        violations.push({line: i + 1, text: line.trim()})
      }
    }

    // #then — comment lines are skipped; no violation
    expect(violations).toHaveLength(0)
  })
})
