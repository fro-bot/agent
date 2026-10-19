import {describe, expect, it} from 'vitest'

import {parseSyntheticNoticePart, parseTaskNotice} from './task-notice.js'

describe('parseTaskNotice', () => {
  it('parses a completed notice', () => {
    // #given
    const text = '<task id="ses_child" state="completed">'

    // #when / #then
    expect(parseTaskNotice(text)).toEqual({childSessionId: 'ses_child', state: 'completed'})
  })

  it('parses an error notice embedded in surrounding text', () => {
    // #given
    const text = 'Background task finished.\n<task id="ses_child" state="error">\nboom'

    // #when / #then
    expect(parseTaskNotice(text)).toEqual({childSessionId: 'ses_child', state: 'error'})
  })

  it('returns null for any other state', () => {
    // #given / #when / #then
    expect(parseTaskNotice('<task id="ses_child" state="running">')).toBeNull()
    expect(parseTaskNotice('<task id="ses_child" state="cancelled">')).toBeNull()
  })

  it('returns null for a missing or empty id', () => {
    // #given / #when / #then
    expect(parseTaskNotice('<task state="completed">')).toBeNull()
    expect(parseTaskNotice('<task id="" state="completed">')).toBeNull()
  })

  it('returns null for text with no notice', () => {
    // #given / #when / #then
    expect(parseTaskNotice('')).toBeNull()
    expect(parseTaskNotice('plain assistant text')).toBeNull()
  })

  it('is stateless across repeated calls', () => {
    // #given
    const text = '<task id="ses_child" state="completed">'

    // #when / #then
    expect(parseTaskNotice(text)).toEqual(parseTaskNotice(text))
  })
})

describe('parseSyntheticNoticePart', () => {
  const text = '<task id="ses_child" state="completed">'

  it('parses a synthetic text part', () => {
    // #given
    const part = {type: 'text', synthetic: true, text}

    // #when / #then
    expect(parseSyntheticNoticePart(part)).toEqual({childSessionId: 'ses_child', state: 'completed'})
  })

  it('returns null for a non-text part', () => {
    // #given / #when / #then
    expect(parseSyntheticNoticePart({type: 'tool', synthetic: true, text})).toBeNull()
  })

  it('returns null for a non-synthetic part', () => {
    // #given / #when / #then
    expect(parseSyntheticNoticePart({type: 'text', synthetic: false, text})).toBeNull()
    expect(parseSyntheticNoticePart({type: 'text', text})).toBeNull()
    expect(parseSyntheticNoticePart({type: 'text', synthetic: 'true', text})).toBeNull()
  })

  it('returns null for a part whose text is missing or not a string', () => {
    // #given / #when / #then
    expect(parseSyntheticNoticePart({type: 'text', synthetic: true})).toBeNull()
    expect(parseSyntheticNoticePart({type: 'text', synthetic: true, text: null})).toBeNull()
    expect(parseSyntheticNoticePart({type: 'text', synthetic: true, text: 1})).toBeNull()
  })

  it('returns null for synthetic text that is not a notice', () => {
    // #given / #when / #then
    expect(parseSyntheticNoticePart({type: 'text', synthetic: true, text: 'hello'})).toBeNull()
  })

  it('returns null for a null or non-object part', () => {
    // #given / #when / #then
    expect(parseSyntheticNoticePart(null)).toBeNull()
    expect(parseSyntheticNoticePart(undefined)).toBeNull()
    expect(parseSyntheticNoticePart(text)).toBeNull()
  })
})
