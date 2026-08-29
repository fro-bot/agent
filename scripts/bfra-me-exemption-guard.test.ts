import {globSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

interface PackageJson {
  readonly workspaces?: unknown
  readonly dependencies?: unknown
  readonly devDependencies?: unknown
  readonly peerDependencies?: unknown
  readonly optionalDependencies?: unknown
}

export interface BunfigExcludes {
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
  return (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const).flatMap(field => {
    const value = packageJson[field]
    if (value === undefined) return []
    return Object.keys(recordValue(value, field))
  })
}

const JSON_COMPATIBLE_ARRAY_ERROR =
  'minimumReleaseAgeExcludes must be a JSON-compatible array (double quotes, no trailing comma, no inline comments)'

export function parseBunfigExcludes(source: string): BunfigExcludes {
  const lines = source.split(/\r?\n/)
  const lineIndex = lines.findIndex(line => /^\s*minimumReleaseAgeExcludes\s*=/.test(line))
  if (lineIndex === -1) {
    throw new Error('bunfig.toml must define minimumReleaseAgeExcludes')
  }

  const line = lines[lineIndex]
  if (line === undefined) {
    throw new Error(`bunfig.toml:${lineIndex + 1} minimumReleaseAgeExcludes is unreadable`)
  }
  const equalsIndex = line.indexOf('=')
  if (equalsIndex === -1) {
    throw new Error(`bunfig.toml:${lineIndex + 1} minimumReleaseAgeExcludes must be an assignment`)
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
    throw new Error(`bunfig.toml:${lineIndex + 1} ${JSON_COMPATIBLE_ARRAY_ERROR}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(arraySource.slice(0, closingBracket + 1)) as unknown
  } catch {
    throw new Error(`bunfig.toml:${lineIndex + 1} ${JSON_COMPATIBLE_ARRAY_ERROR}`)
  }

  let entries: readonly string[]
  try {
    entries = stringArray(parsed, `bunfig.toml:${lineIndex + 1}`)
  } catch {
    throw new Error(`bunfig.toml:${lineIndex + 1} ${JSON_COMPATIBLE_ARRAY_ERROR}`)
  }
  return {entries, lineNumber: lineIndex + 1}
}

function readBunfigExcludes(path: string): BunfigExcludes {
  return parseBunfigExcludes(readFileSync(path, 'utf8'))
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

describe('parseBunfigExcludes', () => {
  it('parses a multi-line JSON-compatible array and preserves its assignment line', () => {
    // #given a Bun configuration whose exemption array spans multiple lines
    const source = '[install]\nminimumReleaseAgeExcludes = [\n  "@bfra.me/es",\n  "@bfra.me/tsconfig"\n]\n'

    // #when / #then
    expect(parseBunfigExcludes(source)).toEqual({
      entries: ['@bfra.me/es', '@bfra.me/tsconfig'],
      lineNumber: 2,
    })
  })

  it('ignores a trailing comment after the exemption array', () => {
    // #given an exemption array followed by a TOML comment
    const source = 'minimumReleaseAgeExcludes = ["@bfra.me/es"] # first-party package\n'

    // #when / #then
    expect(parseBunfigExcludes(source)).toEqual({entries: ['@bfra.me/es'], lineNumber: 1})
  })

  it('reports a missing exemption key', () => {
    // #given Bun configuration without the exemption setting
    const source = 'minimumReleaseAge = 259200\n'

    // #when / #then
    expect(() => parseBunfigExcludes(source)).toThrow('bunfig.toml must define minimumReleaseAgeExcludes')
  })

  it('reports an exemption array without a closing bracket', () => {
    // #given an unterminated exemption array
    const source = 'minimumReleaseAgeExcludes = ["@bfra.me/es"\n'

    // #when / #then
    expect(() => parseBunfigExcludes(source)).toThrow(`bunfig.toml:1 ${JSON_COMPATIBLE_ARRAY_ERROR}`)
  })

  it.each([
    ['a trailing comma', 'minimumReleaseAgeExcludes = ["@bfra.me/es",]\n'],
    ['single-quoted entries', "minimumReleaseAgeExcludes = ['@bfra.me/es']\n"],
    [
      'an inline comment inside the array',
      'minimumReleaseAgeExcludes = ["@bfra.me/es", # comment\n"@bfra.me/tsconfig"]\n',
    ],
  ])('rejects %s with an instructive JSON compatibility error', (_label, source) => {
    // #given an exemption array that is not valid JSON

    // #when / #then
    expect(() => parseBunfigExcludes(source)).toThrow(`bunfig.toml:1 ${JSON_COMPATIBLE_ARRAY_ERROR}`)
  })
})

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

  it('flags first-party peer and optional dependencies missing from exemptions', () => {
    // #given first-party packages declared through the widened dependency fields
    const dependencies = dependencyNames({
      peerDependencies: {'@bfra.me/peer-package': '1.0.0'},
      optionalDependencies: {'@bfra.me/optional-package': '1.0.0'},
    })

    // #when / #then
    expect(checkBfraMeExemptions([], dependencies)).toEqual({
      missingDependencies: ['@bfra.me/optional-package', '@bfra.me/peer-package'],
      invalidExcludes: [],
    })
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
