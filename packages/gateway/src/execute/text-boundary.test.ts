import {describe, expect, it} from 'vitest'

import {createTextBoundaryTracker} from './text-boundary.js'

/** Drive the tracker the way run-core does: separator (if any) then text, both reported as appended. */
function run(steps: readonly (readonly [string | null, string])[]): string {
  const tracker = createTextBoundaryTracker()
  let out = ''
  for (const [key, text] of steps) {
    const separator = tracker.separatorBefore(key, text)
    if (separator.length > 0) {
      out += separator
      tracker.noteAppended(separator)
    }
    out += text
    tracker.noteAppended(text)
  }
  return out
}

describe('createTextBoundaryTracker', () => {
  it('separates distinct segments with a blank line', () => {
    // #given / #when
    const out = run([
      ['a', 'one'],
      ['b', 'two'],
    ])

    // #then
    expect(out).toBe('one\n\ntwo')
  })

  it('adds nothing at the very start, even for a later-introduced first segment', () => {
    // #given / #when
    const out = run([
      ['a', ''],
      ['b', 'two'],
    ])

    // #then
    expect(out).toBe('two')
  })

  it('keeps one segment contiguous', () => {
    // #given / #when
    const out = run([
      ['a', 'x'],
      ['a', 'y'],
    ])

    // #then
    expect(out).toBe('xy')
  })

  it('counts newlines in tool-summary-shaped text', () => {
    // #given text that ends the way a tool summary does
    const out = run([
      ['a', 'one'],
      [null, '\nsummary\n'],
      ['b', 'two'],
    ])

    // #then exactly one newline tops it up
    expect(out).toBe('one\nsummary\n\ntwo')
  })

  it('counts newlines split across whitespace-only deltas', () => {
    // #given
    const out = run([
      ['a', 'one'],
      [null, '\n'],
      [null, '\n'],
      ['b', 'two'],
    ])

    // #then already a blank line
    expect(out).toBe('one\n\ntwo')
  })
})
