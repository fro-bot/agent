import {describe, expect, it} from 'vitest'
import {isValidProvenance} from './provenance.js'

/**
 * Regression tests for the isValidProvenance writer↔validator contract.
 *
 * The published-provenance bug: the workflow writer produced a manifest with
 * `integrationRefs: []` (empty carry set) but an earlier version of the manifest
 * was missing the `integrationRefs` key entirely. isValidProvenance requires
 * Array.isArray(v.integrationRefs), so a missing key caused it to return false,
 * triggering the dev/scaffold fallback at runtime.
 *
 * These tests pin the exact shapes the workflow writer produces and the exact
 * shapes that must be rejected, so any future regression is caught immediately.
 */

describe('isValidProvenance', () => {
  // ── ACCEPT cases ──────────────────────────────────────────────────────────

  it('accepts the empty-carry published shape (1.16.0 with no integration refs)', () => {
    // #given — the exact shape the workflow writer produces for an empty carry set
    const manifest = {
      baseVersion: '1.16.0',
      integrationRefs: [],
      integrationCommit: 'abc1234def5678abc1234def5678abc1234def56',
      buildSha: 'def5678abc1234def5678abc1234def5678abc12',
    }

    // #when
    const result = isValidProvenance(manifest)

    // #then — must be accepted; this is the regression guard for the empty-carry case
    expect(result).toBe(true)
  })

  it('accepts a non-empty-carry shape with populated integrationRefs', () => {
    // #given — a manifest with one integration ref (the normal carry case)
    const manifest = {
      baseVersion: '1.16.0',
      integrationRefs: [
        {
          ref: 'pull/30182/head',
          resolvedSha: 'abc1234def5678abc1234def5678abc1234def56',
        },
      ],
      integrationCommit: 'abc1234def5678abc1234def5678abc1234def56',
      buildSha: 'def5678abc1234def5678abc1234def5678abc12',
    }

    // #when
    const result = isValidProvenance(manifest)

    // #then
    expect(result).toBe(true)
  })

  it('accepts a manifest with integrationCommit: null (dev scaffold shape)', () => {
    // #given — integrationCommit is nullable per the Provenance interface
    const manifest = {
      baseVersion: '1.16.0',
      integrationRefs: [],
      integrationCommit: null,
      buildSha: 'dev',
    }

    // #when
    const result = isValidProvenance(manifest)

    // #then
    expect(result).toBe(true)
  })

  // ── REJECT cases ──────────────────────────────────────────────────────────

  it('rejects a manifest MISSING integrationRefs (the published-provenance-fallback regression)', () => {
    // #given — the EXACT shape that triggered the published-provenance bug:
    // the manifest was written without the integrationRefs key, causing
    // isValidProvenance to return false and getProvenance to fall back to
    // the dev scaffold at runtime even in production.
    // REGRESSION GUARD: this must stay false forever.
    const manifestMissingIntegrationRefs = {
      baseVersion: '1.16.0',
      integrationCommit: 'abc',
      buildSha: 'def',
      // integrationRefs intentionally absent
    }

    // #when
    const result = isValidProvenance(manifestMissingIntegrationRefs)

    // #then — must be rejected; missing integrationRefs is invalid
    expect(result).toBe(false)
  })

  it('rejects integrationRefs that is a string (not an array)', () => {
    // #given — malformed config where integrationRefs is a string
    const manifest = {
      baseVersion: '1.16.0',
      integrationRefs: 'pull/30182/head',
      integrationCommit: 'abc1234',
      buildSha: 'def5678',
    }

    // #when
    const result = isValidProvenance(manifest)

    // #then
    expect(result).toBe(false)
  })

  it('rejects integrationRefs that is a plain object (not an array)', () => {
    // #given — malformed config where integrationRefs is an object
    const manifest = {
      baseVersion: '1.16.0',
      integrationRefs: {ref: 'pull/30182/head'},
      integrationCommit: 'abc1234',
      buildSha: 'def5678',
    }

    // #when
    const result = isValidProvenance(manifest)

    // #then
    expect(result).toBe(false)
  })

  it('rejects a manifest with an empty baseVersion', () => {
    // #given
    const manifest = {
      baseVersion: '',
      integrationRefs: [],
      integrationCommit: null,
      buildSha: 'dev',
    }

    // #when
    const result = isValidProvenance(manifest)

    // #then
    expect(result).toBe(false)
  })

  it('rejects null', () => {
    // #given / #when / #then
    expect(isValidProvenance(null)).toBe(false)
  })

  it('rejects a non-object primitive', () => {
    // #given / #when / #then
    expect(isValidProvenance('not-an-object')).toBe(false)
    expect(isValidProvenance(42)).toBe(false)
  })
})
