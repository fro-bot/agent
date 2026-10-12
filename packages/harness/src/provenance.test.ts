import type {Provenance} from './provenance.js'
import {describe, expect, it} from 'vitest'
import {
  formatPatches,
  formatProvenance,
  formatVersionLine,
  integrationCommitUrl,
  isValidProvenance,
} from './provenance.js'

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

const FIXTURE_SHA = '6546eb64d0fcda66ed3cd91a827bc9bb102fb7a2'
const FIXTURE_URL = `https://github.com/fro-bot/agent/commit/${FIXTURE_SHA}`

const builtProvenance: Provenance = {
  baseVersion: '1.18.34',
  integrationRefs: [{ref: 'https://github.com/anomalyco/opencode/pull/30182', resolvedSha: 'deadbeef', reason: 'fix'}],
  integrationCommit: FIXTURE_SHA,
  buildSha: 'def5678',
}

const devProvenance: Provenance = {
  baseVersion: '1.18.34',
  integrationRefs: [{ref: 'https://github.com/anomalyco/opencode/pull/30182', resolvedSha: 'dev'}],
  integrationCommit: null,
  buildSha: 'dev',
}

describe('integrationCommitUrl', () => {
  it('builds the fro-bot/agent commit page URL', () => {
    // #given / #when
    const url = integrationCommitUrl(FIXTURE_SHA)

    // #then
    expect(url).toBe(FIXTURE_URL)
  })
})

describe('formatProvenance integration commit row', () => {
  it('shows the full commit URL when an integration commit is set', () => {
    // #given / #when
    const output = formatProvenance(builtProvenance)

    // #then
    expect(output).toContain(`  integration commit: ${FIXTURE_URL}`)
    expect(output).not.toContain('(unbuilt/dev scaffold)')
  })

  it('keeps the scaffold text when there is no integration commit', () => {
    // #given / #when
    const output = formatProvenance(devProvenance)

    // #then
    expect(output).toContain('  integration commit: (unbuilt/dev scaffold)')
    expect(output).not.toContain('github.com/fro-bot/agent/commit')
  })
})

describe('formatVersionLine', () => {
  it('appends the full integration SHA after build', () => {
    // #given / #when
    const line = formatVersionLine(builtProvenance)

    // #then
    expect(line).toBe(`@fro.bot/harness base:1.18.34 build:def5678 integration:${FIXTURE_SHA}`)
  })

  it('prints integration:dev when there is no integration commit', () => {
    // #given / #when
    const line = formatVersionLine(devProvenance)

    // #then
    expect(line).toBe('@fro.bot/harness base:1.18.34 build:dev integration:dev')
  })
})

describe('formatPatches', () => {
  it('shows the frozen integration commit as a URL', () => {
    // #given / #when
    const output = formatPatches(builtProvenance)

    // #then
    expect(output).toContain('Integration refs:')
    expect(output).toContain('    reason: fix')
    expect(output).toContain(`\nFrozen integration commit: ${FIXTURE_URL}`)
  })

  it('omits the frozen commit line when there is no integration commit', () => {
    // #given / #when
    const output = formatPatches(devProvenance)

    // #then
    expect(output).toContain('Integration refs:')
    expect(output).not.toContain('Frozen integration commit')
  })

  it('reports a dev scaffold when no refs are configured', () => {
    // #given / #when
    const output = formatPatches({...devProvenance, integrationRefs: []})

    // #then
    expect(output).toBe('No integration refs configured (dev scaffold).')
  })
})
