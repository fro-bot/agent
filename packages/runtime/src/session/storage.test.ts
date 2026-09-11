import type {Project} from '@opencode-ai/sdk'

import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {findProjectByWorkspace, listProjectsViaSDK} from './discovery.js'
import {
  deleteSession,
  findLatestSession,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listSessionsForProject,
} from './storage.js'

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

// `mockLogger` is shared module-wide (not recreated per test), so call history persists across
// tests unless cleared. Reset structurally rather than per-test so this is the default going
// forward, not something every new test author has to remember.
beforeEach(() => {
  vi.clearAllMocks()
})

function createMockSdkClient(options?: {
  sessionListResponse?: {data?: unknown; error?: unknown}
  sessionGetResponse?: {data?: unknown; error?: unknown}
  sessionMessagesResponse?: {data?: unknown; error?: unknown}
  sessionTodosResponse?: {data?: unknown; error?: unknown}
  sessionDeleteResponse?: {data?: unknown; error?: unknown}
  projectListResponse?: {data?: unknown; error?: unknown}
}) {
  return {
    session: {
      list: vi.fn().mockResolvedValue(options?.sessionListResponse ?? {data: []}),
      get: vi.fn().mockResolvedValue(options?.sessionGetResponse ?? {data: null}),
      messages: vi.fn().mockResolvedValue(options?.sessionMessagesResponse ?? {data: []}),
      todos: vi.fn().mockResolvedValue(options?.sessionTodosResponse ?? {data: []}),
      delete: vi.fn().mockResolvedValue(options?.sessionDeleteResponse ?? {data: null}),
    },
    project: {
      list: vi.fn().mockResolvedValue(options?.projectListResponse ?? {data: []}),
    },
  }
}

// A JSON object can shadow constructor with payload-owned text.
const CONSTRUCTOR_SENTINEL = 'private transcript sentinel'
function sentinelPayload(): unknown {
  return JSON.parse(`{"constructor":{"name":"${CONSTRUCTOR_SENTINEL}"}}`)
}

// A JSON object with a non-callable own `toString` makes `String(error)` throw instead of
// coercing (exhausts both ToPrimitive methods without producing a primitive).
function unprintableErrorPayload(): unknown {
  return JSON.parse('{"toString":"x"}')
}

describe('listProjectsViaSDK', () => {
  it('maps project list results using the real v1 SDK `Project` shape (no `path`, no `time.updated`)', async () => {
    // #given: typed as `@opencode-ai/sdk`'s v1 `Project` — the type re-exported from the package
    // root (dist/gen/types.gen.d.ts), which is what backend.ts's `createOpencode` import resolves
    // to. id, worktree, optional vcs, required `time.created` (no `time.updated` — that's only on
    // the separate v2 client's type, which nothing in this runtime path imports). Upstream never
    // sends `path`. Typing the fixtures against the real type means a future SDK shape change
    // fails typecheck here instead of drifting silently.
    const projects: Project[] = [
      {id: 'proj_1', worktree: '/repo', vcs: 'git', time: {created: 1000}},
      {id: 'proj_2', worktree: '/repo-two', time: {created: 3000}},
    ]
    const client = createMockSdkClient({projectListResponse: {data: projects}})

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then: routes to the instance for this workspace, matching listSessionsForProject's pattern
    expect(client.project.list).toHaveBeenCalledWith({query: {directory: '/repo'}})
    expect(result).toEqual([
      {id: 'proj_1', worktree: '/repo'},
      {id: 'proj_2', worktree: '/repo-two'},
    ])
  })

  it('returns empty array when project list fails', async () => {
    // #given
    const client = createMockSdkClient({projectListResponse: {error: 'boom', data: null}})

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK project list failed', expect.any(Object))
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({projectListResponse: {error: unprintableErrorPayload(), data: null}})

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then no throw, fallback message logged
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK project list failed', {error: '[unprintable error]'})
  })

  it('returns empty array and warns when the payload is not an array', async () => {
    // #given: a structurally unexpected but non-error, non-null response — the one early-return
    // shape in this function that previously exited with no logging at all. `data` here is
    // deliberately untyped against `Project[]` (the mock helper's `data?: unknown` already covers
    // that) since this exercises the pre-array-narrowing branch, not a malformed array element.
    const client = createMockSdkClient({projectListResponse: {data: {not: 'an array'}}})

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK project list returned a non-array payload', {
      type: 'object',
    })
  })

  it('does not leak a payload-owned constructor name into the warning', async () => {
    // #given a payload-owned constructor key
    const client = createMockSdkClient({projectListResponse: {data: sentinelPayload()}})

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then intrinsic type only
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK project list returned a non-array payload', {
      type: 'object',
    })
    expect(JSON.stringify(vi.mocked(mockLogger.warning).mock.calls)).not.toContain(CONSTRUCTOR_SENTINEL)
  })

  it('filters malformed project records (missing/non-string id or worktree)', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {
        data: [
          {worktree: '/repo'}, // missing id
          {id: 123, worktree: '/repo'}, // id not a string
        ],
      },
    })

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then
    expect(result).toEqual([])
  })

  it('retains a project regardless of `time` shape — `time` is not read and must not gate inclusion', async () => {
    // #given: these payloads intentionally diverge from the real `Project` type (which requires
    // `time.created`) to prove discovery doesn't gate on `time` at all once `id`/`worktree` are
    // present — not even to distinguish a genuine `0` from a missing value.
    const client = createMockSdkClient({
      projectListResponse: {
        data: [
          {id: 'proj_partial', worktree: '/repo-partial', time: {created: 1000}}, // no `updated`
          {id: 'proj_no_time', worktree: '/repo-no-time'}, // `time` absent entirely
          {id: 'proj_zero', worktree: '/repo-zero', time: {created: 0, updated: 0}}, // zeros, not missing
        ],
      },
    })

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then
    expect(result).toEqual([
      {id: 'proj_partial', worktree: '/repo-partial'},
      {id: 'proj_no_time', worktree: '/repo-no-time'},
      {id: 'proj_zero', worktree: '/repo-zero'},
    ])
  })

  it('retains a project when `vcs` is not a string', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {data: [{id: 'proj_1', worktree: '/repo', vcs: 123}]},
    })

    // #when
    const result = await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then
    expect(result).toEqual([{id: 'proj_1', worktree: '/repo'}])
  })

  it('logs skipped and total counts after mapping', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {
        data: [{id: 'proj_1', worktree: '/repo'}, {worktree: '/missing-id'}],
      },
    })

    // #when
    await listProjectsViaSDK(client as unknown as SessionClient, '/repo', mockLogger)

    // #then
    expect(mockLogger.debug).toHaveBeenCalledWith('Discovered projects via SDK', {
      total: 2,
      skipped: 1,
      retained: 1,
    })
  })
})

describe('findProjectByWorkspace', () => {
  it('returns project matching normalized workspace path', async () => {
    // #given: real SDK shape — worktree is the only location field upstream provides
    const client = createMockSdkClient({
      projectListResponse: {
        data: [{id: 'proj_1', worktree: '/repo', vcs: 'git', time: {created: 1000}} satisfies Project],
      },
    })

    // #when
    const result = await findProjectByWorkspace(client as unknown as SessionClient, '/repo/', mockLogger)

    // #then: passes the raw (unnormalized) workspacePath through to the routing query
    expect(client.project.list).toHaveBeenCalledWith({query: {directory: '/repo/'}})
    expect(result).toEqual({id: 'proj_1', worktree: '/repo'})
  })

  it('returns null when no project matches', async () => {
    // #given
    const client = createMockSdkClient({
      projectListResponse: {data: [{id: 'proj_1', worktree: '/repo', time: {created: 1000}} satisfies Project]},
    })

    // #when
    const result = await findProjectByWorkspace(client as unknown as SessionClient, '/other', mockLogger)

    // #then
    expect(result).toBeNull()
  })
})

describe('listSessionsForProject', () => {
  it('lists sessions via SDK', async () => {
    // #given
    const sdkSession = {
      id: 'ses_sdk',
      version: '1.1.53',
      projectID: 'proj_sdk',
      directory: '/workspace',
      title: 'SDK Session',
      time: {created: 1000, updated: 2000},
    }
    const client = createMockSdkClient({sessionListResponse: {data: [sdkSession]}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then
    expect(client.session.list).toHaveBeenCalledWith({query: {directory: '/workspace'}})
    expect(result).toMatchObject([
      {
        id: 'ses_sdk',
        version: '1.1.53',
        projectID: 'proj_sdk',
        directory: '/workspace',
        title: 'SDK Session',
        time: {created: 1000, updated: 2000},
      },
    ])
  })

  it('returns empty list when SDK session list fails', async () => {
    // #given
    const client = createMockSdkClient({sessionListResponse: {error: 'boom', data: null}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list failed', expect.any(Object))
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({sessionListResponse: {error: unprintableErrorPayload(), data: null}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then no throw, fallback message logged
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list failed', {
      source: 'listSessionsForProject',
      error: '[unprintable error]',
    })
  })

  it('returns empty list and warns when the payload is not an array', async () => {
    // #given: same structurally-unexpected-but-not-an-error shape covered in listProjectsViaSDK
    // above — `data` here is deliberately untyped against the mapper's expected array shape.
    const client = createMockSdkClient({sessionListResponse: {data: {not: 'an array'}}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then: `source` distinguishes this call site from findLatestSession's identical message text
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list returned a non-array payload', {
      source: 'listSessionsForProject',
      type: 'object',
    })
  })

  it('does not leak a payload-owned constructor name into the warning', async () => {
    // #given a payload-owned constructor key
    const client = createMockSdkClient({sessionListResponse: {data: sentinelPayload()}})

    // #when
    const result = await listSessionsForProject(client as unknown as SessionClient, '/workspace', mockLogger)

    // #then intrinsic type only
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list returned a non-array payload', {
      source: 'listSessionsForProject',
      type: 'object',
    })
    expect(JSON.stringify(vi.mocked(mockLogger.warning).mock.calls)).not.toContain(CONSTRUCTOR_SENTINEL)
  })
})

describe('getSession', () => {
  it('gets session via SDK', async () => {
    // #given
    const sdkSession = {
      id: 'ses_sdk',
      version: '1.1.53',
      projectID: 'proj_sdk',
      directory: '/workspace',
      title: 'SDK Session',
      time: {created: 1000, updated: 2000},
    }
    const client = createMockSdkClient({sessionGetResponse: {data: sdkSession}})

    // #when
    const result = await getSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.get).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toMatchObject({
      id: 'ses_sdk',
      version: '1.1.53',
      projectID: 'proj_sdk',
      directory: '/workspace',
      title: 'SDK Session',
      time: {created: 1000, updated: 2000},
    })
  })

  it('returns null when SDK session get fails', async () => {
    // #given
    const client = createMockSdkClient({sessionGetResponse: {error: 'boom', data: null}})

    // #when
    const result = await getSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session get failed', expect.any(Object))
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({sessionGetResponse: {error: unprintableErrorPayload(), data: null}})

    // #when
    const result = await getSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then no throw, fallback message logged
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session get failed', {error: '[unprintable error]'})
  })
})

describe('getSessionMessages', () => {
  it('returns sorted messages via SDK', async () => {
    // #given
    const sdkMessages = [
      {
        id: 'msg_1',
        sessionId: 'ses_sdk',
        role: 'assistant',
        time: {created: 2000},
        parentId: 'msg_0',
        modelId: 'model',
        providerId: 'provider',
        mode: 'chat',
        agent: 'Sisyphus',
        path: {cwd: '/workspace', root: '/workspace'},
        cost: 0,
        tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
      },
      {
        id: 'msg_2',
        sessionId: 'ses_sdk',
        role: 'user',
        time: {created: 1000},
        agent: 'User',
        model: {providerID: 'provider', modelID: 'model'},
      },
    ]
    const client = createMockSdkClient({sessionMessagesResponse: {data: sdkMessages}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.messages).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toHaveLength(2)
    expect(result[0]?.id).toBe('msg_2')
    expect(result[1]?.id).toBe('msg_1')
  })

  it('returns empty messages when SDK messages fail', async () => {
    // #given
    const client = createMockSdkClient({sessionMessagesResponse: {error: 'boom', data: null}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages failed', expect.any(Object))
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({sessionMessagesResponse: {error: unprintableErrorPayload(), data: null}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then no throw, fallback message logged
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages failed', {error: '[unprintable error]'})
  })

  it('returns empty array and warns when the payload is not an array', async () => {
    // #given: a structurally unexpected but non-error, non-null response — mapSdkMessages
    // unconditionally maps its input, so a non-array payload previously reached it and threw.
    const client = createMockSdkClient({sessionMessagesResponse: {data: {not: 'an array'}}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages returned a non-array payload', {
      type: 'object',
    })
  })

  it('does NOT warn when messages are genuinely empty', async () => {
    // #given
    const client = createMockSdkClient({sessionMessagesResponse: {data: []}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then: an empty result is normal operation — it must not start emitting warnings
    expect(result).toEqual([])
    expect(mockLogger.warning).not.toHaveBeenCalled()
  })

  it('returns empty array and warns when the payload is a string', async () => {
    // #given
    const client = createMockSdkClient({sessionMessagesResponse: {data: 'not-an-array'}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages returned a non-array payload', {
      type: 'string',
    })
  })

  it('returns empty array and warns when the payload is a number', async () => {
    // #given
    const client = createMockSdkClient({sessionMessagesResponse: {data: 42}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages returned a non-array payload', {
      type: 'number',
    })
  })

  it('returns empty array and warns when the payload is a null-prototype object', async () => {
    // #given a non-array object without inherited properties
    const payload: unknown = Object.create(null) as Record<string, never>
    const client = createMockSdkClient({sessionMessagesResponse: {data: payload}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages returned a non-array payload', {
      type: 'object',
    })
  })

  it('does not leak a payload-owned constructor name into the warning', async () => {
    // #given a payload-owned constructor key
    const client = createMockSdkClient({sessionMessagesResponse: {data: sentinelPayload()}})

    // #when
    const result = await getSessionMessages(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then intrinsic type only
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session messages returned a non-array payload', {
      type: 'object',
    })
    expect(JSON.stringify(vi.mocked(mockLogger.warning).mock.calls)).not.toContain(CONSTRUCTOR_SENTINEL)
  })
})

describe('getSessionTodos', () => {
  it('returns todos via SDK', async () => {
    // #given
    const sdkTodos = [
      {content: 'Task 1', status: 'pending', priority: 'high'},
      {id: 't2', content: 'Task 2', status: 'completed', priority: 'low'},
    ]
    const client = createMockSdkClient({sessionTodosResponse: {data: sdkTodos}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(client.session.todos).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(result).toEqual([
      {content: 'Task 1', status: 'pending', priority: 'high'},
      {id: 't2', content: 'Task 2', status: 'completed', priority: 'low'},
    ])
  })

  it('returns empty todos when SDK todos fail', async () => {
    // #given
    const client = createMockSdkClient({sessionTodosResponse: {error: 'boom', data: null}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session todos failed', expect.any(Object))
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({sessionTodosResponse: {error: unprintableErrorPayload(), data: null}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then no throw, fallback message logged
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session todos failed', {error: '[unprintable error]'})
  })

  it('returns empty array and warns when the payload is not an array', async () => {
    // #given: same structurally-unexpected-but-not-an-error shape as the other call sites in this
    // file — the guard is hoisted here (from mapSdkTodos's own defensive check) since a logger is
    // in scope in storage.ts but not in the pure-mapping storage-mappers.ts module.
    const client = createMockSdkClient({sessionTodosResponse: {data: {not: 'an array'}}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session todos returned a non-array payload', {
      type: 'object',
    })
  })

  it('does not leak a payload-owned constructor name into the warning', async () => {
    // #given a payload-owned constructor key
    const client = createMockSdkClient({sessionTodosResponse: {data: sentinelPayload()}})

    // #when
    const result = await getSessionTodos(client as unknown as SessionClient, 'ses_sdk', mockLogger)

    // #then intrinsic type only
    expect(result).toEqual([])
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session todos returned a non-array payload', {
      type: 'object',
    })
    expect(JSON.stringify(vi.mocked(mockLogger.warning).mock.calls)).not.toContain(CONSTRUCTOR_SENTINEL)
  })
})

describe('findLatestSession', () => {
  it('finds latest session via SDK', async () => {
    // #given
    const sdkSession = {
      id: 'ses_latest',
      version: '1.1.53',
      projectId: 'proj_sdk',
      directory: '/workspace',
      title: 'Latest',
      time: {created: 5000, updated: 6000},
    }
    const client = createMockSdkClient({sessionListResponse: {data: [sdkSession]}})

    // #when
    const result = await findLatestSession(client as unknown as SessionClient, '/workspace', 4000, mockLogger)

    // #then
    expect(client.session.list).toHaveBeenCalledWith({
      query: {directory: '/workspace', start: 4000, roots: true, limit: 10},
    })
    expect(result?.session.id).toBe('ses_latest')
  })

  it('returns null and warns when the payload is not an array', async () => {
    // #given: the previously-unlogged branch — collapsed with the genuinely-empty case before
    // this fix, so a malformed payload here looked identical in CI to "no sessions since this
    // timestamp".
    const client = createMockSdkClient({sessionListResponse: {data: {not: 'an array'}}})

    // #when
    const result = await findLatestSession(client as unknown as SessionClient, '/workspace', 4000, mockLogger)

    // #then: `source` distinguishes this call site from listSessionsForProject's identical message
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list returned a non-array payload', {
      source: 'findLatestSession',
      type: 'object',
    })
  })

  it('does not leak a payload-owned constructor name into the warning', async () => {
    // #given a payload-owned constructor key
    const client = createMockSdkClient({sessionListResponse: {data: sentinelPayload()}})

    // #when
    const result = await findLatestSession(client as unknown as SessionClient, '/workspace', 4000, mockLogger)

    // #then intrinsic type only
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list returned a non-array payload', {
      source: 'findLatestSession',
      type: 'object',
    })
    expect(JSON.stringify(vi.mocked(mockLogger.warning).mock.calls)).not.toContain(CONSTRUCTOR_SENTINEL)
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({sessionListResponse: {error: unprintableErrorPayload(), data: null}})

    // #when
    const result = await findLatestSession(client as unknown as SessionClient, '/workspace', 4000, mockLogger)

    // #then no throw, fallback message logged
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session list failed', {
      source: 'findLatestSession',
      error: '[unprintable error]',
    })
  })

  it('returns null and does NOT warn when the array is genuinely empty', async () => {
    // #given
    const client = createMockSdkClient({sessionListResponse: {data: []}})

    // #when
    const result = await findLatestSession(client as unknown as SessionClient, '/workspace', 4000, mockLogger)

    // #then: an empty result is normal operation — it must not start emitting warnings
    expect(result).toBeNull()
    expect(mockLogger.warning).not.toHaveBeenCalled()
  })
})

describe('deleteSession', () => {
  it('deletes session via SDK', async () => {
    // #given
    const client = createMockSdkClient({sessionDeleteResponse: {data: null}})

    // #when
    await expect(deleteSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)).resolves.toBeUndefined()

    // #then
    expect(client.session.delete).toHaveBeenCalledWith({path: {id: 'ses_sdk'}})
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Deleted session via SDK',
      expect.objectContaining({sessionID: 'ses_sdk'}),
    )
  })

  it('handles SDK delete errors gracefully', async () => {
    // #given
    const client = createMockSdkClient({sessionDeleteResponse: {error: 'Not found'}})

    // #when
    await expect(deleteSession(client as unknown as SessionClient, 'ses_missing', mockLogger)).resolves.toBeUndefined()

    // #then
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'SDK session delete failed',
      expect.objectContaining({sessionID: 'ses_missing'}),
    )
  })

  it('does not throw when the failure payload cannot be coerced to a string', async () => {
    // #given a payload whose own toString is not callable
    const client = createMockSdkClient({sessionDeleteResponse: {error: unprintableErrorPayload()}})

    // #when
    await expect(deleteSession(client as unknown as SessionClient, 'ses_sdk', mockLogger)).resolves.toBeUndefined()

    // #then no throw, fallback message logged
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session delete failed', {
      sessionID: 'ses_sdk',
      error: '[unprintable error]',
    })
  })
})
