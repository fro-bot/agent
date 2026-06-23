// Shared license-notice generation module.
//
// Collects third-party license data from the installed node_modules and
// formats it into the THIRD_PARTY_NOTICES.txt content string. Does NOT write
// any files — callers are responsible for writing the result.
//
// Run via: node --experimental-strip-types scripts/third-party-notices.ts
// (or import collectThirdPartyNotices from other scripts)
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. Test files use .js imports for Vitest.

import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {getProjectLicenses} from 'generate-license-file'

const execFileAsync = promisify(execFile)

/**
 * Formats the real diagnostics from a failed child-process invocation.
 *
 * execFile rejections carry `stderr`, `stdout`, `code`, and `signal` alongside
 * `message`, but `message` alone is just the generic "Command failed: ..." line.
 * When a license-tooling command fails in a constrained environment (e.g. a
 * Renovate runner), the actual reason lives in `stderr`/`stdout` — so surface
 * all of it instead of swallowing it behind the generic message.
 */
export function formatChildProcessError(error: unknown): string {
  if (error == null || typeof error !== 'object') {
    return String(error)
  }
  const record = error as {
    message?: unknown
    stderr?: unknown
    stdout?: unknown
    code?: unknown
    signal?: unknown
  }
  const parts: string[] = []
  if (typeof record.message === 'string' && record.message.length > 0) {
    parts.push(record.message)
  }
  if (record.code != null) {
    parts.push(`exitCode=${String(record.code)}`)
  }
  if (record.signal != null) {
    parts.push(`signal=${String(record.signal)}`)
  }
  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : ''
  if (stderr.length > 0) {
    parts.push(`stderr:\n${stderr}`)
  }
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : ''
  if (stdout.length > 0) {
    parts.push(`stdout:\n${stdout}`)
  }
  return parts.length > 0 ? parts.join('\n') : String(error)
}

export interface LicenseEntry {
  readonly version: string
  readonly license: string
  readonly content: string
}

/**
 * Formats collected license entries into the THIRD_PARTY_NOTICES output string.
 * Sorts by package name (locale-aware), normalizes line endings to LF.
 * Exported for unit testing.
 *
 * Attribution keeps the highest resolved version's license text per package.
 * This is safe when the license text is identical across resolved versions of
 * the same package, which holds for the vast majority of npm packages. The CI
 * CycloneDX SBOM (pnpm sbom) is the complete per-version inventory.
 */
export function formatThirdPartyNotices(entries: ReadonlyMap<string, LicenseEntry>): string {
  return Array.from(entries.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, {version, license, content}]) => `${name}@${version}\n${license}\n${content}`)
    .join('\n\n')
    .replaceAll('\r\n', '\n')
}

interface PnpmLicenseEntry {
  readonly name: string
  readonly versions?: readonly string[]
  readonly version?: string
  readonly license?: string | null
}

interface PnpmLicensesJson extends Record<string, readonly PnpmLicenseEntry[]> {}

interface PnpmLicenseEntryCandidate {
  readonly name?: unknown
  readonly versions?: unknown
  readonly version?: unknown
  readonly license?: unknown
}

function isPnpmLicensesJson(value: unknown): value is PnpmLicensesJson {
  if (value == null || typeof value !== 'object') {
    return false
  }

  return Object.values(value).every(entries => {
    if (!Array.isArray(entries)) {
      return false
    }

    return entries.every(entry => {
      if (entry == null || typeof entry !== 'object') {
        return false
      }

      const candidate = entry as PnpmLicenseEntryCandidate
      if (typeof candidate.name !== 'string') {
        return false
      }

      if (candidate.versions != null && !Array.isArray(candidate.versions)) {
        return false
      }

      if (candidate.version != null && typeof candidate.version !== 'string') {
        return false
      }

      if (candidate.license != null && typeof candidate.license !== 'string') {
        return false
      }

      return true
    })
  })
}

async function getPnpmLicensesJson(): Promise<PnpmLicensesJson> {
  try {
    const {stdout} = await execFileAsync('pnpm', ['licenses', 'list', '--json', '--prod'], {
      encoding: 'utf8',
    })

    const parsed: unknown = JSON.parse(stdout)
    if (!isPnpmLicensesJson(parsed)) {
      console.warn('[license-collector] pnpm licenses list returned invalid JSON; falling back to empty map')
      return {}
    }

    return parsed
  } catch (error) {
    console.warn(
      `[license-collector] pnpm licenses list failed; license types will be "Unknown"\n${formatChildProcessError(error)}`,
    )
    return {}
  }
}

function buildLicenseTypeMap(entries: PnpmLicensesJson): Map<string, string> {
  const map = new Map<string, string>()

  for (const [licenseKey, items] of Object.entries(entries)) {
    for (const item of items) {
      let versions = item.versions
      if (versions == null) {
        const singleVersion = item.version
        versions = singleVersion == null ? [] : [singleVersion]
      }
      const licenseType = item.license ?? licenseKey

      for (const version of versions) {
        map.set(`${item.name}@${version}`, licenseType)
      }
    }
  }

  return map
}

function parsePackageName(dep: string): string {
  const name = dep.split('@').find(Boolean) ?? ''
  return dep.startsWith('@') ? `@${name}` : name
}

/**
 * Splits a `name@version` (or `@scope/name@version`) dependency string into its
 * version segment, or `null` when there is no version segment. A scoped name's
 * leading `@` is ignored so `@scope/pkg` (no version) yields `null` rather than
 * mistaking the scope/name for a version.
 */
function parseDepVersion(dep: string): string | null {
  const atIndex = dep.lastIndexOf('@')
  if (atIndex <= 0) {
    return null
  }
  const version = dep.slice(atIndex + 1)
  return version === '' ? null : version
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  const length = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < length; i++) {
    const aPart = aParts[i] ?? 0
    const bPart = bParts[i] ?? 0
    // A non-numeric segment (NaN) must not make a comparison silently false,
    // which would let a malformed entry latch and never be replaced by a real
    // version. Treat a malformed segment as strictly lower than a numeric one so
    // a valid version always wins.
    const aNaN = Number.isNaN(aPart)
    const bNaN = Number.isNaN(bPart)
    if (aNaN || bNaN) {
      if (aNaN && bNaN) {
        continue
      }
      return aNaN ? -1 : 1
    }
    if (aPart !== bPart) {
      return aPart - bPart
    }
  }
  return 0
}

/**
 * Collects third-party license notices from the installed node_modules and
 * returns the formatted THIRD_PARTY_NOTICES.txt content as a string.
 *
 * - getPnpmLicensesJson() is fail-soft: per-dependency gaps produce "Unknown"
 *   license types rather than throwing.
 * - getProjectLicenses() is fail-closed: a total failure here means the notice
 *   would be incomplete, so this function throws with a rich error including the
 *   underlying cause/stderr.
 *
 * @param packageJsonPath - Path to the root package.json (default: './package.json').
 *   Pass an absolute path when the caller's cwd differs from the repo root.
 *
 * Does NOT write any files. Callers decide what to do with the result.
 */
export async function collectThirdPartyNotices(packageJsonPath = './package.json'): Promise<string> {
  const highestVersions = new Map<string, LicenseEntry>()
  const licenseTypeMap = buildLicenseTypeMap(await getPnpmLicensesJson())

  let licenses: Awaited<ReturnType<typeof getProjectLicenses>>
  try {
    licenses = await getProjectLicenses(packageJsonPath)
  } catch (error) {
    const diagnostics = formatChildProcessError(error)
    throw new Error(
      `[license-collector] license collection failed; cannot produce THIRD_PARTY_NOTICES.txt:\n${diagnostics}`,
      {cause: error instanceof Error ? error : new Error(diagnostics)},
    )
  }

  for (const license of licenses) {
    for (const dep of license.dependencies) {
      const pkgName = parsePackageName(dep)
      const version = parseDepVersion(dep)

      if (version != null) {
        const existing = highestVersions.get(pkgName)
        if (existing == null || compareVersions(existing.version, version) < 0) {
          const licenseType = licenseTypeMap.get(`${pkgName}@${version}`) ?? 'Unknown'
          highestVersions.set(pkgName, {
            version,
            license: licenseType,
            content: license.content,
          })
        }
      }
    }
  }

  return formatThirdPartyNotices(highestVersions)
}
