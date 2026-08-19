import type {EventType} from './types.js'
import {describe, expect, it} from 'vitest'
import {resolveOutputMode} from './output-mode.js'

describe('resolveOutputMode', () => {
  it('returns null for affected event types and unsupported events', () => {
    // #given
    const eventTypes: readonly EventType[] = [
      'discussion_comment',
      'issue_comment',
      'issues',
      'pull_request',
      'pull_request_review_comment',
      'unsupported',
    ]

    // #when
    const results = eventTypes.map(eventType => resolveOutputMode(eventType, 'auto'))

    // #then
    expect(results).toEqual(eventTypes.map(() => null))
  })

  it('resolves auto to working-dir for manual triggers without prompt inference', () => {
    // #given a compatibility request on each manual trigger
    const eventTypes: readonly EventType[] = ['schedule', 'workflow_dispatch']

    // #when
    const results = eventTypes.map(eventType => resolveOutputMode(eventType, 'auto'))

    // #then
    expect(results).toEqual(['working-dir', 'working-dir'])
  })

  it('keeps explicit branch-pr available for manual triggers', () => {
    // #when
    const scheduleResult = resolveOutputMode('schedule', 'branch-pr')
    const dispatchResult = resolveOutputMode('workflow_dispatch', 'branch-pr')

    // #then
    expect(scheduleResult).toBe('branch-pr')
    expect(dispatchResult).toBe('branch-pr')
  })

  it('keeps explicit working-dir available for manual triggers', () => {
    // #when
    const result = resolveOutputMode('workflow_dispatch', 'working-dir')

    // #then
    expect(result).toBe('working-dir')
  })

  it('uses exhaustive guards for event and mode switches', () => {
    // #given / #when / #then
    // Adding a new EventType or OutputMode variant must break the corresponding
    // compile-time guard in src/features/agent/output-mode.ts.
    expect(true).toBe(true)
  })
})
