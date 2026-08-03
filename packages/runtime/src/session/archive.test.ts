import type {SessionClient} from './backend.js'
import type {Logger} from './types.js'

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {archiveSession} from './archive.js'
import {resolveSessionForLogicalKey} from './logical-key.js'

const mockCreateOpencodeClient = vi.fn()

interface ArchiveUpdateOptions {
  readonly sessionID: string
  readonly time: {readonly archived: number}
}

interface ArchiveUpdateResponse {
  readonly data?: unknown
  readonly error?: unknown
}

const mockUpdate = vi.fn<(options: ArchiveUpdateOptions) => Promise<ArchiveUpdateResponse>>()

vi.mock('@opencode-ai/sdk/v2/client', () => ({
  createOpencodeClient: (...args: unknown[]): unknown => mockCreateOpencodeClient(...args),
}))

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}

const BASE_URL = 'http://127.0.0.1:4096'

function createSession() {
  return {
    id: 'ses_archive',
    version: '1.1.53',
    projectID: 'proj_1',
    directory: '/workspace',
    title: 'fro-bot: pr-347',
    time: {created: 100, updated: 200} as {created: number; updated: number; archived?: number},
  }
}

describe('archiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateOpencodeClient.mockReturnValue({session: {update: mockUpdate}})
  })

  it('archives a session and makes it ineligible for logical-key resolution', async () => {
    // #given
    const session = createSession()
    mockUpdate.mockImplementation(async (options: {time?: {archived?: number}}) => {
      session.time.archived = options.time?.archived
      return {data: session}
    })
    const client = {
      session: {
        list: vi.fn().mockResolvedValue({data: [session]}),
      },
    }

    // #when
    const archived = await archiveSession(BASE_URL, session.id, mockLogger)
    const resolution = await resolveSessionForLogicalKey(
      client as unknown as SessionClient,
      '/workspace',
      {key: 'pr-347', entityType: 'pr', entityId: '347'},
      mockLogger,
    )

    // #then
    expect(archived).toBe(true)
    expect(mockCreateOpencodeClient).toHaveBeenCalledWith({baseUrl: BASE_URL})
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    const updateOptions = mockUpdate.mock.calls[0]?.[0]
    expect(updateOptions?.sessionID).toBe(session.id)
    expect(typeof updateOptions?.time.archived).toBe('number')
    expect(typeof session.time.archived).toBe('number')
    expect(resolution).toEqual({status: 'not-found'})
  })

  it('logs a warning and returns false when archiving fails', async () => {
    // #given
    mockUpdate.mockRejectedValue(new Error('connection refused'))

    // #when
    const archived = await archiveSession(BASE_URL, 'ses_archive', mockLogger)

    // #then
    expect(archived).toBe(false)
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session archive failed', {
      sessionId: 'ses_archive',
      error: 'connection refused',
    })
  })

  it('logs a warning and returns false when the SDK returns an archive error', async () => {
    // #given
    mockUpdate.mockResolvedValue({data: undefined, error: 'server error'})

    // #when
    const archived = await archiveSession(BASE_URL, 'ses_archive', mockLogger)

    // #then
    expect(archived).toBe(false)
    expect(mockLogger.warning).toHaveBeenCalledWith('SDK session archive failed', {
      sessionId: 'ses_archive',
      error: 'server error',
    })
  })
})
