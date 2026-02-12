import {describe, expect, it} from 'vitest'

import {buildLicenseTypeMap} from './license-collector.js'

describe('buildLicenseTypeMap', () => {
  it('maps license types by name and version', () => {
    // #given
    const input = {
      MIT: [
        {name: 'before-after-hook', versions: ['4.0.0'], license: 'Apache-2.0'},
        {name: 'semver', versions: ['7.7.3'], license: 'ISC'},
      ],
      'Apache-2.0': [{name: 'before-after-hook', versions: ['3.0.0'], license: 'Apache-2.0'}],
    }

    // #when
    const map = buildLicenseTypeMap(input)

    // #then
    expect(map.get('before-after-hook@4.0.0')).toBe('Apache-2.0')
    expect(map.get('before-after-hook@3.0.0')).toBe('Apache-2.0')
    expect(map.get('semver@7.7.3')).toBe('ISC')
  })

  it('falls back to license key when entry license is missing', () => {
    // #given
    const input = {
      MIT: [{name: 'left-pad', versions: ['1.3.0']}],
    }

    // #when
    const map = buildLicenseTypeMap(input)

    // #then
    expect(map.get('left-pad@1.3.0')).toBe('MIT')
  })
})
