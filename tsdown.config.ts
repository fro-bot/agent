import type {Plugin} from 'rolldown'
import {execFile} from 'node:child_process'
import {writeFile} from 'node:fs/promises'
import {promisify} from 'node:util'
import {getProjectLicenses} from 'generate-license-file'
import {defineConfig} from 'tsdown'
import {buildLicenseTypeMap, type PnpmLicensesJson} from './src/utils/license-collector.js'

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

/**
 * Rolldown plugin that collects license information from bundled dependencies.
 *
 * Generates dist/licenses.txt with deduplicated highest version of each package,
 * including license type and full license text. Packages are resolved from
 * node_modules to extract license metadata from package.json.
 *
 * @returns Rolldown plugin with writeBundle hook
 */
interface PnpmLicenseEntryCandidate {
  readonly name?: unknown
  readonly versions?: unknown
  readonly version?: unknown
  readonly license?: unknown
}

const execFileAsync = promisify(execFile)

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

      await writeFile('dist/licenses.txt', output)
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
