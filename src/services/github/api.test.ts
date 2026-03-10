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
  getRepositoryPermission,
  getUserByUsername,
  listCommentReactions,
  parseRepoString,
  removeLabelFromIssue,
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
