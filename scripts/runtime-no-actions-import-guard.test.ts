import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'
import {describe, expect, it} from 'vitest'

// `@fro-bot/runtime` is shared by the Action, the gateway, and the harness. The gateway Docker image builds
// `packages/gateway` (and the runtime it depends on) without the Action toolkit, and runtime returns plain values
// rather than touching the GitHub Actions runtime. Nothing enforces that boundary mechanically: the ESLint phantom
// guard unions root and package manifests, so an `@actions/core` import in runtime would resolve and pass lint.
// This guard fails the build if any `.ts` file under `packages/runtime/src` (tests included) imports or requires
// an `@actions/*` module.
const RUNTIME_SRC = join(import.meta.dirname, '..', 'packages', 'runtime', 'src')

// Static `import ... from '@actions/x'`, side-effect `import '@actions/x'`, `export ... from '@actions/x'`,
// dynamic `import('@actions/x')`, and `require('@actions/x')`.
const ACTIONS_MODULE_PATTERNS = [
  /\bfrom\s*['"]@actions\//,
  /\bimport\s*['"]@actions\//,
  /\bimport\s*\(\s*['"]@actions\//,
  /\brequire\s*\(\s*['"]@actions\//,
] as const

function findActionsImports(source: string): readonly number[] {
  const lines = source.split('\n')
  const hits: number[] = []
  for (const [index, line] of lines.entries()) {
    if (ACTIONS_MODULE_PATTERNS.some(pattern => pattern.test(line))) hits.push(index + 1)
  }
  return hits
}

function listTypeScriptFiles(directory: string): readonly string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

describe('runtime stays free of @actions/* imports', () => {
  it('finds runtime source files to scan', () => {
    // #given / #when
    const files = listTypeScriptFiles(RUNTIME_SRC)

    // #then — a path typo would otherwise make the guard pass vacuously
    expect(files.length).toBeGreaterThan(0)
  })

  it('no file under packages/runtime/src imports or requires @actions/*', () => {
    // #given
    const files = listTypeScriptFiles(RUNTIME_SRC)

    // #when
    const offenders = files.flatMap(file =>
      findActionsImports(readFileSync(file, 'utf8')).map(line => `${relative(RUNTIME_SRC, file)}:${line}`),
    )

    // #then
    expect(offenders).toEqual([])
  })

  it.each([
    ["import * as core from '@actions/core'", true],
    ["import {getInput} from '@actions/core'", true],
    ["import type {Context} from '@actions/github'", true],
    ["import '@actions/core'", true],
    ["export {context} from '@actions/github'", true],
    ["const core = await import('@actions/core')", true],
    ["const core = require('@actions/core')", true],
    ['import {getInput} from "@actions/core"', true],
    ["import {x} from '@fro-bot/runtime'", false],
    ["import {x} from './actions/core.js'", false],
    ['// @actions/core is intentionally not used here', false],
    ["const note = 'see @actions/core docs'", false],
  ] as const)('detects %s -> %s', (source, expected) => {
    // #given / #when / #then
    expect(findActionsImports(source).length > 0).toBe(expected)
  })
})
