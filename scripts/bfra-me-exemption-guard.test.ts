import {globSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

interface PackageJson {
  readonly workspaces?: unknown
  readonly dependencies?: unknown
  readonly devDependencies?: unknown
}

interface BunfigExcludes {
  readonly entries: readonly string[]
  readonly lineNumber: number
}

export interface BfraMeExemptionCheck {
  readonly missingDependencies: readonly string[]
  readonly invalidExcludes: readonly string[]
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

function isBfraMePackage(name: string): boolean {
  return /^@bfra\.me\/[^/]+$/.test(name)
}

function dependencyNames(packageJson: PackageJson): readonly string[] {
  return (['dependencies', 'devDependencies'] as const).flatMap(field => {
    const value = packageJson[field]
    if (value === undefined) return []
    return Object.keys(recordValue(value, field))
  })
}

function readBunfigExcludes(path: string): BunfigExcludes {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const lineIndex = lines.findIndex(line => /^\s*minimumReleaseAgeExcludes\s*=/.test(line))
  if (lineIndex === -1) {
    throw new Error(`${path} must define minimumReleaseAgeExcludes`)
  }

  const line = lines[lineIndex]
  if (line === undefined) {
    throw new Error(`${path}:${lineIndex + 1} minimumReleaseAgeExcludes is unreadable`)
  }
  const equalsIndex = line.indexOf('=')
  if (equalsIndex === -1) {
    throw new Error(`${path}:${lineIndex + 1} minimumReleaseAgeExcludes must be an assignment`)
  }
  let arraySource = line.slice(equalsIndex + 1).trim()
  let nextLine = lineIndex + 1
  while (arraySource.includes(']') === false && nextLine < lines.length) {
    const continuation = lines[nextLine]
    if (continuation === undefined) break
    arraySource += `\n${continuation.trim()}`
    nextLine += 1
  }

  const closingBracket = arraySource.indexOf(']')
  if (closingBracket === -1) {
    throw new Error(`${path}:${lineIndex + 1} minimumReleaseAgeExcludes must be an array`)
  }

  const entries = stringArray(
    JSON.parse(arraySource.slice(0, closingBracket + 1)) as unknown,
    `${path}:${lineIndex + 1}`,
  )
  return {entries, lineNumber: lineIndex + 1}
}

export function checkBfraMeExemptions(
  excludes: readonly string[],
  dependencies: readonly string[],
): BfraMeExemptionCheck {
  const uniqueDependencies = [...new Set(dependencies)].filter(isBfraMePackage).sort()
  const uniqueExcludes = [...new Set(excludes)]

  return {
    missingDependencies: uniqueDependencies.filter(dependency => uniqueExcludes.includes(dependency) === false),
    invalidExcludes: uniqueExcludes.filter(entry => isBfraMePackage(entry) === false),
  }
}

function actionableMessage(check: BfraMeExemptionCheck, lineNumber: number): string {
  const configLine = `bunfig.toml:${lineNumber}`
  const messages: string[] = []
  if (check.missingDependencies.length > 0) {
    messages.push(
      `minimumReleaseAgeExcludes is missing @bfra.me dependencies: ${check.missingDependencies.join(', ')}; ` +
        `add them to ${configLine}.`,
    )
  }
  if (check.invalidExcludes.length > 0) {
    messages.push(
      `minimumReleaseAgeExcludes contains non-@bfra.me packages: ${check.invalidExcludes.join(', ')}; ` +
        `remove them from ${configLine}.`,
    )
  }
  return messages.join(' ')
}

describe('checkBfraMeExemptions', () => {
  it('reports a first-party dependency missing from the exemption list', () => {
    // #given a newly introduced first-party dependency without a matching exemption
    const check = checkBfraMeExemptions(['@bfra.me/es'], ['@bfra.me/es', '@bfra.me/new-package'])

    // #when / #then
    expect(check).toEqual({missingDependencies: ['@bfra.me/new-package'], invalidExcludes: []})
    expect(actionableMessage(check, 20)).toContain(
      'missing @bfra.me dependencies: @bfra.me/new-package; add them to bunfig.toml:20.',
    )
  })

  it('reports an exemption entry outside the first-party scope', () => {
    // #given an exemption list that accidentally names a third-party package
    const check = checkBfraMeExemptions(['@bfra.me/es', 'lodash'], ['@bfra.me/es'])

    // #when / #then
    expect(check).toEqual({missingDependencies: [], invalidExcludes: ['lodash']})
    expect(actionableMessage(check, 20)).toContain('non-@bfra.me packages: lodash; remove them from bunfig.toml:20.')
  })

  it('allows a retained first-party exemption when its dependency is temporarily absent', () => {
    // #given a stale first-party exemption for a temporarily removed dependency
    const check = checkBfraMeExemptions(['@bfra.me/es', '@bfra.me/temporarily-removed'], ['@bfra.me/es'])

    // #when / #then
    expect(check).toEqual({missingDependencies: [], invalidExcludes: []})
  })
})

describe('bfra.me minimum release age exemption guard', () => {
  it('exempts every first-party dependency without weakening the exemption scope', () => {
    // #given the root package, its workspace manifests, and the Bun configuration on disk
    const root = process.cwd()
    const rootPackage = readPackageJson(join(root, 'package.json'))
    const workspaces = stringArray(rootPackage.workspaces, 'root package.json workspaces')
    const packagePaths = [join(root, 'package.json'), ...workspacePackagePaths(root, workspaces)]
    const dependencies = packagePaths.flatMap(path => dependencyNames(readPackageJson(path)))
    const bunfig = readBunfigExcludes(join(root, 'bunfig.toml'))

    // #when every discovered first-party dependency is checked against the configured exemptions
    const check = checkBfraMeExemptions(bunfig.entries, dependencies)

    // #then drift reports the exact assignment line that needs updating
    const failureMessage = actionableMessage(check, bunfig.lineNumber)
    if (failureMessage.length > 0) throw new Error(failureMessage)
    expect(check).toEqual({missingDependencies: [], invalidExcludes: []})
  })
})
