import {describe, expect, it} from 'vitest'
import {
  buildAssetUrl,
  convertHarnessTag,
  evaluateHeadStatus,
  parseHarnessTag,
  parseReleaseDetails,
  shouldSkipDuplicate,
} from './duplicate-harness-release-tags.js'

describe('convertHarnessTag', () => {
  it('converts a legacy harness tag to a prerelease tag', () => {
    // #given / #when / #then
    expect(convertHarnessTag('1.18.21+harness.abc12345')).toBe('1.18.21-harness.abc12345')
  })

  it.each(['1.18.21', 'v1.18.21+harness.abc12345', '1.18.21+other.abc12345', 'not-a-version'])(
    'rejects a non-harness tag: %s',
    tag => {
      // #given / #when / #then
      expect(convertHarnessTag(tag)).toBeNull()
    },
  )
})

describe('parseHarnessTag', () => {
  it('returns both source and target identities for a legacy tag', () => {
    // #given / #when
    const result = parseHarnessTag('1.18.21+harness.abc12345')

    // #then
    expect(result).toEqual({
      baseVersion: '1.18.21',
      shortSha: 'abc12345',
      sourceTag: '1.18.21+harness.abc12345',
      targetTag: '1.18.21-harness.abc12345',
    })
  })
})

describe('parseReleaseDetails', () => {
  it.each(['nested/asset.tar.gz', '..'])('rejects unsafe asset path: %s', assetName => {
    // #given
    const release = JSON.stringify({
      tagName: '1.18.21+harness.abc12345',
      targetCommitish: 'abc12345',
      isPrerelease: false,
      assets: [{name: assetName}],
    })

    // #when / #then
    expect(() => parseReleaseDetails(release)).toThrow(/unsafe path/)
  })
})

describe('buildAssetUrl', () => {
  it('percent-encodes the plus in a legacy tag URL', () => {
    // #given / #when / #then
    expect(buildAssetUrl('fro-bot/agent', '1.18.21+harness.abc12345', 'SHA256SUMS')).toBe(
      'https://github.com/fro-bot/agent/releases/download/1.18.21%2Bharness.abc12345/SHA256SUMS',
    )
  })

  it('leaves the hyphen harness tag unencoded in its URL', () => {
    // #given / #when / #then
    expect(buildAssetUrl('fro-bot/agent', '1.18.21-harness.abc12345', 'opencode-linux-x64')).toBe(
      'https://github.com/fro-bot/agent/releases/download/1.18.21-harness.abc12345/opencode-linux-x64',
    )
  })
})

describe('shouldSkipDuplicate', () => {
  it('skips creation when the target release already exists', () => {
    // #given / #when / #then
    expect(
      shouldSkipDuplicate(['1.18.21+harness.abc12345', '1.18.21-harness.abc12345'], '1.18.21-harness.abc12345'),
    ).toBe(true)
  })

  it('requests creation when the target release does not exist', () => {
    // #given / #when / #then
    expect(shouldSkipDuplicate(['1.18.21+harness.abc12345'], '1.18.21-harness.abc12345')).toBe(false)
  })
})

describe('evaluateHeadStatus', () => {
  it('accepts only HTTP 200', () => {
    // #given / #when / #then
    expect(evaluateHeadStatus(200)).toEqual({ok: true, status: 200})
    expect(evaluateHeadStatus(201).ok).toBe(false)
  })

  it('fails closed on a non-200 HEAD response', () => {
    // #given / #when / #then
    expect(evaluateHeadStatus(404)).toEqual({ok: false, status: 404})
  })
})
