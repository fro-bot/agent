import type {WebOperatorActor} from '../approvals/registry.js'
import type {WebOperatorIdentity} from '../execute/launch-types.js'
import type {OperatorIdentity} from './identity.js'

import {describe, expectTypeOf, it} from 'vitest'

describe('OperatorIdentity', () => {
  // #given a concrete web-operator value built against the canonical OperatorIdentity shape
  const webOperator: OperatorIdentity = {
    kind: 'web-operator',
    githubUserId: 42,
    login: 'octocat',
    sessionCorrelationId: 'sess-abc',
  }

  it('is structurally assignable to WebOperatorActor', () => {
    // #when assigned to WebOperatorActor (the approvals alias)
    // #then TypeScript accepts the assignment without error
    expectTypeOf(webOperator).toMatchTypeOf<WebOperatorActor>()
  })

  it('is structurally assignable to WebOperatorIdentity', () => {
    // #when assigned to WebOperatorIdentity (the launch-types alias)
    // #then TypeScript accepts the assignment without error
    expectTypeOf(webOperator).toMatchTypeOf<WebOperatorIdentity>()
  })

  it('webOperatorActor is assignable to OperatorIdentity (bidirectional equivalence)', () => {
    // #given a value typed as WebOperatorActor
    const actor: WebOperatorActor = webOperator
    // #when checked against OperatorIdentity
    // #then the types are structurally equivalent
    expectTypeOf(actor).toMatchTypeOf<OperatorIdentity>()
  })

  it('webOperatorIdentity is assignable to OperatorIdentity (bidirectional equivalence)', () => {
    // #given a value typed as WebOperatorIdentity
    const identity: WebOperatorIdentity = webOperator
    // #when checked against OperatorIdentity
    // #then the types are structurally equivalent
    expectTypeOf(identity).toMatchTypeOf<OperatorIdentity>()
  })

  it('discriminant kind narrows correctly', () => {
    // #given a union that includes OperatorIdentity alongside a distinct variant
    interface OtherVariant {
      readonly kind: 'discord-user'
      readonly userId: string
    }
    type IdentityUnion = OperatorIdentity | OtherVariant

    const value: IdentityUnion = webOperator

    if (value.kind === 'web-operator') {
      // #when narrowed by the discriminant
      // #then all OperatorIdentity fields are accessible
      expectTypeOf(value).toMatchTypeOf<OperatorIdentity>()
      expectTypeOf(value.githubUserId).toBeNumber()
      expectTypeOf(value.login).toBeString()
      expectTypeOf(value.sessionCorrelationId).toBeString()
    }
  })

  it('kind literal is exactly web-operator', () => {
    // #given the canonical identity
    // #when the kind field is inspected
    // #then it is the exact literal type 'web-operator'
    expectTypeOf(webOperator.kind).toEqualTypeOf<'web-operator'>()
  })
})
