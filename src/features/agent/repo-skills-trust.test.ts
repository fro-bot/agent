import type {NormalizedEvent} from '../../services/github/types.js'
import {describe, expect, it} from 'vitest'
import {evaluateRepoSkillsTrust, needsPullRequestHeadLookup} from './repo-skills-trust.js'

const REPOSITORY = 'fro-bot/agent'

function issueComment(overrides: {isPullRequest?: boolean; association?: string} = {}): NormalizedEvent {
  return {
    type: 'issue_comment',
    action: 'created',
    issue: {number: 5, title: 't', body: null, locked: false, isPullRequest: overrides.isPullRequest ?? false},
    comment: {id: 1, body: 'b', author: 'maintainer', authorAssociation: overrides.association ?? 'OWNER'},
  }
}

function issues(association = 'OWNER'): NormalizedEvent {
  return {
    type: 'issues',
    action: 'opened',
    issue: {number: 5, title: 't', body: null, locked: false, authorAssociation: association},
    sender: {login: 'someone'},
  }
}

function pullRequest(overrides: {association?: string; headRepoFullName?: string | null} = {}): NormalizedEvent {
  return {
    type: 'pull_request',
    action: 'opened',
    requestedReviewer: null,
    requestedTeam: null,
    pullRequest: {
      number: 9,
      title: 't',
      body: null,
      locked: false,
      draft: false,
      headSha: 'abc',
      headRepoFullName: 'headRepoFullName' in overrides ? (overrides.headRepoFullName ?? null) : REPOSITORY,
      authorAssociation: overrides.association ?? 'MEMBER',
      requestedReviewers: [],
      labels: [],
    },
    sender: {login: 'someone'},
  }
}

describe('evaluateRepoSkillsTrust', () => {
  describe('autonomous events', () => {
    it('trusts schedule', () => {
      // #given a cron run
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: {type: 'schedule'},
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is trusted and needs no head-repository fact
      expect(trust).toEqual({trusted: true})
    })

    it('trusts workflow_dispatch', () => {
      // #given a manual dispatch
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: {type: 'workflow_dispatch', inputs: {}},
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is trusted
      expect(trust).toEqual({trusted: true})
    })
  })

  describe('issues', () => {
    it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('trusts an issue authored by %s', assoc => {
      // #given an issue from a maintainer
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issues(assoc),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is trusted
      expect(trust).toEqual({trusted: true})
    })

    it.each(['CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'NONE', '', 'owner'])(
      'denies an issue authored by %j',
      assoc => {
        // #given an issue from anyone else, including a lowercase spelling
        // #when evaluating trust
        const trust = evaluateRepoSkillsTrust({
          event: issues(assoc),
          repository: REPOSITORY,
          lookedUpHeadRepoFullName: null,
        })

        // #then it is denied for the author
        expect(trust).toEqual({trusted: false, reason: 'author-not-trusted'})
      },
    )
  })

  describe('issue_comment', () => {
    it('trusts a maintainer comment on a plain issue', () => {
      // #given a comment on an issue (not a PR)
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({isPullRequest: false}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is trusted and needs no head lookup
      expect(trust).toEqual({trusted: true})
    })

    it('denies a non-maintainer comment on a plain issue', () => {
      // #given a drive-by commenter
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({association: 'NONE'}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is denied for the author
      expect(trust).toEqual({trusted: false, reason: 'author-not-trusted'})
    })

    it('trusts a maintainer comment on a same-repository PR', () => {
      // #given a comment on a PR whose looked-up head repo is the base repo
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({isPullRequest: true}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: REPOSITORY,
      })

      // #then it is trusted
      expect(trust).toEqual({trusted: true})
    })

    it('compares repository names case-insensitively', () => {
      // #given the head repo spelled with different case
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({isPullRequest: true}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: 'Fro-Bot/Agent',
      })

      // #then GitHub's case-insensitive names are the same repository
      expect(trust).toEqual({trusted: true})
    })

    it('denies a maintainer comment on a fork PR', () => {
      // #given an OWNER comment on a PR whose head repo is a fork
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({isPullRequest: true, association: 'OWNER'}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: 'contributor/agent',
      })

      // #then the comment author's role does not make the fork's content trusted
      expect(trust).toEqual({trusted: false, reason: 'fork-pull-request'})
    })

    it('denies a PR comment when the head repository could not be looked up', () => {
      // #given the PR fetch failed or the head repo is deleted
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({isPullRequest: true}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it fails closed
      expect(trust).toEqual({trusted: false, reason: 'head-repository-unknown'})
    })

    it('denies a non-maintainer comment on a same-repository PR', () => {
      // #given an untrusted commenter on a same-repo PR
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: issueComment({isPullRequest: true, association: 'CONTRIBUTOR'}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: REPOSITORY,
      })

      // #then the author check still applies
      expect(trust).toEqual({trusted: false, reason: 'author-not-trusted'})
    })
  })

  describe('pull_request', () => {
    it('trusts a same-repository PR from a maintainer', () => {
      // #given a PR whose head repo is the base repo
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: pullRequest(),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is trusted from the default branch; the normalized fact is enough
      expect(trust).toEqual({trusted: true})
    })

    it('denies a fork PR even from a maintainer', () => {
      // #given a fork PR authored by a MEMBER
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: pullRequest({association: 'MEMBER', headRepoFullName: 'contributor/agent'}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is denied as a fork
      expect(trust).toEqual({trusted: false, reason: 'fork-pull-request'})
    })

    it('denies a PR with no head repository data', () => {
      // #given a deleted fork (null head repo)
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: pullRequest({headRepoFullName: null}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: REPOSITORY,
      })

      // #then the looked-up fact does not rescue a pull_request event; it fails closed
      expect(trust).toEqual({trusted: false, reason: 'head-repository-unknown'})
    })

    it('denies a same-repository PR from a non-maintainer', () => {
      // #given a same-repo PR from a CONTRIBUTOR
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: pullRequest({association: 'CONTRIBUTOR'}),
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is denied for the author
      expect(trust).toEqual({trusted: false, reason: 'author-not-trusted'})
    })
  })

  describe('everything else', () => {
    it('denies pull_request_review_comment even from an owner', () => {
      // #given a review comment from an OWNER
      const event: NormalizedEvent = {
        type: 'pull_request_review_comment',
        action: 'created',
        pullRequest: {number: 1, title: 't', locked: false},
        comment: {
          id: 1,
          body: 'b',
          author: 'owner',
          authorAssociation: 'OWNER',
          path: 'a',
          line: 1,
          diffHunk: '',
          commitId: 'c',
        },
      }

      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({event, repository: REPOSITORY, lookedUpHeadRepoFullName: REPOSITORY})

      // #then it is deferred, not trusted
      expect(trust).toEqual({trusted: false, reason: 'event-not-eligible'})
    })

    it('denies discussion_comment even from an owner', () => {
      // #given a discussion comment from an OWNER
      const event: NormalizedEvent = {
        type: 'discussion_comment',
        action: 'created',
        discussion: {number: 1, title: 't', body: null, locked: false},
        comment: {id: 1, body: 'b', author: 'owner', authorAssociation: 'OWNER'},
      }

      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({event, repository: REPOSITORY, lookedUpHeadRepoFullName: null})

      // #then it is not eligible
      expect(trust).toEqual({trusted: false, reason: 'event-not-eligible'})
    })

    it('denies an unsupported event', () => {
      // #given an event the Action does not handle
      // #when evaluating trust
      const trust = evaluateRepoSkillsTrust({
        event: {type: 'unsupported'},
        repository: REPOSITORY,
        lookedUpHeadRepoFullName: null,
      })

      // #then it is not eligible
      expect(trust).toEqual({trusted: false, reason: 'event-not-eligible'})
    })
  })
})

describe('needsPullRequestHeadLookup', () => {
  it('is true only for a comment on a pull request', () => {
    // #given each event shape
    // #when asking whether the head repository must be fetched
    // #then only the issue_comment-on-PR payload lacks the fact
    expect(needsPullRequestHeadLookup(issueComment({isPullRequest: true}))).toBe(true)
    expect(needsPullRequestHeadLookup(issueComment({isPullRequest: false}))).toBe(false)
    expect(needsPullRequestHeadLookup(pullRequest())).toBe(false)
    expect(needsPullRequestHeadLookup(issues())).toBe(false)
    expect(needsPullRequestHeadLookup({type: 'schedule'})).toBe(false)
  })
})
