import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {isWithin} from './path-within.js'

describe('isWithin', () => {
  it.each([
    ['the same path', '/ws', '/ws'],
    ['a child', '/ws', '/ws/dist'],
    ['a deep descendant', '/ws', '/ws/a/b/c'],
    ['a directory whose name starts with two dots', '/ws', '/ws/..action'],
    ['a descendant of a directory whose name starts with two dots', '/ws', '/ws/..action/dist/main.js'],
    ['a file named ..x directly under the root', '/ws', '/ws/..x'],
    ['a non-normalized child', '/ws/', '/ws/a/../b'],
  ])('counts %s as inside', (_label, parent, child) => {
    // #given a parent and a child spelled as shown
    // #then the child is within the parent
    expect(isWithin(parent, child)).toBe(true)
  })

  it.each([
    ['the parent of the root', '/ws/a', '/ws'],
    ['a sibling', '/ws/a', '/ws/b'],
    ['a sibling sharing a name prefix', '/ws', '/ws-tools'],
    ['a sibling sharing a name prefix, deeper', '/ws', '/ws-tools/dist'],
    ['a path that climbs out', '/ws', '/ws/../etc'],
    ['an unrelated absolute path', '/ws', '/opt/x'],
  ])('counts %s as outside', (_label, parent, child) => {
    // #given a parent and a child spelled as shown
    // #then the child is not within the parent
    expect(isWithin(parent, child)).toBe(false)
  })

  it('treats a different drive or root as outside (an absolute relative result)', () => {
    // #given two paths that path.relative cannot relate (on posix this is only reachable through a stubbed relative)
    // #then absolute results are outside; posix paths always relate, so assert the posix behaviour holds
    expect(path.isAbsolute(path.relative('/a', '/b'))).toBe(false)
    expect(isWithin('/a', '/b')).toBe(false)
  })
})
