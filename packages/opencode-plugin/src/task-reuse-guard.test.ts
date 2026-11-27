import {describe, expect, it} from 'vitest'

import {
  createSubagentResumeGuard,
  DEFAULT_MAX_RECORDED_CHILDREN,
  GUARDED_TOOL,
  TASK_REUSE_REJECTION,
} from './task-reuse-guard.js'

const PARENT = 'ses_parent0000000000000000'
const OTHER_PARENT = 'ses_otherparent00000000000'
const CHILD = 'ses_child00000000000000000'

/** The `execute.after` event a successful fresh `subagent` call produces on v2.4.1 (see `parseDispatch`'s source). */
function dispatched(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'subagent',
    codemode: false,
    sessionID: PARENT,
    agent: 'build',
    messageID: 'msg_1',
    id: 'call_1',
    input: {agent: 'general', description: 'x', prompt: 'do it'},
    status: 'completed',
    result: {
      output: {sessionID: CHILD, status: 'running', output: 'The subagent is working in the background.'},
      content: 'The subagent is working in the background.',
      metadata: {sessionID: CHILD, status: 'running'},
    },
    ...overrides,
  }
}

function resumeCall(sessionID: unknown, caller: string = PARENT) {
  return {tool: 'subagent', sessionID: caller, input: {agent: 'general', prompt: 'again', sessionID}}
}

function refusalOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

describe('a guard on a host that never allows a resume', () => {
  const refuseAll = () => createSubagentResumeGuard({actionHost: false})

  it('lets a subagent call through when no sessionID is passed', () => {
    // #given a fresh subagent call
    const event = {tool: 'subagent', sessionID: PARENT, input: {agent: 'general', description: 'x', prompt: 'do it'}}

    // #when / #then
    expect(() => refuseAll().before(event)).not.toThrow()
  })

  it('rejects a subagent call that resumes a session', () => {
    // #given a call carrying a sessionID
    const event = {
      tool: 'subagent',
      sessionID: PARENT,
      input: {agent: 'general', prompt: 'again', sessionID: 'ses_e7c3de9a1ffergLi0Cw6pu106S'},
    }

    // #when / #then
    expect(() => refuseAll().before(event)).toThrow(TASK_REUSE_REJECTION)
  })

  it('keeps ids, arguments and secrets out of the model-visible rejection text', () => {
    // #given a rejected call that carries an id and prompt text
    const event = {tool: 'subagent', input: {sessionID: 'ses_secretlookingid123', prompt: 'token=hunter2'}}

    // #when
    const message = refusalOf(() => refuseAll().before(event))

    // #then only the fixed text comes back
    expect(message).toBe(TASK_REUSE_REJECTION)
    expect(message).not.toContain('ses_')
    expect(message).not.toContain('hunter2')
  })

  it('does not modify the call input', () => {
    // #given
    const input = {agent: 'general', sessionID: 'ses_abc'}
    const event = {tool: 'subagent', sessionID: PARENT, input}

    // #when
    expect(() => refuseAll().before(event)).toThrow()

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
    const event = {tool: 'subagent', sessionID: PARENT, input: {agent: 'general', sessionID}}

    // #when / #then
    expect(() => refuseAll().before(event)).not.toThrow()
  })

  it.each([
    ['a number', 7],
    ['true', true],
    ['an object', {id: 'ses_1'}],
  ])('fails closed when sessionID is %s', (_label, sessionID) => {
    // #given a malformed but present sessionID
    const event = {tool: 'subagent', sessionID: PARENT, input: {sessionID}}

    // #when / #then
    expect(() => refuseAll().before(event)).toThrow(TASK_REUSE_REJECTION)
  })

  it('ignores other tools, even with a sessionID argument', () => {
    // #given
    const event = {tool: 'session_read', sessionID: PARENT, input: {sessionID: 'ses_abc'}}

    // #when / #then
    expect(() => refuseAll().before(event)).not.toThrow()
  })

  it.each([
    ['null', null],
    ['a string', 'ses_abc'],
    ['an array', ['ses_abc']],
    ['undefined', undefined],
  ])('lets a call through when the input is %s', (_label, input) => {
    // #given an input that cannot carry a resume request
    // #when / #then
    expect(() => refuseAll().before({tool: GUARDED_TOOL, sessionID: PARENT, input})).not.toThrow()
  })

  it('refuses a recorded child of the caller: the host decides first', () => {
    // #given a child the plugin recorded from a fresh dispatch, on a host that is not the Action
    const guard = refuseAll()
    guard.after(dispatched())

    // #when / #then
    expect(() => guard.before(resumeCall(CHILD))).toThrow(TASK_REUSE_REJECTION)
  })
})

describe('a guard on the Action host', () => {
  const actionGuard = (maxRecordedChildren?: number) =>
    createSubagentResumeGuard({actionHost: true, ...(maxRecordedChildren === undefined ? {} : {maxRecordedChildren})})

  it('admits a resume of a child its caller dispatched in this run', () => {
    // #given a fresh dispatch by PARENT that returned CHILD
    const guard = actionGuard()
    guard.after(dispatched())

    // #when / #then the same caller may resume it, more than once
    expect(() => guard.before(resumeCall(CHILD))).not.toThrow()
    expect(() => guard.before(resumeCall(CHILD))).not.toThrow()
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty string', ''],
  ])('admits a fresh dispatch when sessionID is %s', (_label, sessionID) => {
    // #given
    const event = {tool: 'subagent', sessionID: PARENT, input: {agent: 'general', sessionID}}

    // #when / #then
    expect(() => actionGuard().before(event)).not.toThrow()
  })

  it('refuses an id the plugin never recorded', () => {
    // #given a recorded child and a foreign id
    const guard = actionGuard()
    guard.after(dispatched())

    // #when / #then the refusal text is the fixed one and names no id
    const message = refusalOf(() => guard.before(resumeCall('ses_foreign000000000000000')))
    expect(message).toBe(TASK_REUSE_REJECTION)
    expect(message).not.toContain('ses_foreign')
  })

  it('refuses a child recorded for another caller', () => {
    // #given CHILD belongs to PARENT
    const guard = actionGuard()
    guard.after(dispatched())

    // #when / #then another session cannot resume it
    expect(() => guard.before(resumeCall(CHILD, OTHER_PARENT))).toThrow(TASK_REUSE_REJECTION)
  })

  it('refuses a resume when the host event carries no caller session', () => {
    // #given
    const guard = actionGuard()
    guard.after(dispatched())

    // #when / #then a missing or empty caller never matches a record
    const input = {agent: 'general', prompt: 'again', sessionID: CHILD}
    expect(() => guard.before({tool: 'subagent', input})).toThrow(TASK_REUSE_REJECTION)
    expect(() => guard.before({tool: 'subagent', sessionID: '', input})).toThrow(TASK_REUSE_REJECTION)
  })

  it.each([
    ['a number', 7],
    ['true', true],
    ['an object', {id: CHILD}],
    ['an array', [CHILD]],
  ])('refuses a malformed sessionID: %s', (_label, sessionID) => {
    // #given
    const guard = actionGuard()
    guard.after(dispatched())

    // #when / #then
    expect(() => guard.before(resumeCall(sessionID))).toThrow(TASK_REUSE_REJECTION)
  })

  it('does not treat an object that stringifies to the child id as the child', () => {
    // #given
    const guard = actionGuard()
    guard.after(dispatched())

    // #when / #then
    expect(() => guard.before(resumeCall({toString: () => CHILD}))).toThrow(TASK_REUSE_REJECTION)
  })

  it('records one caller per child and keeps several children apart', () => {
    // #given two callers, each with a child
    const guard = actionGuard()
    guard.after(dispatched())
    guard.after(
      dispatched({
        sessionID: OTHER_PARENT,
        result: {metadata: {sessionID: 'ses_child2', status: 'running'}, output: {sessionID: 'ses_child2'}},
      }),
    )

    // #when / #then each caller reaches only its own
    expect(() => guard.before(resumeCall(CHILD))).not.toThrow()
    expect(() => guard.before(resumeCall('ses_child2', OTHER_PARENT))).not.toThrow()
    expect(() => guard.before(resumeCall('ses_child2'))).toThrow(TASK_REUSE_REJECTION)
    expect(() => guard.before(resumeCall(CHILD, OTHER_PARENT))).toThrow(TASK_REUSE_REJECTION)
  })

  describe('what makes a record', () => {
    it('records nothing from another tool that returns the same shape', () => {
      // #given a different tool answering {sessionID, status: 'running'}
      const guard = actionGuard()
      guard.after(dispatched({tool: 'session_read'}))

      // #when / #then
      expect(() => guard.before(resumeCall(CHILD))).toThrow(TASK_REUSE_REJECTION)
    })

    it('records nothing from a failed subagent call', () => {
      // #given a call that ended in an error, even one whose payload names a child
      const guard = actionGuard()
      const failed = dispatched({status: 'error', error: {_tag: 'Tool.Error', message: 'denied'}})
      delete failed.result
      guard.after(failed)
      guard.after(dispatched({status: 'error'}))

      // #when / #then
      expect(() => guard.before(resumeCall(CHILD))).toThrow(TASK_REUSE_REJECTION)
    })

    it('records nothing from a call that was itself a resume', () => {
      // #given a completed call whose input carried a sessionID (an admitted resume, or a forged event)
      const guard = actionGuard()
      guard.after(dispatched({input: {agent: 'general', prompt: 'again', sessionID: 'ses_other'}}))

      // #when / #then neither the named id nor the reported child becomes resumable
      expect(() => guard.before(resumeCall(CHILD))).toThrow(TASK_REUSE_REJECTION)
      expect(() => guard.before(resumeCall('ses_other'))).toThrow(TASK_REUSE_REJECTION)
    })

    it('treats an empty-string sessionID in the input as a fresh dispatch', () => {
      // #given upstream deletes `sessionID: ""` before it runs, so this was a fresh dispatch
      const guard = actionGuard()
      guard.after(dispatched({input: {agent: 'general', prompt: 'x', sessionID: ''}}))

      // #when / #then
      expect(() => guard.before(resumeCall(CHILD))).not.toThrow()
    })

    it.each([
      ['no result', {result: undefined}],
      ['an empty result', {result: {}}],
      ['no child in metadata or output', {result: {metadata: {status: 'running'}, content: 'x'}}],
      ['an empty child id', {result: {metadata: {sessionID: ''}}}],
      ['a non-string child id', {result: {metadata: {sessionID: 7}}}],
      ['a metadata that is not an object', {result: {metadata: 'ses_child00000000000000000'}}],
      [
        'an output and metadata that name different children',
        {result: {metadata: {sessionID: CHILD}, output: {sessionID: 'ses_different'}}},
      ],
      ['an input that is not an object', {input: undefined}],
      ['no caller session', {sessionID: undefined}],
      ['an empty caller session', {sessionID: ''}],
    ])('records nothing from a dispatch with %s', (_label, overrides) => {
      // #given
      const guard = actionGuard()
      guard.after(dispatched(overrides))

      // #when / #then neither id is resumable
      expect(() => guard.before(resumeCall(CHILD))).toThrow(TASK_REUSE_REJECTION)
      expect(() => guard.before(resumeCall('ses_different'))).toThrow(TASK_REUSE_REJECTION)
    })

    it('reads the child from the output when the metadata is missing', () => {
      // #given a result with only the structured output
      const guard = actionGuard()
      guard.after(dispatched({result: {output: {sessionID: CHILD, status: 'running'}}}))

      // #when / #then
      expect(() => guard.before(resumeCall(CHILD))).not.toThrow()
    })

    it.each([
      ['null', null],
      ['a string', 'ses_child00000000000000000'],
      ['an array', [dispatched()]],
      ['undefined', undefined],
    ])('never throws on an after event that is %s', (_label, event) => {
      // #given / #when / #then the hook cannot fail a tool call
      expect(() => actionGuard().after(event)).not.toThrow()
    })

    it('does not modify the event', () => {
      // #given
      const event = dispatched()
      const snapshot = structuredClone(event)

      // #when
      actionGuard().after(event)

      // #then
      expect(event).toEqual(snapshot)
    })
  })

  describe('lifetime', () => {
    it('refuses a previously valid resume on a fresh guard (a plugin reload)', () => {
      // #given a record in one instance
      const first = actionGuard()
      first.after(dispatched())
      expect(() => first.before(resumeCall(CHILD))).not.toThrow()

      // #when the plugin reloads and builds a new guard
      const second = actionGuard()

      // #then nothing carried over, and the two instances share no state
      expect(() => second.before(resumeCall(CHILD))).toThrow(TASK_REUSE_REJECTION)
    })

    it('keeps the most recent children when the record is full, and refuses the evicted one', () => {
      // #given room for two children and three dispatches
      const guard = actionGuard(2)
      for (const child of ['ses_a', 'ses_b', 'ses_c']) {
        guard.after(dispatched({result: {metadata: {sessionID: child, status: 'running'}}}))
      }

      // #when / #then the oldest fell out and fails closed
      expect(() => guard.before(resumeCall('ses_a'))).toThrow(TASK_REUSE_REJECTION)
      expect(() => guard.before(resumeCall('ses_b'))).not.toThrow()
      expect(() => guard.before(resumeCall('ses_c'))).not.toThrow()
    })

    it('has a bound by default', () => {
      // #given / #when / #then
      expect(DEFAULT_MAX_RECORDED_CHILDREN).toBeGreaterThan(0)
      expect(Number.isFinite(DEFAULT_MAX_RECORDED_CHILDREN)).toBe(true)
    })

    it.each([0, -1, Number.NaN, 1.5])('falls back to the default bound for %s', bound => {
      // #given a nonsense bound
      const guard = actionGuard(bound)
      guard.after(dispatched())

      // #when / #then the record still works
      expect(() => guard.before(resumeCall(CHILD))).not.toThrow()
    })
  })
})
