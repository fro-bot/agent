import type {Plugin} from 'rolldown'
import {execFile} from 'node:child_process'
import {readdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {getProjectLicenses} from 'generate-license-file'
import {defineConfig} from 'tsdown'
import {BINARY_EXTENSIONS, HIDDEN_UNICODE_REPLACE_RE, HIDDEN_UNICODE_TEST_RE} from './scripts/dist-hidden-unicode.ts'

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
      `[license-collector] pnpm licenses list failed (${error instanceof Error ? error.message : String(error)}); license types will be "Unknown"`,
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

function escapeHiddenUnicodePlugin(): Plugin {
  return {
    name: 'escape-hidden-unicode',
    async writeBundle(options) {
      const dir = options.dir ?? 'dist'
      // `withFileTypes` avoids the stat→read TOCTOU CodeQL flags.
      const entries = await readdir(dir, {withFileTypes: true})
      await Promise.all(
        entries.map(async entry => {
          if (!entry.isFile()) return
          const ext = entry.name.split('.').pop() ?? ''
          if (BINARY_EXTENSIONS.has(ext)) return
          const path = join(dir, entry.name)
          const content = await readFile(path, 'utf8')
          if (!HIDDEN_UNICODE_TEST_RE.test(content)) return
          // Fresh /g regex per file to avoid lastIndex leakage across concurrent Promise.all iterations
          const re = new RegExp(HIDDEN_UNICODE_REPLACE_RE.source, 'g')
          const fixed = content.replaceAll(re, char => {
            const code = char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
            return String.raw`\u${code}`
          })
          await writeFile(path, fixed)
        }),
      )
    },
  }
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

function licenseCollectorPlugin(): Plugin {
  return {
    name: 'license-collector',
    async writeBundle() {
      const highestVersions = new Map<string, LicenseEntry>()
      const licenseTypeMap = buildLicenseTypeMap(await getPnpmLicensesJson())

      // Fail closed: license collection reads resolved license text from installed
      // node_modules, so a total failure here means the notice would be incomplete.
      // Throw rather than write nothing (a missing per-dependency license is handled
      // by generate-license-file and does not reach this catch).
      let licenses: Awaited<ReturnType<typeof getProjectLicenses>>
      try {
        licenses = await getProjectLicenses('./package.json')
      } catch (error) {
        throw new Error(
          `[license-collector] license collection failed; cannot produce THIRD_PARTY_NOTICES.txt: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

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

      await writeFile('dist/THIRD_PARTY_NOTICES.txt', formatThirdPartyNotices(highestVersions))
    },
  }
}

// Guard: the action is code-split, so the OpenCode default version literal can
// land in a shared chunk rather than main.js. A harness default carries a
// `+harness.<sha>` build-metadata suffix that a minifier could strip or collapse
// against the stock fallback; this fails the build if the configured default does
// not survive into the emitted bundle.

/**
 * Pure assertion: throws if `expected` is not present in any of the provided chunk contents.
 * Exported for unit testing; the plugin calls this after reading chunks from disk.
 */
export function assertVersionPresent(expected: string, chunkContents: readonly string[]): void {
  if (!chunkContents.some(c => c.includes(expected))) {
    throw new Error(
      `[default-version-invariant] DEFAULT_OPENCODE_VERSION '${expected}' is absent from every dist chunk — the bundler likely stripped its build metadata. Aborting to prevent shipping a silent stock default.`,
    )
  }
}

function defaultVersionInvariantPlugin(): Plugin {
  return {
    name: 'default-version-invariant',
    async writeBundle() {
      const constantsSource = await readFile('packages/runtime/src/shared/constants.ts', 'utf8')
      const match = /DEFAULT_OPENCODE_VERSION\s*=\s*'([^']+)'/.exec(constantsSource)
      if (match?.[1] == null) {
        throw new Error('[default-version-invariant] could not read DEFAULT_OPENCODE_VERSION from source')
      }
      const expected = match[1]
      const chunks = (await readdir('dist')).filter(name => name.endsWith('.js'))
      const chunkContents = await Promise.all(chunks.map(async name => readFile(join('dist', name), 'utf8')))
      assertVersionPresent(expected, chunkContents)
    },
  }
}

export default defineConfig({
  entry: ['apps/action/src/main.ts', 'apps/action/src/post.ts'],
  fixedExtension: false,
  inlineOnly: false,
  minify: true,
  // Source maps roughly triple committed dist/ size and the action never reads them.
  sourcemap: false,
  plugins: [licenseCollectorPlugin(), escapeHiddenUnicodePlugin(), defaultVersionInvariantPlugin()],
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
