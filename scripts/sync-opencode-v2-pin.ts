#!/usr/bin/env node

// Regenerates the per-asset sha256 digests in packages/runtime/src/shared/opencode-v2-pin.json from the upstream
// release's SHA256SUMS. Run it on the Renovate bump PR, which changes only `version`:
//
//   node scripts/sync-opencode-v2-pin.ts            # rewrite the digests for the pinned version
//   node scripts/sync-opencode-v2-pin.ts 2.3.0      # set the version too, then rewrite the digests
//   node scripts/sync-opencode-v2-pin.ts --check    # exit 1 if the file disagrees with upstream; writes nothing
//
// The set of assets is whatever the file already lists: this script never adds or drops an asset, and it fails when the
// release has no SHA256SUMS line for one. The Dockerfile's `opencode-v2` stage and the Action's installOpenCode
// re-verify each digest against SHA256SUMS and the archive at install time, so a wrong digest cannot ship silently.
//
// Plain Node (24 strips types), no dependencies. The relative `.ts` extensions in sibling scripts follow the same rule.

import {readFileSync, writeFileSync} from 'node:fs'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const PIN_PATH = fileURLToPath(new URL('../packages/runtime/src/shared/opencode-v2-pin.json', import.meta.url))
const RELEASE_BASE_URL = 'https://github.com/anomalyco/opencode/releases/download'
const FETCH_TIMEOUT_MS = 30_000
const SEMVER = /^\d+\.\d+\.\d+$/
const SHA256_HEX = /^[0-9a-f]{64}$/

export interface OpenCodeV2Pin {
  readonly version: string
  readonly assets: Readonly<Record<string, string>>
}

/** Parse `SHA256SUMS` text (`<hex>  <filename>` per line, an optional `*` or `./` before the name) into a map. */
export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) sums.set(match[2], match[1].toLowerCase())
  }
  return sums
}

/** Validate the shape of a parsed pin file. */
export function parsePin(value: unknown): OpenCodeV2Pin {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const {version, assets} = record
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error('opencode-v2-pin.json: `version` must be an exact x.y.z version')
  }
  if (typeof assets !== 'object' || assets === null || Object.keys(assets).length === 0) {
    throw new Error('opencode-v2-pin.json: `assets` must list at least one asset')
  }
  const entries = Object.entries(assets as Record<string, unknown>)
  for (const [name, digest] of entries) {
    if (typeof digest !== 'string' || !SHA256_HEX.test(digest)) {
      throw new Error(`opencode-v2-pin.json: asset ${name} has no valid sha256 digest`)
    }
  }
  return {version, assets: Object.fromEntries(entries.map(([name, digest]) => [name, String(digest)]))}
}

/**
 * The pin with every listed asset's digest replaced by its SHA256SUMS entry. Throws when the release has no entry for
 * an asset the pin lists.
 */
export function syncPinDigests(pin: OpenCodeV2Pin, sums: ReadonlyMap<string, string>): OpenCodeV2Pin {
  const assets: Record<string, string> = {}
  for (const name of Object.keys(pin.assets)) {
    const digest = sums.get(name)
    if (digest === undefined) {
      throw new Error(
        `SHA256SUMS for v${pin.version} has no entry for ${name}: drop it from the pin or check the release`,
      )
    }
    assets[name] = digest
  }
  return {version: pin.version, assets}
}

function serializePin(pin: OpenCodeV2Pin): string {
  return `${JSON.stringify(pin, null, 2)}\n`
}

async function fetchSums(version: string): Promise<ReadonlyMap<string, string>> {
  const url = `${RELEASE_BASE_URL}/v${version}/SHA256SUMS`
  const response = await fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow'})
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return parseSha256Sums(await response.text())
}

async function main(args: readonly string[]): Promise<void> {
  const check = args.includes('--check')
  const requested = args.find(arg => !arg.startsWith('--'))
  if (requested !== undefined && !SEMVER.test(requested)) throw new Error(`not an exact x.y.z version: ${requested}`)
  if (check && requested !== undefined) throw new Error('--check verifies the file as it is; do not pass a version')

  const current = parsePin(JSON.parse(readFileSync(PIN_PATH, 'utf8')))
  const target: OpenCodeV2Pin = {version: requested ?? current.version, assets: current.assets}
  const next = syncPinDigests(target, await fetchSums(target.version))
  const changed = serializePin(next) !== serializePin(current)

  if (check) {
    if (changed) throw new Error(`opencode-v2-pin.json disagrees with the v${current.version} SHA256SUMS`)
    process.stdout.write(`opencode-v2-pin.json matches the v${current.version} SHA256SUMS\n`)
    return
  }
  if (changed) writeFileSync(PIN_PATH, serializePin(next))
  process.stdout.write(
    changed ? `rewrote opencode-v2-pin.json for v${next.version}\n` : 'opencode-v2-pin.json is already current\n',
  )
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`sync-opencode-v2-pin: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
