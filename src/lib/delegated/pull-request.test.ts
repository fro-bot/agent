import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {
  addPRLabels,
  createPullRequest,
  findPRForBranch,
  generatePRBody,
  requestReviewers,
  updatePullRequest,
} from './pull-request.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockOctokit(
  overrides: {
    create?: ReturnType<typeof vi.fn>
    list?: ReturnType<typeof vi.fn>
    update?: ReturnType<typeof vi.fn>
    addLabels?: ReturnType<typeof vi.fn>
    requestReviewers?: ReturnType<typeof vi.fn>
  } = {},
): Octokit {
  return {
    rest: {
      pulls: {
        create: overrides.create ?? vi.fn(),
        list: overrides.list ?? vi.fn(),
        update: overrides.update ?? vi.fn(),
        requestReviewers: overrides.requestReviewers ?? vi.fn(),
      },
      issues: {
        addLabels: overrides.addLabels ?? vi.fn(),
      },
    },
  } as unknown as Octokit
}

describe('createPullRequest', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('creates PR with all options', async () => {
    // #given
    const create = vi.fn().mockResolvedValue({
      data: {
        number: 42,
        html_url: 'https://github.com/owner/repo/pull/42',
        title: 'feat: new feature',
        state: 'open',
      },
    })
    const octokit = createMockOctokit({create})

    // #when
    const result = await createPullRequest(
      octokit,
      {
        owner: 'owner',
        repo: 'repo',
        title: 'feat: new feature',
        body: 'Description here',
        head: 'feature-branch',
        base: 'main',
        draft: true,
      },
      logger,
    )

    // #then
    expect(result.number).toBe(42)
    expect(result.url).toBe('https://github.com/owner/repo/pull/42')
    expect(create).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      title: 'feat: new feature',
      body: 'Description here',
      head: 'feature-branch',
      base: 'main',
      draft: true,
    })
  })

  it('defaults draft to false', async () => {
    // #given
    const create = vi.fn().mockResolvedValue({
      data: {number: 1, html_url: 'url', title: 'title', state: 'open'},
    })
    const octokit = createMockOctokit({create})

    // #when
    await createPullRequest(
      octokit,
      {
        owner: 'owner',
        repo: 'repo',
        title: 'PR',
        body: 'body',
        head: 'branch',
        base: 'main',
      },
      logger,
    )

    // #then
    expect(create).toHaveBeenCalledWith(expect.objectContaining({draft: false}))
  })
})

describe('findPRForBranch', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('returns PR when found', async () => {
    // #given
    const list = vi.fn().mockResolvedValue({
      data: [{number: 10, html_url: 'url', title: 'PR Title', state: 'open'}],
    })
    const octokit = createMockOctokit({list})

    // #when
    const result = await findPRForBranch(octokit, 'owner', 'repo', 'feature', logger)

    // #then
    expect(result).not.toBeNull()
    expect(result?.number).toBe(10)
  })

  it('returns null when no PR exists', async () => {
    // #given
    const list = vi.fn().mockResolvedValue({data: []})
    const octokit = createMockOctokit({list})

    // #when
    const result = await findPRForBranch(octokit, 'owner', 'repo', 'no-pr', logger)

    // #then
    expect(result).toBeNull()
  })
})

describe('updatePullRequest', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('updates PR title and body', async () => {
    // #given
    const update = vi.fn().mockResolvedValue({
      data: {number: 5, html_url: 'url', title: 'New Title', state: 'open'},
    })
    const octokit = createMockOctokit({update})

    // #when
    const result = await updatePullRequest(octokit, 'owner', 'repo', 5, {title: 'New Title', body: 'New Body'}, logger)

    // #then
    expect(result.title).toBe('New Title')
    expect(update).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 5,
      title: 'New Title',
      body: 'New Body',
    })
  })
})

describe('addPRLabels', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('adds labels to PR', async () => {
    // #given
    const addLabels = vi.fn().mockResolvedValue({data: {}})
    const octokit = createMockOctokit({addLabels})

    // #when
    await addPRLabels(octokit, 'owner', 'repo', 10, ['bug', 'priority'], logger)

    // #then
    expect(addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 10,
      labels: ['bug', 'priority'],
    })
  })

  it('no-ops on empty labels', async () => {
    // #given
    const addLabels = vi.fn()
    const octokit = createMockOctokit({addLabels})

    // #when
    await addPRLabels(octokit, 'owner', 'repo', 10, [], logger)

    // #then
    expect(addLabels).not.toHaveBeenCalled()
  })
})

describe('requestReviewers', () => {
  let logger: Logger

  beforeEach(() => {
    logger = createMockLogger()
  })

  it('requests reviewers', async () => {
    // #given
    const requestReviewersFn = vi.fn().mockResolvedValue({data: {}})
    const octokit = createMockOctokit({requestReviewers: requestReviewersFn})

    // #when
    await requestReviewers(octokit, 'owner', 'repo', 10, ['alice', 'bob'], logger)

    // #then
    expect(requestReviewersFn).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 10,
      reviewers: ['alice', 'bob'],
    })
  })

  it('no-ops on empty reviewers', async () => {
    // #given
    const requestReviewersFn = vi.fn()
    const octokit = createMockOctokit({requestReviewers: requestReviewersFn})

    // #when
    await requestReviewers(octokit, 'owner', 'repo', 10, [], logger)

    // #then
    expect(requestReviewersFn).not.toHaveBeenCalled()
  })
})

describe('generatePRBody', () => {
  it('generates body with description only', () => {
    // #given / #when
    const result = generatePRBody({description: 'This is a fix'})

    // #then
    expect(result).toBe('This is a fix')
  })

  it('includes changes list', () => {
    // #given / #when
    const result = generatePRBody({
      description: 'Fix bugs',
      changes: ['Fixed issue A', 'Fixed issue B'],
    })

    // #then
    expect(result).toContain('## Changes')
    expect(result).toContain('- Fixed issue A')
    expect(result).toContain('- Fixed issue B')
  })

  it('includes issue reference', () => {
    // #given / #when
    const result = generatePRBody({
      description: 'Fixes the bug',
      issueNumber: 123,
    })

    // #then
    expect(result).toContain('Closes #123')
  })

  it('includes session attribution', () => {
    // #given / #when
    const result = generatePRBody({
      description: 'Auto-generated',
      sessionId: 'ses_abc123',
    })

    // #then
    expect(result).toContain('session: `ses_abc123`')
    expect(result).toContain('Fro Bot Agent')
  })

  it('includes all sections', () => {
    // #given / #when
    const result = generatePRBody({
      description: 'Complete fix',
      changes: ['Change 1'],
      issueNumber: 42,
      sessionId: 'ses_xyz',
    })

    // #then
    expect(result).toContain('Complete fix')
    expect(result).toContain('## Changes')
    expect(result).toContain('Closes #42')
    expect(result).toContain('session: `ses_xyz`')
  })
})
