import type {StateKey} from './state-keys.js'
import {describe, expect, it} from 'vitest'
import {STATE_KEYS} from './state-keys.js'

describe('state-keys', () => {
  describe('STATE_KEYS', () => {
    it('contains shouldSaveCache key', () => {
      expect(STATE_KEYS.SHOULD_SAVE_CACHE).toBe('shouldSaveCache')
    })

    it('contains sessionId key', () => {
      expect(STATE_KEYS.SESSION_ID).toBe('sessionId')
    })

    it('contains cacheSaved key', () => {
      expect(STATE_KEYS.CACHE_SAVED).toBe('cacheSaved')
    })

    it('contains opencodeVersion key', () => {
      expect(STATE_KEYS.OPENCODE_VERSION).toBe('opencodeVersion')
    })

    it('has correct number of keys', () => {
      expect(Object.keys(STATE_KEYS)).toHaveLength(4)
    })

    it('values are string type compatible', () => {
      const key: StateKey = STATE_KEYS.SHOULD_SAVE_CACHE
      expect(typeof key).toBe('string')
    })
  })
})
