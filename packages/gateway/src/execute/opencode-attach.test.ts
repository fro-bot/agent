/**
 * Tests for `attachOpencode` — remote-attach client factory.
 *
 * Convention: `as unknown as <Type>` in test doubles is permitted per the
 * established gateway test pattern (mirrors `streaming.test.ts`).
 */

import type {OpenCodeServerHandle} from '@fro-bot/runtime'

import {describe, expect, it} from 'vitest'

import {attachOpencode} from './opencode-attach.js'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('attachOpencode', () => {
  it('returns an OpenCodeServerHandle', () => {
    // #given / #when
    const handle = attachOpencode('http://workspace:9200', 'secret-token')

    // #then — the handle has the expected shape
    expect(handle).toHaveProperty('client')
    expect(handle).toHaveProperty('server')
    expect(typeof handle.shutdown).toBe('function')
  })

  describe('no-op close and shutdown', () => {
    it('server.close() is a no-op (does not throw)', () => {
      // #given
      const handle = attachOpencode('http://workspace:9200', 'secret-token')

      // #when / #then
      expect(() => handle.server.close()).not.toThrow()
    })

    it('shutdown() is a no-op (does not throw)', () => {
      // #given
      const handle = attachOpencode('http://workspace:9200', 'secret-token')

      // #when / #then
      expect(() => handle.shutdown()).not.toThrow()
    })

    it('server.close() returns undefined (not a promise)', () => {
      // #given
      const handle = attachOpencode('http://workspace:9200', 'secret-token')

      // #when
      const result = handle.server.close()

      // #then
      expect(result).toBeUndefined()
    })

    it('shutdown() returns undefined (not a promise)', () => {
      // #given
      const handle = attachOpencode('http://workspace:9200', 'secret-token')

      // #when
      const result = handle.shutdown()

      // #then
      expect(result).toBeUndefined()
    })
  })

  it('server.url reflects the baseURL', () => {
    // #given / #when
    const handle = attachOpencode('http://workspace:9200', 'my-token')

    // #then
    expect(handle.server.url).toBe('http://workspace:9200')
  })

  it('the handle satisfies the OpenCodeServerHandle shape', () => {
    // #given / #when
    const handle = attachOpencode('http://workspace:9200', 'my-token')

    // #then — structural: can assign to the interface type (TS-level test via cast)
    const typedHandle: OpenCodeServerHandle = handle
    expect(typedHandle).toBeDefined()
  })
})
