import type {Logger} from '../../shared/logger.js'
import type {Octokit} from './types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {
  addLabelsToIssue,
  createCommentReaction,
  deleteCommentReaction,
  ensureLabelExists,
  getDefaultBranch,
  getLatestLabeledEventTimes,
  getRepositoryPermission,
  getUserByUsername,
  listCommentReactions,
  listLabelsOnIssue,
  parseRepoString,
  removeLabelFromIssue,
  removeLabelFromIssueWithOutcome,
} from './api.js'
import {createMockOctokit} from './test-helpers.js'

describe('parseRepoString', () => {
  it('parses valid owner/repo string', () => {
    // #given
    const repoString = 'owner/repo'

    // #when
    const result = parseRepoString(repoString)

    // #then
    expect(result).toEqual({owner: 'owner', repo: 'repo'})
  })

  it('throws on invalid format', () => {
    // #given
    const invalidStrings = ['invalid', '', 'owner/', '/repo']

    // #then
    for (const str of invalidStrings) {
      expect(() => parseRepoString(str)).toThrow('Invalid repository string')
    }
  })
})

describe('createCommentReaction', () => {
  let mockLogger: Logger
  let mockOctokit: Octokit

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockOctokit = createMockOctokit()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates reaction and returns id', async () => {
    // #given
    const repoString = 'owner/repo'
    const commentId = 12345
    const content = 'eyes' as const

    // #when
    const result = await createCommentReaction(mockOctokit, repoString, commentId, content, mockLogger)

    // #then
    expect(result).toEqual({id: 123})
    expect(mockOctokit.rest.reactions.createForIssueComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 12345,
      content: 'eyes',
    })
  })

  it('returns null and logs warning on error', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.reactions.createForIssueComment).mockRejectedValue(new Error('API error'))

    // #when
    const result = await createCommentReaction(mockClient, 'owner/repo', 123, 'eyes', mockLogger)

    // #then
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to create comment reaction',
      expect.objectContaining({error: 'API error'}),
    )
  })
})

describe('listCommentReactions', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('returns mapped reactions', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.reactions.listForIssueComment).mockResolvedValue({
      data: [
        {id: 1, content: 'eyes', user: {login: 'bot-user'}},
        {id: 2, content: 'hooray', user: {login: 'other-user'}},
      ],
    } as never)

    // #when
    const result = await listCommentReactions(mockClient, 'owner/repo', 123, mockLogger)

    // #then
    expect(result).toEqual([
      {id: 1, content: 'eyes', userLogin: 'bot-user'},
      {id: 2, content: 'hooray', userLogin: 'other-user'},
    ])
  })

  it('returns empty array on error', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.reactions.listForIssueComment).mockRejectedValue(new Error('API error'))

    // #when
    const result = await listCommentReactions(mockClient, 'owner/repo', 123, mockLogger)

    // #then
    expect(result).toEqual([])
  })
})

describe('deleteCommentReaction', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('deletes reaction and returns true', async () => {
    // #given
    const mockClient = createMockOctokit()

    // #when
    const result = await deleteCommentReaction(mockClient, 'owner/repo', 123, 456, mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockClient.rest.reactions.deleteForIssueComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 123,
      reaction_id: 456,
    })
  })

  it('returns false on error', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.reactions.deleteForIssueComment).mockRejectedValue(new Error('Not found'))

    // #when
    const result = await deleteCommentReaction(mockClient, 'owner/repo', 123, 456, mockLogger)

    // #then
    expect(result).toBe(false)
  })
})

describe('ensureLabelExists', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('creates label and returns true', async () => {
    // #given
    const mockClient = createMockOctokit()

    // #when
    const result = await ensureLabelExists(mockClient, 'owner/repo', 'bug', 'ff0000', 'Bug label', mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockClient.rest.issues.createLabel).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      name: 'bug',
      color: 'ff0000',
      description: 'Bug label',
    })
  })

  it('returns true when label already exists (422 error)', async () => {
    // #given
    const mockClient = createMockOctokit()
    const error = Object.assign(new Error('Validation Failed'), {status: 422})
    vi.mocked(mockClient.rest.issues.createLabel).mockRejectedValue(error)

    // #when
    const result = await ensureLabelExists(mockClient, 'owner/repo', 'bug', 'ff0000', 'Bug label', mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockLogger.debug).toHaveBeenCalledWith('Label already exists', {name: 'bug'})
  })

  it('returns false on other errors', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.issues.createLabel).mockRejectedValue(new Error('Permission denied'))

    // #when
    const result = await ensureLabelExists(mockClient, 'owner/repo', 'bug', 'ff0000', 'Bug label', mockLogger)

    // #then
    expect(result).toBe(false)
    expect(mockLogger.warning).toHaveBeenCalled()
  })
})

describe('addLabelsToIssue', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('adds labels and returns true', async () => {
    // #given
    const mockClient = createMockOctokit()

    // #when
    const result = await addLabelsToIssue(mockClient, 'owner/repo', 42, ['bug', 'urgent'], mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockClient.rest.issues.addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      labels: ['bug', 'urgent'],
    })
  })

  it('returns false on error', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.issues.addLabels).mockRejectedValue(new Error('Not found'))

    // #when
    const result = await addLabelsToIssue(mockClient, 'owner/repo', 42, ['bug'], mockLogger)

    // #then
    expect(result).toBe(false)
  })
})

describe('removeLabelFromIssueWithOutcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports removed, absent (404) and failed distinctly', async () => {
    // #given three clients: remove succeeds, 404s, and 500s
    const ok = createMockOctokit()
    const missing = createMockOctokit()
    vi.mocked(missing.rest.issues.removeLabel).mockRejectedValue(Object.assign(new Error('Not Found'), {status: 404}))
    const broken = createMockOctokit()
    vi.mocked(broken.rest.issues.removeLabel).mockRejectedValue(Object.assign(new Error('boom'), {status: 500}))

    // #when / #then each outcome is distinguishable
    expect(await removeLabelFromIssueWithOutcome(ok, 'owner/repo', 1, 'bug', createMockLogger())).toBe('removed')
    expect(await removeLabelFromIssueWithOutcome(missing, 'owner/repo', 1, 'bug', createMockLogger())).toBe('absent')
    expect(await removeLabelFromIssueWithOutcome(broken, 'owner/repo', 1, 'bug', createMockLogger())).toBe('failed')
  })

  it('forwards an abort signal as request.signal only when one is given', async () => {
    // #given a client and a signal
    const client = createMockOctokit()
    const {signal} = new AbortController()

    // #when removing with and without the signal
    await removeLabelFromIssueWithOutcome(client, 'owner/repo', 1, 'bug', createMockLogger(), signal)
    await removeLabelFromIssueWithOutcome(client, 'owner/repo', 1, 'bug', createMockLogger())

    // #then only the first call carries a request option
    const calls = vi.mocked(client.rest.issues.removeLabel).mock.calls
    expect(calls[0]?.[0]).toMatchObject({request: {signal}})
    expect(calls[1]?.[0]).not.toHaveProperty('request')
  })
})

describe('removeLabelFromIssue', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('removes label and returns true', async () => {
    // #given
    const mockClient = createMockOctokit()

    // #when
    const result = await removeLabelFromIssue(mockClient, 'owner/repo', 42, 'bug', mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockClient.rest.issues.removeLabel).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      name: 'bug',
    })
  })

  it('returns true when label not present (404 error)', async () => {
    // #given
    const mockClient = createMockOctokit()
    const error = Object.assign(new Error('Not Found'), {status: 404})
    vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(error)

    // #when
    const result = await removeLabelFromIssue(mockClient, 'owner/repo', 42, 'bug', mockLogger)

    // #then
    expect(result).toBe(true)
    expect(mockLogger.debug).toHaveBeenCalledWith('Label was not present on issue', {issueNumber: 42, label: 'bug'})
  })

  it('returns false on other errors', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.issues.removeLabel).mockRejectedValue(new Error('Permission denied'))

    // #when
    const result = await removeLabelFromIssue(mockClient, 'owner/repo', 42, 'bug', mockLogger)

    // #then
    expect(result).toBe(false)
  })
})

describe('getDefaultBranch', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('returns default branch from API', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.get).mockResolvedValue({
      data: {default_branch: 'develop'},
    } as never)

    // #when
    const result = await getDefaultBranch(mockClient, 'owner/repo', mockLogger)

    // #then
    expect(result).toBe('develop')
  })

  it('returns "main" on error', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.get).mockRejectedValue(new Error('Not found'))

    // #when
    const result = await getDefaultBranch(mockClient, 'owner/repo', mockLogger)

    // #then
    expect(result).toBe('main')
    expect(mockLogger.warning).toHaveBeenCalled()
  })
})

describe('getRepositoryPermission', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('maps admin permission to OWNER', async () => {
    // #given a user with admin permission
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'admin', user: {login: 'admin-user'}},
    } as never)

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'admin-user', mockLogger)

    // #then it should return OWNER
    expect(result).toBe('OWNER')
  })

  it('maps maintain permission to MEMBER', async () => {
    // #given a user with maintain permission
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'maintain', user: {login: 'maintainer'}},
    } as never)

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'maintainer', mockLogger)

    // #then it should return MEMBER
    expect(result).toBe('MEMBER')
  })

  it('maps write permission to COLLABORATOR', async () => {
    // #given a user with write permission
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'write', user: {login: 'writer'}},
    } as never)

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'writer', mockLogger)

    // #then it should return COLLABORATOR
    expect(result).toBe('COLLABORATOR')
  })

  it('maps triage permission to COLLABORATOR', async () => {
    // #given a user with triage permission
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'triage', user: {login: 'triager'}},
    } as never)

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'triager', mockLogger)

    // #then it should return COLLABORATOR
    expect(result).toBe('COLLABORATOR')
  })

  it('returns null for read permission', async () => {
    // #given a user with read-only permission
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'read', user: {login: 'reader'}},
    } as never)

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'reader', mockLogger)

    // #then it should return null (not an authorized association)
    expect(result).toBeNull()
  })

  it('returns null for none permission', async () => {
    // #given a user with no permission
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'none', user: {login: 'outsider'}},
    } as never)

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'outsider', mockLogger)

    // #then it should return null
    expect(result).toBeNull()
  })

  it('returns null on API error', async () => {
    // #given an API failure
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockRejectedValue(new Error('Not found'))

    // #when resolving their repository permission
    const result = await getRepositoryPermission(mockClient, 'owner', 'repo', 'unknown', mockLogger)

    // #then it should return null and log a warning
    expect(result).toBeNull()
    expect(mockLogger.warning).toHaveBeenCalledWith(
      'Failed to resolve sender permission',
      expect.objectContaining({username: 'unknown'}),
    )
  })

  it('logs resolved permission details', async () => {
    // #given a successful permission resolution
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.repos.getCollaboratorPermissionLevel).mockResolvedValue({
      data: {permission: 'write', user: {login: 'marcus'}},
    } as never)

    // #when resolving their repository permission
    await getRepositoryPermission(mockClient, 'owner', 'repo', 'marcus', mockLogger)

    // #then it should log the resolution
    expect(mockLogger.debug).toHaveBeenCalledWith('Resolved sender permission', {
      username: 'marcus',
      permission: 'write',
      association: 'COLLABORATOR',
    })
  })
})

describe('getUserByUsername', () => {
  let mockLogger: Logger

  beforeEach(() => {
    mockLogger = createMockLogger()
    vi.clearAllMocks()
  })

  it('returns user info', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.users.getByUsername).mockResolvedValue({
      data: {id: 789, login: 'fro-bot[bot]'},
    } as never)

    // #when
    const result = await getUserByUsername(mockClient, 'fro-bot[bot]', mockLogger)

    // #then
    expect(result).toEqual({id: 789, login: 'fro-bot[bot]'})
  })

  it('returns null on error', async () => {
    // #given
    const mockClient = createMockOctokit()
    vi.mocked(mockClient.rest.users.getByUsername).mockRejectedValue(new Error('Not found'))

    // #when
    const result = await getUserByUsername(mockClient, 'unknown', mockLogger)

    // #then
    expect(result).toBeNull()
  })
})

describe('listLabelsOnIssue', () => {
  it('returns the label names', async () => {
    // #given an issue with two labels
    const client = createMockOctokit({listLabelsOnIssue: [{name: 'bug'}, {name: 'agent: blocked'}]})

    // #when listing
    const result = await listLabelsOnIssue(client, 'owner/repo', 42, createMockLogger())

    // #then names come back from a single call
    expect(result).toEqual(['bug', 'agent: blocked'])
    expect(client.rest.issues.listLabelsOnIssue).toHaveBeenCalledTimes(1)
  })

  it('returns null (not an empty list) when the call fails', async () => {
    // #given the API fails
    const client = createMockOctokit({listLabelsOnIssue: vi.fn().mockRejectedValue(new Error('boom'))})
    const logger = createMockLogger()

    // #when listing
    const result = await listLabelsOnIssue(client, 'owner/repo', 42, logger)

    // #then failure is distinguishable from "no labels" and is logged
    expect(result).toBeNull()
    expect(logger.warning).toHaveBeenCalled()
  })
})

describe('getLatestLabeledEventTimes', () => {
  const lastLink = (page: number) => ({
    link: `<https://api.github.com/x?per_page=100&page=2>; rel="next", <https://api.github.com/x?per_page=100&page=${page}>; rel="last"`,
  })
  const labeled = (createdAt: string, name: string) => ({event: 'labeled', created_at: createdAt, label: {name}})
  const other = {event: 'commented', created_at: '2026-10-09T12:00:00Z'}
  const wanted = ['agent: blocked', 'agent: working']

  it('reads only page 1 when there is no Link header, returning both labels', async () => {
    // #given a single page carrying both labels
    const listEvents = vi.fn().mockResolvedValue({
      data: [labeled('2026-10-09T10:00:00Z', 'agent: blocked'), labeled('2026-10-09T11:00:00Z', 'agent: working')],
      headers: {},
    })
    const client = createMockOctokit({listEvents})

    // #when reading the latest labeled times
    const result = await getLatestLabeledEventTimes(client, 'owner/repo', 1, wanted, createMockLogger())

    // #then one call, both times
    expect(listEvents).toHaveBeenCalledTimes(1)
    expect(result?.get('agent: blocked')).toBe(Date.parse('2026-10-09T10:00:00Z'))
    expect(result?.get('agent: working')).toBe(Date.parse('2026-10-09T11:00:00Z'))
  })

  it('scans back from the last page until both labels are found, once per page', async () => {
    // #given the last page (3) has only other events, page 2 has the working label, page 1 has the blocked one
    const pages: Record<number, unknown[]> = {
      1: [labeled('2026-10-09T09:00:00Z', 'agent: blocked')],
      2: [labeled('2026-10-09T10:00:00Z', 'agent: working')],
      3: [other],
    }
    const listEvents = vi
      .fn()
      .mockImplementation(async ({page}: {page: number}) => ({data: pages[page], headers: lastLink(3)}))
    const client = createMockOctokit({listEvents})

    // #when reading
    const result = await getLatestLabeledEventTimes(client, 'owner/repo', 1, wanted, createMockLogger())

    // #then both are found, page 1 is fetched exactly once, and no page repeats
    expect(result?.get('agent: working')).toBe(Date.parse('2026-10-09T10:00:00Z'))
    expect(result?.get('agent: blocked')).toBe(Date.parse('2026-10-09T09:00:00Z'))
    expect(listEvents.mock.calls.map(call => (call[0] as {page: number}).page)).toEqual([1, 3, 2])
  })

  it('omits labels with no labeled event instead of failing', async () => {
    // #given a page with no matching events
    const client = createMockOctokit({listEvents: vi.fn().mockResolvedValue({data: [other], headers: {}})})

    // #when reading
    const result = await getLatestLabeledEventTimes(client, 'owner/repo', 1, wanted, createMockLogger())

    // #then an empty map (not null) is returned
    expect(result?.size).toBe(0)
  })

  it('returns null when events cannot be read', async () => {
    // #given a failing events API
    const client = createMockOctokit({listEvents: vi.fn().mockRejectedValue(new Error('500'))})

    // #when reading
    const result = await getLatestLabeledEventTimes(client, 'owner/repo', 1, wanted, createMockLogger())

    // #then null
    expect(result).toBeNull()
  })
})
