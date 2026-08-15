import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

interface HarnessConfig {
  readonly release_repo: string
  readonly base_version: string
  readonly integrationRefs: readonly string[]
}

interface CarryEntry {
  readonly identity: string
  readonly evidence: string
  readonly removalCondition: string
}

interface ParsedLedger {
  readonly verifiedAgainstBaseVersion: string
  readonly entries: readonly CarryEntry[]
}

const config = JSON.parse(readFileSync(new URL('../harness.config.json', import.meta.url), 'utf8')) as HarnessConfig
const ledger = readFileSync(new URL('../../../docs/reference/carry-ledger.md', import.meta.url), 'utf8')

function canonicalPullRequestIdentity(value: string, releaseRepo: string): string {
  let url: URL

  try {
    url = new URL(value)
  } catch {
    throw new Error(`Malformed pull request identity "${value}"`)
  }

  const segments = url.pathname.split('/').filter(segment => segment.length > 0)
  const repo = `${segments[0] ?? ''}/${segments[1] ?? ''}`
  const number = segments[3] ?? ''

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    segments.length !== 4 ||
    segments[2] !== 'pull' ||
    repo !== releaseRepo ||
    !/^[1-9]\d*$/.test(number)
  ) {
    throw new Error(`Malformed pull request identity "${value}"`)
  }

  return `${repo}#${Number(number)}`
}

function canonicalManifestIdentity(source: string, releaseRepo: string): string {
  return canonicalPullRequestIdentity(source, releaseRepo)
}

function canonicalLedgerIdentity(value: string, releaseRepo: string): string {
  if (/^#[1-9]\d*$/.test(value)) {
    return `${releaseRepo}#${Number(value.slice(1))}`
  }

  return canonicalPullRequestIdentity(value, releaseRepo)
}

function parseLedger(text: string, releaseRepo: string): ParsedLedger {
  const frontMatterEnd = text.indexOf('\n---\n', 4)
  const frontMatter = text.startsWith('---\n') && frontMatterEnd !== -1 ? text.slice(4, frontMatterEnd) : undefined
  const versionLine = frontMatter?.split('\n').find(line => line.startsWith('verifiedAgainstBaseVersion:'))
  const versionValue = versionLine?.slice('verifiedAgainstBaseVersion:'.length).trim()
  const verifiedAgainstBaseVersion = (() => {
    if (versionValue === undefined || versionValue.length < 2) {
      return undefined
    }

    const quote = versionValue[0]
    if ((quote !== '"' && quote !== "'") || !versionValue.endsWith(quote)) {
      return undefined
    }

    return versionValue.slice(1, -1)
  })()

  if (verifiedAgainstBaseVersion === undefined || verifiedAgainstBaseVersion.trim().length === 0) {
    throw new Error('Carry ledger is missing verifiedAgainstBaseVersion metadata')
  }

  const carriesStart = text.indexOf('\n## Carries\n')
  const scopeStart = text.indexOf('\n## Scope and authority\n')

  if (carriesStart === -1 || scopeStart <= carriesStart) {
    throw new Error('Carry ledger is missing its Carries or Scope and authority sections')
  }

  const carries = text.slice(carriesStart, scopeStart)
  const headings: {readonly text: string; readonly index: number}[] = []
  let offset = 0

  for (const line of carries.split('\n')) {
    if (line.startsWith('### ')) {
      headings.push({text: line.slice(4).trim(), index: offset})
    }

    offset += line.length + 1
  }

  if (headings.length === 0) {
    throw new Error('Carry ledger contains no carry entries')
  }

  const entries = headings.map((heading, index) => {
    const separatorIndex = heading.text.indexOf(' — ')
    const identityText = (separatorIndex === -1 ? heading.text : heading.text.slice(0, separatorIndex)).trim()
    const identity = canonicalLedgerIdentity(identityText, releaseRepo)
    const start = heading.index
    const end = headings[index + 1]?.index ?? carries.length
    const entryText = carries.slice(start, end)
    const evidencePrefix = '- **Evidence it is still needed:**'
    const removalConditionPrefix = '- **Removal condition:**'
    const evidenceLine = entryText.split('\n').find(line => line.startsWith(evidencePrefix))
    const removalConditionLine = entryText.split('\n').find(line => line.startsWith(removalConditionPrefix))
    const evidence = evidenceLine?.slice(evidencePrefix.length).trim()
    const removalCondition = removalConditionLine?.slice(removalConditionPrefix.length).trim()

    if (evidence === undefined || evidence.length === 0) {
      throw new Error(`Carry ledger entry ${identity} has empty or missing evidence`)
    }

    if (removalCondition === undefined || removalCondition.length === 0) {
      throw new Error(`Carry ledger entry ${identity} has empty or missing removal condition`)
    }

    return {identity, evidence, removalCondition}
  })

  return {verifiedAgainstBaseVersion, entries}
}

function assertCarryLedgerIntegrity(manifest: HarnessConfig, text: string): void {
  const parsed = parseLedger(text, manifest.release_repo)

  if (parsed.verifiedAgainstBaseVersion !== manifest.base_version) {
    throw new Error(
      `Carry ledger base version ${parsed.verifiedAgainstBaseVersion} does not match manifest base version ${manifest.base_version}`,
    )
  }

  const manifestIdentities = manifest.integrationRefs.map(source =>
    canonicalManifestIdentity(source, manifest.release_repo),
  )
  const ledgerIdentities = parsed.entries.map(entry => entry.identity)
  const duplicateLedgerIdentities = ledgerIdentities.filter(
    (identity, index) => ledgerIdentities.indexOf(identity) !== index,
  )

  if (duplicateLedgerIdentities.length > 0) {
    throw new Error(`Carry ledger contains duplicate identity ${duplicateLedgerIdentities[0]}`)
  }

  const duplicateManifestIdentities = manifestIdentities.filter(
    (identity, index) => manifestIdentities.indexOf(identity) !== index,
  )

  if (duplicateManifestIdentities.length > 0) {
    throw new Error(`Manifest contains duplicate integration ref identity ${duplicateManifestIdentities[0]}`)
  }

  const ledgerSet = new Set(ledgerIdentities)
  const manifestSet = new Set(manifestIdentities)
  const missingLedgerEntries = manifestIdentities.filter(identity => !ledgerSet.has(identity))
  const undocumentedLedgerEntries = ledgerIdentities.filter(identity => !manifestSet.has(identity))

  if (missingLedgerEntries.length > 0 || undocumentedLedgerEntries.length > 0) {
    const mismatches = [
      ...missingLedgerEntries.map(identity => `manifest -> ledger missing ${identity}`),
      ...undocumentedLedgerEntries.map(identity => `ledger -> manifest undocumented ${identity}`),
    ]

    throw new Error(`Carry ledger referential integrity failed: ${mismatches.join('; ')}`)
  }
}

function withBaseVersion(text: string, baseVersion = config.base_version): string {
  return `---\nverifiedAgainstBaseVersion: "${baseVersion}"\n---\n\n${text}`
}

function insertBeforeScope(text: string, addition: string): string {
  const marker = '\n## Scope and authority\n'
  const markerIndex = text.indexOf(marker)

  if (markerIndex === -1) {
    throw new Error('Missing scope marker in test fixture')
  }

  return `${text.slice(0, markerIndex)}\n${addition.trim()}\n${text.slice(markerIndex)}`
}

function replaceFirstLineStartingWith(text: string, prefix: string, replacement: string): string {
  const lines = text.split('\n')
  const lineIndex = lines.findIndex(line => line.startsWith(prefix))

  if (lineIndex === -1) {
    throw new Error(`Missing test fixture line starting with ${prefix}`)
  }

  lines[lineIndex] = replacement
  return lines.join('\n')
}

function removeFirstLineStartingWith(text: string, prefix: string): string {
  const lines = text.split('\n')
  const lineIndex = lines.findIndex(line => line.startsWith(prefix))

  if (lineIndex === -1) {
    throw new Error(`Missing test fixture line starting with ${prefix}`)
  }

  lines.splice(lineIndex, 1)
  return lines.join('\n')
}

describe('carry ledger referential integrity', () => {
  it('accepts the current manifest and ledger with matching base metadata', () => {
    // #given / #when / #then
    expect(() => assertCarryLedgerIntegrity(config, ledger)).not.toThrow()
  })

  it('accepts a URL-form manifest ref and canonical ledger number regardless of order', () => {
    // #given
    const reversedManifest = {...config, integrationRefs: [...config.integrationRefs].reverse()}

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(reversedManifest, withBaseVersion(ledger))).not.toThrow()
  })

  it('accepts Unestablished in-repo. as non-empty evidence', () => {
    // #given
    const fixture = withBaseVersion(
      replaceFirstLineStartingWith(
        ledger,
        '- **Evidence it is still needed:**',
        '- **Evidence it is still needed:** Unestablished in-repo.',
      ),
    )

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(config, fixture)).not.toThrow()
  })

  it('rejects an empty evidence value', () => {
    // #given
    const fixture = withBaseVersion(
      replaceFirstLineStartingWith(ledger, '- **Evidence it is still needed:**', '- **Evidence it is still needed:**'),
    )

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(config, fixture)).toThrow(/#33444.*evidence/)
  })

  it('rejects an entry missing its removal condition', () => {
    // #given
    const fixture = withBaseVersion(removeFirstLineStartingWith(ledger, '- **Removal condition:**'))

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(config, fixture)).toThrow(/#33444.*removal condition/)
  })

  it('rejects an undocumented ledger entry in the ledger-to-manifest direction', () => {
    // #given
    const fixture = withBaseVersion(
      insertBeforeScope(
        ledger,
        `### #99999 — undocumented\n\n- **Evidence it is still needed:** fixture evidence\n- **Removal condition:** fixture removal`,
      ),
    )

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(config, fixture)).toThrow(
      /ledger -> manifest undocumented anomalyco\/opencode#99999/,
    )
  })

  it('rejects a manifest ref without a matching ledger entry in the manifest-to-ledger direction', () => {
    // #given
    const manifest = {
      ...config,
      integrationRefs: config.integrationRefs.map(source =>
        source.endsWith('/36361') ? source.replace('/36361', '/12345') : source,
      ),
    }

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(manifest, withBaseVersion(ledger))).toThrow(
      /manifest -> ledger missing anomalyco\/opencode#12345/,
    )
  })

  it('rejects duplicate ledger identities', () => {
    // #given
    const fixture = withBaseVersion(
      insertBeforeScope(
        ledger,
        `### #33444 — duplicate\n\n- **Evidence it is still needed:** duplicate evidence\n- **Removal condition:** duplicate removal`,
      ),
    )

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(config, fixture)).toThrow(/duplicate identity anomalyco\/opencode#33444/)
  })

  it('rejects malformed ledger identities', () => {
    // #given
    const fixture = withBaseVersion(
      insertBeforeScope(
        ledger,
        `### not-a-pull-request — malformed\n\n- **Evidence it is still needed:** malformed evidence\n- **Removal condition:** malformed removal`,
      ),
    )

    // #when / #then
    expect(() => assertCarryLedgerIntegrity(config, fixture)).toThrow(
      /Malformed pull request identity "not-a-pull-request"/,
    )
  })

  it('rejects a base-version mismatch', () => {
    // #given / #when / #then
    // Derive the expected manifest version rather than hardcoding it, so a base
    // bump does not break this assertion.
    const expectedManifestVersion = config.base_version.replaceAll('.', String.raw`\.`)
    expect(() => assertCarryLedgerIntegrity(config, withBaseVersion(ledger, '0.0.0'))).toThrow(
      new RegExp(String.raw`base version 0\.0\.0 does not match manifest base version ${expectedManifestVersion}`),
    )
  })
})
