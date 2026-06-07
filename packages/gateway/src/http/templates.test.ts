import type {AnnouncePayload} from './announce-schema.js'
import {describe, expect, it} from 'vitest'
import {renderDailyDigest, renderEmbed} from './templates.js'

// Accent color constants (mirror templates.ts for assertions)
const COLOR_BLUE = 0x5865f2
const COLOR_GREEN = 0x57f287
const COLOR_PURPLE = 0x9b59b6

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

    it('falls through to templated description when rendered_text is empty string', () => {
      // #given — schema accepts empty string; renderer must not use it verbatim (Discord rejects empty embed descriptions)
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'survey_completed',
        rendered_text: '',
        context: {owner: 'org', repo: 'repo', slug: 'slug', wiki_pages_changed: 2},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then — template description used, not the empty string
      expect(embed.description.length).toBeGreaterThan(0)
      expect(embed.description).toContain('org/repo')
    })

    it('falls through to templated description when rendered_text is whitespace-only', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'invitation_accepted',
        rendered_text: '   ',
        context: {count: 1, repos: [{owner: 'acme', name: 'proj'}]},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then — template description used, not the whitespace string
      expect(embed.description.trim().length).toBeGreaterThan(0)
      expect(embed.description).toContain('acme/proj')
    })

    it('non-empty rendered_text is still used verbatim (regression guard)', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'survey_completed',
        rendered_text: 'real text',
        context: {owner: 'org', repo: 'repo', slug: 'slug', wiki_pages_changed: 99},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then
      expect(embed.description).toBe('real text')
    })
  })

  describe('daily_digest', () => {
    it('happy path: plural surveys_today and repos_tracked, includes report_url', () => {
      // #given
      const context = {surveys_today: 2, repos_tracked: 25, report_url: 'https://example.com/report/2026-06-07'}
      // #when
      const text = renderDailyDigest(context)
      // #then
      expect(text).toContain('2')
      expect(text).toContain('25')
      expect(text).toContain('https://example.com/report/2026-06-07')
      // reads as a reflection, not a status line — must not be empty
      expect(text.length).toBeGreaterThan(0)
    })

    it('edge case: singular surveys_today=1 uses singular noun', () => {
      // #given
      const context = {surveys_today: 1, repos_tracked: 1, report_url: 'https://example.com/report/today'}
      // #when
      const text = renderDailyDigest(context)
      // #then — singular form for both counts
      expect(text).toContain('1')
      // should NOT contain plural forms when counts are 1
      expect(text).not.toMatch(/\bsurveys\b/)
      expect(text).not.toMatch(/\brepos\b/)
    })

    it('edge case: plural surveys_today=3 uses plural noun', () => {
      // #given
      const context = {surveys_today: 3, repos_tracked: 10, report_url: 'https://example.com/r'}
      // #when
      const text = renderDailyDigest(context)
      // #then — plural form
      expect(text).toContain('3')
      expect(text).toContain('10')
    })

    it('integration: renderEmbed on daily_digest payload returns purple accent and daily-digest description', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'daily_digest',
        context: {surveys_today: 4, repos_tracked: 30, report_url: 'https://example.com/report'},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then — purple accent, NOT survey fallthrough
      expect(embed.color).toBe(COLOR_PURPLE)
      expect(embed.description).toContain('4')
      expect(embed.description).toContain('30')
      expect(embed.description).toContain('https://example.com/report')
      // must NOT contain survey_completed template text
      expect(embed.description).not.toContain('Surveyed')
    })

    it('integration: daily_digest with non-empty rendered_text uses override verbatim, accent still purple', () => {
      // #given
      const payload: AnnouncePayload = {
        ...BASE,
        event_type: 'daily_digest',
        rendered_text: 'Custom daily digest override',
        context: {surveys_today: 99, repos_tracked: 999, report_url: 'https://example.com/r'},
      }
      // #when
      const embed = renderEmbed(payload)
      // #then — override wins for description, accent is still purple
      expect(embed.color).toBe(COLOR_PURPLE)
      expect(embed.description).toBe('Custom daily digest override')
      // template text must NOT appear
      expect(embed.description).not.toContain('99')
    })
  })
})
