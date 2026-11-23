import {createHash} from 'node:crypto'
import {describe, expect, it} from 'vitest'

import {TRACING_IDENTITY_FIELD_MAX_CHARS} from '../agent/tracing-launcher.js'
import {createScrubber} from './scrub.js'
import {scrubSafeSessionId} from './session-id.js'

const hashed = (candidate: string): string =>
  `sha256:${createHash('sha256').update(candidate, 'utf8').digest('hex').slice(0, 32)}`

describe('scrubSafeSessionId', () => {
  it('returns the candidate itself when scrubbing leaves it byte-identical', () => {
    // #given an id the scrubber has no reason to touch
    const scrubber = createScrubber()

    // #when / #then it is returned unchanged, not hashed
    expect(scrubSafeSessionId('fro-bot/agent:issue-42', scrubber)).toBe('fro-bot/agent:issue-42')
  })

  it('returns sha256: and the first 32 hex characters of the candidate’s SHA-256 when scrubbing would change it', () => {
    // #given a repository whose name the scrubber reads as a name and value (`password…:`)
    const scrubber = createScrubber()
    const candidate = 'acme/password-manager:issue-42'
    expect(scrubber.scrub(candidate)).toMatchObject({ok: true, redactions: expect.any(Number) as number})
    expect(scrubber.scrub(candidate)).not.toMatchObject({text: candidate})

    // #when
    const id = scrubSafeSessionId(candidate, scrubber)

    // #then it is the documented hashed form, 39 characters, and the scrubber leaves that alone
    expect(id).toBe(hashed(candidate))
    expect(id).toMatch(/^sha256:[0-9a-f]{32}$/)
    expect(scrubber.scrub(id ?? '')).toMatchObject({ok: true, text: id})
  })

  it('gives two ids whose redacted forms would collide two different ids', () => {
    // #given the two conversations the review named
    const scrubber = createScrubber()

    // #when
    const first = scrubSafeSessionId('acme/password-manager:issue-42', scrubber)
    const second = scrubSafeSessionId('acme/password-manager:issue-43', scrubber)

    // #then both are usable and they differ
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first).not.toBe(second)
  })

  it('returns the same id for the same candidate every time', () => {
    const scrubber = createScrubber()
    expect(scrubSafeSessionId('acme/password-manager:issue-42', scrubber)).toBe(
      scrubSafeSessionId('acme/password-manager:issue-42', scrubber),
    )
  })

  it('returns nothing when the hashed form is itself changed by the scrubber', () => {
    // #given a scrubber that knows both the candidate and its hashed form as secrets
    const candidate = 'acme/payments:issue-42'
    const scrubber = createScrubber({extraSecrets: [candidate, hashed(candidate)]})

    // #when / #then neither form is safe, so there is no id
    expect(scrubSafeSessionId(candidate, scrubber)).toBeUndefined()
  })

  it('hashes a candidate a late-added literal matches, and returns nothing once the hash is a literal too', () => {
    // #given an id that was safe when the scrubber was built
    const candidate = 'acme/payments:issue-42'
    const scrubber = createScrubber()
    expect(scrubSafeSessionId(candidate, scrubber)).toBe(candidate)

    // #when a literal added later matches it
    scrubber.addLiterals?.([candidate])

    // #then it is hashed, and the hash is safe until it is a literal as well
    expect(scrubSafeSessionId(candidate, scrubber)).toBe(hashed(candidate))
    scrubber.addLiterals?.([hashed(candidate)])
    expect(scrubSafeSessionId(candidate, scrubber)).toBeUndefined()
  })

  it('returns nothing for an empty candidate', () => {
    expect(scrubSafeSessionId('', createScrubber())).toBeUndefined()
  })

  it.each([
    ['over the launcher limit', `acme/repo:${'k'.repeat(TRACING_IDENTITY_FIELD_MAX_CHARS)}`],
    ['holding a control character', 'acme/repo:issue\n42'],
  ])('hashes a candidate the scrubber leaves alone but the launcher would refuse, for one %s', (_label, candidate) => {
    // #given
    const scrubber = createScrubber()
    expect(scrubber.scrub(candidate)).toMatchObject({ok: true, text: candidate})

    // #when / #then the id is the hashed form, which the launcher accepts
    expect(scrubSafeSessionId(candidate, scrubber)).toBe(hashed(candidate))
  })

  it('returns nothing when the scrubber cannot process the candidate', () => {
    // #given a scrubber whose input ceiling is smaller than the candidate
    const scrubber = {...createScrubber(), scrub: () => ({ok: false, reason: 'over-input-ceiling'}) as const}

    // #when / #then neither form can be checked, so neither is used
    expect(scrubSafeSessionId('acme/repo:issue-42', scrubber)).toBeUndefined()
  })

  it('treats a value the safety net would withhold as changed', () => {
    // #given a scrubber whose scrub leaves the text but whose safety net says a literal survived in the candidate only
    const base = createScrubber()
    const scrubber = {...base, survived: (text: string) => text === 'acme/repo:issue-42'}

    // #when / #then the candidate is not used as is; its hashed form, which the net accepts, is
    expect(scrubSafeSessionId('acme/repo:issue-42', scrubber)).toBe(hashed('acme/repo:issue-42'))
  })
})
