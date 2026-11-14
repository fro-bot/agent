import {describe, expect, it} from 'vitest'
import {ROOT_CHAIN_TAIL_CHARS, rootChainReport, rootChainTail} from './sandbox-namespace.js'

/** A builder report as long as the builder lets one be: a 160-character operation and a 240-character detail. */
function longReport(stage: string): string {
  return `${JSON.stringify({view: 'failed', stage, op: `mount ${'x'.repeat(150)}`, detail: `exited non-zero: ${'e'.repeat(220)}`})}\n`
}

describe('rootChainReport', () => {
  it('reads the stage of a report that is longer than the tail, from the whole text', () => {
    // #given a report whose stage is in its first characters, and more text before it than the tail holds
    const text = `${'noise '.repeat(100)}\n${longReport('seal')}`

    // #when the tail is cut and the report is read
    const tail = rootChainTail(text)
    const report = rootChainReport(text)

    // #then the tail lost the stage and the report did not
    expect(tail).not.toContain('"stage"')
    expect(tail.length).toBeLessThanOrEqual(ROOT_CHAIN_TAIL_CHARS + 3)
    expect(report).toEqual({stage: 'seal'})
  })

  it('takes the last report when there are several, and ignores lines that are not a report', () => {
    // #given two reports and junk between and after
    const first = `${JSON.stringify({view: 'failed', stage: 'bind'})}\n`
    const second = `${JSON.stringify({view: 'failed', stage: 'verify'})}\n`

    // #then the last one wins
    expect(rootChainReport(`${first}junk {not json\n${second}trailing text\n`)).toEqual({stage: 'verify'})
  })

  it.each([
    ['no report', 'pivot_root: failed to change root\n'],
    ['a stage that is not a plain word', `${JSON.stringify({view: 'failed', stage: 'Seal Now!'})}\n`],
    ['a stage that is too long', `${JSON.stringify({view: 'failed', stage: 'abcdefghijklmnopq'})}\n`],
    ['a report that did not fail', `${JSON.stringify({view: 'ok', stage: 'seal'})}\n`],
    ['null', null],
  ])('finds no stage in %s', (_label, text) => {
    // #given text that is not a usable report
    // #then there is no stage
    expect(rootChainReport(text)).toEqual({stage: null})
  })
})
