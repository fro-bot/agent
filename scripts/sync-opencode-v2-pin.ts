#!/usr/bin/env node

// Regenerates the per-asset sha256 digests in packages/runtime/src/shared/opencode-v2-pin.json from the upstream
// release's SHA256SUMS. Run it on the Renovate bump PR, which changes only `version`:
//
//   node scripts/sync-opencode-v2-pin.ts            # rewrite the digests for the pinned version
//   node scripts/sync-opencode-v2-pin.ts 2.3.0      # set the version too, then rewrite the digests
//   node scripts/sync-opencode-v2-pin.ts --check    # exit 1 if the file disagrees with upstream; writes nothing
//
// The only option is `--check`, and at most one positional version is accepted. Anything else (`--help`, `--check=true`,
// a second positional) exits 2 with a usage line, before the pin is read, fetched or written.
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

const USAGE = 'usage: node scripts/sync-opencode-v2-pin.ts [--check | <x.y.z>]'

/** The exit code for a rejected command line (distinct from 1, a failed sync or check). */
export const EXIT_USAGE = 2

export type ParsedArgs =
  | {readonly kind: 'sync'; readonly version: string | undefined}
  | {readonly kind: 'check'}
  | {readonly kind: 'invalid'; readonly reason: string}

/** Validate the whole argument list: `--check` alone, or at most one exact x.y.z version. Nothing else is accepted. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  let check = false
  for (const arg of argv) {
    if (arg === '--check') check = true
    else if (arg.startsWith('-')) return {kind: 'invalid', reason: `unsupported option: ${arg}`}
    else positionals.push(arg)
  }
  if (positionals.length > 1) return {kind: 'invalid', reason: `unexpected extra argument: ${positionals[1]}`}
  const [version] = positionals
  if (version !== undefined && !SEMVER.test(version)) {
    return {kind: 'invalid', reason: `not an exact x.y.z version: ${version}`}
  }
  if (check && version !== undefined) {
    return {kind: 'invalid', reason: '--check verifies the file as it is; do not pass a version'}
  }
  return check ? {kind: 'check'} : {kind: 'sync', version}
}

/** The I/O the CLI performs, injected so it can be tested without a network or the real pin file. */
export interface SyncIo {
  readonly fetch: (
    url: string,
    init: {readonly signal: AbortSignal},
  ) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>
  readonly readPin: () => string
  readonly writePin: (contents: string) => void
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const defaultIo: SyncIo = {
  fetch: async (url, init) => fetch(url, {...init, redirect: 'follow'}),
  readPin: () => readFileSync(PIN_PATH, 'utf8'),
  writePin: contents => writeFileSync(PIN_PATH, contents),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

async function fetchSums(io: SyncIo, version: string): Promise<ReadonlyMap<string, string>> {
  const url = `${RELEASE_BASE_URL}/v${version}/SHA256SUMS`
  const response = await io.fetch(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)})
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return parseSha256Sums(await response.text())
}

/**
 * Run the CLI and return its exit code: 0 on success, 1 on a failed sync or a stale `--check`, 2 on a rejected command
 * line. The arguments are validated before any read, fetch or write, and the pin is written only after a successful fetch.
 */
export async function main(argv: readonly string[], io: SyncIo = defaultIo): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.kind === 'invalid') {
    io.stderr(`sync-opencode-v2-pin: ${parsed.reason}\n${USAGE}\n`)
    return EXIT_USAGE
  }
  try {
    const rawCurrent = io.readPin()
    const current = parsePin(JSON.parse(rawCurrent))
    const requested = parsed.kind === 'sync' ? parsed.version : undefined
    const target: OpenCodeV2Pin = {version: requested ?? current.version, assets: current.assets}
    const next = syncPinDigests(target, await fetchSums(io, target.version))
    const changed = serializePin(next) !== serializePin(current)

    if (parsed.kind === 'check') {
      if (changed) throw new Error(`opencode-v2-pin.json disagrees with the v${current.version} SHA256SUMS`)
      io.stdout(`opencode-v2-pin.json matches the v${current.version} SHA256SUMS\n`)
      return 0
    }
    if (changed) io.writePin(serializePin(next))
    io.stdout(
      changed ? `rewrote opencode-v2-pin.json for v${next.version}\n` : 'opencode-v2-pin.json is already current\n',
    )
    return 0
  } catch (error) {
    io.stderr(`sync-opencode-v2-pin: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2))
}
