import type {Logger} from '../logger.js'
import type {PRDiff, ReviewComment} from './types.js'
import {describe, expect, it, vi} from 'vitest'
import {
  getReviewComments,
  postReviewComment,
  prepareReviewComments,
  replyToReviewComment,
  submitReview,
} from './reviewer.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

function createMockDiff(files: {filename: string; patch: string | null}[]): PRDiff {
  return {
    files: files.map(f => ({
      filename: f.filename,
      status: 'modified' as const,
      additions: 10,
      deletions: 5,
      patch: f.patch,
      previousFilename: null,
    })),
    additions: files.length * 10,
    deletions: files.length * 5,
    changedFiles: files.length,
    truncated: false,
  }
}

describe('prepareReviewComments', () => {
  it('prepares valid comments for files in diff', () => {
    // #given diff with files and comments for those files
    const diff = createMockDiff([
      {filename: 'src/main.ts', patch: '@@ -1 +1 @@\n-old\n+new'},
      {filename: 'src/utils.ts', patch: '@@ -1 +1 @@\n-old\n+new'},
    ])
    const comments: ReviewComment[] = [
      {path: 'src/main.ts', line: 10, side: 'RIGHT', body: 'Comment 1'},
      {path: 'src/utils.ts', line: 20, side: 'RIGHT', body: 'Comment 2'},
    ]
    const logger = createMockLogger()

    // #when preparing comments
    const result = prepareReviewComments(comments, diff, logger)

    // #then all comments should be ready
    expect(result.ready).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)
  })

  it('skips comments for files not in diff', () => {
    // #given diff without the commented file
    const diff = createMockDiff([{filename: 'src/main.ts', patch: '@@ -1 +1 @@'}])
    const comments: ReviewComment[] = [{path: 'nonexistent.ts', line: 1, side: 'RIGHT', body: 'Comment'}]
    const logger = createMockLogger()

    // #when preparing comments
    const result = prepareReviewComments(comments, diff, logger)

    // #then comment should be skipped with reason
    expect(result.ready).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toBe('file_not_in_diff')
  })

  it('skips comments for files with null patch', () => {
    // #given diff with binary file (no patch)
    const diff = createMockDiff([{filename: 'image.png', patch: null}])
    const comments: ReviewComment[] = [{path: 'image.png', line: 1, side: 'RIGHT', body: 'Comment'}]
    const logger = createMockLogger()

    // #when preparing comments
    const result = prepareReviewComments(comments, diff, logger)

    // #then comment should be skipped with reason
    expect(result.ready).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]!.reason).toBe('patch_missing')
  })

  it('handles multi-line comments with start_line', () => {
    // #given comment with start line
    const diff = createMockDiff([{filename: 'src/main.ts', patch: '@@ -1 +1 @@'}])
    const comments: ReviewComment[] = [
      {path: 'src/main.ts', line: 20, side: 'RIGHT', body: 'Multi-line', startLine: 15, startSide: 'RIGHT'},
    ]
    const logger = createMockLogger()

    // #when preparing comments
    const result = prepareReviewComments(comments, diff, logger)

    // #then should include start_line in output
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0]!.start_line).toBe(15)
    expect(result.ready[0]!.start_side).toBe('RIGHT')
  })

  it('does not include start_line when same as line', () => {
    // #given comment where startLine equals line
    const diff = createMockDiff([{filename: 'src/main.ts', patch: '@@ -1 +1 @@'}])
    const comments: ReviewComment[] = [
      {path: 'src/main.ts', line: 10, side: 'RIGHT', body: 'Single line', startLine: 10},
    ]
    const logger = createMockLogger()

    // #when preparing comments
    const result = prepareReviewComments(comments, diff, logger)

    // #then should not have start_line
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0]!.start_line).toBeUndefined()
  })
})

describe('submitReview', () => {
  it('submits review with comments', async () => {
    // #given mock octokit with diff and review endpoints
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({
            data: [{filename: 'src/main.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@'}],
          }),
          createReview: vi.fn().mockResolvedValue({
            data: {id: 123, state: 'COMMENTED', html_url: 'https://github.com/owner/repo/pull/1#pullrequestreview-123'},
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when submitting review
    const result = await submitReview(
      mockOctokit as never,
      {
        prNumber: 1,
        owner: 'owner',
        repo: 'repo',
        event: 'COMMENT',
        body: 'Review body',
        comments: [{path: 'src/main.ts', line: 10, side: 'RIGHT', body: 'Comment'}],
      },
      logger,
    )

    // #then should return review result
    expect(result.reviewId).toBe(123)
    expect(result.state).toBe('COMMENTED')
    expect(result.commentsPosted).toBe(1)
    expect(result.commentsSkipped).toBe(0)
    expect(mockOctokit.rest.pulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
        event: 'COMMENT',
        body: 'Review body',
      }),
    )
  })

  it('skips comments for files not in diff', async () => {
    // #given mock octokit where file is not in diff
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: vi.fn().mockResolvedValue({data: []}),
          createReview: vi.fn().mockResolvedValue({
            data: {id: 456, state: 'COMMENTED', html_url: ''},
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when submitting review with comment for non-existent file
    const result = await submitReview(
      mockOctokit as never,
      {
        prNumber: 1,
        owner: 'owner',
        repo: 'repo',
        event: 'COMMENT',
        body: 'Review body',
        comments: [{path: 'nonexistent.ts', line: 1, side: 'RIGHT', body: 'Comment'}],
      },
      logger,
    )

    // #then should report skipped comment
    expect(result.commentsPosted).toBe(0)
    expect(result.commentsSkipped).toBe(1)
    expect(logger.warning).toHaveBeenCalled()
  })
})

describe('postReviewComment', () => {
  it('posts single review comment', async () => {
    // #given mock octokit
    const mockOctokit = {
      rest: {
        pulls: {
          createReviewComment: vi.fn().mockResolvedValue({data: {id: 789}}),
        },
      },
    }
    const logger = createMockLogger()

    // #when posting review comment
    const commentId = await postReviewComment(
      mockOctokit as never,
      'owner',
      'repo',
      1,
      'abc123',
      {path: 'src/main.ts', line: 10, side: 'RIGHT', body: 'Single comment'},
      logger,
    )

    // #then should return comment id
    expect(commentId).toBe(789)
    expect(mockOctokit.rest.pulls.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'src/main.ts',
        line: 10,
        side: 'RIGHT',
        body: 'Single comment',
        commit_id: 'abc123',
      }),
    )
  })
})

describe('getReviewComments', () => {
  it('fetches review comments from PR', async () => {
    // #given mock octokit with comments
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [
              {id: 1, path: 'src/main.ts', line: 10, body: 'Comment 1', user: {login: 'user1'}, in_reply_to_id: null},
              {
                id: 2,
                path: 'src/utils.ts',
                original_line: 20,
                body: 'Comment 2',
                user: {login: 'user2'},
                in_reply_to_id: 1,
              },
            ],
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching comments
    const comments = await getReviewComments(mockOctokit as never, 'owner', 'repo', 1, logger)

    // #then should return mapped comments
    expect(comments).toHaveLength(2)
    expect(comments[0]).toEqual({
      id: 1,
      path: 'src/main.ts',
      line: 10,
      body: 'Comment 1',
      author: 'user1',
      inReplyToId: null,
    })
    expect(comments[1]).toEqual({
      id: 2,
      path: 'src/utils.ts',
      line: 20,
      body: 'Comment 2',
      author: 'user2',
      inReplyToId: 1,
    })
  })

  it('handles comments without user', async () => {
    // #given mock octokit with comment missing user
    const mockOctokit = {
      rest: {
        pulls: {
          listReviewComments: vi.fn().mockResolvedValue({
            data: [{id: 1, path: 'file.ts', line: 5, body: 'Comment', user: null, in_reply_to_id: null}],
          }),
        },
      },
    }
    const logger = createMockLogger()

    // #when fetching comments
    const comments = await getReviewComments(mockOctokit as never, 'owner', 'repo', 1, logger)

    // #then should use 'unknown' for missing author
    expect(comments[0]!.author).toBe('unknown')
  })
})

describe('replyToReviewComment', () => {
  it('creates reply to existing comment', async () => {
    // #given mock octokit
    const mockOctokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: vi.fn().mockResolvedValue({data: {id: 999}}),
        },
      },
    }
    const logger = createMockLogger()

    // #when replying to comment
    const replyId = await replyToReviewComment(mockOctokit as never, 'owner', 'repo', 1, 123, 'Reply body', logger)

    // #then should return reply id
    expect(replyId).toBe(999)
    expect(mockOctokit.rest.pulls.createReplyForReviewComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 1,
      comment_id: 123,
      body: 'Reply body',
    })
  })
})
