import {describe, expect, it, vi} from 'vitest'

import {createPluginSessionClient, isSessionNotFound} from './session-client.js'

// Failure shapes captured from a real v2.2.0 server through `ctx.session.get`.
const notFound = Object.assign(new Error('placeholder'), {
  message: '',
  _tag: 'Session.NotFoundError',
  sessionID: 'ses_gone',
})
const schemaError = Object.assign(new Error('Expected a string starting with "ses"'), {_tag: 'SchemaError'})

function fakeSession() {
  return {
    list: vi.fn(async (_query: unknown) => ({data: [], cursor: {}})),
    get: vi.fn(async (_input: {readonly sessionID: string}): Promise<unknown> => ({id: 'ses_1'})),
    context: vi.fn(async (_input: {readonly sessionID: string}): Promise<unknown> => []),
  }
}

describe('isSessionNotFound', () => {
  it('recognises the V2 not-found tag and nothing else', () => {
    // #given / #when / #then
    expect(isSessionNotFound(notFound)).toBe(true)
    expect(isSessionNotFound(schemaError)).toBe(false)
    expect(isSessionNotFound(new Error('Session.NotFoundError'))).toBe(false)
    expect(isSessionNotFound(null)).toBe(false)
    expect(isSessionNotFound('Session.NotFoundError')).toBe(false)
  })
})

describe('createPluginSessionClient', () => {
  it('passes the list query through and returns the raw page', async () => {
    // #given
    const session = fakeSession()
    const client = createPluginSessionClient(session)

    // #when
    const page = await client.list({directory: '/work/repo', limit: 5, parentID: null})

    // #then
    expect(session.list).toHaveBeenCalledWith({directory: '/work/repo', limit: 5, parentID: null})
    expect(page).toEqual({data: [], cursor: {}})
  })

  it('reads a session through session.get', async () => {
    // #given
    const session = fakeSession()
    const client = createPluginSessionClient(session)

    // #when
    const payload = await client.get('ses_1')

    // #then
    expect(session.get).toHaveBeenCalledWith({sessionID: 'ses_1'})
    expect(payload).toEqual({id: 'ses_1'})
  })

  it('maps a not-found failure to null', async () => {
    // #given
    const session = fakeSession()
    session.get.mockRejectedValue(notFound)
    const client = createPluginSessionClient(session)

    // #when / #then
    expect(await client.get('ses_gone')).toBeNull()
  })

  it('maps an id that cannot be a session id to null without calling the server', async () => {
    // #given the schema would reject it as a SchemaError, which is not an outage
    const session = fakeSession()
    const client = createPluginSessionClient(session)

    // #when
    const payload = await client.get('definitely-not-a-session')

    // #then
    expect(payload).toBeNull()
    expect(session.get).not.toHaveBeenCalled()
  })

  it('rethrows any other failure so it is reported as unavailable, not as not found', async () => {
    // #given
    const session = fakeSession()
    session.get.mockRejectedValue(new Error('db locked'))
    const client = createPluginSessionClient(session)

    // #when / #then
    await expect(client.get('ses_1')).rejects.toThrow('db locked')
  })

  it('reads messages through session.context', async () => {
    // #given
    const session = fakeSession()
    session.context.mockResolvedValue([{id: 'msg_1'}])
    const client = createPluginSessionClient(session)

    // #when
    const payload = await client.messages('ses_1')

    // #then
    expect(session.context).toHaveBeenCalledWith({sessionID: 'ses_1'})
    expect(payload).toEqual([{id: 'msg_1'}])
  })
})
