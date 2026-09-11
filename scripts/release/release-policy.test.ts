import type {AnalyzeCommitsFn, GenerateNotesFn} from './semantic-release-plugins.js'

import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

import {analyzeReleaseType} from './preview.js'

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
