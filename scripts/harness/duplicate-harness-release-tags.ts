#!/usr/bin/env node

// One-off, create-first migration for legacy +harness releases.
// Dry-run is the default. Only --execute permits release creation or edits.

import {execFileSync} from 'node:child_process'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const EXPECTED_SOURCE_RELEASE_COUNT = 18
const EXPECTED_ASSET_COUNT = 7
const HEAD_TIMEOUT_MS = 30_000
const DEFAULT_REPOSITORY = 'fro-bot/agent'

export interface HarnessTagParts {
  readonly baseVersion: string
  readonly shortSha: string
  readonly sourceTag: string
  readonly targetTag: string
}

export interface AssetVerificationResult {
  readonly ok: boolean
  readonly status: number
}

interface ReleaseAsset {
  readonly name: string
}

interface ReleaseDetails {
  readonly tagName: string
  readonly targetCommitish: string
  readonly isPrerelease: boolean
  readonly assets: readonly ReleaseAsset[]
}

interface CliOptions {
  readonly dryRun: boolean
  readonly repo: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`gh response is missing a valid ${field}`)
  }
  return value
}

/** Convert a legacy +harness tag to its prerelease-tag equivalent. Pure. */
export function convertHarnessTag(tag: string): string | null {
  const match = /^(\d+\.\d+\.\d+)\+harness\.([0-9a-f]{8,40})$/i.exec(tag)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null
  }

  return `${match[1]}-harness.${match[2]}`
}

/** Parse a valid legacy harness tag and derive both public tag forms. Pure. */
export function parseHarnessTag(tag: string): HarnessTagParts | null {
  const targetTag = convertHarnessTag(tag)
  if (targetTag === null) {
    return null
  }

  const match = /^(\d+\.\d+\.\d+)\+harness\.([0-9a-f]{8,40})$/i.exec(tag)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null
  }

  return {baseVersion: match[1], shortSha: match[2], sourceTag: tag, targetTag}
}

/** Build the canonical GitHub release asset URL for either tag form. Pure. */
export function buildAssetUrl(repo: string, tag: string, assetName: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

/** Return true when creation should be skipped because the target release exists. Pure. */
export function shouldSkipDuplicate(existingReleaseTags: readonly string[], targetTag: string): boolean {
  return existingReleaseTags.includes(targetTag)
}

/** HEAD succeeds only for the exact status required by the migration contract. Pure. */
export function evaluateHeadStatus(status: number): AssetVerificationResult {
  return {ok: status === 200, status}
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`)
}

function shellQuote(argument: string): string {
  const quote = String.fromCharCode(39)
  const escapedQuote = `${quote}${String.fromCharCode(92)}${quote}${quote}`
  return `${quote}${argument.replaceAll(quote, escapedQuote)}${quote}`
}

function formatGhCommand(args: readonly string[]): string {
  return ['gh', ...args].map(shellQuote).join(' ')
}

function runGh(args: readonly string[], dryRun: boolean, mutatesRemote: boolean): string {
  writeLine(`${dryRun && mutatesRemote ? '[dry-run] ' : ''}${formatGhCommand(args)}`)

  if (dryRun && mutatesRemote) {
    return ''
  }

  return execFileSync('gh', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']})
}

function releaseListArgs(repo: string): readonly string[] {
  return ['release', 'list', '--repo', repo, '--limit', '100', '--json', 'tagName']
}

function releaseViewArgs(repo: string, tag: string): readonly string[] {
  return ['release', 'view', tag, '--repo', repo, '--json', 'tagName,targetCommitish,isPrerelease,assets']
}

function releasePrereleaseViewArgs(repo: string, tag: string): readonly string[] {
  return ['release', 'view', tag, '--repo', repo, '--json', 'isPrerelease']
}

function parseReleaseTags(rawJson: string): readonly string[] {
  const parsed: unknown = JSON.parse(rawJson)
  if (!Array.isArray(parsed)) {
    throw new TypeError('gh release list returned a non-array response')
  }

  return parsed.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`gh release list entry ${index} is not an object`)
    }
    return requiredString(entry.tagName, `release list entry ${index}.tagName`)
  })
}

function parseReleaseDetails(rawJson: string): ReleaseDetails {
  const parsed: unknown = JSON.parse(rawJson)
  if (!isRecord(parsed)) {
    throw new Error('gh release view returned a non-object response')
  }

  const assetsValue = parsed.assets
  if (!Array.isArray(assetsValue)) {
    throw new TypeError('gh release view returned an invalid assets list')
  }

  const assets = assetsValue.map((entry, index): ReleaseAsset => {
    if (!isRecord(entry)) {
      throw new Error(`gh release asset ${index} is not an object`)
    }
    const name = requiredString(entry.name, `release asset ${index}.name`)
    if (name.includes('/') || name.includes(String.fromCharCode(92)) || name === '.' || name === '..') {
      throw new Error(`release asset ${name} has an unsafe path`)
    }
    return {name}
  })

  return {
    tagName: requiredString(parsed.tagName, 'tagName'),
    targetCommitish: requiredString(parsed.targetCommitish, 'targetCommitish'),
    isPrerelease: parsed.isPrerelease === true,
    assets,
  }
}

function parsePrereleaseFlag(rawJson: string): boolean {
  const parsed: unknown = JSON.parse(rawJson)
  if (!isRecord(parsed)) {
    throw new Error('gh release view returned an invalid prerelease response')
  }
  return parsed.isPrerelease === true
}

function assertExpectedAssets(release: ReleaseDetails, role: string): void {
  if (release.assets.length === 0) {
    throw new Error(`${role} release ${release.tagName} has no assets; refusing to continue`)
  }
  if (release.assets.length !== EXPECTED_ASSET_COUNT) {
    writeLine(
      `::warning::${role} release ${release.tagName} has ${release.assets.length} assets; expected ${EXPECTED_ASSET_COUNT}; enumerating all available assets`,
    )
  }
}

function assertSameAssetNames(source: ReleaseDetails, duplicate: ReleaseDetails): void {
  const sourceNames = source.assets.map(asset => asset.name).toSorted()
  const duplicateNames = duplicate.assets.map(asset => asset.name).toSorted()
  if (sourceNames.join('\n') !== duplicateNames.join('\n')) {
    throw new Error(`duplicate release ${duplicate.tagName} does not contain the same assets as ${source.tagName}`)
  }
}

function assertSameTarget(source: ReleaseDetails, duplicate: ReleaseDetails): void {
  if (source.targetCommitish !== duplicate.targetCommitish) {
    throw new Error(`duplicate release ${duplicate.tagName} targets a different commitish than ${source.tagName}`)
  }
}

function downloadArgs(
  repo: string,
  tag: string,
  directory: string,
  assets: readonly ReleaseAsset[],
): readonly string[] {
  return [
    'release',
    'download',
    tag,
    '--repo',
    repo,
    '--dir',
    directory,
    '--clobber',
    ...assets.flatMap(asset => ['--pattern', asset.name]),
  ]
}

function createArgs(
  repo: string,
  targetTag: string,
  source: ReleaseDetails,
  notes: string,
  assetPaths: readonly string[],
): readonly string[] {
  return [
    'release',
    'create',
    targetTag,
    '--repo',
    repo,
    '--target',
    source.targetCommitish,
    '--prerelease',
    '--latest=false',
    '--notes',
    notes,
    ...assetPaths,
  ]
}

function editArgs(repo: string, tag: string): readonly string[] {
  return ['release', 'edit', tag, '--repo', repo, '--prerelease']
}

async function verifyAssetUrls(
  repo: string,
  tag: string,
  assets: readonly ReleaseAsset[],
  dryRun: boolean,
): Promise<void> {
  for (const asset of assets) {
    const url = buildAssetUrl(repo, tag, asset.name)
    writeLine(`${dryRun ? '[dry-run] ' : ''}HEAD ${url}`)
    if (dryRun) {
      continue
    }

    let response: Response
    try {
      response = await fetch(url, {method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(HEAD_TIMEOUT_MS)})
    } catch {
      throw new Error(`HEAD verification failed for release ${tag}, asset ${url}`)
    }

    const result = evaluateHeadStatus(response.status)
    if (result.ok === false) {
      throw new Error(`HEAD verification failed for release ${tag}, asset ${url}: HTTP ${result.status}`)
    }
  }
}

function assetPaths(directory: string, assets: readonly ReleaseAsset[]): readonly string[] {
  return assets.map(asset => join(directory, asset.name))
}

function ensureDownloaded(directory: string, assets: readonly ReleaseAsset[]): void {
  for (const asset of assets) {
    const path = join(directory, asset.name)
    if (!existsSync(path)) {
      throw new Error(`download did not produce source asset ${asset.name}`)
    }
  }
}

function sourceTagsFromReleaseList(tags: readonly string[]): readonly HarnessTagParts[] {
  return tags
    .filter(tag => tag.includes('+harness.'))
    .map(tag => {
      const parts = parseHarnessTag(tag)
      if (parts === null) {
        throw new Error(`invalid harness release tag discovered: ${tag}`)
      }
      return parts
    })
}

function parseOptions(argv: readonly string[]): CliOptions {
  let dryRun = true
  const environmentRepository = process.env.GITHUB_REPOSITORY?.trim()
  let repo =
    environmentRepository === undefined || environmentRepository === '' ? DEFAULT_REPOSITORY : environmentRepository

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument === '--execute') {
      dryRun = false
      continue
    }
    if (argument === '--repo') {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) {
        throw new Error('--repo requires owner/name')
      }
      repo = value
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }

  if (!/^[^/]+\/[^/]+$/.test(repo)) {
    throw new Error(`invalid repository: ${repo}`)
  }

  return {dryRun, repo}
}

async function migrateOne(
  repo: string,
  parts: HarnessTagParts,
  source: ReleaseDetails,
  existingReleaseTags: readonly string[],
  dryRun: boolean,
): Promise<void> {
  const targetExists = shouldSkipDuplicate(existingReleaseTags, parts.targetTag)
  const action = targetExists ? 'skip creation; verify existing duplicate' : 'create duplicate'
  writeLine(`\n${source.tagName} -> ${parts.targetTag}: ${action}`)

  assertExpectedAssets(source, 'source')

  let target: ReleaseDetails | null = null
  if (targetExists) {
    target = parseReleaseDetails(runGh(releaseViewArgs(repo, parts.targetTag), dryRun, false))
  } else {
    const directory = dryRun ? '<temp-dir>' : mkdtempSync(join(tmpdir(), 'duplicate-harness-release-'))
    try {
      runGh(downloadArgs(repo, source.tagName, directory, source.assets), dryRun, true)

      if (dryRun === false) {
        ensureDownloaded(directory, source.assets)
      }

      const notes = `Duplicate of ${source.tagName}; original release retained for existing consumers.`
      runGh(createArgs(repo, parts.targetTag, source, notes, assetPaths(directory, source.assets)), dryRun, true)
    } finally {
      if (dryRun === false) {
        rmSync(directory, {recursive: true, force: true})
      }
    }
  }

  if (target === null) {
    if (dryRun) {
      // The target is absent during dry-run, so its post-create view is planned but not run.
      writeLine(`[dry-run] ${formatGhCommand(releaseViewArgs(repo, parts.targetTag))}`)
      target = {
        tagName: parts.targetTag,
        targetCommitish: source.targetCommitish,
        isPrerelease: true,
        assets: source.assets,
      }
    } else {
      target = parseReleaseDetails(runGh(releaseViewArgs(repo, parts.targetTag), false, false))
    }
  }

  assertExpectedAssets(target, 'duplicate')
  assertSameTarget(source, target)
  assertSameAssetNames(source, target)
  if (target.isPrerelease === false) {
    throw new Error(`duplicate release ${target.tagName} is not marked prerelease`)
  }

  await verifyAssetUrls(repo, target.tagName, target.assets, dryRun)
  await verifyAssetUrls(repo, source.tagName, source.assets, dryRun)

  if (source.isPrerelease) {
    writeLine(`original release ${source.tagName} is already prerelease; skip edit`)
  } else {
    runGh(editArgs(repo, source.tagName), dryRun, true)
  }

  const prereleaseCheck = runGh(releasePrereleaseViewArgs(repo, source.tagName), dryRun, false)
  if (dryRun === false && parsePrereleaseFlag(prereleaseCheck) === false) {
    throw new Error(`original release ${source.tagName} was not marked prerelease`)
  }

  await verifyAssetUrls(repo, source.tagName, source.assets, dryRun)
}

export async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const listedTags = parseReleaseTags(runGh(releaseListArgs(options.repo), options.dryRun, false))
  const sourceTags = sourceTagsFromReleaseList(listedTags)

  writeLine(`Found ${sourceTags.length} harness releases with +harness. tags.`)
  if (sourceTags.length !== EXPECTED_SOURCE_RELEASE_COUNT) {
    throw new Error(
      `expected ${EXPECTED_SOURCE_RELEASE_COUNT} source releases, found ${sourceTags.length}; refusing to continue`,
    )
  }

  for (const parts of sourceTags) {
    const source = parseReleaseDetails(runGh(releaseViewArgs(options.repo, parts.sourceTag), options.dryRun, false))
    await migrateOne(options.repo, parts, source, listedTags, options.dryRun)
  }

  writeLine(`${options.dryRun ? 'Dry-run complete' : 'Migration complete'}: ${sourceTags.length} releases processed.`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'migration failed'
    process.stderr.write(`::error::${message}\n`)
    process.exitCode = 1
  }
}
