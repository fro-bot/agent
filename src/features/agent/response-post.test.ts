import type {AgentContext} from '@fro-bot/runtime'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {Octokit} from '../../services/github/types.js'
import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {runResponsePost} from './response-post.js'

function makeAgentContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    eventName: 'issue_comment',
    repo: 'owner/repo',
    ref: 'refs/heads/main',
    actor: 'someone',
    runId: '1',
    issueNumber: 42,
    issueTitle: 'Title',
    issueType: 'issue',
    commentBody: null,
    commentAuthor: null,
    commentId: null,
    defaultBranch: 'main',
    diffContext: null,
    hydratedContext: null,
    authorAssociation: null,
    isRequestedReviewer: false,
    ...overrides,
  }
}

function makeTriggerResult(eventType: TriggerResultProcess['context']['eventType']): TriggerResultProcess {
  return {
    shouldProcess: true,
    context: {
      eventType,
      eventName: eventType,
      repo: {owner: 'owner', repo: 'repo'},
      ref: 'refs/heads/main',
      sha: 'sha',
      runId: 1,
      actor: 'someone',
      action: null,
      author: null,
      target: null,
      commentBody: null,
      commentId: null,
      hasMention: true,
      command: null,
      isBotReviewRequested: false,
      raw: {},
    },
  }
}

function makeOctokit(overrides?: {
  readonly createComment?: () => unknown
  readonly getPR?: () => unknown
  readonly createReview?: () => unknown
}) {
  const defaultComment = {data: {id: 1, html_url: 'https://github.com/owner/repo/issues/42#issuecomment-1'}}
  const defaultPR = {
    data: {
      head: {sha: 'head-sha', repo: {full_name: 'owner/repo'}},
      base: {repo: {full_name: 'owner/repo'}},
      user: {login: 'pr-author'},
    },
  }
  const defaultReview = {data: {id: 1, state: 'APPROVED', html_url: 'https://github.com/owner/repo/pull/1/reviews/1'}}

  return {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue(overrides?.createComment?.() ?? defaultComment),
      },
      pulls: {
        get: vi.fn().mockResolvedValue(overrides?.getPR?.() ?? defaultPR),
        createReview: vi.fn().mockResolvedValue(overrides?.createReview?.() ?? defaultReview),
        listFiles: vi.fn().mockResolvedValue({data: []}),
      },
    },
    graphql: vi.fn(),
  }
}

async function writeFixture(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-test-'))
  const filePath = path.join(dir, 'response.md')
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

describe('runResponsePost', () => {
  let logger: Logger
  let tempFiles: string[] = []

  beforeEach(() => {
    logger = createMockLogger()
    tempFiles = []
  })

  afterEach(async () => {
    for (const filePath of tempFiles) {
      await fs.rm(path.dirname(filePath), {recursive: true, force: true})
    }
  })

  it('posts a comment with the file body, targeting the routing-derived owner/repo/number', async () => {
    // #given a valid comment-only response file and an issue_comment trigger
    const filePath = await writeFixture('Body from the model.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'issue', issueNumber: 42}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the comment is posted to the routing target with the file body
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: expect.stringContaining('Body from the model.') as unknown as string,
      }),
    )
  })

  it('submits a REQUEST_CHANGES review through the shared guard for a pull_request trigger', async () => {
    // #given a valid response file with a request-changes verdict
    const filePath = await writeFixture('---\nverdict: request-changes\n---\n\nPlease fix X.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then submitReview is called with REQUEST_CHANGES via createReview
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'REQUEST_CHANGES', pull_number: 7, commit_id: 'head-sha'}),
    )
  })

  it('targets the routing-derived issue number even when the file embeds a different number', async () => {
    // #given a response file that embeds an unrelated "number: 999" line in its body (not frontmatter)
    const filePath = await writeFixture('Body claiming number: 999 but that is just prose.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'issue', issueNumber: 42}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the post still targets the routing number (42), not 999
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({issue_number: 42}),
    )
  })

  it('blocks an approve verdict on a fork PR via the shared guard, without submitting a review', async () => {
    // #given a valid approve-verdict response file, but the PR head repo differs from the base repo (fork)
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha', repo: {full_name: 'attacker/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
    })

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then no APPROVE is submitted and the result reports the guard block
    expect(result).toEqual({
      delivered: false,
      reason: 'review-guard-blocked',
      detail: 'Review guard blocked submission: self-or-fork',
    })
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('submits a REQUEST_CHANGES review on a fork PR via the shared guard, since it can only block', async () => {
    // #given a valid request-changes-verdict response file on a fork PR (head repo differs from base repo)
    const filePath = await writeFixture('---\nverdict: request-changes\n---\n\nPlease fix X.')
    tempFiles.push(filePath)
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha', repo: {full_name: 'attacker/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      }),
    })

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the review guard allows it and REQUEST_CHANGES is submitted, not blocked
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'REQUEST_CHANGES', pull_number: 7, commit_id: 'head-sha'}),
    )
  })

  it('fails closed when the response file does not exist', async () => {
    // #given a response file path that was never created
    const octokit = makeOctokit()

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: '/nonexistent/path/response.md',
      },
      logger,
    )

    // #then the result is a typed file-read failure and nothing was posted
    expect(result.delivered).toBe(false)
    expect((result as {reason: string}).reason).toBe('file-read-failed')
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it('fails closed when postComment returns null (writer failure)', async () => {
    // #given a valid response file but the writer fails every attempt
    const filePath = await writeFixture('Body from the model.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()
    octokit.rest.issues.createComment.mockRejectedValue(new Error('boom'))

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then delivery fails closed after the bounded retry attempts
    expect(result.delivered).toBe(false)
    expect((result as {reason: string}).reason).toBe('post-failed')
  })

  it('rejects a malformed response file with an unknown frontmatter key', async () => {
    // #given a response file with a disallowed frontmatter key (attempted target injection)
    const filePath = await writeFixture('---\nnumber: 999\n---\n\nBody.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the file is rejected before anything is posted
    expect(result.delivered).toBe(false)
    expect((result as {reason: string}).reason).toBe('parse-failed')
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })
})
