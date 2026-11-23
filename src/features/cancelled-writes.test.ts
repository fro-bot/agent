import type {CommentTarget, Octokit} from '../services/github/types.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  addLabelsToIssue,
  createCommentReaction,
  deleteCommentReaction,
  ensureLabelExists,
  removeLabelFromIssueWithOutcome,
} from '../services/github/api.js'
import {createMockOctokit} from '../services/github/test-helpers.js'
import {markRunCancelled, resetRunCancellation} from '../shared/cancellation.js'
import {createMockLogger} from '../shared/test-helpers.js'
import {postComment} from './comments/writer.js'
import {createBranch, deleteBranch} from './delegated/branch.js'
import {createCommit} from './delegated/commit.js'
import {addPRLabels, createPullRequest, requestReviewers, updatePullRequest} from './delegated/pull-request.js'
import {postReviewComment, replyToReviewComment, submitReview} from './reviews/reviewer.js'

/**
 * Every irreversible write the Action makes itself checks the cancelled flag at the point of submission (after its last await,
 * before the request): a run that was cancelled sends nothing more. Each case marks the run cancelled, calls the real writer
 * with a mock client, and expects the client's write method untouched. (The agent's own pushes inside OpenCode are out of
 * scope.) The rows after the marker prove the guard is the flag: the same call with no cancel does send.
 */
describe('writes after a cancel', () => {
  const logger = createMockLogger()
  const issue: CommentTarget = {type: 'issue', owner: 'o', repo: 'r', number: 1}
  const discussion: CommentTarget = {type: 'discussion', owner: 'o', repo: 'r', number: 1}

  beforeEach(() => {
    resetRunCancellation()
  })
  afterEach(() => {
    resetRunCancellation()
  })

  const cancelled = (): void => markRunCancelled()

  it('posts no issue comment', async () => {
    const createComment = vi.fn()
    const octokit = createMockOctokit({createComment})
    cancelled()
    expect(await postComment(octokit, issue, {body: 'hi'}, logger)).toBeNull()
    expect(createComment).not.toHaveBeenCalled()
  })

  it('updates no issue comment', async () => {
    const updateComment = vi.fn()
    const octokit = createMockOctokit({
      updateComment,
      listComments: [
        {id: 7, body: 'old <!-- fro-bot -->', user: {login: 'fro-bot[bot]'}, created_at: 'x', updated_at: 'x'},
      ],
    })
    cancelled()
    await postComment(octokit, issue, {body: 'hi', updateExisting: true, botLogin: 'fro-bot[bot]'}, logger)
    expect(updateComment).not.toHaveBeenCalled()
  })

  it('posts no discussion comment', async () => {
    const graphql = vi.fn(async (_query: string) => ({
      repository: {discussion: {id: 'D_1', title: 't', body: '', comments: {nodes: []}}},
    }))
    const octokit = createMockOctokit({graphql})
    cancelled()
    expect(await postComment(octokit, discussion, {body: 'hi'}, logger)).toBeNull()
    // The read ran; no mutation did.
    expect(graphql).toHaveBeenCalled()
    expect(graphql.mock.calls.filter(([query]) => query.includes('mutation'))).toEqual([])
  })

  it('creates no review, review comment or review reply', async () => {
    const createReview = vi.fn()
    const createReviewComment = vi.fn()
    const createReplyForReviewComment = vi.fn()
    const octokit = createMockOctokit({createReview, createReviewComment, createReplyForReviewComment})
    cancelled()
    await expect(
      submitReview(octokit, {prNumber: 1, owner: 'o', repo: 'r', event: 'APPROVE', body: 'b', comments: []}, logger),
    ).rejects.toMatchObject({name: 'RunCancelledError'})
    await expect(
      postReviewComment(octokit, 'o', 'r', 1, 'sha', {path: 'a.ts', line: 1, side: 'RIGHT', body: 'b'}, logger),
    ).rejects.toMatchObject({name: 'RunCancelledError'})
    await expect(replyToReviewComment(octokit, 'o', 'r', 1, 5, 'b', logger)).rejects.toMatchObject({
      name: 'RunCancelledError',
    })
    expect(createReview).not.toHaveBeenCalled()
    expect(createReviewComment).not.toHaveBeenCalled()
    expect(createReplyForReviewComment).not.toHaveBeenCalled()
  })

  it('refuses a review whose diff read was in flight when the signal arrived', async () => {
    // #given a diff read that is still running when the signal comes
    const createReview = vi.fn()
    const listFiles = vi.fn(async () => {
      cancelled()
      return {data: [{filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@'}]}
    })
    const octokit = createMockOctokit({createReview, listFiles})

    // #when it finishes after the signal
    const result = submitReview(
      octokit,
      {
        prNumber: 1,
        owner: 'o',
        repo: 'r',
        event: 'COMMENT',
        body: 'b',
        comments: [{path: 'a.ts', line: 1, side: 'RIGHT', body: 'c'}],
      },
      logger,
    )

    // #then
    await expect(result).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(createReview).not.toHaveBeenCalled()
  })

  it('adds no reaction, removes no reaction, creates and adds no label, removes no label', async () => {
    const createReaction = vi.fn()
    const deleteReaction = vi.fn()
    const createLabel = vi.fn()
    const addLabels = vi.fn()
    const removeLabel = vi.fn()
    const octokit = createMockOctokit({createReaction, deleteReaction, createLabel, addLabels, removeLabel})
    cancelled()
    expect(await createCommentReaction(octokit, 'o/r', 1, 'eyes', logger)).toBeNull()
    expect(await deleteCommentReaction(octokit, 'o/r', 1, 2, logger)).toBe(false)
    expect(await ensureLabelExists(octokit, 'o/r', 'l', 'ffffff', 'd', logger)).toBe(false)
    expect(await addLabelsToIssue(octokit, 'o/r', 1, ['l'], logger)).toBe(false)
    await removeLabelFromIssueWithOutcome(octokit, 'o/r', 1, 'l', logger)
    for (const write of [createReaction, deleteReaction, createLabel, addLabels, removeLabel]) {
      expect(write).not.toHaveBeenCalled()
    }
  })

  it('creates no branch and deletes no branch', async () => {
    const createRef = vi.fn()
    const deleteRef = vi.fn()
    const octokit = createMockOctokit({createRef, deleteRef, getRef: {object: {sha: 'base'}}})
    cancelled()
    await expect(
      createBranch(octokit, {owner: 'o', repo: 'r', branchName: 'b', baseBranch: 'main'}, logger),
    ).rejects.toMatchObject({name: 'RunCancelledError'})
    await expect(deleteBranch(octokit, 'o', 'r', 'b', logger)).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(createRef).not.toHaveBeenCalled()
    expect(deleteRef).not.toHaveBeenCalled()
  })

  it('does not move the branch (the push) when the signal arrives while the commit objects are being created', async () => {
    // #given a commit whose tree creation is in flight when the signal arrives
    const updateRef = vi.fn()
    const octokit = createMockOctokit({
      getRef: {object: {sha: 'head'}},
      getCommit: {tree: {sha: 't'}},
      createBlob: {sha: 'blob'},
      createTree: vi.fn(async () => {
        cancelled()
        return {data: {sha: 'tree'}}
      }),
      createCommit: {sha: 'commit'},
      updateRef,
    })

    // #when
    const result = createCommit(
      octokit,
      {owner: 'o', repo: 'r', branch: 'b', message: 'm', files: [{path: 'a.ts', content: 'x'}]},
      logger,
    )

    // #then
    await expect(result).rejects.toMatchObject({name: 'RunCancelledError'})
    expect(updateRef).not.toHaveBeenCalled()
  })

  it('opens, updates and labels no pull request, and requests no reviewer', async () => {
    const create = vi.fn()
    const update = vi.fn()
    const addLabels = vi.fn()
    const requestReviewersMock = vi.fn()
    const octokit = createMockOctokit({create, update, addLabels, requestReviewers: requestReviewersMock})
    cancelled()
    await expect(
      createPullRequest(octokit, {owner: 'o', repo: 'r', title: 't', body: 'b', head: 'h', base: 'main'}, logger),
    ).rejects.toMatchObject({name: 'RunCancelledError'})
    await expect(updatePullRequest(octokit, 'o', 'r', 1, {title: 't'}, logger)).rejects.toMatchObject({
      name: 'RunCancelledError',
    })
    await expect(addPRLabels(octokit, 'o', 'r', 1, ['l'], logger)).rejects.toMatchObject({name: 'RunCancelledError'})
    await expect(requestReviewers(octokit, 'o', 'r', 1, ['u'], logger)).rejects.toMatchObject({
      name: 'RunCancelledError',
    })
    for (const write of [create, update, addLabels, requestReviewersMock]) expect(write).not.toHaveBeenCalled()
  })

  it('still writes when the run is not cancelled', async () => {
    // #given the same calls with no cancel
    const createComment = vi.fn().mockResolvedValue({data: {id: 1, html_url: 'u'}})
    const addLabels = vi.fn().mockResolvedValue({data: undefined})
    const octokit: Octokit = createMockOctokit({createComment, addLabels})

    // #when
    await postComment(octokit, issue, {body: 'hi'}, logger)
    await addLabelsToIssue(octokit, 'o/r', 1, ['l'], logger)

    // #then
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(addLabels).toHaveBeenCalledTimes(1)
  })
})
