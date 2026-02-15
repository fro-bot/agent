import type {Octokit} from '../github/types.js'
import type {Logger} from '../logger.js'
import type {IssueGraphQLResponse, PullRequestGraphQLResponse} from './types.js'
import {toErrorMessage} from '../../utils/errors.js'

export const ISSUE_QUERY = `
  query GetIssue($owner: String!, $repo: String!, $number: Int!, $maxComments: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number
        title
        body
        state
        createdAt
        author { login }
        labels(first: 20) {
          nodes { name color }
        }
        assignees(first: 10) {
          nodes { login }
        }
        comments(first: $maxComments) {
          totalCount
          nodes {
            id
            body
            createdAt
            author { login }
            authorAssociation
            isMinimized
          }
        }
      }
    }
  }
`

export const PULL_REQUEST_QUERY = `
  query GetPullRequest(
    $owner: String!,
    $repo: String!,
    $number: Int!,
    $maxComments: Int!,
    $maxCommits: Int!,
    $maxFiles: Int!,
    $maxReviews: Int!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        body
        state
        createdAt
        author { login }
        baseRefName
        headRefName
        baseRepository { owner { login } }
        headRepository { owner { login } }
        labels(first: 20) {
          nodes { name color }
        }
        assignees(first: 10) {
          nodes { login }
        }
        comments(first: $maxComments) {
          totalCount
          nodes {
            id
            body
            createdAt
            author { login }
            authorAssociation
            isMinimized
          }
        }
        commits(first: $maxCommits) {
          totalCount
          nodes {
            commit {
              oid
              message
              author { name }
            }
          }
        }
        files(first: $maxFiles) {
          totalCount
          nodes {
            path
            additions
            deletions
          }
        }
        reviews(first: $maxReviews) {
          totalCount
          nodes {
            state
            body
            createdAt
            author { login }
            comments(first: 10) {
              nodes {
                id
                body
                path
                line
                createdAt
                author { login }
              }
            }
          }
        }
        authorAssociation
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User { login }
              ... on Team { name }
            }
          }
        }
      }
    }
  }
`

export async function executeIssueQuery(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  maxComments: number,
  logger: Logger,
): Promise<IssueGraphQLResponse | null> {
  try {
    const result = await client.graphql<IssueGraphQLResponse>(ISSUE_QUERY, {
      owner,
      repo,
      number,
      maxComments,
    })
    return result
  } catch (error) {
    logger.warning('GraphQL issue query failed', {
      owner,
      repo,
      number,
      error: toErrorMessage(error),
    })
    return null
  }
}

export async function executePullRequestQuery(
  client: Octokit,
  owner: string,
  repo: string,
  number: number,
  maxComments: number,
  maxCommits: number,
  maxFiles: number,
  maxReviews: number,
  logger: Logger,
): Promise<PullRequestGraphQLResponse | null> {
  try {
    const result = await client.graphql<PullRequestGraphQLResponse>(PULL_REQUEST_QUERY, {
      owner,
      repo,
      number,
      maxComments,
      maxCommits,
      maxFiles,
      maxReviews,
    })
    return result
  } catch (error) {
    logger.warning('GraphQL pull request query failed', {
      owner,
      repo,
      number,
      error: toErrorMessage(error),
    })
    return null
  }
}
