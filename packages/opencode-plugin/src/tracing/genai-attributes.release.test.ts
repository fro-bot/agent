/** The Langfuse release on a trace's root span (fro-bot/agent#2403). */

import type {SpanRecord} from './turn-model.js'

import {describe, expect, it} from 'vitest'

import {chat, exported, invoke, rewritingScrubber, tool} from './genai-attributes.testing.js'

describe('langfuse.release', () => {
  it('is the plugin version on a root span, whatever its kind, in local mode too', () => {
    // #given a root invoke_agent span and no Action identity
    const span = exported(invoke(), {release: '1.4.2'})

    // #then
    expect(span.attributes['langfuse.release']).toBe('1.4.2')
  })

  it('is not set on a span that has a parent', () => {
    // #given each kind of span inside a trace
    const records: SpanRecord[] = [
      chat({parentSpanId: 'p'}),
      tool({parentSpanId: 'p'}),
      invoke({role: 'child', parentSpanId: 'p'}),
    ]

    // #then none carries it
    for (const record of records)
      expect(exported(record, {release: '1.4.2'}).attributes['langfuse.release']).toBeUndefined()
  })

  it('is not set when the version is unknown', () => {
    expect(exported(invoke()).attributes['langfuse.release']).toBeUndefined()
  })

  it('goes through the scrub like every other attribute', () => {
    // #given a scrubber that rewrites every string

    // #when
    const span = exported(invoke(), {release: '1.4.2'}, rewritingScrubber)

    // #then the value is what the scrubber made of it
    expect(span.attributes['langfuse.release']).toBe('[REDACTED:5]')
  })
})
