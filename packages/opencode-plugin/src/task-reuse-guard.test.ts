import {describe, expect, it} from 'vitest'

import {GUARDED_TOOL, rejectSubagentReuse, TASK_REUSE_REJECTION} from './task-reuse-guard.js'

describe('rejectSubagentReuse', () => {
  it('lets a subagent call through when no sessionID is passed', () => {
    // #given a fresh subagent call
    const event = {tool: 'subagent', input: {agent: 'general', description: 'x', prompt: 'do it'}}

    // #when / #then
    expect(() => rejectSubagentReuse(event)).not.toThrow()
  })

  it('rejects a subagent call that resumes a session', () => {
    // #given a call carrying a sessionID
    const event = {
      tool: 'subagent',
      input: {agent: 'general', prompt: 'again', sessionID: 'ses_e7c3de9a1ffergLi0Cw6pu106S'},
    }

    // #when / #then
    expect(() => rejectSubagentReuse(event)).toThrow(TASK_REUSE_REJECTION)
  })

  it('keeps ids, arguments and secrets out of the model-visible rejection text', () => {
    // #given a rejected call that carries an id and prompt text
    const event = {tool: 'subagent', input: {sessionID: 'ses_secretlookingid123', prompt: 'token=hunter2'}}

    // #when
    let message = ''
    try {
      rejectSubagentReuse(event)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    // #then only the fixed text comes back
    expect(message).toBe(TASK_REUSE_REJECTION)
    expect(message).not.toContain('ses_')
    expect(message).not.toContain('hunter2')
  })

  it('does not modify the call input', () => {
    // #given
    const input = {agent: 'general', sessionID: 'ses_abc'}
    const event = {tool: 'subagent', input}

    // #when
    expect(() => rejectSubagentReuse(event)).toThrow()

    // #then
    expect(event.input).toBe(input)
    expect(input).toEqual({agent: 'general', sessionID: 'ses_abc'})
  })

  it.each([
    ['an empty string, which upstream treats as absent', ''],
    ['undefined', undefined],
    ['null', null],
  ])('lets a call through when sessionID is %s', (_label, sessionID) => {
    // #given
    const event = {tool: 'subagent', input: {agent: 'general', sessionID}}

    // #when / #then
    expect(() => rejectSubagentReuse(event)).not.toThrow()
  })

  it.each([
    ['a number', 7],
    ['true', true],
    ['an object', {id: 'ses_1'}],
  ])('fails closed when sessionID is %s', (_label, sessionID) => {
    // #given a malformed but present sessionID
    const event = {tool: 'subagent', input: {sessionID}}

    // #when / #then
    expect(() => rejectSubagentReuse(event)).toThrow(TASK_REUSE_REJECTION)
  })

  it('ignores other tools, even with a sessionID argument', () => {
    // #given
    const event = {tool: 'session_read', input: {sessionID: 'ses_abc'}}

    // #when / #then
    expect(() => rejectSubagentReuse(event)).not.toThrow()
  })

  it.each([
    ['null', null],
    ['a string', 'ses_abc'],
    ['an array', ['ses_abc']],
    ['undefined', undefined],
  ])('lets a call through when the input is %s', (_label, input) => {
    // #given an input that cannot carry a resume request
    // #when / #then
    expect(() => rejectSubagentReuse({tool: GUARDED_TOOL, input})).not.toThrow()
  })
})
