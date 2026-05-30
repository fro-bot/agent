import {Either} from 'effect'
import {describe, expect, it} from 'vitest'

import {decodeAnnounce} from './announce-schema.js'

// ── Narrowing helpers ─────────────────────────────────────────────────────────

function expectRight<L, R>(e: Either.Either<R, L>): R {
  if (Either.isLeft(e)) throw new Error(`expected Right, got Left: ${String(e.left)}`)
  return e.right
}

function expectLeft<L, R>(e: Either.Either<R, L>): L {
  if (Either.isRight(e)) throw new Error('expected Left, got Right')
  return e.left
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_FIRED_AT = '2026-05-29T12:00:00Z'

const validInvitation = {
  v: 1,
  event_type: 'invitation_accepted',
  fired_at: VALID_FIRED_AT,
  context: {
    count: 2,
    repos: [
      {owner: 'acme', name: 'alpha'},
      {owner: 'acme', name: 'beta'},
    ],
  },
  rendered_text: null,
} as const

const validSurvey = {
  v: 1,
  event_type: 'survey_completed',
  fired_at: VALID_FIRED_AT,
  context: {
    owner: 'acme',
    repo: 'alpha',
    slug: 'setup-survey',
    wiki_pages_changed: 3,
  },
  rendered_text: null,
} as const

// ── Happy path ────────────────────────────────────────────────────────────────

describe('decodeAnnounce — happy path', () => {
  it('decodes a valid invitation_accepted payload', () => {
    // #given a well-formed invitation_accepted payload
    // #when decoded
    const result = decodeAnnounce(validInvitation)
    // #then it is Right with correct shape
    const payload = expectRight(result)
    expect(payload.event_type).toBe('invitation_accepted')
    expect(payload.v).toBe(1)
    if (payload.event_type !== 'invitation_accepted') throw new Error('unreachable')
    expect(payload.context.repos).toHaveLength(2)
  })

  it('decodes a valid survey_completed payload', () => {
    // #given a well-formed survey_completed payload
    // #when decoded
    const result = decodeAnnounce(validSurvey)
    // #then it is Right with correct shape
    const payload = expectRight(result)
    expect(payload.event_type).toBe('survey_completed')
    if (payload.event_type !== 'survey_completed') throw new Error('unreachable')
    expect(payload.context.owner).toBe('acme')
  })

  it('accepts rendered_text as null (both event types)', () => {
    // #given payloads with null rendered_text
    // #when decoded
    expect(Either.isRight(decodeAnnounce(validInvitation))).toBe(true)
    expect(Either.isRight(decodeAnnounce(validSurvey))).toBe(true)
  })

  it('accepts rendered_text as a non-null string', () => {
    // #given payloads with a string rendered_text
    const withText = {...validInvitation, rendered_text: 'Hello, team!'}
    // #when decoded
    const result = decodeAnnounce(withText)
    // #then it is Right
    const payload = expectRight(result)
    expect(payload.rendered_text).toBe('Hello, team!')
  })

  it('accepts fired_at with sub-second precision (.sss)', () => {
    // #given a fired_at with milliseconds
    const payload = {...validInvitation, fired_at: '2026-05-29T12:00:00.123Z'}
    // #when decoded
    expect(Either.isRight(decodeAnnounce(payload))).toBe(true)
  })
})

// ── Error path ────────────────────────────────────────────────────────────────

describe('decodeAnnounce — error path', () => {
  it('returns Left for an unknown event_type', () => {
    // #given a payload with an unrecognized event_type
    const payload = {...validInvitation, event_type: 'new_unknown_event'}
    // #when decoded
    const result = decodeAnnounce(payload)
    // #then it is Left
    const reason = expectLeft(result)
    expect(typeof reason).toBe('string')
    expect(reason.length).toBeGreaterThan(0)
  })

  it('returns Left for v: 2 (unsupported version)', () => {
    // #given a payload with v:2
    const payload = {...validInvitation, v: 2}
    // #when decoded
    const result = decodeAnnounce(payload)
    // #then it is Left
    expect(Either.isLeft(result)).toBe(true)
  })

  it('returns Left when required context keys are missing — invitation_accepted', () => {
    // #given a payload missing 'repos' in context
    const payload = {
      ...validInvitation,
      context: {count: 1},
    }
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('returns Left when required context keys are missing — survey_completed', () => {
    // #given a payload missing 'slug' in context
    const payload = {
      ...validSurvey,
      context: {owner: 'acme', repo: 'alpha'},
    }
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('returns Left when survey context is used for invitation_accepted event', () => {
    // #given an invitation_accepted payload with survey context shape
    const payload = {
      v: 1,
      event_type: 'invitation_accepted',
      fired_at: VALID_FIRED_AT,
      context: {owner: 'acme', repo: 'alpha', slug: 'survey', wiki_pages_changed: 3},
      rendered_text: null,
    }
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('returns Left when invitation context is used for survey_completed event', () => {
    // #given a survey_completed payload with invitation context shape
    const payload = {
      v: 1,
      event_type: 'survey_completed',
      fired_at: VALID_FIRED_AT,
      context: {count: 2, repos: [{owner: 'acme', name: 'alpha'}]},
      rendered_text: null,
    }
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('returns Left for a completely malformed body (not an object)', () => {
    // #given a non-object input
    expect(Either.isLeft(decodeAnnounce('not-json'))).toBe(true)
    expect(Either.isLeft(decodeAnnounce(null))).toBe(true)
    expect(Either.isLeft(decodeAnnounce(42))).toBe(true)
  })

  it('returns Left for an empty object', () => {
    // #given an empty object
    expect(Either.isLeft(decodeAnnounce({}))).toBe(true)
  })
})

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('decodeAnnounce — edge cases', () => {
  it('returns Left for fired_at that is not ISO-8601 (plain date string)', () => {
    // #given a fired_at with no time component
    const payload = {...validInvitation, fired_at: '2026-05-29'}
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('returns Left for fired_at "yesterday" (obviously non-ISO)', () => {
    // #given a non-ISO fired_at
    const payload = {...validInvitation, fired_at: 'yesterday'}
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('returns Left for fired_at with local offset instead of Z', () => {
    // #given a fired_at with +05:00 offset (not Z)
    const payload = {...validInvitation, fired_at: '2026-05-29T12:00:00+05:00'}
    // #when decoded
    expect(Either.isLeft(decodeAnnounce(payload))).toBe(true)
  })

  it('accepts rendered_text: null on invitation_accepted', () => {
    // #given rendered_text null
    const result = decodeAnnounce({...validInvitation, rendered_text: null})
    expect(Either.isRight(result)).toBe(true)
  })

  it('accepts rendered_text as non-null string on survey_completed', () => {
    // #given rendered_text is a string
    const result = decodeAnnounce({...validSurvey, rendered_text: 'Survey done!'})
    // #then it is Right
    const payload = expectRight(result)
    expect(payload.rendered_text).toBe('Survey done!')
  })
})

// ── Security: no payload echo ─────────────────────────────────────────────────

describe('decodeAnnounce — security: reason string must not echo payload content', () => {
  it('does not include planted repo name from invalid payload in the reason', () => {
    // #given an invalid payload containing a recognizable sentinel value in context
    const SENTINEL = 'super-secret-repo-xyzzy-12345'
    const invalidPayload = {
      v: 1,
      event_type: 'totally_unknown_event',
      fired_at: VALID_FIRED_AT,
      context: {
        count: 1,
        repos: [{owner: 'acme', name: SENTINEL}],
      },
      rendered_text: `contains ${SENTINEL} in text`,
    }
    // #when decoded (will fail — unknown event_type)
    const result = decodeAnnounce(invalidPayload)
    // #then the reason string does NOT contain the sentinel
    const reason = expectLeft(result)
    expect(reason).not.toContain(SENTINEL)
    expect(reason.length).toBeLessThan(100) // short reason
  })

  it('does not include rendered_text content from invalid payload in the reason', () => {
    // #given a payload with wrong v and a sensitive rendered_text
    const SECRET = 'confidential-rendered-content-abc987'
    const invalidPayload = {
      v: 99,
      event_type: 'invitation_accepted',
      fired_at: VALID_FIRED_AT,
      context: {count: 0, repos: []},
      rendered_text: SECRET,
    }
    // #when decoded
    const result = decodeAnnounce(invalidPayload)
    // #then reason does not contain secret
    const reason = expectLeft(result)
    expect(reason).not.toContain(SECRET)
  })
})
