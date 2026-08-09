import type {PullRequestEvent} from '@octokit/webhooks-types'
import type {DiffFileSummary} from '../../packages/runtime/src/agent/index.js'
import {createPullRequestOpenedEvent} from '../../src/features/triggers/__fixtures__/payloads.js'

export const NEUTRAL_REVIEW_PROMPT =
  'Review this pull request for correctness. Inspect the changed files and their tests. Do not modify the repository. Deliver the required PR review response.'

export const SHARED_DIFF_FILES: readonly DiffFileSummary[] = [
  {filename: 'src/access.ts', status: 'added', additions: 3, deletions: 0},
  {filename: 'src/access.test.ts', status: 'added', additions: 4, deletions: 0},
]

export function createNeutralPullRequestEvent(): PullRequestEvent {
  return createPullRequestOpenedEvent({
    prTitle: 'Add age access check',
    prBody: 'Adds an age access check with tests.',
  })
}
