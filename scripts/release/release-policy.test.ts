import type {AnalyzeCommitsFn, GenerateNotesFn, SemverIncFn} from './semantic-release-plugins.js'

import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

import {analyzeReleaseType, computeNextVersion} from './preview.js'

// Neither plugin is a direct devDependency -- they're transitive deps of the declared
// `semantic-release` devDependency, so resolve them through semantic-release's own require
// context (works even when they aren't hoisted to root node_modules).
const hostRequire = createRequire(createRequire(import.meta.url).resolve('semantic-release'))
const {analyzeCommits} = (await import(
  pathToFileURL(hostRequire.resolve('@semantic-release/commit-analyzer')).href
)) as {
  analyzeCommits: AnalyzeCommitsFn
}
const {generateNotes} = (await import(
  pathToFileURL(hostRequire.resolve('@semantic-release/release-notes-generator')).href
)) as {generateNotes: GenerateNotesFn}
// `semver` is itself a real dependency of the `semantic-release` host (not this project's own
// devDependency), so it's the actual increment library the release would run through.
const semverModule = (await import(pathToFileURL(hostRequire.resolve('semver')).href)) as {
  default: {inc: SemverIncFn}
}
const semverInc = semverModule.default.inc

const RELEASERC_PATH = '.releaserc.yaml'
const noopLogger = {log: (): void => {}}

interface ReleasercPolicy {
  readonly preset: string
  readonly presetConfig: unknown
  readonly releaseRules: readonly unknown[]
}

// Reads the real checked-in config -- never a hand-typed duplicate of these rules -- so a future
// edit to .releaserc.yaml is exercised by this test instead of silently drifting from it.
function loadReleasercPolicy(): ReleasercPolicy {
  const doc = parse(readFileSync(RELEASERC_PATH, 'utf8')) as Record<string, unknown>
  const {preset} = doc
  if (typeof preset !== 'string') {
    throw new TypeError(`${RELEASERC_PATH} preset must be a string`)
  }
  const analyzeCommitsConfig = doc.analyzeCommits as {releaseRules?: unknown} | undefined
  const releaseRules = analyzeCommitsConfig?.releaseRules
  if (!Array.isArray(releaseRules)) {
    throw new TypeError(`${RELEASERC_PATH} analyzeCommits.releaseRules must be an array`)
  }
  return {preset, presetConfig: doc.presetConfig, releaseRules}
}

async function analyzeWithRealAnalyzer(message: string): Promise<string | null> {
  const {preset, presetConfig, releaseRules} = loadReleasercPolicy()
  return analyzeCommits(
    {preset, presetConfig, releaseRules},
    {commits: [{hash: 'abc1234', message}], cwd: process.cwd(), logger: noopLogger},
  )
}

interface MatrixCase {
  readonly message: string
  readonly expectedAnalyzer: string | null
  readonly expectedPreview: ReturnType<typeof analyzeReleaseType>
}

// Every case here is checked against BOTH the real, config-driven analyzer AND preview.ts, so
// drift between the two shows up as a failure here rather than as a surprise at release time.
const MATRIX: readonly MatrixCase[] = [
  {message: 'fix: something', expectedAnalyzer: 'patch', expectedPreview: 'patch'},
  {message: 'feat: something', expectedAnalyzer: 'minor', expectedPreview: 'minor'},
  {message: 'fix!: breaking fix', expectedAnalyzer: 'minor', expectedPreview: 'minor'},
  {message: 'feat!: breaking feat', expectedAnalyzer: 'minor', expectedPreview: 'minor'},
  {message: 'fix: normal\n\nBREAKING CHANGE: details', expectedAnalyzer: 'minor', expectedPreview: 'minor'},
  {message: 'build(deps): bump', expectedAnalyzer: 'patch', expectedPreview: 'patch'},
  {
    message: 'build(deps)!: breaking bump\n\nBREAKING CHANGE: details',
    expectedAnalyzer: 'minor',
    expectedPreview: 'minor',
  },
  {message: 'build(dev): tweak', expectedAnalyzer: null, expectedPreview: 'none'},
  {
    message: 'build(dev)!: breaking tweak\n\nBREAKING CHANGE: details',
    expectedAnalyzer: null,
    expectedPreview: 'none',
  },
  {message: 'feat(opencode-plugin): add a feature', expectedAnalyzer: null, expectedPreview: 'none'},
  {message: 'fix(opencode-plugin): fix a bug', expectedAnalyzer: null, expectedPreview: 'none'},
  {message: 'build(opencode-plugin): bundle a dependency', expectedAnalyzer: null, expectedPreview: 'none'},
  {
    message: 'feat(opencode-plugin)!: breaking plugin change\n\nBREAKING CHANGE: details',
    expectedAnalyzer: null,
    expectedPreview: 'none',
  },
  {message: 'feat(action): add a feature', expectedAnalyzer: 'minor', expectedPreview: 'minor'},
  {message: 'docs(readme): update', expectedAnalyzer: 'patch', expectedPreview: 'patch'},
  {message: 'docs(rfcs): update', expectedAnalyzer: 'patch', expectedPreview: 'patch'},
  {
    message: 'docs(readme)!: breaking update\n\nBREAKING CHANGE: details',
    expectedAnalyzer: 'minor',
    expectedPreview: 'minor',
  },
  {message: 'docs: general update', expectedAnalyzer: null, expectedPreview: 'none'},
  {message: 'chore: housekeeping', expectedAnalyzer: null, expectedPreview: 'none'},
  {message: 'skip: ci noop', expectedAnalyzer: null, expectedPreview: 'none'},
  {
    message: 'skip!: breaking skip\n\nBREAKING CHANGE: details',
    expectedAnalyzer: null,
    expectedPreview: 'none',
  },
]

describe('release policy: real @semantic-release/commit-analyzer parity with .releaserc.yaml', () => {
  it.each(MATRIX)(
    'matches both the real analyzer and preview.ts for "$message"',
    async ({message, expectedAnalyzer, expectedPreview}) => {
      // #given/#when
      const analyzerResult = await analyzeWithRealAnalyzer(message)
      const previewResult = analyzeReleaseType([message])

      // #then: the real analyzer, driven by the checked-in .releaserc.yaml, is the source of truth
      expect(analyzerResult, `real analyzer for "${message}"`).toBe(expectedAnalyzer)
      // #then: preview.ts must not silently drift from that real behavior
      expect(previewResult, `preview.ts for "${message}"`).toBe(expectedPreview)
    },
  )
})

describe('release policy: BREAKING CHANGE notes survive the minor-not-major policy', () => {
  it('keeps the BREAKING CHANGES section in real release-notes-generator output', async () => {
    // #given: release-notes-generator reads commit notes directly; it never consults
    // analyzeCommits.releaseRules, so the minor-not-major policy cannot suppress this section
    const {preset, presetConfig} = loadReleasercPolicy()

    // #when
    const notes = await generateNotes(
      {preset, presetConfig},
      {
        cwd: process.cwd(),
        options: {repositoryUrl: 'https://github.com/example/example.git'},
        lastRelease: {gitTag: 'v0.110.0'},
        nextRelease: {version: '0.111.0', gitTag: 'v0.111.0'},
        commits: [
          {
            hash: 'abc1234',
            message: 'fix!: breaking fix header\n\nBREAKING CHANGE: something broke for users',
          },
        ],
      },
    )

    // #then
    expect(notes).toContain('BREAKING CHANGES')
    expect(notes).toContain('something broke for users')
  })
})

async function notesFor(messages: readonly string[]): Promise<string> {
  const {preset, presetConfig} = loadReleasercPolicy()
  return generateNotes(
    {preset, presetConfig},
    {
      cwd: process.cwd(),
      options: {repositoryUrl: 'https://github.com/example/example.git'},
      lastRelease: {gitTag: 'v0.110.0'},
      nextRelease: {version: '0.111.0', gitTag: 'v0.111.0'},
      commits: messages.map((message, index) => ({hash: `abc12${index.toString().padStart(2, '0')}`, message})),
    },
  )
}

describe('release policy: opencode-plugin commits stay out of the Action release notes', () => {
  const PLUGIN_TYPES = [
    'feat',
    'features',
    'fix',
    'build',
    'docs',
    'test',
    'ci',
    'style',
    'refactor',
    'perf',
    'revert',
    'chore',
  ] as const

  it.each(PLUGIN_TYPES)('hides a %s(opencode-plugin) commit', async type => {
    // #given
    const messages = [`${type}(opencode-plugin): plugin only change`, `${type}(action): action change`]

    // #when
    const notes = await notesFor(messages)

    // #then: the plugin commit is absent and the same type under another scope is still listed
    expect(notes).not.toContain('plugin only change')
    expect(notes).toContain('action change')
  })

  it('lets an Action commit set the release when a breaking plugin commit is in the same batch', async () => {
    // #given: a plugin pin update for the Action beside a breaking plugin commit
    const messages = [
      'feat(opencode-plugin)!: breaking plugin change\n\nBREAKING CHANGE: plugin setting renamed',
      'build(deps): update the plugin pin',
    ]
    const {preset, presetConfig, releaseRules} = loadReleasercPolicy()

    // #when
    const releaseType = await analyzeCommits(
      {preset, presetConfig, releaseRules},
      {
        commits: messages.map((message, index) => ({hash: `abc12${index.toString().padStart(2, '0')}`, message})),
        cwd: process.cwd(),
        logger: noopLogger,
      },
    )
    const notes = await notesFor(messages)

    // #then: the pin update alone decides the bump, and preview.ts agrees
    expect(releaseType).toBe('patch')
    expect(analyzeReleaseType(messages)).toBe('patch')
    // #then: the notes generator always shows a breaking note, so the plugin's one stays visible
    expect(notes).toContain('update the plugin pin')
    expect(notes).toContain('plugin setting renamed')
  })

  it('still lists the same types without a scope', async () => {
    // #given/#when
    const notes = await notesFor(['feat: unscoped feature', 'fix: unscoped fix'])

    // #then
    expect(notes).toContain('unscoped feature')
    expect(notes).toContain('unscoped fix')
  })
})

describe('release policy: computeNextVersion matches the real semver increment', () => {
  const versions = ['0.110.0', '0.110.7', '1.2.3'] as const
  const releaseTypes = ['patch', 'minor', 'major'] as const

  for (const version of versions) {
    for (const releaseType of releaseTypes) {
      it(`computeNextVersion('${version}', '${releaseType}') matches semver.inc`, () => {
        // #given/#when
        const previewResult = computeNextVersion(version, releaseType)
        const semverResult = semverInc(version, releaseType)

        // #then: ordinary semver arithmetic, not a project-policy clamp -- semantic-release's own
        // incrementer would not apply a 0.x clamp, so computeNextVersion must not invent one either
        expect(previewResult).toBe(semverResult)
      })
    }
  }

  it("returns null for 'none' instead of running an increment (not comparable to semver.inc)", () => {
    // #given/#when
    const result = computeNextVersion('0.110.0', 'none')

    // #then
    expect(result).toBeNull()
  })
})

describe('release policy: end-to-end -- a real breaking commit stays in the 0.x series', () => {
  it("a breaking commit resolves to 'minor' via the real analyzer and computeNextVersion agrees with preview.ts", async () => {
    // #given: a representative breaking commit, run through the real, config-driven analyzer only
    // -- no manual 'major' input is ever fed into a real release path
    const message = 'fix(setup)!: tighten credential probe\n\nBREAKING CHANGE: preflight now fails fast on stale tokens'
    const currentVersion = '0.110.0'

    // #when
    const analyzerResult = await analyzeWithRealAnalyzer(message)
    const previewResult = analyzeReleaseType([message])

    // #then: the real, config-driven analyzer classifies this breaking commit as 'minor'
    expect(analyzerResult).toBe('minor')
    expect(previewResult).toBe('minor')

    // #then: the real semver increment for 'minor' and computeNextVersion agree, and land on
    // 0.111.0, not 1.0.0
    const semverNext = semverInc(currentVersion, 'minor')
    const previewNext = computeNextVersion(currentVersion, previewResult)
    expect(semverNext).toBe('0.111.0')
    expect(previewNext).toBe('0.111.0')
    expect(previewNext).toBe(semverNext)
  })
})
