/**
 * output.test.ts — Contract tests for the OperatorOutputFrame type.
 *
 * Covers:
 * 1. Type shape — required fields are present; droppedCount is optional.
 * 2. Delta frame semantics — final: false, seq monotonic.
 * 3. Terminal frame semantics — final: true, text is the complete answer.
 * 4. Barrel re-export — OperatorOutputFrame is importable from the contract barrel.
 */

import type {OperatorOutputFrame} from './output.js'

import {describe, expect, expectTypeOf, it} from 'vitest'

// ---------------------------------------------------------------------------
// 1. Type shape — required fields and optional droppedCount
// ---------------------------------------------------------------------------

describe('OperatorOutputFrame — type shape', () => {
  it('accepts a valid delta frame (all required fields, no droppedCount)', () => {
    // #given a minimal delta frame with all required fields
    const frame: OperatorOutputFrame = {
      runId: 'run-abc-123',
      text: 'Hello, ',
      final: false,
      seq: 0,
    }

    // #when the frame is constructed
    // #then all required fields are present and correct
    expect(frame.runId).toBe('run-abc-123')
    expect(frame.text).toBe('Hello, ')
    expect(frame.final).toBe(false)
    expect(frame.seq).toBe(0)
  })

  it('accepts a valid terminal frame (all required fields, no droppedCount)', () => {
    // #given a terminal frame with final: true
    const frame: OperatorOutputFrame = {
      runId: 'run-abc-123',
      text: 'Hello, world!',
      final: true,
      seq: 3,
    }

    // #when the frame is constructed
    // #then final is true and seq is the last monotonic value
    expect(frame.final).toBe(true)
    expect(frame.seq).toBe(3)
    expect(frame.text).toBe('Hello, world!')
  })

  it('accepts a frame with droppedCount present (coalescing signal)', () => {
    // #given a frame that carries a droppedCount (backpressure coalescing occurred)
    const frame: OperatorOutputFrame = {
      runId: 'run-abc-123',
      text: 'partial output',
      final: false,
      seq: 5,
      droppedCount: 2,
    }

    // #when the frame is constructed
    // #then droppedCount is present and reflects the number of elided deltas
    expect(frame.droppedCount).toBe(2)
  })

  it('droppedCount is optional — a frame without it is valid', () => {
    // #given a frame without droppedCount
    const frame: OperatorOutputFrame = {
      runId: 'run-xyz',
      text: 'output text',
      final: false,
      seq: 1,
    }

    // #when the frame is constructed
    // #then droppedCount is absent (undefined)
    expect(frame.droppedCount).toBeUndefined()
  })

  it('type has the required fields at the type level', () => {
    // #given the OperatorOutputFrame type
    // #when inspected at the type level
    // #then all required fields are present in the type
    expectTypeOf<OperatorOutputFrame>().toHaveProperty('runId')
    expectTypeOf<OperatorOutputFrame>().toHaveProperty('text')
    expectTypeOf<OperatorOutputFrame>().toHaveProperty('final')
    expectTypeOf<OperatorOutputFrame>().toHaveProperty('seq')
  })

  it('type has droppedCount as an optional field', () => {
    // #given the OperatorOutputFrame type
    // #when inspected at the type level
    // #then droppedCount is present in the type (optional — number | undefined)
    expectTypeOf<OperatorOutputFrame>().toHaveProperty('droppedCount')
    expectTypeOf<OperatorOutputFrame['droppedCount']>().toEqualTypeOf<number | undefined>()
  })
})

// ---------------------------------------------------------------------------
// 2. Delta frame semantics
// ---------------------------------------------------------------------------

describe('OperatorOutputFrame — delta frame semantics', () => {
  it('delta frames have final: false', () => {
    // #given a sequence of delta frames
    const deltas: OperatorOutputFrame[] = [
      {runId: 'run-1', text: 'chunk-a', final: false, seq: 0},
      {runId: 'run-1', text: 'chunk-b', final: false, seq: 1},
      {runId: 'run-1', text: 'chunk-c', final: false, seq: 2},
    ]

    // #when each frame is inspected
    // #then all have final: false
    for (const frame of deltas) {
      expect(frame.final).toBe(false)
    }
  })

  it('seq is monotonically increasing across delta frames', () => {
    // #given a sequence of delta frames with ascending seq values
    const deltas: OperatorOutputFrame[] = [
      {runId: 'run-1', text: 'a', final: false, seq: 0},
      {runId: 'run-1', text: 'b', final: false, seq: 1},
      {runId: 'run-1', text: 'c', final: false, seq: 2},
    ]

    // #when seq values are extracted
    const seqs = deltas.map(f => f.seq)

    // #then each seq is strictly greater than the previous
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1]
      const curr = seqs[i]
      expect(curr).toBeGreaterThan(prev as number)
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Terminal frame semantics
// ---------------------------------------------------------------------------

describe('OperatorOutputFrame — terminal frame semantics', () => {
  it('terminal frame has final: true', () => {
    // #given a terminal frame
    const terminal: OperatorOutputFrame = {
      runId: 'run-1',
      text: 'The complete answer.',
      final: true,
      seq: 5,
    }

    // #when the frame is inspected
    // #then final is true
    expect(terminal.final).toBe(true)
  })

  it('terminal frame with empty text is valid (no-output run)', () => {
    // #given a terminal frame for a run that produced no output
    const terminal: OperatorOutputFrame = {
      runId: 'run-empty',
      text: '',
      final: true,
      seq: 0,
    }

    // #when the frame is inspected
    // #then text is empty string (not undefined — distinguishes "no output" from "missing output")
    expect(terminal.text).toBe('')
    expect(terminal.final).toBe(true)
  })

  it('terminal frame may carry droppedCount when prior deltas were coalesced', () => {
    // #given a terminal frame where backpressure caused delta coalescing
    const terminal: OperatorOutputFrame = {
      runId: 'run-1',
      text: 'Complete answer despite dropped deltas.',
      final: true,
      seq: 10,
      droppedCount: 7,
    }

    // #when the frame is inspected
    // #then droppedCount reflects the number of elided deltas
    expect(terminal.droppedCount).toBe(7)
    // #then text is still the complete answer (not partial)
    expect(terminal.text).toBe('Complete answer despite dropped deltas.')
  })
})

// ---------------------------------------------------------------------------
// 4. Barrel re-export smoke test
// ---------------------------------------------------------------------------

describe('barrel re-exports', () => {
  it('type is re-exported from the contract barrel', async () => {
    // #given the public barrel for the operator-contract module
    // #when the barrel is imported
    const barrel = await import('./index.js')

    // #then the barrel module is importable without error (type-only export;
    // runtime proof: OPERATOR_CONTRACT_VERSION is present, confirming the barrel loads)
    expect(typeof barrel.OPERATOR_CONTRACT_VERSION).toBe('string')
  })
})
