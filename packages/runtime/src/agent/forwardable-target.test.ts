import {describe, expect, it} from 'vitest'

import {isForwardableTarget} from './forwardable-target.js'

/** A matcher that allows every route, so the canonical-form checks are what decide. */
const anyRoute = (): boolean => true

describe('isForwardableTarget', () => {
  it.each([
    ['GET', '/p/a'],
    ['POST', '/p/a/b?x=1'],
    ['GET', '/p/a?x=%2F'],
    ['GET', '/p/a?beta=true'],
  ])('accepts %s %s', (method, target) => {
    expect(isForwardableTarget(method, target, anyRoute)).toBe(true)
  })

  it.each([
    ['GET', undefined],
    [undefined, '/p/a'],
    ['GET', ''],
    ['GET', 'p/a'],
    ['GET', 'https://host/p/a'],
    ['GET', '//host/p/a'],
    ['CONNECT', 'host:443'],
    ['OPTIONS', '*'],
    ['GET', '/p/a\t'],
    ['GET', '/p/a\n'],
    ['GET', '/p/a\u0000'],
    ['GET', '/p/a?x=\u001F'],
    ['GET', '/p/a?x=\u007F'],
    ['GET', '/p/a x'],
    ['GET', '/p/\u00E9'],
    ['GET', '/p/a#x'],
    ['GET', '/p/a;x'],
    ['GET', String.raw`/p/a\b`],
    ['GET', '/p/%2fx'],
    ['GET', '/p/%2Fx'],
    ['GET', '/p/%5cx'],
    ['GET', '/p/%2ex'],
    ['GET', '/p/%3bx'],
    ['GET', '/p/%25x'],
    ['GET', '/p//x'],
    ['GET', '/p/a/'],
    ['GET', '/p/./x'],
    ['GET', '/p/../x'],
    ['GET', '/p/..'],
    ['GET', '/'],
  ])('refuses %j %j', (method, target) => {
    expect(isForwardableTarget(method, target, anyRoute)).toBe(false)
  })

  it('hands the matcher the method, the path and the raw query, and nothing else decides the route', () => {
    // #given a matcher that records what it is asked
    const seen: [string, string, string][] = []
    const matcher = (method: string, path: string, query: string): boolean => {
      seen.push([method, path, query])
      return true
    }

    // #when targets with and without a query are checked
    isForwardableTarget('POST', '/p/messages?beta=true', matcher)
    isForwardableTarget('GET', '/p/models', matcher)

    // #then the matcher sees the split target
    expect(seen).toEqual([
      ['POST', '/p/messages', 'beta=true'],
      ['GET', '/p/models', ''],
    ])
  })

  it('refuses when the matcher does', () => {
    expect(isForwardableTarget('GET', '/p/a', () => false)).toBe(false)
  })
})
