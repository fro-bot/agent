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

  it('a whitespace-only lead-in of a new segment does not defer its boundary onto an existing segment', () => {
    // #given segment b opens with whitespace only, then segment a resumes, then b becomes visible
    const out = run([
      ['a', 'hel'],
      ['b', ' '],
      ['a', 'lo'],
      ['b', 'new'],
    ])

    // #then a's continuation is not split; b's boundary is decided on b's own first visible delta
    expect(out).toBe('hel lo\n\nnew')
  })

  it('a whitespace-only lead-in does not make the next anonymous delta consume the boundary', () => {
    // #given
    const out = run([
      ['a', 'hel'],
      ['b', ' '],
      [null, 'lo'],
    ])

    // #then
    expect(out).toBe('hel lo')
  })

  it('a segment that starts empty is separated when it becomes visible after another segment', () => {
    // #given a is mentioned empty, b becomes visible first, then a becomes visible
    const out = run([
      ['a', ''],
      ['b', 'two'],
      ['a', 'one'],
    ])

    // #then a was never visible before b, so it is a new segment relative to b's text
    expect(out).toBe('two\n\none')
  })

  it('a segment that starts whitespace-only is separated when it becomes visible after another segment', () => {
    // #given
    const out = run([
      ['a', ' '],
      ['b', 'two'],
      ['a', 'one'],
    ])

    // #then
    expect(out).toBe(' two\n\none')
  })

  it.each([
    ['one newline', '\n'],
    ['two newlines', '\n\n'],
    ['three newlines', '\n\n\n'],
    ['newline, space, newline', '\n \n'],
  ])('separation is identical however the leading whitespace is chunked — %s', (_label, lead) => {
    // #given the same per-segment text "<lead>b", split every way across the whitespace / visible boundary
    const text = `${lead}b`
    const splits = Array.from({length: text.length}, (_unused, index) => index) // 0 = single delta
    const outputs = splits.map(at => {
      const chunks = at === 0 ? [text] : [text.slice(0, at), text.slice(at)]
      return run([['a', 'a'], ...chunks.map(chunk => ['b', chunk] as const)])
    })

    // #then every chunking yields the same output as the unsplit text, and exactly one blank line separates a from b
    expect(new Set(outputs).size).toBe(1)
    expect(outputs[0]?.replaceAll(' ', '')).toBe(`a${'\n'.repeat(Math.max(2, lead.split('\n').length - 1))}b`)
  })

  it('each chunking emits the segment text unchanged (only the separator is added)', () => {
    // #given
    const tracker = createTextBoundaryTracker()
    const emitted: string[] = []
    for (const [key, text] of [
      ['a', 'a'],
      ['b', '\n'],
      ['b', 'b'],
    ] as const) {
      const separator = tracker.separatorBefore(key, text)
      tracker.noteAppended(separator)
      tracker.noteAppended(text)
      emitted.push(separator, text)
    }

    // #then the texts reach the sink verbatim; the top-up accounts for the newline already emitted
    expect(emitted).toEqual(['', 'a', '', '\n', '\n', 'b'])
  })
})
