import type {AgentContext} from '@fro-bot/runtime'
import type {TriggerResultProcess} from '../../features/triggers/types.js'
import type {Logger} from '../../shared/logger.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {BOT_COMMENT_MARKER, type Octokit} from '../../services/github/types.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createIssueCommentCreatedEvent} from '../triggers/__fixtures__/payloads.js'
import {routeEvent} from '../triggers/router.js'
import {createMockGitHubContext} from '../triggers/test-helpers.js'
import {resolveResponseSurface} from './response-file.js'
import {readAndParseResponseFile, runResponsePost} from './response-post.js'

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  actualReadFile: undefined as typeof import('node:fs/promises').readFile | undefined,
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  fsMocks.actualReadFile = actual.readFile
  fsMocks.readFile.mockImplementation(actual.readFile)
  fsMocks.readdir.mockImplementation(actual.readdir)
  return {...actual, readFile: fsMocks.readFile, readdir: fsMocks.readdir}
})

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
      // Production never yields a null author for a comment event: the context
      // builders always populate one, defaulting a missing association to 'NONE'.
      // Surface derivation fails closed on a null author, so a realistic
      // authorized commenter is required to exercise the review-permitted path.
      author: {login: 'maintainer', association: 'MEMBER', isBot: false},
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
  readonly getIssue?: () => unknown
  readonly listComments?: () => unknown
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
  const defaultIssue = {data: {title: 'Title', body: 'Body', user: {login: 'someone'}}}
  const defaultComments = {data: []}

  return {
    rest: {
      issues: {
        createComment: vi.fn().mockResolvedValue(overrides?.createComment?.() ?? defaultComment),
        get: vi.fn().mockResolvedValue(overrides?.getIssue?.() ?? defaultIssue),
        listComments: vi.fn().mockResolvedValue(overrides?.listComments?.() ?? defaultComments),
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

async function createMissingResponsePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-missing-'))
  await fs.rm(dir, {recursive: true, force: true})
  return path.join(dir, 'expected-response.md')
}

function routeMention(
  overrides: Parameters<typeof createIssueCommentCreatedEvent>[0],
  config: Parameters<typeof routeEvent>[2] = {},
) {
  const payload = createIssueCommentCreatedEvent({
    isPullRequest: true,
    commentBody: '@fro-bot review this PR',
    ...overrides,
  })
  return routeEvent(createMockGitHubContext('issue_comment', payload), createMockLogger(), {
    botLogin: 'fro-bot',
    ...config,
  })
}

describe('mention review authorization coupling', () => {
  it('skips an unauthorized PR mention at the routing boundary before execution', () => {
    // #given a real issue_comment payload from an unauthorized contributor
    // #when the production routing entry point evaluates the event
    const result = routeMention({authorAssociation: 'CONTRIBUTOR'})

    // #then execution is skipped before any response-post path can be reached
    expect(result).toMatchObject({shouldProcess: false, skipReason: 'unauthorized_author'})
    expect(result.context.target?.kind).toBe('pr')
  })

  it('skips a bot-authored PR mention at the routing boundary before execution', () => {
    // #given a real issue_comment payload authored by a bot
    // #when the production routing entry point evaluates the event
    const result = routeMention({isBotComment: true})

    // #then bot rejection wins before response delivery can run
    expect(result).toMatchObject({shouldProcess: false, skipReason: 'self_comment'})
  })

  it('allows a trusted PR mention and derives the review-permitted surface', () => {
    // #given a real issue_comment payload from an allowed repository member
    // #when the production routing entry point evaluates the event
    const result = routeMention({authorAssociation: 'MEMBER'})

    // #then the gate admits the run and the trusted context reaches the permitted review surface
    expect(result.shouldProcess).toBe(true)
    expect(result.context.target?.kind).toBe('pr')
    expect(resolveResponseSurface({issueType: 'pr'}, result.context)).toBe('pr-review-permitted')
  })

  it('skips a trusted PR comment without a mention when mention routing is required', () => {
    // #given a trusted PR comment with no bot mention and the production mention requirement enabled
    const result = routeMention(
      {authorAssociation: 'MEMBER', commentBody: 'please review this'},
      {requireMention: true},
    )

    // #then the real router rejects it before the permitted review surface can be reached
    expect(result).toMatchObject({shouldProcess: false, skipReason: 'no_mention'})
  })
})

describe('readAndParseResponseFile read failures', () => {
  let logger: Logger
  let tempFiles: string[] = []

  beforeEach(() => {
    logger = createMockLogger()
    tempFiles = []
    fsMocks.readFile.mockReset().mockRejectedValue(new Error('read failed'))
    fsMocks.readdir.mockClear()
  })

  afterEach(async () => {
    for (const filePath of tempFiles) {
      await fs.rm(path.dirname(filePath), {recursive: true, force: true})
    }
  })

  it('logs a missing directory without changing the read failure result', async () => {
    // #given a response path whose run-scoped directory is missing
    const responseFilePath = await createMissingResponsePath()
    tempFiles.push(responseFilePath)

    // #when reading the response file after a successful execution
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        executionSucceeded: true,
      },
      logger,
    )

    // #then the missing-directory state and original failure are logged without the filename
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'read failed'})
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Response-post: failed to read response file', {
      responseFileDirectory: path.dirname(responseFilePath),
      error: 'read failed',
      directoryStatus: 'missing',
      directoryEntriesObserved: null,
      directoryEntriesTruncated: false,
      directoryEntries: [],
      directoryDiagnostics: {
        [path.dirname(responseFilePath)]: {
          directoryStatus: 'missing',
          directoryEntriesObserved: null,
          directoryEntriesTruncated: false,
          directoryEntries: [],
        },
      },
    })
  })

  it('logs an empty present directory and keeps failed-execution read failures at debug', async () => {
    // #given a present but empty run-scoped directory
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-empty-'))
    const responseFilePath = path.join(dir, 'expected-response.md')
    tempFiles.push(responseFilePath)

    // #when reading the response file after a failed execution
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        executionSucceeded: false,
      },
      logger,
    )

    // #then the empty-directory state is logged at debug and the failure contract is unchanged
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'read failed'})
    expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
      'Response-post: no response file after failed execution (expected)',
      {
        responseFileDirectory: path.dirname(responseFilePath),
        error: 'read failed',
        directoryStatus: 'empty',
        directoryEntriesObserved: 0,
        directoryEntriesTruncated: false,
        directoryEntries: [],
        directoryDiagnostics: {
          [path.dirname(responseFilePath)]: {
            directoryStatus: 'empty',
            directoryEntriesObserved: 0,
            directoryEntriesTruncated: false,
            directoryEntries: [],
          },
        },
      },
    )
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled()
  })

  it('logs capped entry names and signals truncation without materializing the full listing', async () => {
    // #given a run-scoped directory containing more entries than the diagnostic cap
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-entries-'))
    const responseFilePath = path.join(dir, 'expected-response.md')
    tempFiles.push(responseFilePath)
    const entryNames = Array.from({length: 25}, (_, index) => `near-miss-${String(index).padStart(2, '0')}.md`)
    for (const entryName of entryNames) {
      await fs.writeFile(path.join(dir, entryName), `secret content for ${entryName}`, 'utf8')
    }

    // #when reading the response file after a successful execution
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        executionSucceeded: true,
      },
      logger,
    )

    // #then only names are logged, the listing is capped, and no entry contents are read
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'read failed'})
    expect(fsMocks.readFile).toHaveBeenCalledExactlyOnceWith(responseFilePath, 'utf8')
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Response-post: failed to read response file',
      expect.objectContaining({
        responseFileDirectory: path.dirname(responseFilePath),
        error: 'read failed',
        directoryStatus: 'present',
        directoryEntriesObserved: 20,
        directoryEntriesTruncated: true,
      }),
    )
    const [, payload] = vi.mocked(logger.error).mock.calls[0] as [
      string,
      {readonly directoryEntries: readonly string[]},
    ]
    expect(payload.directoryEntries).toHaveLength(20)
    expect(payload.directoryEntries.every(entry => entryNames.includes(entry))).toBe(true)
    expect(fsMocks.readdir).not.toHaveBeenCalled()
    expect(JSON.stringify(payload)).not.toContain('secret content')
  })

  it('redacts a candidate filename when its directory is listable', async () => {
    // #given a listable response directory containing the nonce-named response file
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-listable-'))
    const responseFilePath = path.join(dir, 'secret-nonce-response.md')
    tempFiles.push(responseFilePath)
    await fs.writeFile(responseFilePath, 'response content', 'utf8')
    const error = Object.assign(new Error('missing'), {code: 'ENOENT'})
    fsMocks.readFile.mockReset().mockRejectedValue(error)

    // #when reading the response file while the directory diagnostic runs
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        executionSucceeded: true,
      },
      logger,
    )

    // #then the nonce is absent from every log payload and the listing remains bounded
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'missing'})
    const [, payload] = vi.mocked(logger.error).mock.calls[0] as [
      string,
      {readonly directoryEntries: readonly string[]},
    ]
    expect(payload.directoryEntries).toEqual(['<filename-redacted>'])
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('secret-nonce-response')
  })

  it('inspects every candidate parent directory when the primary read fails', async () => {
    // #given a missing primary path and two distinct fallback directories containing near misses
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-primary-'))
    const firstFallbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-first-fallback-'))
    const secondFallbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-second-fallback-'))
    const responseFilePath = path.join(primaryDir, 'expected-response.md')
    const firstFallbackPath = path.join(firstFallbackDir, 'first-fallback-response.md')
    const secondFallbackPath = path.join(secondFallbackDir, 'second-fallback-response.md')
    tempFiles.push(responseFilePath, firstFallbackPath, secondFallbackPath)
    await fs.writeFile(path.join(firstFallbackDir, 'near-miss-first.md'), 'untrusted content', 'utf8')
    await fs.writeFile(path.join(secondFallbackDir, 'near-miss-second.md'), 'untrusted content', 'utf8')
    const error = Object.assign(new Error('missing'), {code: 'ENOENT'})
    fsMocks.readFile.mockReset().mockRejectedValue(error)

    // #when reading the response file with two fallback candidates
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        responseFilePathCandidates: {
          expectedPath: responseFilePath,
          fallbackPaths: [firstFallbackPath, secondFallbackPath],
        },
        executionSucceeded: true,
      },
      logger,
    )

    // #then diagnostics include all three parent directories without exposing file contents
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'missing'})
    const [, payload] = vi.mocked(logger.error).mock.calls[0] as [string, Record<string, unknown>]
    expect(payload).toMatchObject({
      responseFileDirectory: primaryDir,
      directoryDiagnostics: {
        [primaryDir]: {
          directoryStatus: 'empty',
          directoryEntriesObserved: 0,
          directoryEntriesTruncated: false,
          directoryEntries: [],
        },
        [firstFallbackDir]: {
          directoryStatus: 'present',
          directoryEntriesObserved: 1,
          directoryEntriesTruncated: false,
          directoryEntries: ['near-miss-first.md'],
        },
        [secondFallbackDir]: {
          directoryStatus: 'present',
          directoryEntriesObserved: 1,
          directoryEntriesTruncated: false,
          directoryEntries: ['near-miss-second.md'],
        },
      },
    })
    expect(JSON.stringify(payload)).not.toContain('untrusted content')
  })

  it('recovers from a fallback candidate only after an ENOENT primary failure and warns with sanitized locations', async () => {
    // #given a missing expected artifact and a valid fallback artifact
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-primary-'))
    const fallbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-fallback-'))
    const responseFilePath = path.join(primaryDir, 'expected-secret-nonce.md')
    const fallbackPath = path.join(fallbackDir, 'expected-secret-nonce.md')
    tempFiles.push(responseFilePath, fallbackPath)
    await fs.writeFile(fallbackPath, 'Recovered body', 'utf8')
    const error = Object.assign(new Error('missing'), {code: 'ENOENT'})
    fsMocks.readFile.mockReset().mockImplementation(async (filePath: string) => {
      if (filePath === responseFilePath) {
        throw error
      }
      return fsMocks.actualReadFile?.(filePath, 'utf8')
    })

    // #when reading with the fallback candidate
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        responseFilePathCandidates: {expectedPath: responseFilePath, fallbackPaths: [fallbackPath]},
      },
      logger,
    )

    // #then the body is recovered, the fallback is marked, and the warning omits the nonce
    expect(result).toEqual({
      success: true,
      data: {
        parsed: {body: 'Recovered body'},
        surface: 'issue-comment',
        recoveredFromFallback: true,
        actualResponseFilePath: fallbackPath,
      },
    })
    expect(logger.warning).toHaveBeenCalledWith(
      'Response-post: recovered response file from fallback location',
      expect.objectContaining({expectedResponseDirectory: primaryDir, actualResponseDirectory: fallbackDir}),
    )
    expect(JSON.stringify(vi.mocked(logger.warning).mock.calls)).not.toContain('expected-secret-nonce')
  })

  it('continues after an ENOENT first fallback and recovers from the second fallback', async () => {
    // #given a missing primary artifact, missing first fallback, and valid second fallback
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-primary-'))
    const firstFallbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-first-fallback-'))
    const secondFallbackDir = await fs.mkdtemp(path.join(os.tmpdir(), 'response-post-second-fallback-'))
    const responseFilePath = path.join(primaryDir, 'response.md')
    const firstFallbackPath = path.join(firstFallbackDir, 'response.md')
    const secondFallbackPath = path.join(secondFallbackDir, 'response.md')
    tempFiles.push(responseFilePath, firstFallbackPath, secondFallbackPath)
    await fs.writeFile(secondFallbackPath, 'Recovered from second fallback', 'utf8')
    const missing = Object.assign(new Error('missing'), {code: 'ENOENT'})
    fsMocks.readFile.mockReset().mockImplementation(async (filePath: string) => {
      if (filePath === responseFilePath || filePath === firstFallbackPath) {
        throw missing
      }
      return fsMocks.actualReadFile?.(filePath, 'utf8')
    })

    // #when reading with both ordered fallback candidates
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        responseFilePathCandidates: {
          expectedPath: responseFilePath,
          fallbackPaths: [firstFallbackPath, secondFallbackPath],
        },
      },
      logger,
    )

    // #then the second fallback is recovered and the actual path is returned
    expect(result).toEqual({
      success: true,
      data: {
        parsed: {body: 'Recovered from second fallback'},
        surface: 'issue-comment',
        recoveredFromFallback: true,
        actualResponseFilePath: secondFallbackPath,
      },
    })
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, responseFilePath, 'utf8')
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(2, firstFallbackPath, 'utf8')
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(3, secondFallbackPath, 'utf8')
  })

  it('does not probe fallback candidates for a non-ENOENT primary read error', async () => {
    // #given a primary read failure that is not a missing-file error
    const responseFilePath = '/tmp/primary/response.md'
    const fallbackPath = '/tmp/fallback/response.md'
    const error = Object.assign(new Error('permission denied'), {code: 'EACCES'})
    fsMocks.readFile.mockReset().mockRejectedValue(error)

    // #when reading with a fallback candidate
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        responseFilePathCandidates: {expectedPath: responseFilePath, fallbackPaths: [fallbackPath]},
      },
      logger,
    )

    // #then only the primary path was probed and the original failure is returned
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'permission denied'})
    expect(fsMocks.readFile).toHaveBeenCalledExactlyOnceWith(responseFilePath, 'utf8')
  })

  it('stops probing after a non-ENOENT first fallback read error', async () => {
    // #given a missing primary artifact and a denied first fallback
    const responseFilePath = '/tmp/primary/response.md'
    const firstFallbackPath = '/tmp/first-fallback/response.md'
    const secondFallbackPath = '/tmp/second-fallback/response.md'
    const missing = Object.assign(new Error('missing'), {code: 'ENOENT'})
    const denied = Object.assign(new Error('permission denied'), {code: 'EACCES'})
    fsMocks.readFile.mockReset().mockImplementation(async (filePath: string) => {
      if (filePath === responseFilePath) {
        throw missing
      }
      throw denied
    })

    // #when reading with two fallback candidates
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        responseFilePathCandidates: {
          expectedPath: responseFilePath,
          fallbackPaths: [firstFallbackPath, secondFallbackPath],
        },
      },
      logger,
    )

    // #then the non-ENOENT error stops probing and is returned
    expect(result).toEqual({delivered: false, reason: 'file-read-failed', detail: 'permission denied'})
    expect(fsMocks.readFile).toHaveBeenCalledTimes(2)
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(1, responseFilePath, 'utf8')
    expect(fsMocks.readFile).toHaveBeenNthCalledWith(2, firstFallbackPath, 'utf8')
  })
})

describe('runResponsePost', () => {
  let logger: Logger
  let tempFiles: string[] = []

  beforeEach(() => {
    logger = createMockLogger()
    tempFiles = []
    if (fsMocks.actualReadFile !== undefined) {
      fsMocks.readFile.mockReset().mockImplementation(fsMocks.actualReadFile)
    }
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
        deliveryFooter: '### Brokered push delivered\n- Branch: `feature/fix`',
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

  it.each([
    {
      surface: 'issue-comment' as const,
      agentContext: {issueType: 'issue' as const, issueNumber: 42},
      eventType: 'issue_comment' as const,
    },
    {
      surface: 'pr-comment' as const,
      agentContext: {issueType: 'pr' as const, issueNumber: 42},
      eventType: 'pull_request_review_comment' as const,
    },
  ])('drops verdict frontmatter and posts the body on the $surface surface', async scenario => {
    // #given a response with review verdict frontmatter on a comment surface
    const filePath = await writeFixture('---\nverdict: approve\n---\nBody without frontmatter residue.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext(scenario.agentContext),
        triggerResult: makeTriggerResult(scenario.eventType),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the prose is delivered as a comment and the misplaced verdict is visible in logs
    expect(result).toEqual({delivered: true, kind: 'comment'})
    const commentRequest = octokit.rest.issues.createComment.mock.calls[0]?.[0] as {readonly body: string}
    expect(commentRequest.body).toContain('Body without frontmatter residue.')
    expect(commentRequest.body).not.toContain('verdict:')
    expect(commentRequest.body).not.toContain('---')
    expect(logger.warning).toHaveBeenCalledWith(
      `Response-post: dropped verdict on "${scenario.surface}" surface; posting response body as a comment`,
      {surface: scenario.surface},
    )
  })

  it('appends a trusted delivery footer after the model body and before response markers', async () => {
    // #given a valid comment response and an action-generated delivery footer
    const filePath = await writeFixture('Body from the model.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()
    const deliveryFooter = '### Brokered push delivered\n- Branch: `feature/fix`\n- Changed paths: `src/fix.ts`'

    // #when running response-post with the footer
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'issue', issueNumber: 42}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
        deliveryFooter,
      },
      logger,
    )

    // #then the single comment contains the model body, footer, and markers in order
    expect(result).toEqual({delivered: true, kind: 'comment'})
    const request = octokit.rest.issues.createComment.mock.calls[0]?.[0] as {readonly body: string}
    expect(request.body).toContain('Body from the model.')
    expect(request.body).toContain(deliveryFooter)
    expect(request.body.indexOf(deliveryFooter)).toBeLessThan(request.body.indexOf(BOT_COMMENT_MARKER))
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
        deliveryFooter: '### Brokered push delivered\n- Branch: `feature/fix`',
      },
      logger,
    )

    // #then submitReview is called with REQUEST_CHANGES via createReview
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'REQUEST_CHANGES', pull_number: 7, commit_id: 'head-sha'}),
    )
    const request = octokit.rest.pulls.createReview.mock.calls[0]?.[0] as {readonly body: string}
    expect(request.body).toContain('Brokered push delivered')
  })

  it('submits a fallback-sourced approving verdict as a non-approving COMMENT review', async () => {
    // #given an approving response recovered from the fallback candidate
    const primaryPath = await createMissingResponsePath()
    const fallbackPath = await writeFixture('---\nverdict: approve\n---\n\nRecovered approval.')
    tempFiles.push(primaryPath, fallbackPath)
    const octokit = makeOctokit()

    // #when posting with the fallback candidate
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: primaryPath,
        responseFilePathCandidates: {expectedPath: primaryPath, fallbackPaths: [fallbackPath]},
      },
      logger,
    )

    // #then content is delivered without an approving review event
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'COMMENT', pull_number: 7, commit_id: 'head-sha'}),
    )
    expect(logger.warning).toHaveBeenCalledWith(
      'Response-post: withholding approving verdict from fallback response artifact',
      expect.objectContaining({
        expectedResponseDirectory: path.dirname(primaryPath),
        actualResponsePath: path.join(path.dirname(fallbackPath), '<filename-redacted>'),
        actualResponseDirectory: path.dirname(fallbackPath),
      }),
    )
  })

  it('downgrades an approving verdict recovered from the second fallback', async () => {
    // #given an approving response recovered from the second fallback candidate
    const primaryPath = await createMissingResponsePath()
    const firstFallbackPath = await createMissingResponsePath()
    const secondFallbackPath = await writeFixture('---\nverdict: approve\n---\n\nRecovered approval.')
    tempFiles.push(primaryPath, firstFallbackPath, secondFallbackPath)
    const octokit = makeOctokit()

    // #when posting with both ordered fallback candidates
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: primaryPath,
        responseFilePathCandidates: {expectedPath: primaryPath, fallbackPaths: [firstFallbackPath, secondFallbackPath]},
      },
      logger,
    )

    // #then the second fallback is delivered without an approving review event
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'COMMENT', pull_number: 7, commit_id: 'head-sha'}),
    )
  })

  it('keeps a primary-sourced approving verdict as an APPROVE review', async () => {
    // #given an approving response at the expected path
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when posting from the primary candidate
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
        responseFilePathCandidates: {expectedPath: filePath, fallbackPaths: ['/tmp/unused-fallback.md']},
      },
      logger,
    )

    // #then the normal approving path is unchanged
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE', pull_number: 7, commit_id: 'head-sha'}),
    )
    expect(fsMocks.readFile).toHaveBeenCalledExactlyOnceWith(filePath, 'utf8')
    expect(logger.warning).not.toHaveBeenCalled()
  })

  it('passes a fallback-sourced non-approving verdict through unchanged', async () => {
    // #given a request-changes response recovered from a fallback path
    const primaryPath = await createMissingResponsePath()
    const fallbackPath = await writeFixture('---\nverdict: request-changes\n---\n\nPlease fix X.')
    tempFiles.push(primaryPath, fallbackPath)
    const octokit = makeOctokit()

    // #when posting with the fallback candidate
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: primaryPath,
        responseFilePathCandidates: {expectedPath: primaryPath, fallbackPaths: [fallbackPath]},
      },
      logger,
    )

    // #then REQUEST_CHANGES remains unchanged
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'REQUEST_CHANGES', pull_number: 7, commit_id: 'head-sha'}),
    )
  })

  it('fails closed for a fallback-sourced pr-review artifact with no verdict frontmatter', async () => {
    // #given a response recovered from the fallback path without review verdict frontmatter
    const primaryPath = await createMissingResponsePath()
    const fallbackPath = await writeFixture('Recovered review body without a verdict.')
    tempFiles.push(primaryPath, fallbackPath)
    const octokit = makeOctokit()

    // #when posting the fallback response for a pull_request trigger
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: primaryPath,
        responseFilePathCandidates: {expectedPath: primaryPath, fallbackPaths: [fallbackPath]},
      },
      logger,
    )

    // #then no review or comment is submitted
    expect(result).toEqual({
      delivered: false,
      reason: 'missing-verdict',
      detail: 'pull_request responses must carry a verdict frontmatter',
    })
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
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
        deliveryFooter: '### Brokered push delivered\n- Branch: `feature/fix`',
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
    expect(logger.warning).toHaveBeenCalledWith(
      'Response-post: review guard blocked the verdict, no review submitted',
      {reason: 'self-or-fork', prNumber: 7},
    )
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

  it('logs an expected missing response file at debug level after a failed execution', async () => {
    // #given a failed execution whose response file was never created
    const responseFilePath = '/nonexistent/path/response.md'

    // #when reading the response file with the failed-execution context
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        executionSucceeded: false,
      },
      logger,
    )

    // #then the typed failure is preserved without emitting a noisy error log
    expect(result).toMatchObject({delivered: false, reason: 'file-read-failed'})
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      'Response-post: no response file after failed execution (expected)',
      expect.objectContaining({responseFileDirectory: path.dirname(responseFilePath)}),
    )
  })

  it('keeps the response-file read error log for a successful execution', async () => {
    // #given a successful execution whose response file is unexpectedly absent
    const responseFilePath = '/nonexistent/path/response.md'

    // #when reading the response file with the successful-execution context
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
        executionSucceeded: true,
      },
      logger,
    )

    // #then the typed failure and genuine read error remain visible
    expect(result).toMatchObject({delivered: false, reason: 'file-read-failed'})
    expect(logger.error).toHaveBeenCalledWith(
      'Response-post: failed to read response file',
      expect.objectContaining({responseFileDirectory: path.dirname(responseFilePath)}),
    )
    expect(logger.debug).not.toHaveBeenCalledWith(
      'Response-post: no response file after failed execution (expected)',
      expect.anything(),
    )
  })

  it('redacts the response nonce from read-error logs', async () => {
    // #given a missing response path containing a secret nonce
    const responseFilePath = '/nonexistent/secret-nonce-123.md'

    // #when reading the missing response file
    const result = await readAndParseResponseFile(
      {
        agentContext: makeAgentContext(),
        triggerResult: makeTriggerResult('issue_comment'),
        responseFilePath,
      },
      logger,
    )

    // #then the failure remains typed and no log payload contains the nonce
    expect(result).toMatchObject({delivered: false, reason: 'file-read-failed'})
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('secret-nonce-123')
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

  it('does not probe on the first attempt (only creates)', async () => {
    // #given a valid response file that posts successfully on the first attempt
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

    // #then delivery succeeds and the probe (listComments/get) is never invoked
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledOnce()
    expect(octokit.rest.issues.get).not.toHaveBeenCalled()
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled()
  })

  it("treats an ambiguous failure as delivered when the probe finds this run's marker", async () => {
    // #given the first create attempt throws (ambiguous failure), but the comment actually landed
    process.env.GITHUB_RUN_ID = '999'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    const filePath = await writeFixture('Body from the model.')
    tempFiles.push(filePath)
    const octokit = makeOctokit({
      listComments: () => ({
        data: [
          {
            id: 5,
            body: `Body from the model.\n<!-- fro-bot-agent -->\n<!-- fro-bot-response:999-1 -->`,
            user: {login: 'fro-bot[bot]'},
            author_association: 'NONE',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      }),
    })
    octokit.rest.issues.createComment.mockRejectedValueOnce(new Error('network blip'))

    try {
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

      // #then the probe finds this run's marker and delivery succeeds without a second create
      expect(result).toEqual({delivered: true, kind: 'comment'})
      expect(octokit.rest.issues.createComment).toHaveBeenCalledOnce()
      expect(octokit.rest.issues.listComments).toHaveBeenCalled()
    } finally {
      delete process.env.GITHUB_RUN_ID
      delete process.env.GITHUB_RUN_ATTEMPT
    }
  })

  it("creates a new comment when the probe only finds a previous run's marker comment", async () => {
    // #given a previous run's response comment exists (different run id), and this run's create ambiguously fails once
    process.env.GITHUB_RUN_ID = '999'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    const filePath = await writeFixture('Body from the model.')
    tempFiles.push(filePath)
    const octokit = makeOctokit({
      listComments: () => ({
        data: [
          {
            id: 5,
            body: `Old response.\n<!-- fro-bot-agent -->\n<!-- fro-bot-response:111-1 -->`,
            user: {login: 'fro-bot[bot]'},
            author_association: 'NONE',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      }),
    })
    octokit.rest.issues.createComment.mockRejectedValueOnce(new Error('network blip'))

    try {
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

      // #then the previous run's marker does not satisfy the probe, so a new comment is created
      expect(result).toEqual({delivered: true, kind: 'comment'})
      expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2)
    } finally {
      delete process.env.GITHUB_RUN_ID
      delete process.env.GITHUB_RUN_ATTEMPT
    }
  })

  it('resolves issue_comment on a PR to the review-permitted surface without requiring a verdict', async () => {
    // #given an issue_comment trigger on a PR with a response file that has no verdict frontmatter
    const filePath = await writeFixture('Body from the model.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running the response-post orchestration
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then it is delivered as a comment on the PR number, no verdict required
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        issue_number: 7,
        body: expect.stringContaining('Body from the model.') as unknown as string,
      }),
    )
  })

  it('submits an APPROVE review for a verdict on a review-permitted mention surface', async () => {
    // #given an approving response file from an authorized PR mention
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for an issue_comment on a PR
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
        deliveryFooter: '### Brokered push delivered\n- Branch: `feature/fix`',
      },
      logger,
    )

    // #then the shared guards submit an APPROVE pinned to the observed head
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({event: 'APPROVE', owner: 'owner', repo: 'repo', pull_number: 7, commit_id: 'head-sha'}),
    )
    const request = octokit.rest.pulls.createReview.mock.calls[0]?.[0] as {readonly body: string}
    expect(request.body).toContain('### Brokered push delivered\n- Branch: `feature/fix`')
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it('degrades to a comment when the bot login is unavailable on the permitted surface', async () => {
    // #given a valid approving response but no bot login for review submission
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post on a review-permitted surface
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'issue_comment', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: null,
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the response is delivered as a comment rather than discarded
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalledWith('Response-post: verdict could not be submitted; degrading to comment', {
      surface: 'pr-review-permitted',
      reason: 'missing-target-context',
    })
  })

  it('fails closed when the bot login is unavailable on the required review surface', async () => {
    // #given a valid approving response but no bot login for review submission
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post on a review-required surface
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: null,
        responseFilePath: filePath,
      },
      logger,
    )

    // #then nothing is posted: a required review must never silently become a comment
    expect(result).toEqual({
      delivered: false,
      reason: 'missing-target-context',
      detail: 'Cannot submit a review: bot login is unavailable',
    })
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('degrades an invalid verdict on the permitted review surface to a comment', async () => {
    // #given a permitted-surface response with a verdict value the parser cannot accept
    const filePath = await writeFixture('---\nverdict: lgtm\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for an issue_comment on a PR
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the unparseable verdict is not accepted, but its validated prose is delivered as a comment
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({body: expect.stringContaining('LGTM.') as unknown as string}),
    )
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalledWith(
      'Response-post: invalid verdict on permitted surface; posting response body as a comment',
      {surface: 'pr-review-permitted', reason: 'unknown-verdict'},
    )
  })

  it('fails closed for an invalid verdict on the required review surface', async () => {
    // #given a required review response with a verdict value the parser cannot accept
    const filePath = await writeFixture('---\nverdict: lgtm\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for a pull_request trigger
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the malformed verdict remains a parse failure with no delivery
    expect(result).toEqual({delivered: false, reason: 'parse-failed', detail: 'Unknown verdict value: "lgtm"'})
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('degrades an empty verdict on the permitted review surface to a comment', async () => {
    // #given a permitted-surface response with an empty verdict value
    const filePath = await writeFixture('---\nverdict:\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for an issue_comment on a PR
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the unparseable verdict is not accepted, but its prose is delivered as a comment
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(octokit.rest.issues.createComment).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({body: expect.stringContaining('LGTM.') as unknown as string}),
    )
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(logger.warning).toHaveBeenCalledWith(
      'Response-post: invalid verdict on permitted surface; posting response body as a comment',
      {surface: 'pr-review-permitted', reason: 'missing-verdict-value'},
    )
  })

  it('fails closed for an empty verdict on the required review surface', async () => {
    // #given a required review response with an empty verdict value
    const filePath = await writeFixture('---\nverdict:\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for a pull_request trigger
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the malformed verdict remains a parse failure with no delivery
    expect(result).toEqual({
      delivered: false,
      reason: 'parse-failed',
      detail: 'Frontmatter "verdict" key has no value',
    })
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it('keeps a required pull_request review fail-closed when its verdict is missing', async () => {
    // #given a pull_request response file with no verdict frontmatter
    const filePath = await writeFixture('Review body without a verdict.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for the review-required surface
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then no comment or review is posted and the required verdict is reported missing
    expect(result).toEqual({
      delivered: false,
      reason: 'missing-verdict',
      detail: 'pull_request responses must carry a verdict frontmatter',
    })
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
  })

  it('degrades a guard-blocked approving mention review on a fork to a comment', async () => {
    // #given an approving mention response and a fork PR
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

    // #when running response-post for an issue_comment on that PR
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the shared fork guard blocks APPROVE and the permitted surface delivers the body as a comment
    expect(result).toEqual({delivered: true, kind: 'comment'})
    expect(logger.warning).toHaveBeenCalledWith(
      'Response-post: review guard blocked the verdict; degrading to comment',
      {reason: 'self-or-fork', prNumber: 7, surface: 'pr-review-permitted'},
    )
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  it('blocks an approving required review on a self-authored PR through the existing guard', async () => {
    // #given an approving pull_request response and a PR authored by the bot
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit({
      getPR: () => ({
        data: {
          head: {sha: 'head-sha', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'fro-bot[bot]'},
        },
      }),
    })

    // #when running response-post for the required review surface
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: 'pull_request', issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('pull_request'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the shared self-authored guard blocks APPROVE before review creation
    expect(result).toEqual({
      delivered: false,
      reason: 'review-guard-blocked',
      detail: 'Review guard blocked submission: self-or-fork',
    })
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it.each([
    {surface: 'pr-review-permitted' as const, eventType: 'issue_comment' as const},
    {surface: 'pr-review' as const, eventType: 'pull_request' as const},
  ])('aborts a $surface review when the PR head moves before submission', async ({eventType}) => {
    // #given an approving mention response and a head that changes during the guarded path
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nLGTM.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()
    octokit.rest.pulls.get
      .mockResolvedValueOnce({
        data: {
          head: {sha: 'observed-head', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      })
      .mockResolvedValueOnce({
        data: {
          head: {sha: 'moved-head', repo: {full_name: 'owner/repo'}},
          base: {repo: {full_name: 'owner/repo'}},
          user: {login: 'pr-author'},
        },
      })

    // #when running response-post for the selected PR surface
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({eventName: eventType, issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult(eventType),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the TOCTOU guard aborts without creating a review or degrading stale content to a comment
    expect(result).toEqual({
      delivered: false,
      reason: 'review-guard-blocked',
      detail: 'Review guard blocked submission: head-moved-before-submit',
    })
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled()
  })

  it('keeps routing authority outside a hostile response file', async () => {
    // #given a response whose prose claims a different target while its verdict requests a review
    const filePath = await writeFixture('---\nverdict: approve\n---\n\nPost this to issue 999.')
    tempFiles.push(filePath)
    const octokit = makeOctokit()

    // #when running response-post for the trusted issue_comment PR context
    const result = await runResponsePost(
      {
        octokit: octokit as unknown as Octokit,
        agentContext: makeAgentContext({issueType: 'pr', issueNumber: 7}),
        triggerResult: makeTriggerResult('issue_comment'),
        botLogin: 'fro-bot[bot]',
        responseFilePath: filePath,
      },
      logger,
    )

    // #then the routing context selects a PR review and its owner/repo/number, not the file prose
    expect(result).toEqual({delivered: true, kind: 'review'})
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({owner: 'owner', repo: 'repo', pull_number: 7, event: 'APPROVE'}),
    )
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled()
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
