import {describe, expect, it} from 'vitest'

import {resolveResponseDelivery} from './response-delivery.js'

describe('resolveResponseDelivery', () => {
  it.each(['pull_request', 'issue_comment', 'issues'] as const)(
    'delivers via file-convention and withholds the credential for %s with responseMode github',
    eventName => {
      // #given an affected trigger with github response mode
      // #when resolving delivery
      const decision = resolveResponseDelivery(eventName, 'github')

      // #then delivery goes through the file convention and the credential is withheld
      expect(decision).toStrictEqual({delivery: 'file-convention', credential: 'withhold'})
    },
  )

  it.each(['workflow_dispatch', 'schedule'] as const)(
    'delivers via model-gh and provisions the credential for %s with responseMode github',
    eventName => {
      // #given an autonomous trigger with github response mode
      // #when resolving delivery
      const decision = resolveResponseDelivery(eventName, 'github')

      // #then the model calls gh directly and the credential is provisioned
      expect(decision).toStrictEqual({delivery: 'model-gh', credential: 'provision'})
    },
  )

  it.each(['pull_request', 'issue_comment', 'issues'] as const)(
    'withholds the credential for %s even when responseMode is none',
    eventName => {
      // #given an affected trigger with response mode none
      // #when resolving delivery
      const decision = resolveResponseDelivery(eventName, 'none')

      // #then nothing is delivered but the credential stays withheld
      expect(decision).toStrictEqual({delivery: 'none', credential: 'withhold'})
    },
  )

  it('provisions the credential for an autonomous trigger even when responseMode is none', () => {
    // #given an autonomous trigger with response mode none
    // #when resolving delivery
    const decision = resolveResponseDelivery('workflow_dispatch', 'none')

    // #then nothing is delivered but the credential is still provisioned
    expect(decision).toStrictEqual({delivery: 'none', credential: 'provision'})
  })

  it.each([
    'pull_request_review_comment',
    'discussion_comment',
    'discussion',
    'push',
    'merge_group',
    'Schedule',
    'WORKFLOW_DISPATCH',
    '',
  ] as const)(
    'delivers via file-convention and withholds the credential for the non-allowlisted name %j',
    eventName => {
      // #given an event name outside the provisioning allowlist, known or not
      // #when resolving delivery with github response mode
      const decision = resolveResponseDelivery(eventName, 'github')

      // #then delivery goes through the file convention and the credential is withheld
      expect(decision).toStrictEqual({delivery: 'file-convention', credential: 'withhold'})
    },
  )

  it.each(['pull_request_review_comment', 'discussion_comment', 'push', ''] as const)(
    'selects no delivery and still withholds the credential for the non-allowlisted name %j with responseMode none',
    eventName => {
      // #given a non-allowlisted event name with response mode none
      // #when resolving delivery
      const decision = resolveResponseDelivery(eventName, 'none')

      // #then nothing is delivered but the credential stays withheld
      expect(decision).toStrictEqual({delivery: 'none', credential: 'withhold'})
    },
  )
})
