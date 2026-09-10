import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

// Deep relative import, deliberately not the `@fro-bot/runtime` package specifier: a barrel
// import through packages/runtime/src/index.ts would pull in zod and @opencode-ai/sdk for two
// string constants, and runtime's `exports` map has no subpath for shared/constants alone.
import {DEFAULT_OPENCODE_VERSION, DEFAULT_SYSTEMATIC_VERSION} from '../../runtime/src/shared/constants.js'

interface HarnessConfig {
  readonly source_repo: string
  readonly base_version: string
}

interface CloneDepsEntry {
  readonly name: string
  readonly resolvedVersion: string
  readonly repoUrl: string
  readonly ref: string
}

interface CloneDepsManifest {
  readonly dependencies: readonly CloneDepsEntry[]
}

const config = JSON.parse(readFileSync(new URL('../harness.config.json', import.meta.url), 'utf8')) as HarnessConfig
const cloneDepsPath = new URL('../../../.slim/clonedeps.json', import.meta.url)
const renovatePath = new URL('../../../.github/renovate.json5', import.meta.url)
const architecturePath = new URL('../../../ARCHITECTURE.md', import.meta.url)
const cloneDeps = JSON.parse(readFileSync(cloneDepsPath, 'utf8')) as CloneDepsManifest
const renovateText = readFileSync(renovatePath, 'utf8')
const architectureText = readFileSync(architecturePath, 'utf8')

// ---------------------------------------------------------------------------
// Version comparison
//
// `.github/renovate.json5` is JSON5 (comments, unquoted keys), so JSON.parse
// cannot read it — and the repo has no JSON5 parser dependency (checked
// node_modules and every workspace package.json), so a new dependency is not
// warranted for reading one field. The allowedVersions bound is extracted with
// a narrow regex scoped to the single packageRules block that both targets
// `anomalyco/opencode` and declares `allowedVersions`, then compared
// semantically — string comparison would wrongly treat '1.18.9' as greater
// than '1.18.30'. The repo has no direct semver dependency either (only a
// transitive one buried in node_modules), so version comparison is a small
// local helper over the dotted numeric parts rather than a new dependency.
// ---------------------------------------------------------------------------

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(part => Number.parseInt(part, 10))
  const rightParts = right.split('.').map(part => Number.parseInt(part, 10))
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0

    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  return 0
}

// ---------------------------------------------------------------------------
// .slim/clonedeps.json — read-only upstream source clone pin
// ---------------------------------------------------------------------------

// Shared by both cases below so the "ignores unrelated entries" case exercises
// the real filter rather than a copy inlined inside its own fixture — a copy
// cannot fail when the real filter is broken. See
// docs/solutions/workflow-issues/a-check-written-from-inside-its-own-premise-cannot-fail-2026-09-04.md
function filterUpstreamEntries(entries: readonly CloneDepsEntry[]): readonly CloneDepsEntry[] {
  return entries.filter(entry => entry.repoUrl === config.source_repo)
}

describe('clonedeps pin matches the harness base version', () => {
  it('every OpenCode upstream entry has resolvedVersion and ref matching base_version', () => {
    // #given the harness base version and the clonedeps entries that point at the OpenCode upstream repo
    const upstreamEntries = filterUpstreamEntries(cloneDeps.dependencies)
    const expectedRef = `v${config.base_version}`

    // #when / #then every upstream entry must be pinned to the current base version
    if (upstreamEntries.length === 0) {
      throw new Error(
        `.slim/clonedeps.json: expected at least one dependency with repoUrl "${config.source_repo}", found none`,
      )
    }

    for (const entry of upstreamEntries) {
      expect(
        entry.resolvedVersion,
        `.slim/clonedeps.json: dependency "${entry.name}" has resolvedVersion "${entry.resolvedVersion}", expected "${config.base_version}" (harness.config.json base_version)`,
      ).toBe(config.base_version)

      expect(
        entry.ref,
        `.slim/clonedeps.json: dependency "${entry.name}" has ref "${entry.ref}", expected "${expectedRef}" (derived from harness.config.json base_version)`,
      ).toBe(expectedRef)
    }
  })

  it('ignores entries for repositories other than the OpenCode upstream', () => {
    // #given a clonedeps manifest containing an entry for an unrelated repository
    const manifest: CloneDepsManifest = {
      dependencies: [
        {
          name: 'unrelated dependency',
          resolvedVersion: '0.0.1',
          repoUrl: 'https://github.com/example/unrelated.git',
          ref: 'v0.0.1',
        },
      ],
    }

    // #when filtering to the OpenCode upstream repo, through the same helper the real check uses
    const upstreamEntries = filterUpstreamEntries(manifest.dependencies)

    // #then the unrelated entry is excluded rather than failing the pin check
    expect(upstreamEntries).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// .github/renovate.json5 — allowedVersions cap for anomalyco/opencode
// ---------------------------------------------------------------------------

function extractOpencodeAllowedVersionsBound(text: string): string {
  // Scoped to the single packageRules object whose matchPackageNames array
  // contains the quoted 'anomalyco/opencode' entry and which declares
  // allowedVersions — packageRules entries are flat objects (arrays use []
  // not {}), so `[^{}]*` cannot cross into a neighboring object. Anchoring on
  // the matchPackageNames array (not a bare literal-text match) is
  // deliberate: a *comment* mentioning "anomalyco/opencode" elsewhere in the
  // same file (e.g. the Bun cap block's comment) must not satisfy this and
  // did under the previous bare-substring version — the match was correct
  // only because the OpenCode block happened to precede the Bun block.
  const blockMatch =
    /\{[^{}]*matchPackageNames:\s*\[[^\]]*'anomalyco\/opencode'[^\]]*\][^{}]*allowedVersions:\s*'([^']+)'[^{}]*\}/.exec(
      text,
    )

  if (blockMatch?.[1] === undefined) {
    throw new Error(
      '.github/renovate.json5: expected a packageRules entry matching "anomalyco/opencode" with an allowedVersions bound, found none',
    )
  }

  return blockMatch[1]
}

function parseAllowedVersionsBound(bound: string): string {
  const versionMatch = /(\d+\.\d+\.\d+)/.exec(bound)

  if (versionMatch?.[1] === undefined) {
    throw new Error(`.github/renovate.json5: allowedVersions bound "${bound}" does not contain a dotted version`)
  }

  return versionMatch[1]
}

describe('renovate allowedVersions cap covers the harness base version', () => {
  it('the anomalyco/opencode allowedVersions bound is >= base_version', () => {
    // #given the Renovate cap on anomalyco/opencode and the harness base version
    const bound = extractOpencodeAllowedVersionsBound(renovateText)
    const boundVersion = parseAllowedVersionsBound(bound)

    // #when comparing semantically
    const comparison = compareDottedVersions(boundVersion, config.base_version)

    // #then the cap must not sit below the base version, or Renovate silently
    // stops proposing the releases the cap exists to gate
    expect(
      comparison >= 0,
      `.github/renovate.json5: anomalyco/opencode allowedVersions bound "${bound}" (version ${boundVersion}) is below harness.config.json base_version "${config.base_version}"`,
    ).toBe(true)
  })
})

describe('compareDottedVersions', () => {
  it('compares dotted numeric parts semantically, not lexically', () => {
    // #given two versions that would compare incorrectly as strings
    // #when / #then semantic comparison finds 1.18.30 greater than 1.18.9
    expect(compareDottedVersions('1.18.30', '1.18.9')).toBeGreaterThan(0)
    expect(compareDottedVersions('1.18.9', '1.18.30')).toBeLessThan(0)
    expect(compareDottedVersions('1.18.30', '1.18.30')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// ARCHITECTURE.md — documented version pins vs packages/runtime/src/shared/constants.ts
//
// ARCHITECTURE.md's code-map table documents DEFAULT_SYSTEMATIC_VERSION and
// DEFAULT_OPENCODE_VERSION as parenthesized, backtick-quoted values in each
// row's rightmost ("Role") cell. That documentation has already drifted twice
// within the lifetime of a single PR (#1589) — once because it was already
// stale when the PR opened, once because a version bump landed on main
// underneath it — so this binds the doc to the real exported constants
// instead of trusting someone to keep them in sync by hand.
//
// The row pattern anchors on the constant name in the row's *first* cell
// (`| \`CONSTANT_NAME\` |`), not a bare substring match — the renovate
// extractor above shows what goes wrong with a looser anchor (it matched a
// comment elsewhere in the file and was only correct by file-ordering
// accident). extractDocumentedVersion throws unless exactly one row matches,
// so both an unanchored regex catching extra rows and a typo'd constant name
// matching zero rows fail loudly instead of comparing undefined to undefined.
//
// The first cell tolerates arbitrary padding (`\s*` on both sides of the
// name) rather than demanding exactly one space, because column-aligned
// markdown tables are common and nothing in this repo's lint/fix formats
// them — a table formatter would otherwise turn a present, correct row into
// a false "row not found". The value capture is non-greedy up to the first
// parenthesized backtick group so a Role cell with more than one such group
// (e.g. a version plus an unrelated aside) extracts the one immediately
// after the name, not whichever one happens to be last. The capture itself
// is `[^\`]*` (allows empty), not `[^\`]+`: an empty backtick pair like
// (``) must reach the "no value" branch below and report that specific
// diagnosis, rather than the pattern failing to match at all and reporting
// the misleading "row not found".
// ---------------------------------------------------------------------------

function extractDocumentedVersion(text: string, constantName: string): string {
  const rowPattern = new RegExp(String.raw`^\|\s*\`${constantName}\`\s*\|.*?\(\`([^\`]*)\`\)`, 'gm')
  const matches = [...text.matchAll(rowPattern)]

  if (matches.length !== 1) {
    throw new Error(`ARCHITECTURE.md: expected exactly one table row for \`${constantName}\`, found ${matches.length}`)
  }

  // matches.length === 1 above guarantees matches[0] exists; the `?.` here is
  // only to satisfy noUncheckedIndexedAccess, not a real fallibility branch.
  const value = matches[0]?.[1] ?? ''

  if (value.length === 0) {
    throw new Error(`ARCHITECTURE.md: row for \`${constantName}\` has no parenthesized backtick-quoted value`)
  }

  return value
}

describe('ARCHITECTURE.md documented version pins match packages/runtime/src/shared/constants.ts', () => {
  it.each([
    ['DEFAULT_SYSTEMATIC_VERSION', DEFAULT_SYSTEMATIC_VERSION],
    ['DEFAULT_OPENCODE_VERSION', DEFAULT_OPENCODE_VERSION],
  ] as const)('%s documented value matches the exported constant', (constantName, actualValue) => {
    // #given the ARCHITECTURE.md table row documenting this constant
    const documentedValue = extractDocumentedVersion(architectureText, constantName)

    // #when / #then the documented value must match the real constant, or CI catches the drift
    expect(
      documentedValue,
      `ARCHITECTURE.md documents ${constantName} as "${documentedValue}" but packages/runtime/src/shared/constants.ts exports "${actualValue}" — update ARCHITECTURE.md to match`,
    ).toBe(actualValue)
  })

  it('fails rather than passing vacuously when no row matches the constant name', () => {
    // #given a constant name with no corresponding ARCHITECTURE.md table row
    // #when / #then extraction must throw, not silently compare undefined to undefined
    expect(() => extractDocumentedVersion(architectureText, 'DEFAULT_NONEXISTENT_VERSION')).toThrow(
      /expected exactly one table row for `DEFAULT_NONEXISTENT_VERSION`, found 0/,
    )
  })

  it('throws when the constant name appears in more than one row', () => {
    // #given two rows both claiming the same constant — the exact shape of the
    // earlier Renovate two-packageRules near-miss this file's design rationale cites
    const text = [
      '| `DEFAULT_OPENCODE_VERSION` | Constant | `a` | Pinned (`1.0.0`) |',
      '| `DEFAULT_OPENCODE_VERSION` | Constant | `b` | Pinned (`2.0.0`) |',
    ].join('\n')

    // #when / #then extraction must throw naming both the constant and the count, not pick one silently
    expect(() => extractDocumentedVersion(text, 'DEFAULT_OPENCODE_VERSION')).toThrow(
      /expected exactly one table row for `DEFAULT_OPENCODE_VERSION`, found 2/,
    )
  })

  it('extracts the value from a column-aligned row with extra padding around the constant name', () => {
    // #given a row padded for column alignment — the shape a markdown table formatter produces
    const text = '| `DEFAULT_OPENCODE_VERSION`   | Constant | `x` | Pinned (`1.18.30+harness.7c479429`) |'

    // #when / #then padding around the first-cell name must not defeat the match
    expect(extractDocumentedVersion(text, 'DEFAULT_OPENCODE_VERSION')).toBe('1.18.30+harness.7c479429')
  })

  it('extracts the first parenthesized backtick group when the row cell contains two', () => {
    // #given a Role cell with a version and an unrelated aside, both parenthesized and backtick-quoted
    const text = '| `DEFAULT_OPENCODE_VERSION` | Constant | `x` | Pinned (`3.16.3`) see also (`note`) |'

    // #when / #then the first group wins, not whichever the greedy match reaches last
    expect(extractDocumentedVersion(text, 'DEFAULT_OPENCODE_VERSION')).toBe('3.16.3')
  })

  it('reports a real "no value" diagnosis for an empty parenthesized backtick pair', () => {
    // #given a row whose Role cell has an empty backtick-quoted parenthetical
    const text = '| `DEFAULT_OPENCODE_VERSION` | Constant | `x` | Pinned (``) |'

    // #when / #then this must reach the "no value" branch, not the misleading "row not found" branch
    expect(() => extractDocumentedVersion(text, 'DEFAULT_OPENCODE_VERSION')).toThrow(
      /row for `DEFAULT_OPENCODE_VERSION` has no parenthesized backtick-quoted value/,
    )
  })
})
