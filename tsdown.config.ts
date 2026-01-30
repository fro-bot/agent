import type {Plugin} from 'rolldown'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {getProjectLicenses} from 'generate-license-file'
import {readPackageUp} from 'read-package-up'
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

/**
 * Rolldown plugin that collects license information from bundled dependencies.
 *
 * Generates dist/licenses.txt with deduplicated highest version of each package,
 * including license type and full license text. Packages are resolved from
 * node_modules to extract license metadata from package.json.
 *
 * @returns Rolldown plugin with writeBundle hook
 */
function licenseCollectorPlugin(): Plugin {
  return {
    name: 'license-collector',
    async writeBundle() {
      const highestVersions = new Map<string, {version: string; license: string; content: string}>()

      const licenses = await getProjectLicenses('./package.json')

      for (const license of licenses) {
        for (const dep of license.dependencies) {
          const pkgName = parsePackageName(dep)
          const version = dep.split('@').pop()

          if (version != null) {
            const existing = highestVersions.get(pkgName)
            if (existing == null || compareVersions(existing.version, version) < 0) {
              let licenseType = 'Unknown'
              try {
                const result = await readPackageUp({cwd: join('node_modules', pkgName)})
                licenseType = result?.packageJson.license ?? 'Unknown'
              } catch (error) {
                console.error(
                  `Failed to read package.json for ${pkgName}@${version}: ${error instanceof Error ? error.message : String(error)}`,
                )
              }
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
