import type {V2ErrorInfo} from '@fro-bot/runtime'

import {describe, expect, it} from 'vitest'

import {failureFromV2Error} from './provider-failure-v2.js'

function error(overrides: Partial<V2ErrorInfo> & {readonly type: string}): V2ErrorInfo {
  return {message: 'something went wrong', status: null, retryAfterMs: null, ...overrides}
}

describe('failureFromV2Error', () => {
  it.each(['bad key', 'The provider rejected the credentials', '', 'ProviderAuthError', '401 Unauthorized'])(
    'labels a provider.auth failure as an auth failure whatever the message says: %j',
    message => {
      // #given — the V2 discriminant is the structured evidence; the message is provider-controlled text
      const failure = failureFromV2Error(error({type: 'provider.auth', message}))

      // #then
      expect(failure).toEqual({reason: 'provider auth unavailable', errorName: 'unknown'})
    },
  )

  it('keeps labelling quota and unclassified failures by the shared classifier', () => {
    // #given / #then
    expect(failureFromV2Error(error({type: 'provider.unknown', message: 'x', status: 402})).reason).toBe(
      'provider quota exceeded',
    )
    expect(failureFromV2Error(error({type: 'provider.unknown', message: 'weird'})).reason).toBe('session error')
  })

  it('never returns the upstream type or message', () => {
    // #given
    const failure = failureFromV2Error(error({type: 'provider.auth', message: 'sk-secret-123'}))

    // #then
    expect(JSON.stringify(failure)).not.toContain('sk-secret')
    expect(JSON.stringify(failure)).not.toContain('provider.auth')
  })
})
