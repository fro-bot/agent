import type {LogicalSessionKey} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createSessionReaderV2, prepareSessionContextV2, resolveSessionForLogicalKeyV2} from './session-v2.js'

const KEY: LogicalSessionKey = {key: 'issue-42', entityType: 'issue', entityId: '42'}
const WORKSPACE = '/workspace/repo'

function session(id: string, title: string, updated: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    projectID: 'prj_1',
    title,
    time: {created: 1, updated},
    location: {directory: WORKSPACE},
    ...extra,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** A fake server: answers the list, get and context routes from the given tables. */
function fakeRoutes(options: {
  readonly sessions: readonly unknown[]
  readonly messages?: Readonly<Record<string, unknown>>
  readonly listStatus?: number
}) {
  const calls: string[] = []
  const fetchRoute = vi.fn(async (path: string) => {
    calls.push(path)
    if (path.startsWith('/api/session?')) {
      if (options.listStatus !== undefined) return json(options.listStatus, {})
      return json(200, {data: options.sessions, cursor: {}})
    }
    const context = /^\/api\/session\/([^/]+)\/context$/.exec(path)
    if (context !== null) return json(200, {data: options.messages?.[context[1] as string] ?? []})
    const one = /^\/api\/session\/([^/]+)$/.exec(path)
    if (one !== null) {
      const found = (options.sessions as readonly {id: string}[]).find(item => item.id === one[1])
      return found === undefined ? json(404, {}) : json(200, {data: found})
    }
    return json(404, {})
  })
  return {fetchRoute, calls}
}

describe('createSessionReaderV2', () => {
  it('lists with the V2 filter query: exact directory, root sessions, unarchived, newest first', async () => {
    // #given
    const {fetchRoute, calls} = fakeRoutes({sessions: []})
    const reader = createSessionReaderV2(fetchRoute)

    // #when
    await reader.list({directory: WORKSPACE, limit: 100, order: 'desc', parentID: null, archived: false})

    // #then
    const url = new URL(calls[0] as string, 'http://x')
    expect(url.pathname).toBe('/api/session')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      directory: WORKSPACE,
      limit: '100',
      order: 'desc',
      parentID: 'null',
      archived: 'false',
    })
  })

  it('reads a missing session as null and any other failure as an error, so an outage is not "no session"', async () => {
    // #given
    const reader = createSessionReaderV2(
      vi.fn(async (path: string) => (path.endsWith('ses_gone') ? json(404, {}) : json(503, {}))),
    )

    // #when / #then
    expect(await reader.get('ses_gone')).toBeNull()
    await expect(reader.get('ses_other')).rejects.toThrow('http 503')
  })

  it('encodes the session id into the path', async () => {
    // #given
    const fetchRoute = vi.fn(async () => json(200, {data: []}))

    // #when
    await createSessionReaderV2(fetchRoute).messages('ses/odd id')

    // #then
    expect(fetchRoute).toHaveBeenCalledWith('/api/session/ses%2Fodd%20id/context', expect.anything())
  })
})

describe('resolveSessionForLogicalKeyV2', () => {
  it('continues the newest unarchived root session titled for the logical key', async () => {
    // #given
    const title = `fro-bot: ${KEY.key}`
    const {fetchRoute} = fakeRoutes({
      sessions: [
        session('ses_old', title, 10),
        session('ses_new', title, 30),
        session('ses_other', 'fro-bot: issue-7', 40),
        session('ses_child', title, 50, {parentID: 'ses_new'}),
      ],
    })

    // #when
    const resolution = await resolveSessionForLogicalKeyV2(
      createSessionReaderV2(fetchRoute),
      WORKSPACE,
      KEY,
      createMockLogger(),
    )

    // #then
    expect(resolution).toEqual({status: 'found', sessionId: 'ses_new'})
  })

  it('reports not-found when no title matches', async () => {
    // #given
    const {fetchRoute} = fakeRoutes({sessions: [session('ses_a', 'something else', 1)]})

    // #when / #then
    expect(
      await resolveSessionForLogicalKeyV2(createSessionReaderV2(fetchRoute), WORKSPACE, KEY, createMockLogger()),
    ).toEqual({status: 'not-found'})
  })

  it('reports an error, never not-found, when the listing fails', async () => {
    // #given
    const {fetchRoute} = fakeRoutes({sessions: [], listStatus: 500})

    // #when
    const resolution = await resolveSessionForLogicalKeyV2(
      createSessionReaderV2(fetchRoute),
      WORKSPACE,
      KEY,
      createMockLogger(),
    )

    // #then
    expect(resolution.status).toBe('error')
  })
})

describe('prepareSessionContextV2', () => {
  it('summarizes recent sessions with their message counts and agents, and finds prior work by content', async () => {
    // #given one session with a user message and an assistant message that mentions the query
    const messages = {
      ses_a: [
        {id: 'msg_1', type: 'user', time: {created: 1}, text: 'please fix flaky cache'},
        {
          id: 'msg_2',
          type: 'assistant',
          agent: 'build',
          time: {created: 2},
          content: [{type: 'text', text: 'fixed flaky cache'}],
        },
      ],
    }
    const {fetchRoute} = fakeRoutes({sessions: [session('ses_a', 'fro-bot: issue-42', 5)], messages})

    // #when
    const context = await prepareSessionContextV2({
      reader: createSessionReaderV2(fetchRoute),
      workspacePath: WORKSPACE,
      searchQuery: 'flaky',
      logger: createMockLogger(),
    })

    // #then the recent-session summary carries the V2 id and title the prompt table prints
    expect(context.recentSessions).toHaveLength(1)
    expect(context.recentSessions[0]).toMatchObject({id: 'ses_a', title: 'fro-bot: issue-42', directory: WORKSPACE})
    expect(context.recentSessions[0]?.isChild).toBe(false)
  })

  it('fails soft to empty context, with a warning, when the listing fails', async () => {
    // #given
    const logger = createMockLogger()
    const {fetchRoute} = fakeRoutes({sessions: [], listStatus: 500})

    // #when
    const context = await prepareSessionContextV2({
      reader: createSessionReaderV2(fetchRoute),
      workspacePath: WORKSPACE,
      searchQuery: 'x',
      logger,
    })

    // #then
    expect(context).toEqual({recentSessions: [], priorWorkContext: []})
    expect(logger.warning).toHaveBeenCalled()
  })
})
