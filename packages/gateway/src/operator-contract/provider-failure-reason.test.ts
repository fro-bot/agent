import type {ProviderFailureReason} from '../execute/provider-failure.js'
import type {OperatorProviderFailureReason} from './provider-failure-reason.js'

import {describe, expect, it} from 'vitest'
import {OPERATOR_LAUNCH_PROMPT_MAX_LENGTH, OPERATOR_LAUNCH_PROMPT_TOO_LONG} from './launch-prompt.js'
import {
  OPERATOR_PROVIDER_FAILURE_REASONS,
  parseOperatorProviderFailureReason,
  PROVIDER_FAILURE_REASON_TO_OPERATOR,
  toOperatorProviderFailureReason,
} from './provider-failure-reason.js'

const INTERNAL_TO_WIRE = [
  ['provider auth unavailable', 'provider-auth-unavailable'],
  ['model not available', 'model-not-available'],
  ['provider quota exceeded', 'provider-quota-exceeded'],
  ['model provider rejected the request', 'provider-rejected-request'],
  ['session error', 'unclassified'],
] as const satisfies readonly (readonly [ProviderFailureReason, OperatorProviderFailureReason])[]

describe('toOperatorProviderFailureReason — internal → wire mapping', () => {
  it.each(INTERNAL_TO_WIRE)("maps internal '%s' → wire '%s'", (internal, wire) => {
    // #given an internal ProviderFailureReason
    // #when mapped to the wire enum
    const result = toOperatorProviderFailureReason(internal)

    // #then it resolves to the kebab-case wire value
    expect(result).toBe(wire)
  })

  it('covers every internal reason exactly once (no entry is missing from the table under test)', () => {
    // #given the production mapping table
    // #when its keys are compared with the cases above
    // #then they are the same set — a new internal reason forces this case list to grow
    expect(Object.keys(PROVIDER_FAILURE_REASON_TO_OPERATOR).sort()).toEqual(
      INTERNAL_TO_WIRE.map(([internal]) => internal).sort(),
    )
  })

  it("maps the internal catch-all 'session error' to 'unclassified'", () => {
    // #given the internal catch-all
    // #when mapped
    // #then it is 'unclassified' on the wire
    expect(toOperatorProviderFailureReason('session error')).toBe('unclassified')
  })

  it('every wire value round-trips through the parser', () => {
    // #given each mapped wire value
    for (const [, wire] of INTERNAL_TO_WIRE) {
      // #when parsed
      // #then it is accepted unchanged
      expect(parseOperatorProviderFailureReason(wire)).toBe(wire)
    }
  })
})

describe('parseOperatorProviderFailureReason — closed enum gate', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a boolean', true],
    ['an object', {reason: 'unclassified'}],
    ['an array', ['unclassified']],
    ['an empty string', ''],
    ['different casing', 'Unclassified'],
    ['upper-case', 'PROVIDER-AUTH-UNAVAILABLE'],
    ['padded', ' unclassified '],
    ['the internal spaced spelling', 'provider auth unavailable'],
    ['the internal catch-all spelling', 'session error'],
    ['an unknown string', 'quota-exhausted'],
  ])('drops %s', (_label, value) => {
    // #given a value that is not exactly a wire enum string
    // #when parsed
    const result = parseOperatorProviderFailureReason(value)

    // #then it is dropped with no sentinel
    expect(result).toBeUndefined()
  })

  it.each(['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'])(
    '(security) rejects prototype key %s',
    key => {
      // #given an Object.prototype member name
      // #when parsed
      const result = parseOperatorProviderFailureReason(key)

      // #then it is not mistaken for an enum member
      expect(result).toBeUndefined()
    },
  )
})

describe('launch prompt contract constants', () => {
  it('bounds the prompt at 8,000 UTF-16 code units', () => {
    // #given the exported bound
    // #when read
    // #then it is exactly 8,000 (raise-only; lowering silently drops stored prompts)
    expect(OPERATOR_LAUNCH_PROMPT_MAX_LENGTH).toBe(8000)
  })

  it('counts in UTF-16 code units: 4,001 emoji is 8,002 units and exceeds the bound', () => {
    // #given 4,001 astral-plane characters (2 code units each)
    const prompt = '😀'.repeat(4001)

    // #when measured the way the contract defines the bound
    // #then it is over, although it is only 4,001 code points
    expect(prompt.length).toBe(8002)
    expect(prompt.length > OPERATOR_LAUNCH_PROMPT_MAX_LENGTH).toBe(true)
    expect([...prompt].length).toBe(4001)
  })

  it("exports the typed 'prompt-too-long' rejection reason", () => {
    // #given the exported reason
    // #when read
    // #then it is the wire string
    expect(OPERATOR_LAUNCH_PROMPT_TOO_LONG).toBe('prompt-too-long')
  })
})

describe('barrel re-exports', () => {
  it('exposes the reason parser, mapping, prompt bound and rejection reason from the contract barrel', async () => {
    // #given the public barrel
    const barrel = await import('./index.js')

    // #when / #then the 1.12.0 additions are importable from it
    expect(barrel.parseOperatorProviderFailureReason).toBe(parseOperatorProviderFailureReason)
    expect(barrel.toOperatorProviderFailureReason).toBe(toOperatorProviderFailureReason)
    expect(barrel.PROVIDER_FAILURE_REASON_TO_OPERATOR).toBe(PROVIDER_FAILURE_REASON_TO_OPERATOR)
    expect(barrel.OPERATOR_LAUNCH_PROMPT_MAX_LENGTH).toBe(OPERATOR_LAUNCH_PROMPT_MAX_LENGTH)
    expect(barrel.OPERATOR_LAUNCH_PROMPT_TOO_LONG).toBe(OPERATOR_LAUNCH_PROMPT_TOO_LONG)
  })
})

describe('wire tuple and internal mapping stay in step', () => {
  it('the mapping values equal the wire tuple, compared as sets', () => {
    // #given the single declaration of the wire values and the internal→wire table
    const tuple = new Set<string>(OPERATOR_PROVIDER_FAILURE_REASONS)
    const mapped = new Set<string>(Object.values(PROVIDER_FAILURE_REASON_TO_OPERATOR))

    // #when compared
    // #then every wire value is reachable from an internal reason and no mapping targets an undeclared value
    expect(mapped).toEqual(tuple)
    expect(tuple.size).toBe(5)
  })

  it('the parser accepts exactly the tuple', () => {
    // #given each declared wire value and the internal spellings
    // #when parsed
    // #then wire values pass and nothing else does
    for (const wire of OPERATOR_PROVIDER_FAILURE_REASONS) {
      expect(parseOperatorProviderFailureReason(wire)).toBe(wire)
    }
    for (const internal of Object.keys(PROVIDER_FAILURE_REASON_TO_OPERATOR)) {
      expect(parseOperatorProviderFailureReason(internal)).toBeUndefined()
    }
  })
})
