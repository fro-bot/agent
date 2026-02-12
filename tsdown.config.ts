import type {Plugin} from 'rolldown'
import {execFile} from 'node:child_process'
import {writeFile} from 'node:fs/promises'
import {promisify} from 'node:util'
import {getProjectLicenses} from 'generate-license-file'
import {defineConfig} from 'tsdown'

/**
 * Extracts package name from dependency string.
 */
function parsePackageName(dep: string): string {
  const name = dep.split('@').find(Boolean) ?? ''
  return dep.startsWith('@') ? `@${name}` : name
}

/**
 * Compares two semantic version strings.
 */
function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(Number)
  const bParts = b.split('.').map(Number)
  const length = Math.max(aParts.length, bParts.length)

  for (let i = 0; i < length; i++) {
    const aPart = aParts[i] ?? 0
    const bPart = bParts[i] ?? 0
    if (aPart !== bPart) {
      return aPart - bPart
    }
  }
  return 0
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

const execFileAsync = promisify(execFile)

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
  const {stdout} = await execFileAsync('pnpm', ['licenses', 'list', '--json', '--prod'], {
    encoding: 'utf8',
  })

  const parsed: unknown = JSON.parse(stdout)
  if (!isPnpmLicensesJson(parsed)) {
    throw new Error('pnpm licenses list returned invalid JSON')
  }

  return parsed
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

function licenseCollectorPlugin(): Plugin {
  return {
    name: 'license-collector',
    async writeBundle() {
      const highestVersions = new Map<string, {version: string; license: string; content: string}>()
      const licenseTypeMap = buildLicenseTypeMap(await getPnpmLicensesJson())

      const licenses = await getProjectLicenses('./package.json')

      for (const license of licenses) {
        for (const dep of license.dependencies) {
          const pkgName = parsePackageName(dep)
          const version = dep.split('@').pop()

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

      const output = Array.from(highestVersions.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, {version, license, content}]) => `${name}@${version}\n${license}\n${content}`)
        .join('\n\n')

      await writeFile('dist/licenses.txt', output.replaceAll('\r\n', '\n'))
    },
  }
}

export default defineConfig({
  entry: ['src/main.ts', 'src/post.ts'],
  fixedExtension: false,
  inlineOnly: false,
  minify: true,
  plugins: [licenseCollectorPlugin()],
  noExternal: id => {
    // Bundle all @bfra.me/es subpaths
    if (id.startsWith('@bfra.me/es')) return true
    // Bundle all @actions/* packages
    if (id.startsWith('@actions/')) return true
    // Bundle @octokit/auth-app
    if (id.startsWith('@octokit/auth-app')) return true
    // Bundle @opencode-ai/sdk (RFC-013)
    if (id.startsWith('@opencode-ai/sdk')) return true
    return false
  },
})
