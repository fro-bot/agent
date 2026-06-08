/**
 * Tests for `buildDiscordPrompt`.
 */

import {describe, expect, it} from 'vitest'

import {buildDiscordPrompt, DISCORD_MECHANICAL_GUIDANCE, EmptyPromptError} from './prompt.js'

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

    it('structures prompt with mechanical guidance then repo header then user text (no persona)', () => {
      // #given / #when
      const result = buildDiscordPrompt({messageText: 'Do the thing', owner: 'org', repo: 'myrepo'})

      // #then — mechanical guidance + repo + message, in that order
      const guidanceIdx = result.indexOf(DISCORD_MECHANICAL_GUIDANCE)
      const repoIdx = result.indexOf('Repository: org/myrepo')
      const msgIdx = result.indexOf('Do the thing')
      expect(guidanceIdx).toBeGreaterThanOrEqual(0)
      expect(repoIdx).toBeGreaterThan(guidanceIdx)
      expect(msgIdx).toBeGreaterThan(repoIdx)
    })
  })

  describe('persona composition', () => {
    it('happy path: persona present → prompt is scoped-persona + mechanical guidance + repo + message, in order', () => {
      // #given
      const persona = 'You are Fro Bot, a capable engineering assistant.'

      // #when
      const result = buildDiscordPrompt({
        messageText: 'List the files',
        owner: 'org',
        repo: 'myrepo',
        persona,
      })

      // #then — scoped persona first, then guidance, then repo, then message
      const personaIdx = result.indexOf(persona)
      const guidanceIdx = result.indexOf(DISCORD_MECHANICAL_GUIDANCE)
      const repoIdx = result.indexOf('Repository: org/myrepo')
      const msgIdx = result.indexOf('List the files')

      expect(personaIdx).toBeGreaterThanOrEqual(0)
      expect(guidanceIdx).toBeGreaterThan(personaIdx)
      expect(repoIdx).toBeGreaterThan(guidanceIdx)
      expect(msgIdx).toBeGreaterThan(repoIdx)
    })

    it('persona scoping: persona is wrapped in a voice/style-only header so it cannot override Discord guidance', () => {
      // #given
      const persona = 'You are Fro Bot.'

      // #when
      const result = buildDiscordPrompt({
        messageText: 'Do the thing',
        owner: 'org',
        repo: 'myrepo',
        persona,
      })

      // #then — persona is wrapped in a scoped header
      expect(result).toContain('--- Persona (voice and style only) ---')
      expect(result).toContain('--- End Persona ---')
      // Discord guidance appears AFTER the persona section
      const personaSectionEnd = result.indexOf('--- End Persona ---')
      const guidanceIdx = result.indexOf(DISCORD_MECHANICAL_GUIDANCE)
      expect(guidanceIdx).toBeGreaterThan(personaSectionEnd)
    })

    it('edge (R4 fail-soft): persona absent → mechanical guidance + repo + message, no error', () => {
      // #given — no persona param

      // #when / #then — must not throw
      expect(() => buildDiscordPrompt({messageText: 'Do the thing', owner: 'org', repo: 'myrepo'})).not.toThrow()

      const result = buildDiscordPrompt({messageText: 'Do the thing', owner: 'org', repo: 'myrepo'})
      expect(result).toContain(DISCORD_MECHANICAL_GUIDANCE)
      expect(result).toContain('Repository: org/myrepo')
      expect(result).toContain('Do the thing')
    })

    it('edge (R4 fail-soft): persona null → mechanical guidance + repo + message, no error', () => {
      // #given
      const result = buildDiscordPrompt({
        messageText: 'Do the thing',
        owner: 'org',
        repo: 'myrepo',
        persona: null,
      })

      // #then — no persona section, guidance still present
      expect(result).toContain(DISCORD_MECHANICAL_GUIDANCE)
      expect(result).toContain('Repository: org/myrepo')
      expect(result).toContain('Do the thing')
    })

    it('edge (R4 fail-soft): persona empty string → treated as absent, no error', () => {
      // #given
      const result = buildDiscordPrompt({
        messageText: 'Do the thing',
        owner: 'org',
        repo: 'myrepo',
        persona: '',
      })

      // #then — empty persona is ignored; guidance still present
      expect(result).toContain(DISCORD_MECHANICAL_GUIDANCE)
      expect(result).toContain('Repository: org/myrepo')
      expect(result).toContain('Do the thing')
    })

    it('edge (R4 fail-soft): persona whitespace-only → treated as absent, no error', () => {
      // #given
      const result = buildDiscordPrompt({
        messageText: 'Do the thing',
        owner: 'org',
        repo: 'myrepo',
        persona: '   \n  ',
      })

      // #then — whitespace-only persona is ignored
      expect(result).toContain(DISCORD_MECHANICAL_GUIDANCE)
      expect(result).toContain('Repository: org/myrepo')
      expect(result).toContain('Do the thing')
    })

    it('edge: user message is preserved verbatim after prepended sections', () => {
      // #given — message with special characters and formatting
      const verbatimMessage = 'Fix `src/foo.ts` — it has a bug on line 42!\n\nDetails:\n- step 1\n- step 2'

      // #when
      const result = buildDiscordPrompt({
        messageText: verbatimMessage,
        owner: 'org',
        repo: 'myrepo',
        persona: 'You are Fro Bot.',
      })

      // #then — the message appears verbatim at the end
      expect(result.endsWith(verbatimMessage)).toBe(true)
    })

    it('happy path (SC2): composed prompt contains the long-enumeration response policy', () => {
      // #given / #when
      const result = buildDiscordPrompt({
        messageText: 'What files are in this repo?',
        owner: 'org',
        repo: 'myrepo',
      })

      // #then — the guidance must instruct the agent to summarize/attach long lists
      // This is the SC2 resolution: hiding the tool line alone is not enough.
      expect(result).toMatch(/summarize|attach/i)
      expect(result).toMatch(/inline/i)
    })

    it('happy path (SC2): guidance explicitly addresses long enumerations (file lists, search results, logs)', () => {
      // #given / #when — assert the DISCORD_MECHANICAL_GUIDANCE constant itself carries the policy
      expect(DISCORD_MECHANICAL_GUIDANCE).toMatch(/summarize|attach/i)
      expect(DISCORD_MECHANICAL_GUIDANCE).toMatch(/inline/i)
    })

    it('persona wiring (P2.8): non-empty persona flows into the built prompt', () => {
      // #given — persona provided via deps
      const persona = 'You are Fro Bot, a capable engineering assistant. Be direct.'

      // #when
      const result = buildDiscordPrompt({
        messageText: 'Fix the bug',
        owner: 'org',
        repo: 'myrepo',
        persona,
      })

      // #then — persona content appears in the prompt
      expect(result).toContain(persona)
      // And the scoped header is present
      expect(result).toContain('--- Persona (voice and style only) ---')
    })

    it('persona wiring (P2.8): null persona → prompt contains only guidance + repo + message', () => {
      // #given — null persona (config.persona is null when unset)

      // #when
      const result = buildDiscordPrompt({
        messageText: 'Fix the bug',
        owner: 'org',
        repo: 'myrepo',
        persona: null,
      })

      // #then — no persona section in prompt
      expect(result).not.toContain('--- Persona')
      expect(result).toContain(DISCORD_MECHANICAL_GUIDANCE)
      expect(result).toContain('Repository: org/myrepo')
      expect(result).toContain('Fix the bug')
    })
  })

  describe('bot mention stripping (unchanged behavior)', () => {
    it('strips leading bot mention when botUserId is provided', () => {
      // #given / #when
      const result = buildDiscordPrompt({
        messageText: '<@123> Fix the bug',
        owner: 'org',
        repo: 'repo',
        botUserId: '123',
      })

      // #then — mention stripped, message preserved
      expect(result).toContain('Fix the bug')
      expect(result).not.toContain('<@123>')
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
