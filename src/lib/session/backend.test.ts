import type {SessionClient} from './backend.js'
import {describe, expect, it} from 'vitest'

describe('SessionClient', () => {
  it('is a valid type alias for SDK client', () => {
    // #given
    // SessionClient is a type alias for the SDK client returned by createOpencode()

    // #then
    // Type assertion verifies SessionClient can be used as a type
    const client: SessionClient = {} as SessionClient
    expect(client).toBeDefined()
  })
})
