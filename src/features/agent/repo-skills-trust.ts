import type {NormalizedEvent} from '../../services/github/types.js'
import {ALLOWED_ASSOCIATIONS} from '../../shared/types.js'

/**
 * The `repo-skills` trust predicate (fro-bot/agent#2129): may this run load skills from the repository?
 *
 * Deliberately NOT `resolveResponseDelivery`'s credential disposition. That axis is about whether the model may hold the
 * GitHub token; it admits `pull_request_review_comment`, `discussion_comment` and every future event name by default.
 * This predicate is the opposite: an allow list that denies anything it does not name.
 *
 * It decides WHETHER a run may load repository skills, not where they come from: every eligible run reads a freshly fetched
 * default branch, never the checkout (see `stageDefaultBranchSkills`).
 *
 * Pure and fail-closed. Every fact it needs is a field of `NormalizedEvent` or the one extra fact the caller looked up
 * for `issue_comment` on a pull request (the payload carries no head repository). A missing fact denies.
 */

export type RepoSkillsDenyReason =
  'author-not-trusted' | 'event-not-eligible' | 'fork-pull-request' | 'head-repository-unknown'

export type RepoSkillsTrust =
  {readonly trusted: true} | {readonly trusted: false; readonly reason: RepoSkillsDenyReason}

export interface RepoSkillsTrustInput {
  readonly event: NormalizedEvent
  /** The repository the run executes in, `owner/repo`. */
  readonly repository: string
  /**
   * `head.repo.full_name` from the pull request fetch, for `issue_comment` on a PR only (see
   * `needsPullRequestHeadLookup`). Null when the fetch failed or the head repository no longer exists. Ignored for every
   * other event: a `pull_request` event carries its own head repository and is never rescued by this value.
   */
  readonly lookedUpHeadRepoFullName: string | null
}

const trusted: RepoSkillsTrust = {trusted: true}
const denied = (reason: RepoSkillsDenyReason): RepoSkillsTrust => ({trusted: false, reason})

function isTrustedAssociation(association: string): boolean {
  return (ALLOWED_ASSOCIATIONS as readonly string[]).includes(association)
}

function isSameRepository(headRepoFullName: string, repository: string): boolean {
  // GitHub owner and repository names are case-insensitive.
  return headRepoFullName.toLowerCase() === repository.toLowerCase()
}

/** Whether the caller must fetch the head repository: only a comment on a pull request lacks it in its payload. */
export function needsPullRequestHeadLookup(event: NormalizedEvent): boolean {
  return event.type === 'issue_comment' && event.issue.isPullRequest
}

function checkHeadRepository(headRepoFullName: string | null, repository: string): RepoSkillsTrust | null {
  if (headRepoFullName == null) return denied('head-repository-unknown')
  if (!isSameRepository(headRepoFullName, repository)) return denied('fork-pull-request')
  return null
}

export function evaluateRepoSkillsTrust(input: RepoSkillsTrustInput): RepoSkillsTrust {
  const {event, repository} = input

  switch (event.type) {
    // Autonomous runs: no untrusted text drives them.
    case 'schedule':
    case 'workflow_dispatch':
      return trusted

    // Only a maintainer's issue may steer a run that loads repository skills.
    case 'issues':
      return isTrustedAssociation(event.issue.authorAssociation) ? trusted : denied('author-not-trusted')

    case 'issue_comment': {
      if (!isTrustedAssociation(event.comment.authorAssociation)) return denied('author-not-trusted')
      // A plain issue: no pull request is involved.
      if (!event.issue.isPullRequest) return trusted
      // A maintainer commenting on a fork PR is still a fork: the head repository decides, not the commenter.
      return checkHeadRepository(input.lookedUpHeadRepoFullName, repository) ?? trusted
    }

    case 'pull_request': {
      if (!isTrustedAssociation(event.pullRequest.authorAssociation)) return denied('author-not-trusted')
      return checkHeadRepository(event.pullRequest.headRepoFullName, repository) ?? trusted
    }

    // Deferred surfaces and anything unknown: deny by absence.
    case 'discussion_comment':
    case 'pull_request_review_comment':
    case 'unsupported':
      return denied('event-not-eligible')
  }
}
