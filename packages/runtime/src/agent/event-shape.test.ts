import {describe, expect, it} from 'vitest'

import {getEventKind, getEventPayload, getEventSessionID, getSessionID} from './event-shape.js'

describe('getSessionID', () => {
  it('reads an own sessionID string', () => {
    // #given / #when / #then
    expect(getSessionID({sessionID: 'ses_1'})).toBe('ses_1')
  })

  it('returns null on a miss, a wrong type, an inherited value, or a non-object', () => {
    // #given
    const inherited = Object.create({sessionID: 'ses_inherited'}) as object

    // #when / #then
    expect(getSessionID({})).toBeNull()
    expect(getSessionID({sessionID: 1})).toBeNull()
    expect(getSessionID(inherited)).toBeNull()
    expect(getSessionID(null)).toBeNull()
    expect(getSessionID('ses_1')).toBeNull()
  })
})

describe('getEventKind', () => {
  it('returns the type of a non-sync event as-is', () => {
    // #given / #when / #then
    expect(getEventKind({type: 'message.part.updated'})).toBe('message.part.updated')
  })

  it('strips the trailing .N index from a sync event name', () => {
    // #given
    const event = {type: 'sync', name: 'message.part.updated.1'}

    // #when / #then
    expect(getEventKind(event)).toBe('message.part.updated')
  })

  it('strips only a trailing numeric index', () => {
    // #given / #when / #then
    expect(getEventKind({type: 'sync', name: 'session.v2.status'})).toBe('session.v2.status')
    expect(getEventKind({type: 'sync', name: 'session.status.12'})).toBe('session.status')
    expect(getEventKind({type: 'sync', name: 'session.status.1a'})).toBe('session.status.1a')
  })

  it('falls back to "sync" when a sync event carries no name', () => {
    // #given / #when / #then
    expect(getEventKind({type: 'sync'})).toBe('sync')
  })

  it('returns null when the type is missing or the event is not an object', () => {
    // #given / #when / #then
    expect(getEventKind({})).toBeNull()
    expect(getEventKind(null)).toBeNull()
    expect(getEventKind('sync')).toBeNull()
  })
})

describe('getEventPayload', () => {
  it('prefers properties over data', () => {
    // #given
    const properties = {from: 'properties'}
    const event = {properties, data: {from: 'data'}}

    // #when / #then
    expect(getEventPayload(event)).toBe(properties)
  })

  it('falls back to data when properties is absent', () => {
    // #given
    const data = {from: 'data'}

    // #when / #then
    expect(getEventPayload({data})).toBe(data)
  })

  it('returns null when neither is present or the event is not an object', () => {
    // #given / #when / #then
    expect(getEventPayload({})).toBeNull()
    expect(getEventPayload(null)).toBeNull()
    expect(getEventPayload(undefined)).toBeNull()
  })
})

describe('getEventSessionID', () => {
  it('reads properties.sessionID first', () => {
    // #given
    const event = {properties: {sessionID: 'ses_props'}, data: {sessionID: 'ses_data'}}

    // #when / #then
    expect(getEventSessionID(event)).toBe('ses_props')
  })

  it('falls back to data.sessionID when properties has none', () => {
    // #given
    const event = {properties: {}, data: {sessionID: 'ses_data'}}

    // #when / #then
    expect(getEventSessionID(event)).toBe('ses_data')
  })

  it('returns null when neither carries a sessionID or the event is not an object', () => {
    // #given / #when / #then
    expect(getEventSessionID({properties: {}, data: {}})).toBeNull()
    expect(getEventSessionID({})).toBeNull()
    expect(getEventSessionID(null)).toBeNull()
  })
})
