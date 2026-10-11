import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {buildInvocationIdentity, getInvocationIdentity} from './invocation-identity.js'

describe('buildInvocationIdentity', () => {
  it('returns the job id for a plain (non-matrix) job', () => {
    // #given a job with no matrix
    // #when
    const identity = buildInvocationIdentity({job: 'fro-bot-observe', matrixContext: undefined})

    // #then
    expect(identity).toBe('fro-bot-observe')
  })

  it('returns null outside a runner (no GITHUB_JOB)', () => {
    // #given no job
    // #when / #then
    expect(buildInvocationIdentity({job: undefined, matrixContext: undefined})).toBeNull()
    expect(buildInvocationIdentity({job: '   ', matrixContext: '{"os":"linux"}'})).toBeNull()
  })

  it.each(['', '   ', 'null', '{}', ' null \n'])('treats a no-matrix toJSON(matrix) value %j as no matrix leg', raw => {
    // #given the values toJSON(matrix) / an unset input can produce for a job without a matrix
    // #when
    const identity = buildInvocationIdentity({job: 'build', matrixContext: raw})

    // #then no matrix hash is appended
    expect(identity).toBe('build')
  })

  it('appends a short stable hash for a matrix leg and distinguishes legs', () => {
    // #given two legs of one matrix job
    const linux = buildInvocationIdentity({job: 'build', matrixContext: '{"os":"ubuntu-latest","node":"22"}'})
    const mac = buildInvocationIdentity({job: 'build', matrixContext: '{"os":"macos-latest","node":"22"}'})

    // #then each is `job-m<8 hex>` and they differ
    expect(linux).toMatch(/^build-m[0-9a-f]{8}$/)
    expect(mac).toMatch(/^build-m[0-9a-f]{8}$/)
    expect(linux).not.toBe(mac)
  })

  it('hashes the same leg identically regardless of key order or whitespace (stable across re-runs)', () => {
    // #given the same matrix leg serialized with different key order / pretty-printing
    const compact = buildInvocationIdentity({job: 'build', matrixContext: '{"os":"linux","node":"22"}'})
    const pretty = buildInvocationIdentity({job: 'build', matrixContext: '{\n  "node": "22",\n  "os": "linux"\n}'})

    // #then identical
    expect(pretty).toBe(compact)
  })

  it('hashes a non-JSON matrix-context string as-is', () => {
    // #given an operator-supplied non-JSON value
    const identity = buildInvocationIdentity({job: 'build', matrixContext: 'leg-7'})

    // #then still a stable matrix suffix
    expect(identity).toMatch(/^build-m[0-9a-f]{8}$/)
    expect(identity).toBe(buildInvocationIdentity({job: 'build', matrixContext: 'leg-7'}))
  })

  it('sanitizes characters that are invalid in cache keys and artifact names', () => {
    // #given a job id containing characters outside the safe set
    const identity = buildInvocationIdentity({job: 'a,b/c:d e', matrixContext: undefined})

    // #then they are replaced
    expect(identity).toBe('a-b-c-d-e')
  })
})

describe('getInvocationIdentity', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {...originalEnv}
    delete process.env.GITHUB_JOB
    delete process.env['INPUT_MATRIX-CONTEXT']
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('reads GITHUB_JOB and the matrix-context action input from the environment', () => {
    // #given a runner environment for a matrix leg
    process.env.GITHUB_JOB = 'fro-bot-observe'
    process.env['INPUT_MATRIX-CONTEXT'] = '{"os":"linux"}'

    // #when / #then
    expect(getInvocationIdentity()).toMatch(/^fro-bot-observe-m[0-9a-f]{8}$/)
  })

  it('returns just the job id when the matrix-context input is unset', () => {
    // #given
    process.env.GITHUB_JOB = 'fro-bot-observe'

    // #when / #then
    expect(getInvocationIdentity()).toBe('fro-bot-observe')
  })

  it('returns null when GITHUB_JOB is unset', () => {
    // #given no runner env
    // #when / #then
    expect(getInvocationIdentity()).toBeNull()
  })
})
