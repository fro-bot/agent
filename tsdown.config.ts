import type {Plugin} from 'rolldown'
import {execFile} from 'node:child_process'
import {readdir, readFile, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {getProjectLicenses} from 'generate-license-file'
import {defineConfig} from 'tsdown'

function parsePackageName(dep: string): string {
  const name = dep.split('@').find(Boolean) ?? ''
  return dep.startsWith('@') ? `@${name}` : name
}

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

/**
 * Match the same hidden-Unicode characters Renovate flags via
 * `lib/util/unicode.ts` in the renovatebot/renovate repo. Bundled vendor code
 * (e.g. @actions/artifact's HTML entity tables) embeds these as raw bytes,
 * which trips Renovate's "Hidden Unicode characters" warning on the dependency
 * dashboard. Replacing the raw bytes with `\uXXXX` JS escapes preserves the
 * runtime string value but keeps the on-disk bytes ASCII-only.
 */
const HIDDEN_UNICODE_RE = /[\u00A0\u00AD\u1680\u2000-\u200C\u200E\u200F\u2028\u2029\u202A-\u202F\u205F\u3000\uFEFF]/g

function escapeHiddenUnicodePlugin(): Plugin {
  return {
    name: 'escape-hidden-unicode',
    async writeBundle(options) {
      const dir = options.dir ?? 'dist'
      const entries = await readdir(dir)
      await Promise.all(
        entries.map(async name => {
          if (!name.endsWith('.js')) return
          const path = join(dir, name)
          const info = await stat(path)
          if (!info.isFile()) return
          const content = await readFile(path, 'utf8')
          if (!HIDDEN_UNICODE_RE.test(content)) return
          HIDDEN_UNICODE_RE.lastIndex = 0
          const fixed = content.replace(HIDDEN_UNICODE_RE, char => {
            const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
            return String.raw`\u${code}`
          })
          await writeFile(path, fixed)
        }),
      )
    },
  }
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
  entry: ['apps/action/src/main.ts', 'apps/action/src/post.ts'],
  fixedExtension: false,
  inlineOnly: false,
  minify: true,
  plugins: [licenseCollectorPlugin(), escapeHiddenUnicodePlugin()],
  noExternal: id => {
    if (id.startsWith('@bfra.me/es')) return true
    if (id.startsWith('@actions/')) return true
    if (id.startsWith('@octokit/auth-app')) return true
    if (id.startsWith('@opencode-ai/sdk')) return true
    if (id.startsWith('@aws-sdk/')) return true
    if (id.startsWith('@smithy/')) return true
    if (id.startsWith('@fro-bot/runtime')) return true
    return false
  },
})
