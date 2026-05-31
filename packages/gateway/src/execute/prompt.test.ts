/**
 * Tests for `buildDiscordPrompt`.
 */

import {describe, expect, it} from 'vitest'

import {buildDiscordPrompt, EmptyPromptError} from './prompt.js'

describe('buildDiscordPrompt', () => {
  describe('happy path', () => {
    it('includes the repository context', () => {
      // #given / #when
      const result = buildDiscordPrompt({messageText: 'Fix the bug', owner: 'acme', repo: 'api'})

      // #then
      expect(result).toContain('acme/api')
    })

    it('includes the trimmed message text', () => {
      // #given / #when
      const result = buildDiscordPrompt({messageText: '  Fix the bug  ', owner: 'acme', repo: 'api'})

      // #then
      expect(result).toContain('Fix the bug')
      expect(result).not.toContain('  Fix')
    })

    it('structures prompt with repo header then user text', () => {
      // #given / #when
      const result = buildDiscordPrompt({messageText: 'Do the thing', owner: 'org', repo: 'myrepo'})

      // #then
      expect(result).toBe('Repository: org/myrepo\n\nDo the thing')
    })
  })

  describe('empty / whitespace guard', () => {
    it('throws EmptyPromptError for empty string', () => {
      // #given / #when / #then
      expect(() => buildDiscordPrompt({messageText: '', owner: 'org', repo: 'repo'})).toThrow(EmptyPromptError)
    })

    it('throws EmptyPromptError for whitespace-only string', () => {
      // #given / #when / #then
      expect(() => buildDiscordPrompt({messageText: '   \t\n  ', owner: 'org', repo: 'repo'})).toThrow(EmptyPromptError)
    })

    it('thrown EmptyPromptError has the correct name', () => {
      // #given / #when
      let caught: unknown
      try {
        buildDiscordPrompt({messageText: '', owner: 'org', repo: 'repo'})
      } catch (error) {
        caught = error
      }

      // #then
      expect(caught).toBeInstanceOf(EmptyPromptError)
      expect((caught as EmptyPromptError).name).toBe('EmptyPromptError')
    })
  })
})
