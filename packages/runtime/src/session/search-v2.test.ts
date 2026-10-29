import type {SessionClientV2} from './backend-v2.js'
import type {Logger} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {getSessionInfoV2, listSessionsV2, SEARCH_MAX_SESSIONS, searchSessionsV2} from './search-v2.js'

const logger: Logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn()}

const rawSession = (id: string, created: number, updated: number, extra: Record<string, unknown> = {}) => ({
  id,
  projectID: 'proj',
  time: {created, updated, ...(extra.archived == null ? {} : {archived: extra.archived})},
  title: `title ${id}`,
  location: {directory: '/work/repo'},
  ...(extra.parentID == null ? {} : {parentID: extra.parentID}),
})

const userMessage = (id: string, text: string, created = 1) => ({id, time: {created}, type: 'user', text})
const assistantMessage = (id: string, text: string, created = 2, agent = 'build') => ({
  id,
  time: {created},
  type: 'assistant',
  agent,
  content: [{type: 'text', text}],
})

interface Store {
  readonly sessions: readonly ReturnType<typeof rawSession>[]
  readonly messages: Readonly<Record<string, readonly unknown[]>>
}

function clientFor(store: Store): SessionClientV2 {
  return {
    list: vi.fn(async () => ({data: store.sessions})),
    get: vi.fn(async (id: string) => store.sessions.find(s => s.id === id) ?? null),
    messages: vi.fn(async (id: string) => store.messages[id] ?? []),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listSessionsV2', () => {
  const store: Store = {
    sessions: [
      rawSession('ses_old', Date.UTC(2026, 0, 1), 100),
      rawSession('ses_new', Date.UTC(2026, 5, 1), 300),
      rawSession('ses_mid', Date.UTC(2026, 2, 1), 200),
      rawSession('ses_child', Date.UTC(2026, 5, 2), 400, {parentID: 'ses_new'}),
      rawSession('ses_archived', Date.UTC(2026, 5, 3), 500, {archived: 999}),
    ],
    messages: {},
  }

  it('returns root, unarchived sessions most recently updated first', async () => {
    // #given a store with a child and an archived session
    // #when
    const result = await listSessionsV2(clientFor(store), '/work/repo', {}, logger)

    // #then the child and the archived session are excluded even though the server returned them
    expect(result.success && result.data.map(s => s.id)).toEqual(['ses_new', 'ses_mid', 'ses_old'])
  })

  it('applies limit after sorting', async () => {
    // #given
    // #when
    const result = await listSessionsV2(clientFor(store), '/work/repo', {limit: 2}, logger)

    // #then
    expect(result.success && result.data.map(s => s.id)).toEqual(['ses_new', 'ses_mid'])
  })

  it('filters on creation date, with both bounds inclusive', async () => {
    // #given a window covering only March
    const fromDate = new Date(Date.UTC(2026, 2, 1))
    const toDate = new Date(Date.UTC(2026, 2, 1))

    // #when
    const result = await listSessionsV2(clientFor(store), '/work/repo', {fromDate, toDate}, logger)

    // #then
    expect(result.success && result.data.map(s => s.id)).toEqual(['ses_mid'])
  })

  it('propagates a listing failure as an error result', async () => {
    // #given
    const client: SessionClientV2 = {
      ...clientFor(store),
      list: vi.fn(async () => {
        throw new Error('offline')
      }),
    }

    // #when
    const result = await listSessionsV2(client, '/work/repo', {}, logger)

    // #then
    expect(result.success).toBe(false)
  })
})

describe('searchSessionsV2', () => {
  const store: Store = {
    sessions: [rawSession('ses_a', 1, 300), rawSession('ses_b', 1, 200), rawSession('ses_c', 1, 100)],
    messages: {
      ses_a: [
        userMessage('msg_a1', 'please fix the Flaky cache test'),
        assistantMessage('msg_a2', 'looking at the cache now'),
      ],
      ses_b: [assistantMessage('msg_b1', 'unrelated work'), userMessage('msg_b2', 'cache invalidation question')],
      ses_c: [userMessage('msg_c1', 'nothing relevant here')],
    },
  }

  it('finds matches case-insensitively by default, with a context excerpt, role and agent', async () => {
    // #given
    // #when
    const result = await searchSessionsV2('FLAKY', clientFor(store), '/work/repo', {}, logger)

    // #then
    expect(result.success && result.data).toEqual([
      {
        sessionId: 'ses_a',
        matches: [
          {
            messageId: 'msg_a1',
            partId: 'msg_a1:0',
            excerpt: '...please fix the Flaky cache test...',
            role: 'user',
          },
        ],
      },
    ])
  })

  it('respects caseSensitive', async () => {
    // #given
    const client = clientFor(store)

    // #when
    const lower = await searchSessionsV2('flaky', client, '/work/repo', {caseSensitive: true}, logger)
    const exact = await searchSessionsV2('Flaky', client, '/work/repo', {caseSensitive: true}, logger)

    // #then
    expect(lower.success && lower.data).toEqual([])
    expect(exact.success && exact.data).toHaveLength(1)
  })

  it('trims the excerpt to 50 characters of context either side', async () => {
    // #given a long message with the needle in the middle
    const long = `${'a'.repeat(80)}NEEDLE${'b'.repeat(80)}`
    const client = clientFor({sessions: [rawSession('ses_a', 1, 1)], messages: {ses_a: [userMessage('msg_1', long)]}})

    // #when
    const result = await searchSessionsV2('needle', client, '/work/repo', {}, logger)

    // #then
    const excerpt = result.success ? result.data[0]?.matches[0]?.excerpt : undefined
    expect(excerpt).toBe(`...${'a'.repeat(50)}NEEDLE${'b'.repeat(50)}...`)
  })

  it('stops at the match limit across sessions', async () => {
    // #given two sessions that each match
    // #when
    const result = await searchSessionsV2('cache', clientFor(store), '/work/repo', {limit: 2}, logger)

    // #then ses_a has two matches, which spends the limit before ses_b is read
    expect(result.success && result.data.map(r => r.sessionId)).toEqual(['ses_a'])
    expect(result.success && result.data[0]?.matches).toHaveLength(2)
  })

  it('cuts a session to the matches the limit still allows', async () => {
    // #given ses_a holds two matches but only one is allowed
    // #when
    const result = await searchSessionsV2('cache', clientFor(store), '/work/repo', {limit: 1}, logger)

    // #then the single allowed match comes from the newest session with matches, not a whole session's worth
    expect(result.success && result.data).toHaveLength(1)
    expect(result.success && result.data[0]?.matches).toHaveLength(1)
  })

  it('scopes to one session and honours excludeSessionIds', async () => {
    // #given
    const client = clientFor(store)

    // #when
    const scoped = await searchSessionsV2('cache', client, '/work/repo', {sessionId: 'ses_b'}, logger)
    const excluded = await searchSessionsV2('cache', client, '/work/repo', {excludeSessionIds: ['ses_a']}, logger)
    const scopedAndExcluded = await searchSessionsV2(
      'cache',
      client,
      '/work/repo',
      {sessionId: 'ses_a', excludeSessionIds: ['ses_a']},
      logger,
    )

    // #then
    expect(scoped.success && scoped.data.map(r => r.sessionId)).toEqual(['ses_b'])
    expect(excluded.success && excluded.data.map(r => r.sessionId)).toEqual(['ses_b'])
    expect(scopedAndExcluded.success && scopedAndExcluded.data).toEqual([])
  })

  it('skips a session whose messages cannot be read and still searches the rest', async () => {
    // #given the newest session fails to read
    const client: SessionClientV2 = {
      ...clientFor(store),
      messages: vi.fn(async (id: string) => {
        if (id === 'ses_a') throw new Error('corrupt session')
        return store.messages[id] ?? []
      }),
    }

    // #when
    const result = await searchSessionsV2('cache', client, '/work/repo', {}, logger)

    // #then
    expect(result.success && result.data.map(r => r.sessionId)).toEqual(['ses_b'])
    expect(logger.warning).toHaveBeenCalled()
  })

  it('fails instead of reporting no matches when listing succeeds but every session read fails', async () => {
    // #given three listed sessions and a store whose message reads all fail
    const client: SessionClientV2 = {
      ...clientFor(store),
      messages: vi.fn(async () => {
        throw new Error('store offline')
      }),
    }

    // #when
    const result = await searchSessionsV2('cache', client, '/work/repo', {}, logger)

    // #then the search says it could not read, rather than "no matches"
    expect(result.success).toBe(false)
    expect(!result.success && result.error.message).toBe('could not read any of 3 sessions: store offline')
  })

  it('returns an empty result when every session reads fine but none match', async () => {
    // #given
    // #when
    const result = await searchSessionsV2('zzz-no-such-text', clientFor(store), '/work/repo', {}, logger)

    // #then
    expect(result.success && result.data).toEqual([])
  })

  it('returns an empty result when there are no sessions to read', async () => {
    // #given nothing is attempted, so nothing can fail
    // #when
    const result = await searchSessionsV2('cache', clientFor({sessions: [], messages: {}}), '/work/repo', {}, logger)

    // #then
    expect(result.success && result.data).toEqual([])
  })

  it('fails when a single-session scope cannot be read', async () => {
    // #given
    const client: SessionClientV2 = {
      ...clientFor(store),
      messages: vi.fn(async () => {
        throw new Error('corrupt session')
      }),
    }

    // #when
    const result = await searchSessionsV2('cache', client, '/work/repo', {sessionId: 'ses_a'}, logger)

    // #then
    expect(result.success).toBe(false)
  })

  it('reads at most SEARCH_MAX_SESSIONS sessions', async () => {
    // #given more sessions than the bound, none matching
    const sessions = Array.from({length: SEARCH_MAX_SESSIONS + 25}, (_, i) => rawSession(`ses_${i}`, 1, 1000 - i))
    const client = clientFor({sessions, messages: {}})

    // #when
    await searchSessionsV2('anything', client, '/work/repo', {}, logger)

    // #then
    expect(client.messages).toHaveBeenCalledTimes(SEARCH_MAX_SESSIONS)
  })
})

describe('getSessionInfoV2', () => {
  const store: Store = {
    sessions: [rawSession('ses_a', 1, 2)],
    messages: {
      ses_a: [
        userMessage('msg_1', 'hi'),
        {
          ...assistantMessage('msg_2', 'done', 3, 'build'),
          content: [
            {
              type: 'tool',
              id: 'c',
              name: 'todowrite',
              state: {
                status: 'completed',
                input: {
                  todos: [
                    {content: 'a', status: 'completed'},
                    {content: 'b', status: 'pending'},
                  ],
                },
                content: [{type: 'text', text: 'ok'}],
              },
            },
          ],
        },
        assistantMessage('msg_3', 'explore', 4, 'explore'),
      ],
    },
  }

  it('summarises counts, agents and todos', async () => {
    // #given
    // #when
    const result = await getSessionInfoV2(clientFor(store), 'ses_a', logger)

    // #then
    expect(result.success && result.data).toMatchObject({
      session: {id: 'ses_a'},
      messageCount: 3,
      agents: ['build', 'explore'],
      hasTodos: true,
      todoCount: 2,
      completedTodos: 1,
    })
  })

  it('returns ok(null) for a missing session', async () => {
    // #given
    // #when
    const result = await getSessionInfoV2(clientFor(store), 'ses_nope', logger)

    // #then
    expect(result.success && result.data).toBeNull()
  })

  it('returns an error result when messages cannot be read', async () => {
    // #given
    const client: SessionClientV2 = {
      ...clientFor(store),
      messages: vi.fn(async () => {
        throw new Error('boom')
      }),
    }

    // #when
    const result = await getSessionInfoV2(client, 'ses_a', logger)

    // #then
    expect(result.success).toBe(false)
  })
})
