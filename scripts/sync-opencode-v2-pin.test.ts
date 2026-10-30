import type {SyncIo} from './sync-opencode-v2-pin.ts'

import {readFileSync} from 'node:fs'

import {describe, expect, it, vi} from 'vitest'
import {EXIT_USAGE, main, parseArgs, parsePin, parseSha256Sums, syncPinDigests} from './sync-opencode-v2-pin.ts'

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

const X64 = 'opencode-linux-x64-musl.tar.gz'
const ARM = 'opencode-linux-arm64-musl.tar.gz'

function pinText(version: string, x64: string, arm: string): string {
  return `${JSON.stringify({version, assets: {[X64]: x64, [ARM]: arm}}, null, 2)}\n`
}

interface Harness {
  readonly io: SyncIo
  readonly fetchMock: ReturnType<typeof vi.fn>
  readonly writes: string[]
  readonly out: string[]
  readonly err: string[]
}

/** CLI harness: the pin file starts as `file`, and `sums` (or a thrown error) is what every fetch returns. */
function harness(file: string, sums: string | Error | {readonly status: number}): Harness {
  const writes: string[] = []
  const out: string[] = []
  const err: string[] = []
  const fetchMock = vi.fn(async () => {
    if (sums instanceof Error) throw sums
    if (typeof sums !== 'string') return {ok: false, status: sums.status, text: async () => ''}
    return {ok: true, status: 200, text: async () => sums}
  })
  const io: SyncIo = {
    fetch: fetchMock,
    readPin: () => file,
    writePin: contents => writes.push(contents),
    stdout: text => out.push(text),
    stderr: text => err.push(text),
  }
  return {io, fetchMock, writes, out, err}
}

const upstreamSums = `${NEW_X64}  ${X64}\n${NEW_ARM}  ${ARM}\n`

describe('parseArgs', () => {
  it.each([
    [[], {kind: 'sync', version: undefined}],
    [['2.3.0'], {kind: 'sync', version: '2.3.0'}],
    [['--check'], {kind: 'check'}],
  ])('accepts %j', (argv, expected) => {
    // #given an accepted command line / #when / #then
    expect(parseArgs(argv)).toEqual(expected)
  })

  it.each([
    [['--help'], 'unsupported option'],
    [['-h'], 'unsupported option'],
    [['--check=true'], 'unsupported option'],
    [['--chec'], 'unsupported option'],
    [['--check', '--force'], 'unsupported option'],
    [['2.3.0', '2.4.0'], 'extra argument'],
    [['^2.3.0'], 'x.y.z'],
    [['--check', '2.3.0'], '--check'],
  ])('rejects %j', (argv, reason) => {
    // #given a command line the script does not support / #when / #then
    const parsed = parseArgs(argv)
    expect(parsed.kind).toBe('invalid')
    expect(parsed.kind === 'invalid' ? parsed.reason : '').toContain(reason)
  })
})

describe('main', () => {
  it.each([['--help'], ['--check=true'], ['--force'], ['2.3.0', '2.4.0'], ['--check', '2.3.0'], ['v2.3.0']])(
    'rejects %j with exit 2 before any fetch or write',
    async (...argv) => {
      // #given a pin whose digests differ from upstream, so an accidental sync would write
      const h = harness(pinText('2.2.0', OLD, OLD), upstreamSums)

      // #when the CLI is run with a command line it does not support
      const code = await main(argv, h.io)

      // #then it exits 2 with a usage line and touched nothing
      expect(code).toBe(EXIT_USAGE)
      expect(h.err.join('')).toContain('usage: bun scripts/sync-opencode-v2-pin.ts')
      expect(h.fetchMock).not.toHaveBeenCalled()
      expect(h.writes).toEqual([])
    },
  )

  it('--check with matching digests exits 0 and writes nothing', async () => {
    // #given a pin that already matches upstream
    const h = harness(pinText('2.2.0', NEW_X64, NEW_ARM), upstreamSums)

    // #when / #then
    expect(await main(['--check'], h.io)).toBe(0)
    expect(h.writes).toEqual([])
    expect(h.fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2.2.0/SHA256SUMS'), expect.anything())
  })

  it('--check with stale digests exits 1 and writes nothing', async () => {
    // #given a pin that disagrees with upstream
    const h = harness(pinText('2.2.0', OLD, OLD), upstreamSums)

    // #when / #then the file is left exactly as it was (nothing is written at all)
    expect(await main(['--check'], h.io)).toBe(1)
    expect(h.writes).toEqual([])
    expect(h.err.join('')).toContain('disagrees')
  })

  it('writes the new digests for the pinned version when run with no argument', async () => {
    // #given a bumped pin with stale digests
    const h = harness(pinText('2.3.0', OLD, OLD), upstreamSums)

    // #when / #then
    expect(await main([], h.io)).toBe(0)
    expect(h.writes).toEqual([pinText('2.3.0', NEW_X64, NEW_ARM)])
  })

  it('an explicit version updates the file to that version with the new digests', async () => {
    // #given a pin at 2.2.0
    const h = harness(pinText('2.2.0', OLD, OLD), upstreamSums)

    // #when run with an explicit version
    expect(await main(['2.3.0'], h.io)).toBe(0)

    // #then the digests come from that version's SHA256SUMS and the version is rewritten
    expect(h.fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2.3.0/SHA256SUMS'), expect.anything())
    expect(h.writes).toEqual([pinText('2.3.0', NEW_X64, NEW_ARM)])
  })

  it('writes nothing when the pin is already current', async () => {
    // #given a pin that matches upstream
    const h = harness(pinText('2.2.0', NEW_X64, NEW_ARM), upstreamSums)

    // #when / #then
    expect(await main([], h.io)).toBe(0)
    expect(h.writes).toEqual([])
  })

  it.each([
    ['a network error', new Error('connect ECONNREFUSED')],
    ['an HTTP error', {status: 404}],
    ['a release missing a listed asset', `${NEW_X64}  ${X64}\n`],
  ])('%s: exits 1 and writes nothing', async (_label, failure) => {
    // #given an upstream that cannot supply the digests
    const h = harness(pinText('2.3.0', OLD, OLD), failure)

    // #when / #then the stale digests are kept, not blanked or partially replaced
    expect(await main([], h.io)).toBe(1)
    expect(h.writes).toEqual([])
    expect(h.err.join('')).toContain('sync-opencode-v2-pin:')
  })
})
