import {describe, expect, it} from 'vitest'
import {extractCommitShas, extractGithubUrls, isGithubUrl, isValidAttachmentUrl} from './urls.js'

describe('urls', () => {
  describe('isGithubUrl', () => {
    it('returns true for valid github.com URLs', () => {
      expect(isGithubUrl('https://github.com/owner/repo')).toBe(true)
      expect(isGithubUrl('https://github.com/owner/repo/pull/1')).toBe(true)
    })

    it('returns true for valid api.github.com URLs', () => {
      expect(isGithubUrl('https://api.github.com/repos/owner/repo')).toBe(true)
    })

    it('returns false for non-GitHub domains', () => {
      expect(isGithubUrl('https://attacker-github.com/owner/repo')).toBe(false)
      expect(isGithubUrl('https://github.com.attacker.com/owner/repo')).toBe(false)
      expect(isGithubUrl('https://google.com')).toBe(false)
    })

    it('returns false for invalid URLs', () => {
      expect(isGithubUrl('not-a-url')).toBe(false)
    })
  })

  describe('isValidAttachmentUrl', () => {
    it('returns true for valid user-attachments URLs', () => {
      expect(isValidAttachmentUrl('https://github.com/user-attachments/assets/abc-123')).toBe(true)
      expect(isValidAttachmentUrl('https://github.com/user-attachments/files/xyz-789')).toBe(true)
    })

    it('returns false for other GitHub URLs', () => {
      expect(isValidAttachmentUrl('https://github.com/owner/repo/pull/1')).toBe(false)
      expect(isValidAttachmentUrl('https://github.com/user-attachments/other/abc')).toBe(false)
    })

    it('returns false for non-GitHub domains', () => {
      expect(isValidAttachmentUrl('https://attacker-github.com/user-attachments/assets/abc')).toBe(false)
    })
  })

  describe('extractGithubUrls', () => {
    it('extracts PR and Issue URLs', () => {
      const text = 'Check PR https://github.com/owner/repo/pull/1 and issue https://github.com/owner/repo/issues/42'
      const urls = extractGithubUrls(text)
      expect(urls).toEqual(['https://github.com/owner/repo/pull/1', 'https://github.com/owner/repo/issues/42'])
    })

    it('extracts comment URLs', () => {
      const text = 'See https://github.com/owner/repo/pull/1#issuecomment-12345'
      const urls = extractGithubUrls(text)
      expect(urls).toEqual(['https://github.com/owner/repo/pull/1#issuecomment-12345'])
    })

    it('ignores spoofed URLs', () => {
      const text = 'Fake: https://attacker-github.com/owner/repo/pull/1'
      const urls = extractGithubUrls(text)
      expect(urls).toEqual([])
    })

    it('handles multiple identical URLs by de-duplicating', () => {
      const text = 'https://github.com/owner/repo/pull/1 and https://github.com/owner/repo/pull/1'
      const urls = extractGithubUrls(text)
      expect(urls).toEqual(['https://github.com/owner/repo/pull/1'])
    })
  })

  describe('extractCommitShas', () => {
    it('extracts SHAs from standard git commit output', () => {
      const text = '[main abc1234567890abcdef1234567890abcdef1234] commit message'
      const shas = extractCommitShas(text)
      expect(shas).toEqual(['abc1234567890abcdef1234567890abcdef1234'])
    })

    it('extracts multiple SHAs', () => {
      const text = '[feat-branch a1b2c3d] message 1\n[fix-branch e5f6a7b] message 2'
      const shas = extractCommitShas(text)
      expect(shas).toEqual(['a1b2c3d', 'e5f6a7b'])
    })
  })
})
