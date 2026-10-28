import {describe, expect, it} from 'vitest'

import {mapSessionInfoV2, mapSessionPageV2} from './storage-mappers-v2.js'

// Session payload as `ctx.session.list` / `.get` return it.
const rawSession = {
  id: 'ses_e7c3de9a1ffergLi0Cw6pu106S',
  projectID: '9478f66770974ac2776a01decd9114287946f8b4',
  cost: 0,
  tokens: {input: 20, output: 10, reasoning: 0, cache: {read: 0, write: 0}},
  outcome: 'succeeded',
  time: {created: 1793211897440, updated: 1793211897516, idle: 1793211897497},
  title: 'Fix the flaky cache test',
  subpath: '../../../../../tmp/work/repo',
  location: {directory: '/tmp/work/repo'},
}

describe('mapSessionInfoV2', () => {
  it('maps a V2 session to the projected info', () => {
    // #given a session payload as the V2 API returns it
    // #when it is mapped
    const result = mapSessionInfoV2(rawSession)

    // #then the fields the tools read are present and the rest is dropped
    expect(result).toEqual({
      id: 'ses_e7c3de9a1ffergLi0Cw6pu106S',
      projectID: '9478f66770974ac2776a01decd9114287946f8b4',
      directory: '/tmp/work/repo',
      title: 'Fix the flaky cache test',
      time: {created: 1793211897440, updated: 1793211897516},
    })
  })

  it('carries parentID and the archive time when set', () => {
    // #given a child session that was archived
    const payload = {...rawSession, parentID: 'ses_parent', time: {...rawSession.time, archived: 1793211999999}}

    // #when
    const result = mapSessionInfoV2(payload)

    // #then
    expect(result?.parentID).toBe('ses_parent')
    expect(result?.time.archived).toBe(1793211999999)
  })

  it('unwraps a {data} envelope', () => {
    // #given the HTTP client's envelope instead of the plugin context's bare payload
    // #when
    const result = mapSessionInfoV2({data: rawSession})

    // #then
    expect(result?.id).toBe(rawSession.id)
  })

  it('defaults a missing title to an empty string', () => {
    // #given a session that has no title yet
    const untitled = {...rawSession, title: undefined}

    // #when
    const result = mapSessionInfoV2(untitled)

    // #then
    expect(result?.title).toBe('')
  })

  it.each([
    ['null', null],
    ['a string', 'ses_1'],
    ['an array', []],
    ['a record without an id', {...rawSession, id: undefined}],
    ['a record without times', {...rawSession, time: undefined}],
    ['a record with non-numeric times', {...rawSession, time: {created: 'yesterday', updated: 1}}],
    ['a record without a location', {...rawSession, location: undefined}],
  ])('returns null for %s', (_label, payload) => {
    // #given a payload that is not a session
    // #when
    const result = mapSessionInfoV2(payload)

    // #then
    expect(result).toBeNull()
  })
})

describe('mapSessionPageV2', () => {
  it('maps a {data, cursor} page and exposes the next cursor', () => {
    // #given
    const payload = {data: [rawSession], cursor: {previous: 'prev', next: 'next-token'}}

    // #when
    const page = mapSessionPageV2(payload)

    // #then
    expect(page?.sessions.map(s => s.id)).toEqual([rawSession.id])
    expect(page?.nextCursor).toBe('next-token')
  })

  it('accepts a bare array and reports no next cursor', () => {
    // #given
    // #when
    const page = mapSessionPageV2([rawSession])

    // #then
    expect(page?.sessions).toHaveLength(1)
    expect(page?.nextCursor).toBeUndefined()
  })

  it('drops malformed entries and keeps the valid ones', () => {
    // #given one good session among junk
    const payload = {data: [rawSession, {id: 'ses_broken'}, 'junk', null]}

    // #when
    const page = mapSessionPageV2(payload)

    // #then
    expect(page?.sessions.map(s => s.id)).toEqual([rawSession.id])
  })

  it('returns null when the payload is not list-shaped, so callers can tell it from an empty page', () => {
    // #given
    // #when
    // #then
    expect(mapSessionPageV2({not: 'a list'})).toBeNull()
    expect(mapSessionPageV2(undefined)).toBeNull()
    expect(mapSessionPageV2({data: []})?.sessions).toEqual([])
  })
})
