import {describe, expect, it} from 'vitest'
import {resolveRepoDirectory} from './repo-quiescence.js'

describe('resolveRepoDirectory', () => {
  it('resolves to the canonical lowercased workspace directory', () => {
    // #given / #when / #then
    expect(resolveRepoDirectory('Acme/Widget')).toBe('/workspace/repos/acme/widget')
  })

  it('resolves a padded repo through the slug contract to the same directory', () => {
    // #given the slug parser trims, as it does everywhere else
    // #when / #then
    expect(resolveRepoDirectory('  Acme/Widget ')).toBe('/workspace/repos/acme/widget')
  })

  it.each([['not-a-slug'], ['acme/'], ['/widget'], ['a/b/c'], ['acme/wid get'], ['\u212Aacme/widget']])(
    'is null for %j, which names no workspace directory',
    repo => {
      // #given / #when / #then
      expect(resolveRepoDirectory(repo)).toBeNull()
    },
  )
})
