import {globSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

interface PackageJson {
  readonly name?: unknown
  readonly scripts?: unknown
  readonly workspaces?: unknown
}

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (Array.isArray(value) === false || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  return value.filter((item): item is string => typeof item === 'string')
}

function workspacePackagePaths(root: string, workspaces: readonly string[]): readonly string[] {
  const paths = workspaces.flatMap(pattern => globSync(join(pattern, 'package.json'), {cwd: root}))
  return [...new Set(paths)].sort().map(path => join(root, path))
}

function packageName(packageJson: PackageJson, path: string): string {
  if (typeof packageJson.name !== 'string' || packageJson.name.length === 0) {
    throw new TypeError(`${relative(process.cwd(), path)} must declare a non-empty package name`)
  }
  return packageJson.name
}

function packageHasTestScript(packageJson: PackageJson): boolean {
  if (packageJson.scripts === undefined) return false
  const scripts = recordValue(packageJson.scripts, 'scripts')
  return typeof scripts.test === 'string'
}

// Assumes the chain's uniform `bun run --filter <name> test` shape. A variant such as
// `--filter <name> run test`, or a flag between the name and `test`, reads as missing.
function referencesPackageTest(rootTestScript: string, name: string): boolean {
  const tokens = rootTestScript.trim().split(/\s+/)
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '--filter' && tokens[index + 1] === name && tokens[index + 2] === 'test') return true
  }
  return false
}

describe('root test chain', () => {
  it('invokes every workspace package that declares a test script', () => {
    // #given the root package and every package selected by its workspace globs
    const root = process.cwd()
    const rootPackage = readPackageJson(join(root, 'package.json'))
    const rootScripts = recordValue(rootPackage.scripts, 'root scripts')
    const rootTestScript = rootScripts.test
    if (typeof rootTestScript !== 'string') {
      throw new TypeError('root package.json scripts.test must be a string')
    }
    const workspaces = stringArray(rootPackage.workspaces, 'root package.json workspaces')
    const packagePaths = workspacePackagePaths(root, workspaces)

    // #when each workspace package with a test script is checked against the root chain
    const missingPackages = packagePaths.flatMap(path => {
      const packageJson = readPackageJson(path)
      const name = packageName(packageJson, path)
      if (packageHasTestScript(packageJson) && referencesPackageTest(rootTestScript, name) === false) {
        return [name]
      }
      return []
    })

    // #then the root chain must name every package whose own test script should run
    if (missingPackages.length > 0) {
      const additions = missingPackages.map(name => `"bun run --filter ${name} test"`).join(', ')
      throw new Error(
        `Root package.json scripts.test is missing workspace packages: ${missingPackages.join(', ')}; ` +
          `add ${additions} to the test chain.`,
      )
    }
    expect(missingPackages).toEqual([])
  })
})
