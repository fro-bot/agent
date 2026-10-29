import {readFileSync} from 'node:fs'

import {describe, expect, it} from 'vitest'

import {parsePin, parseSha256Sums, syncPinDigests} from './sync-opencode-v2-pin.ts'

const OLD = 'a'.repeat(64)
const NEW_X64 = 'b'.repeat(64)
const NEW_ARM = 'c'.repeat(64)

describe('parseSha256Sums', () => {
  it('reads two-space, binary-marker and ./-prefixed lines and lower-cases the digest', () => {
    // #given SHA256SUMS lines in the formats sha256sum and other tools emit
    const text = [
      `${NEW_X64}  opencode-linux-x64-musl.tar.gz`,
      `${NEW_ARM.toUpperCase()} *opencode-linux-arm64-musl.tar.gz`,
      `${OLD}  ./opencode-darwin-arm64.zip`,
      'not a checksum line',
      '',
    ].join('\n')

    // #when parsed
    const sums = parseSha256Sums(text)

    // #then every well-formed line is keyed by bare filename
    expect(Object.fromEntries(sums)).toEqual({
      'opencode-linux-x64-musl.tar.gz': NEW_X64,
      'opencode-linux-arm64-musl.tar.gz': NEW_ARM,
      'opencode-darwin-arm64.zip': OLD,
    })
  })
})

describe('syncPinDigests', () => {
  const pin = {
    version: '2.3.0',
    assets: {'opencode-linux-x64-musl.tar.gz': OLD, 'opencode-linux-arm64-musl.tar.gz': OLD},
  }

  it('replaces each listed digest and ignores assets the pin does not list', () => {
    // #given a bumped pin with stale digests and a release that also ships unlisted assets
    const sums = new Map([
      ['opencode-linux-x64-musl.tar.gz', NEW_X64],
      ['opencode-linux-arm64-musl.tar.gz', NEW_ARM],
      ['opencode-windows-x64.zip', OLD],
    ])

    // #when synced
    const synced = syncPinDigests(pin, sums)

    // #then the version is untouched, the listed digests are new, and no asset was added
    expect(synced).toEqual({
      version: '2.3.0',
      assets: {'opencode-linux-x64-musl.tar.gz': NEW_X64, 'opencode-linux-arm64-musl.tar.gz': NEW_ARM},
    })
  })

  it('throws when the release has no entry for a listed asset', () => {
    // #given a release missing one asset the pin lists
    const sums = new Map([['opencode-linux-x64-musl.tar.gz', NEW_X64]])

    // #when / #then syncing fails rather than keeping the stale digest
    expect(() => syncPinDigests(pin, sums)).toThrow('opencode-linux-arm64-musl.tar.gz')
  })
})

describe('parsePin', () => {
  it('accepts the committed pin file', () => {
    // #given the real pin file
    const raw: unknown = JSON.parse(
      readFileSync(new URL('../packages/runtime/src/shared/opencode-v2-pin.json', import.meta.url), 'utf8'),
    )

    // #when / #then it parses with a V2 version
    expect(parsePin(raw).version).toMatch(/^2\.\d+\.\d+$/)
  })

  it.each([
    ['a non-exact version', {version: '^2.2.0', assets: {a: OLD}}],
    ['no assets', {version: '2.2.0', assets: {}}],
    ['a short digest', {version: '2.2.0', assets: {a: 'abc'}}],
    ['a non-object', 'nope'],
  ])('rejects %s', (_label, value) => {
    // #given a malformed pin / #when / #then
    expect(() => parsePin(value)).toThrow('opencode-v2-pin.json')
  })
})
