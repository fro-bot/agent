/**
 * Tests for the boundApprovalDetail helper.
 *
 * TDD: these tests were written before the implementation.
 * Convention: pure function — no mocks needed.
 */

import {describe, expect, it} from 'vitest'

import {APPROVAL_DETAIL_MAX_LENGTH, boundApprovalDetail} from './approval-detail.js'

// ---------------------------------------------------------------------------
// boundApprovalDetail
// ---------------------------------------------------------------------------

describe('boundApprovalDetail', () => {
  // ── undefined / empty ────────────────────────────────────────────────────

  it('returns undefined for undefined input', () => {
    // #given no value
    // #when
    const result = boundApprovalDetail(undefined)
    // #then
    expect(result).toBeUndefined()
  })

  it('returns undefined for null input (cast)', () => {
    // #given null coerced to the union
    const result = boundApprovalDetail(null as unknown as undefined)
    expect(result).toBeUndefined()
  })

  it('returns empty string for empty string input', () => {
    // #given an empty string (valid, just nothing to show)
    const result = boundApprovalDetail('')
    // #then returns empty string (not undefined — caller can decide to omit)
    expect(result).toBe('')
  })

  // ── happy path ───────────────────────────────────────────────────────────

  it('passes through a normal short command unchanged', () => {
    // #given a typical bash command
    const result = boundApprovalDetail('ls -la /tmp')
    // #then returned as-is
    expect(result).toBe('ls -la /tmp')
  })

  it('passes through a normal filepath unchanged', () => {
    const result = boundApprovalDetail('/workspace/src/index.ts')
    expect(result).toBe('/workspace/src/index.ts')
  })

  // ── length cap ───────────────────────────────────────────────────────────

  it('truncates a value longer than APPROVAL_DETAIL_MAX_LENGTH', () => {
    // #given a string longer than the cap
    const oversized = 'x'.repeat(APPROVAL_DETAIL_MAX_LENGTH + 100)
    // #when
    const result = boundApprovalDetail(oversized)
    // #then truncated to exactly the cap
    expect(result).not.toBeUndefined()
    expect(result!.length).toBeLessThanOrEqual(APPROVAL_DETAIL_MAX_LENGTH)
  })

  it('does not truncate a value exactly at the cap', () => {
    // #given a string exactly at the cap
    const atCap = 'a'.repeat(APPROVAL_DETAIL_MAX_LENGTH)
    const result = boundApprovalDetail(atCap)
    expect(result!.length).toBe(APPROVAL_DETAIL_MAX_LENGTH)
  })

  it('does not truncate a value one under the cap', () => {
    const underCap = 'b'.repeat(APPROVAL_DETAIL_MAX_LENGTH - 1)
    const result = boundApprovalDetail(underCap)
    expect(result!.length).toBe(APPROVAL_DETAIL_MAX_LENGTH - 1)
  })

  // ── control character stripping ──────────────────────────────────────────

  it(String.raw`strips ASCII control characters (\x00–\x1F except \t)`, () => {
    // #given a command with embedded NUL, BEL, ESC, etc.
    const withControls = 'rm\u0000 -rf\u0007 /tmp\u001B[31m'
    const result = boundApprovalDetail(withControls)
    // #then control chars are removed
    expect(result).not.toContain('\u0000')
    expect(result).not.toContain('\u0007')
    expect(result).not.toContain('\u001B')
    // #and the printable content survives
    expect(result).toContain('rm')
    expect(result).toContain('-rf')
    expect(result).toContain('/tmp')
  })

  it(String.raw`strips DEL character (\x7F)`, () => {
    const result = boundApprovalDetail('hello\u007Fworld')
    expect(result).not.toContain('\u007F')
    expect(result).toContain('hello')
    expect(result).toContain('world')
  })

  it(String.raw`strips carriage return (\r)`, () => {
    const result = boundApprovalDetail('line1\r\nline2')
    expect(result).not.toContain('\r')
  })

  it(String.raw`strips newline (\n)`, () => {
    // #given a multi-line command (hostile injection attempt)
    const result = boundApprovalDetail('cmd1\ncmd2')
    expect(result).not.toContain('\n')
  })

  it(String.raw`strips tab (\t)`, () => {
    // Tabs are control chars; strip them for SSE-frame safety
    const result = boundApprovalDetail('col1\tcol2')
    expect(result).not.toContain('\t')
  })

  // ── JSON safety ──────────────────────────────────────────────────────────

  it('result is JSON-serializable without throwing', () => {
    // #given a value with quotes and backslashes
    const tricky = String.raw`echo "hello \"world\"" && cat /etc/passwd`
    const result = boundApprovalDetail(tricky)
    // #then JSON.stringify does not throw and round-trips cleanly
    expect(() => JSON.stringify({v: result})).not.toThrow()
    const parsed = JSON.parse(JSON.stringify({v: result})) as {v: string}
    expect(parsed.v).toBe(result)
  })

  it('result is JSON-serializable for a value with backslashes', () => {
    const withBackslash = String.raw`cat C:\Users\foo\secret.txt`
    const result = boundApprovalDetail(withBackslash)
    expect(() => JSON.stringify({v: result})).not.toThrow()
  })

  // ── prototype pollution guard ─────────────────────────────────────────────

  it('handles a string value that looks like a prototype-polluted key', () => {
    // The helper receives a plain string — no object access — so this is
    // just a sanity check that the string content doesn't cause issues.
    const result = boundApprovalDetail('__proto__')
    expect(result).toBe('__proto__')
  })

  // ── combined edge cases ───────────────────────────────────────────────────

  it('truncates AND strips control chars from an oversized hostile value', () => {
    // #given a very long string with embedded control chars
    const hostile = `\u001B[31m${'A'.repeat(APPROVAL_DETAIL_MAX_LENGTH)}`.repeat(2)
    const result = boundApprovalDetail(hostile)
    expect(result).not.toBeUndefined()
    expect(result!.length).toBeLessThanOrEqual(APPROVAL_DETAIL_MAX_LENGTH)
    expect(result).not.toContain('\u001B')
  })
})
