import {describe, expect, it} from 'vitest'
import {compareVersions, isSqliteBackend, OPENCODE_SQLITE_VERSION} from './version.js'

describe('version', () => {
  describe('OPENCODE_SQLITE_VERSION', () => {
    it('is set to 1.1.53', () => {
      expect(OPENCODE_SQLITE_VERSION).toBe('1.1.53')
    })
  })

  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      expect(compareVersions('1.1.53', '1.1.53')).toBe(0)
    })

    it('returns positive when first version is greater (patch)', () => {
      expect(compareVersions('1.1.54', '1.1.53')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (patch)', () => {
      expect(compareVersions('1.1.52', '1.1.53')).toBeLessThan(0)
    })

    it('returns positive when first version is greater (minor)', () => {
      expect(compareVersions('1.2.0', '1.1.53')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (minor)', () => {
      expect(compareVersions('1.0.99', '1.1.53')).toBeLessThan(0)
    })

    it('returns positive when first version is greater (major)', () => {
      expect(compareVersions('2.0.0', '1.1.53')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (major)', () => {
      expect(compareVersions('0.9.99', '1.1.53')).toBeLessThan(0)
    })

    it('handles versions with different segment counts gracefully', () => {
      // #given versions with only two segments
      expect(compareVersions('1.1', '1.1.0')).toBe(0)
    })
  })

  describe('isSqliteBackend', () => {
    it('returns false for null version', () => {
      expect(isSqliteBackend(null)).toBe(false)
    })

    it('returns false for version below threshold', () => {
      expect(isSqliteBackend('1.1.52')).toBe(false)
    })

    it('returns true for exact threshold version', () => {
      expect(isSqliteBackend('1.1.53')).toBe(true)
    })

    it('returns true for version above threshold (patch)', () => {
      expect(isSqliteBackend('1.1.65')).toBe(true)
    })

    it('returns true for version above threshold (minor)', () => {
      expect(isSqliteBackend('1.2.0')).toBe(true)
    })

    it('returns true for version above threshold (major)', () => {
      expect(isSqliteBackend('2.0.0')).toBe(true)
    })

    it('returns false for much older version', () => {
      expect(isSqliteBackend('1.0.0')).toBe(false)
    })
  })
})
