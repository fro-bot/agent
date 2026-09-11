export type ReleaseType = 'none' | 'patch' | 'minor' | 'major'

interface ParsedCommit {
  readonly type: string
  readonly scope: string | null
  readonly isBreakingHeader: boolean
  readonly body: string
}

const RELEASE_PRIORITY: Readonly<Record<ReleaseType, number>> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
}

const CONVENTIONAL_HEADER_PATTERN = /^(?<type>[a-z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<breaking>!)?:\s.+$/
const BREAKING_CHANGE_PATTERN = /(?:^|\n)BREAKING[ -]CHANGE:\s.+/m

function parseConventionalCommit(message: string): ParsedCommit | null {
  const [header, ...bodyLines] = message.split('\n')
  if (header == null || header.trim().length === 0) {
    return null
  }

  const match = CONVENTIONAL_HEADER_PATTERN.exec(header)
  if (match == null || match.groups == null) {
    return null
  }

  const type = match.groups.type
  if (type == null) {
    return null
  }

  const scope = match.groups.scope
  const breaking = match.groups.breaking

  return {
    type,
    scope: scope ?? null,
    isBreakingHeader: breaking === '!',
    body: bodyLines.join('\n'),
  }
}

function resolveReleaseTypeForParsedCommit(parsed: ParsedCommit): ReleaseType {
  // Explicit suppressions win over the breaking marker. This mirrors .releaserc.yaml's
  // analyzeCommits.releaseRules: `breaking: true` is listed first, but the scoped `build(dev)`
  // and `skip` suppression rules are evaluated after it and win on a match (confirmed against the
  // real @semantic-release/commit-analyzer -- see scripts/release/release-policy.test.ts).
  if (parsed.type === 'build' && parsed.scope === 'dev') {
    return 'none'
  }

  if (parsed.type === 'skip') {
    return 'none'
  }

  // Project policy: this project stays 0.x, so a breaking change is a minor bump, never major
  // (0.110.x -> 0.111.0, not 1.0.0). BREAKING CHANGE notes are unaffected by this -- they come
  // from @semantic-release/release-notes-generator, which reads commit notes independently of
  // analyzeCommits.releaseRules.
  if (parsed.isBreakingHeader || BREAKING_CHANGE_PATTERN.test(parsed.body)) {
    return 'minor'
  }

  if (parsed.type === 'feat' || parsed.type === 'features') {
    return 'minor'
  }

  if (parsed.type === 'fix' || parsed.type === 'perf' || parsed.type === 'revert') {
    return 'patch'
  }

  if (parsed.type === 'build') {
    return 'patch'
  }

  if (parsed.type === 'docs') {
    return parsed.scope === 'readme' || parsed.scope === 'rfcs' ? 'patch' : 'none'
  }

  if (
    parsed.type === 'chore' ||
    parsed.type === 'ci' ||
    parsed.type === 'style' ||
    parsed.type === 'refactor' ||
    parsed.type === 'test'
  ) {
    return 'none'
  }

  return 'none'
}

export function filterHarnessTags(tags: readonly string[]): readonly string[] {
  return tags.filter(tag => !tag.includes('+harness'))
}

export function analyzeReleaseType(messages: readonly string[]): ReleaseType {
  let highest: ReleaseType = 'none'

  for (const message of messages) {
    const parsed = parseConventionalCommit(message)
    if (parsed == null) {
      continue
    }

    const releaseType = resolveReleaseTypeForParsedCommit(parsed)
    if (RELEASE_PRIORITY[releaseType] > RELEASE_PRIORITY[highest]) {
      highest = releaseType
    }
  }

  return highest
}

export function computeNextVersion(currentVersion: string, releaseType: ReleaseType): string | null {
  if (releaseType === 'none') {
    return null
  }

  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion)
  if (match == null) {
    throw new Error(`Invalid semantic version: ${currentVersion}`)
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])

  if (releaseType === 'patch') {
    return `${major}.${minor}.${patch + 1}`
  }

  if (releaseType === 'minor') {
    return `${major}.${minor + 1}.0`
  }

  return `${major + 1}.0.0`
}
