#!/usr/bin/env node

import {execFileSync} from 'node:child_process'
import {appendFileSync} from 'node:fs'
import process from 'node:process'

// This file uses .ts import because it runs directly under Node's
// --experimental-strip-types / --experimental-transform-types.
// The test file (preview.test.ts) uses .js because it runs under
// Vitest with bundler module resolution. Both are correct for their runtime.
import {analyzeReleaseType, computeNextVersion} from './preview.ts'

const COMMIT_SEPARATOR = '---COMMIT_SEPARATOR---'

interface ParsedArgs {
  readonly from: string | null
  readonly to: string
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: {from: string | null; to: string} = {
    from: null,
    to: 'HEAD',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--from') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --from')
      }
      parsed.from = value
      index += 1
      continue
    }

    if (arg === '--to') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error('Missing value for --to')
      }
      parsed.to = value
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return parsed
}

function runGit(...args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function resolveFromTag(overrideTag: string | null): string {
  if (overrideTag !== null) {
    return overrideTag
  }

  const tagsOutput = runGit('tag', '--list', 'v*', '--sort=-version:refname')
  const latestTag = tagsOutput
    .split('\n')
    .map(tag => tag.trim())
    .find(tag => tag.length > 0)
  if (latestTag === undefined) {
    throw new Error("No git tag matching pattern 'v*' was found")
  }

  return latestTag
}

function readCommitMessages(fromTag: string, toRef: string): readonly string[] {
  const output = runGit('log', `${fromTag}..${toRef}`, `--format=%B%n${COMMIT_SEPARATOR}`)
  return output
    .split(COMMIT_SEPARATOR)
    .map(message => message.trim())
    .filter(message => message.length > 0)
}

function normalizeVersionFromTag(tag: string): string {
  if (!tag.startsWith('v')) {
    throw new Error(`Expected --from tag to start with 'v', received: ${tag}`)
  }

  return tag.slice(1)
}

function writeGitHubOutput(releaseType: string, nextVersion: string): void {
  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput === undefined || githubOutput.length === 0) {
    return
  }

  appendFileSync(githubOutput, `release_type=${releaseType}\n`, 'utf8')
  appendFileSync(githubOutput, `next_version=${nextVersion}\n`, 'utf8')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const fromTag = resolveFromTag(args.from)
  const toRef = args.to
  const commitMessages = readCommitMessages(fromTag, toRef)

  const releaseType = analyzeReleaseType(commitMessages)
  const currentVersion = normalizeVersionFromTag(fromTag)
  const nextVersion = computeNextVersion(currentVersion, releaseType) ?? ''

  console.log(`release_type=${releaseType}`)
  console.log(`next_version=${nextVersion}`)

  writeGitHubOutput(releaseType, nextVersion)
}

try {
  main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
