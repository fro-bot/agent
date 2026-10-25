import type {Logger} from '../shared/logger.js'
import type {SessionClient} from './backend.js'
import {describe, expect, it, vi} from 'vitest'
import {reassertSessionTitle} from './title-reassert.js'

function createLogger(): Logger {
  return {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}
}

function createClient(update: () => Promise<unknown>): SessionClient {
  return {session: {update: vi.fn(update)}} as unknown as SessionClient
}

describe('reassertSessionTitle', () => {
  it('does nothing without a title', async () => {
    const logger = createLogger()
    const client = createClient(async () => ({data: {}, error: undefined}))

    await reassertSessionTitle(client, 'ses_1', undefined, logger)

    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('logs the message of a JSON error envelope, not [object Object]', async () => {
    // #given the SDK client's error for a JSON HTTP error body is a plain object
    const logger = createLogger()
    const client = createClient(async () => ({
      data: undefined,
      error: {name: 'NotFoundError', data: {message: 'Session not found: ses_1'}},
    }))

    // #when
    await reassertSessionTitle(client, 'ses_1', 'My title', logger)

    // #then
    expect(logger.warning).toHaveBeenCalledWith('Best-effort session title re-assertion failed', {
      sessionId: 'ses_1',
      sessionTitle: 'My title',
      error: 'Session not found: ses_1',
    })
  })

  it('logs a thrown error message', async () => {
    const logger = createLogger()
    const client = createClient(async () => {
      throw new Error('connection refused')
    })

    await reassertSessionTitle(client, 'ses_1', 'My title', logger)

    expect(logger.warning).toHaveBeenCalledWith('Best-effort session title re-assertion failed', {
      sessionId: 'ses_1',
      sessionTitle: 'My title',
      error: 'connection refused',
    })
  })
})
