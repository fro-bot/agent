import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {afterEach, describe, expect, it} from 'vitest'

import {readPackageVersion} from './package-version.js'

const made: string[] = []
function manifest(content: string): URL {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fro-bot-pkg-'))
  made.push(dir)
  const file = path.join(dir, 'package.json')
  writeFileSync(file, content)
  return pathToFileURL(file)
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, {recursive: true, force: true})
})

const PLUGIN = '@fro.bot/opencode-plugin'

describe('readPackageVersion', () => {
  it('reads the version of the plugin from the package.json next to the module, at run time', () => {
    // #given the plugin's own manifest, as the source tree and an installed copy both lay it out
    const real = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {version: string}

    // #when the default location is read (this file sits in `src/`, as the built chunks sit in `dist/`)
    // #then it is the manifest's version, not a constant baked in at build time
    expect(readPackageVersion()).toBe(real.version)
  })

  it('reads a released version', () => {
    // #given a manifest the release job has stamped
    const url = manifest(JSON.stringify({name: PLUGIN, version: '1.4.2'}))

    // #then
    expect(readPackageVersion(url)).toBe('1.4.2')
  })

  it('accepts a prerelease and build metadata', () => {
    expect(readPackageVersion(manifest(JSON.stringify({name: PLUGIN, version: '2.0.0-rc.1+build.5'})))).toBe(
      '2.0.0-rc.1+build.5',
    )
  })

  it('leaves the version unset, and never throws, when the file is missing', () => {
    // #given a path with no file
    const url = pathToFileURL(path.join(os.tmpdir(), 'fro-bot-no-such-dir', 'package.json'))

    // #then
    expect(readPackageVersion(url)).toBeUndefined()
  })

  it('leaves the version unset when the manifest is not valid JSON', () => {
    expect(readPackageVersion(manifest('{not json'))).toBeUndefined()
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['no version', JSON.stringify({name: PLUGIN})],
    ['a numeric version', JSON.stringify({name: PLUGIN, version: 3})],
    ['an empty version', JSON.stringify({name: PLUGIN, version: ''})],
    ['text that is not a version', JSON.stringify({name: PLUGIN, version: 'latest build'})],
    ['a control character', JSON.stringify({name: PLUGIN, version: '1.0.0\n'})],
    ['an over-long version', JSON.stringify({name: PLUGIN, version: `1.0.0-${'a'.repeat(100)}`})],
    ['another package’s manifest', JSON.stringify({name: 'something-else', version: '1.0.0'})],
  ])('leaves the version unset for %s', (_label, content) => {
    expect(readPackageVersion(manifest(content))).toBeUndefined()
  })

  it('leaves the version unset when reading throws', () => {
    // #given a reader that is denied
    const reader = (): string => {
      throw new Error('EACCES: permission denied')
    }

    // #then
    expect(readPackageVersion(new URL('file:///x/package.json'), reader)).toBeUndefined()
  })
})
