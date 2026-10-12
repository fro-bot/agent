import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
interface PackageJson {
  readonly bin?: Record<string, string>
}

function readPackageJson(file: string): PackageJson {
  return JSON.parse(readFileSync(file, 'utf8')) as PackageJson
}

describe('@fro.bot/harness package invariants', () => {
  it('declares exactly the harness and opencode bins', () => {
    // #given the harness package.json
    const pkg = readPackageJson(path.join(PACKAGE_ROOT, 'package.json'))

    // #then bin maps exactly those two commands to the built entry points
    expect(pkg.bin).toEqual({harness: './dist/cli.mjs', opencode: './dist/opencode.mjs'})
  })

  it('builds the opencode entry point', () => {
    // #given the tsdown config
    const config = readFileSync(path.join(PACKAGE_ROOT, 'tsdown.config.ts'), 'utf8')

    // #when extracting the entry list
    const match = /entry:\s*\[([^\]]*)\]/.exec(config)
    const entries = (match?.[1] ?? '')
      .split(',')
      .map(item => item.trim().replaceAll(/^['"]|['"]$/g, ''))
      .filter(item => item.length > 0)

    // #then every bin target has a source entry
    expect(entries).toContain('src/opencode.ts')
    expect(entries).toContain('src/cli.ts')
  })
})
