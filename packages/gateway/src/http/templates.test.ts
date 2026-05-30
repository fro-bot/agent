import type {AnnouncePayload} from './announce-schema.js'
import {describe, expect, it} from 'vitest'
import {renderEmbed} from './templates.js'

// Accent color constants (mirror templates.ts for assertions)
const COLOR_BLUE = 0x5865f2
const COLOR_GREEN = 0x57f287

const BASE = {v: 1 as const, fired_at: '2026-05-29T12:00:00Z', rendered_text: null}

describe('renderEmbed', () => {
  describe('invitation_accepted', () => {
    it('returns blue accent and description with count + repo list', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'invitation_accepted',
        context: {
          count: 2,
          repos: [
            {owner: 'acme', name: 'api'},
            {owner: 'acme', name: 'web'},
          ],
        },
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.color).toBe(COLOR_BLUE)
      expect(embed.description).toContain('2')
      expect(embed.description).toContain('acme/api')
      expect(embed.description).toContain('acme/web')
    })

    it('handles count 0 gracefully — no trailing comma or garbled text', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'invitation_accepted',
        context: {count: 0, repos: []},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.color).toBe(COLOR_BLUE)
      expect(embed.description).not.toMatch(/,$/)
      expect(embed.description.length).toBeGreaterThan(0)
    })

    it('handles many repos — all listed, no trailing comma', () => {
      // #given
      const repos = Array.from({length: 5}, (_, i) => ({owner: 'org', name: `repo-${i}`}))
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'invitation_accepted',
        context: {count: 5, repos},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.color).toBe(COLOR_BLUE)
      expect(embed.description).toContain('org/repo-0')
      expect(embed.description).toContain('org/repo-4')
      expect(embed.description).not.toMatch(/,$/)
    })

    it('singular noun when count is 1', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'invitation_accepted',
        context: {count: 1, repos: [{owner: 'solo', name: 'proj'}]},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.description).toContain('invitation')
      expect(embed.description).not.toContain('invitations')
    })
  })

  describe('survey_completed', () => {
    it('returns green accent and description with owner/repo/pages', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'survey_completed',
        context: {owner: 'acme', repo: 'docs', slug: 'main', wiki_pages_changed: 3},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.color).toBe(COLOR_GREEN)
      expect(embed.description).toContain('acme/docs')
      expect(embed.description).toContain('3')
    })

    it('singular "entry" when wiki_pages_changed is 1', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'survey_completed',
        context: {owner: 'org', repo: 'kb', slug: 'slug', wiki_pages_changed: 1},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.description).toContain('entry')
      expect(embed.description).not.toContain('entries')
    })
  })

  describe('rendered_text override', () => {
    it('uses rendered_text verbatim as description for invitation_accepted, still sets blue accent', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'invitation_accepted',
        rendered_text: 'Custom override text for invitation',
        context: {count: 99, repos: [{owner: 'x', name: 'y'}]},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.color).toBe(COLOR_BLUE)
      expect(embed.description).toBe('Custom override text for invitation')
      // template text must NOT appear
      expect(embed.description).not.toContain('99')
    })

    it('uses rendered_text verbatim as description for survey_completed, still sets green accent', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'survey_completed',
        rendered_text: 'Bespoke survey summary',
        context: {owner: 'org', repo: 'repo', slug: 'slug', wiki_pages_changed: 7},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.color).toBe(COLOR_GREEN)
      expect(embed.description).toBe('Bespoke survey summary')
      expect(embed.description).not.toContain('7')
    })
  })
})
