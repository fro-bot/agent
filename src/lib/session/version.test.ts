import * as fs from 'node:fs/promises'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {compareVersions, getOpenCodeDbPath, isSqliteBackend, OPENCODE_SQLITE_VERSION} from './version.js'

vi.mock('node:fs/promises')

describe('version', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.XDG_DATA_HOME = '/test/data'
  })

  afterEach(() => {
    delete process.env.XDG_DATA_HOME
  })

  describe('OPENCODE_SQLITE_VERSION', () => {
    it('is set to 1.2.0', () => {
      expect(OPENCODE_SQLITE_VERSION).toBe('1.2.0')
    })
  })

  describe('getOpenCodeDbPath', () => {
    it('returns XDG-based path when XDG_DATA_HOME is set', () => {
      process.env.XDG_DATA_HOME = '/custom/data'
      expect(getOpenCodeDbPath()).toBe('/custom/data/opencode/opencode.db')
    })

    it('falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
      delete process.env.XDG_DATA_HOME
      const result = getOpenCodeDbPath()
      expect(result).toMatch(/\/opencode\/opencode\.db$/)
    })
  })

  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      expect(compareVersions('1.2.0', '1.2.0')).toBe(0)
    })

    it('returns positive when first version is greater (patch)', () => {
      expect(compareVersions('1.2.1', '1.2.0')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (patch)', () => {
      expect(compareVersions('1.1.99', '1.2.0')).toBeLessThan(0)
    })

    it('returns positive when first version is greater (minor)', () => {
      expect(compareVersions('1.3.0', '1.2.0')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (minor)', () => {
      expect(compareVersions('1.1.99', '1.2.0')).toBeLessThan(0)
    })

    it('returns positive when first version is greater (major)', () => {
      expect(compareVersions('2.0.0', '1.2.0')).toBeGreaterThan(0)
    })

    it('returns negative when first version is lesser (major)', () => {
      expect(compareVersions('0.9.99', '1.2.0')).toBeLessThan(0)
    })

    it('handles versions with different segment counts gracefully', () => {
      // #given versions with only two segments
      expect(compareVersions('1.1', '1.1.0')).toBe(0)
    })
  })

  describe('isSqliteBackend', () => {
    it('returns false for version below threshold', async () => {
      expect(await isSqliteBackend('1.1.99')).toBe(false)
    })

    it('returns true for exact threshold version', async () => {
      expect(await isSqliteBackend('1.2.0')).toBe(true)
    })

    it('returns true for version above threshold (patch)', async () => {
      expect(await isSqliteBackend('1.2.1')).toBe(true)
    })

    it('returns true for version above threshold (minor)', async () => {
      expect(await isSqliteBackend('1.3.0')).toBe(true)
    })

    it('returns true for version above threshold (major)', async () => {
      expect(await isSqliteBackend('2.0.0')).toBe(true)
    })

    it('returns false for much older version', async () => {
      expect(await isSqliteBackend('1.0.0')).toBe(false)
    })

    it('does not check filesystem when version is provided', async () => {
      // #given a known version
      // #when checking if sqlite backend
      await isSqliteBackend('1.2.0')

      // #then filesystem is not checked
      expect(fs.access).not.toHaveBeenCalled()
    })

    it('returns true when version is null but opencode.db exists', async () => {
      // #given opencode.db exists on disk
      vi.mocked(fs.access).mockResolvedValue(undefined)

      // #when
      const result = await isSqliteBackend(null)

      // #then
      expect(result).toBe(true)
      expect(fs.access).toHaveBeenCalledWith('/test/data/opencode/opencode.db')
    })

    it('returns false when version is null and opencode.db does not exist', async () => {
      // #given opencode.db does not exist
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))

      // #when
      const result = await isSqliteBackend(null)

      // #then
      expect(result).toBe(false)
    })
  })
})
