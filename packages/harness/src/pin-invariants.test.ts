import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'

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
const cloneDeps = JSON.parse(readFileSync(cloneDepsPath, 'utf8')) as CloneDepsManifest
const renovateText = readFileSync(renovatePath, 'utf8')

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
