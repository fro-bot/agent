import {describe, expect, it} from 'vitest'

import {createTextBoundaryTracker} from './text-boundary.js'

type Step = readonly [string | null, string]

/** Drive the tracker the way run-core does: append what each delta returns. Held text stays held. */
function drive(steps: readonly Step[]) {
  const tracker = createTextBoundaryTracker()
  let out = ''
  for (const [key, text] of steps) out += tracker.append(key, text)
  return {tracker, out}
}

/** Everything the sink holds once the stream is over: the appends, then the flush run-core does when the loop exits. */
function run(steps: readonly Step[]): string {
  const {tracker, out} = drive(steps)
  return out + tracker.flush()
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

    // #then a's continuation is not split; b's boundary is decided on b's own first visible delta, and b's held
    // space goes AFTER the separator (it used to land before it: "hel lo\n\nnew")
    expect(out).toBe('hello\n\n new')
  })

  it('a whitespace-only lead-in does not make the next anonymous delta consume the boundary', () => {
    // #given
    const {tracker, out} = drive([
      ['a', 'hel'],
      ['b', ' '],
      [null, 'lo'],
    ])

    // #then the anonymous delta is appended untouched and b's space is still held (it used to be emitted: "hel lo")
    expect(out).toBe('hello')
    expect(tracker.flush()).toBe(' ')
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
    ['newline and indentation', '\n    '],
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

  it(String.raw`keeps Markdown code indentation after the separator for EVERY chunking of "\n    code"`, () => {
    // #given part a emitted "a", then part b's text "\n    code" split at every possible set of boundaries
    const text = '\n    code'
    const outputs = new Set<string>()
    for (let mask = 0; mask < 2 ** (text.length - 1); mask += 1) {
      const chunks: string[] = []
      let start = 0
      for (let at = 1; at < text.length; at += 1) {
        if ((mask >> (at - 1)) % 2 === 1) {
          chunks.push(text.slice(start, at))
          start = at
        }
      }
      chunks.push(text.slice(start))
      outputs.add(run([['a', 'a'], ...chunks.map(chunk => ['b', chunk] as const)]))
    }

    // #then all 256 chunkings are byte-identical: an indented code block, never "a\n    \ncode"
    expect([...outputs]).toEqual(['a\n\n    code'])
  })

  it.each([
    ['in one delta', ['\n    code']],
    ['split immediately before the code', ['\n    ', 'code']],
    ['split inside the indentation', ['\n  ', '  code']],
    ['split after the newline', ['\n', '    code']],
  ])('code indentation survives the boundary — %s', (_label, chunks) => {
    // #given / #when
    const out = run([['a', 'a'], ...chunks.map(chunk => ['b', chunk] as const)])

    // #then
    expect(out).toBe('a\n\n    code')
  })

  it("holds a new segment's whitespace-only deltas and emits separator + held + text as one string", () => {
    // #given
    const tracker = createTextBoundaryTracker()

    // #when
    const emitted = [
      tracker.append('a', 'a'),
      tracker.append('b', '\n'),
      tracker.append('b', '    '),
      tracker.append('b', 'x'),
    ]

    // #then nothing is emitted for the held lead-in; the first visible delta releases it behind the separator
    expect(emitted).toEqual(['a', '', '', '\n\n    x'])
  })

  it('does not hold before any visible output: whitespace passes straight through', () => {
    // #given / #when
    const tracker = createTextBoundaryTracker()

    // #then
    expect(tracker.append('a', '  ')).toBe('  ')
    expect(tracker.append('b', '\n')).toBe('\n')
    expect(tracker.flush()).toBe('')
  })

  it('does not hold whitespace of an already-visible segment', () => {
    // #given
    const tracker = createTextBoundaryTracker()
    tracker.append('a', 'a')

    // #when / #then
    expect(tracker.append('a', '  ')).toBe('  ')
  })

  it('never holds or separates anonymous deltas', () => {
    // #given
    const tracker = createTextBoundaryTracker()
    tracker.append('a', 'a')

    // #when / #then
    expect(tracker.append(null, ' ')).toBe(' ')
    expect(tracker.append(null, 'b')).toBe('b')
    expect(tracker.flush()).toBe('')
  })

  it("a held lead-in is not released by another segment's continuation or by anonymous deltas", () => {
    // #given b holds a space
    const tracker = createTextBoundaryTracker()
    tracker.append('a', 'hel')
    tracker.append('b', ' ')

    // #when a continues and an anonymous delta follows
    const emitted = [tracker.append('a', 'lo'), tracker.append(null, '!')]

    // #then neither emits or consumes b's space; it is still released with b's own text, behind the separator
    expect(emitted).toEqual(['lo', '!'])
    expect(tracker.append('b', 'new')).toBe('\n\n new')
  })

  it("flush releases a never-visible segment's held text as-is, with no separator, in first-held order", () => {
    // #given two segments hold whitespace and never become visible
    const tracker = createTextBoundaryTracker()
    tracker.append('a', 'a')
    tracker.append('b', '\n')
    tracker.append('c', ' ')
    tracker.append('b', '\n')

    // #when
    const flushed = tracker.flush()

    // #then per-segment text stays in order, and nothing is added or lost
    expect(flushed).toBe('\n\n ')
    expect(tracker.flush()).toBe('')
  })

  it('flush keeps the trailing-newline count accurate for text that follows it', () => {
    // #given
    const tracker = createTextBoundaryTracker()
    tracker.append('a', 'a')
    tracker.append('b', '\n')
    tracker.flush()

    // #when a later segment starts after the flushed newline
    // #then one newline already ends the output, so one more completes the blank line
    expect(tracker.append('c', 'c')).toBe('\nc')
  })

  it("emits a segment's separator, held lead-in and first visible text as ONE append", () => {
    // #given
    const tracker = createTextBoundaryTracker()
    const emitted: string[] = []
    for (const [key, text] of [
      ['a', 'a'],
      ['b', '\n'],
      ['b', 'b'],
    ] as const) {
      emitted.push(tracker.append(key, text))
    }

    // #then the whitespace-only delta is held (emits nothing), then released with the text after its top-up
    expect(emitted).toEqual(['a', '', '\n\nb'])
  })
})
