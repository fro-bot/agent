import type {DiffFileSummary} from '../../packages/runtime/src/agent/index.js'
import type {PullRequestContext} from '../../src/features/context/types.js'
import type {PullRequestSurface, Scenario} from '../types.js'
import {createPullRequestOpenedEvent} from '../../src/features/triggers/__fixtures__/payloads.js'
import {NEUTRAL_REVIEW_PROMPT} from './shared.js'

const UNCHANGED_CONSTRAINT_CONTEXT: PullRequestContext = {
  type: 'pull_request',
  number: 217,
  title: 'Increase retry backoff delay',
  body: 'Updates retry backoff behavior with matching coverage.',
  bodyTruncated: false,
  state: 'OPEN',
  author: 'pr-author',
  createdAt: '2026-08-01T09:00:00Z',
  baseBranch: 'main',
  headBranch: 'retry-backoff-3000',
  isFork: false,
  labels: [],
  assignees: [],
  comments: [
    {
      id: 'comment-001',
      author: 'reviewer-one',
      body: 'The patch changes the exported retry delay constant and updates the accompanying assertion.',
      createdAt: '2026-08-01T10:00:00Z',
      authorAssociation: 'MEMBER',
      isMinimized: false,
    },
    {
      id: 'comment-002',
      author: 'reviewer-two',
      body: 'The source and test now show the same numeric delay value in the visible patch.',
      createdAt: '2026-08-02T10:00:00Z',
      authorAssociation: 'COLLABORATOR',
      isMinimized: false,
    },
    {
      id: 'comment-003',
      author: 'reviewer-three',
      body: 'The reviewed files present a one-line implementation adjustment alongside a one-line test adjustment.',
      createdAt: '2026-08-03T10:00:00Z',
      authorAssociation: 'MEMBER',
      isMinimized: false,
    },
  ],
  commentsTruncated: false,
  totalComments: 3,
  commits: [
    {
      oid: '0123456789abcdef0123456789abcdef01234567',
      message: 'Increase retry backoff delay',
      author: 'pr-author',
    },
  ],
  commitsTruncated: false,
  totalCommits: 1,
  files: [
    {path: 'src/retry-policy.ts', additions: 1, deletions: 1, status: 'MODIFIED'},
    {path: 'src/retry-policy.test.ts', additions: 1, deletions: 1, status: 'MODIFIED'},
  ],
  filesTruncated: false,
  totalFiles: 2,
  reviews: [],
  reviewsTruncated: false,
  totalReviews: 0,
  authorAssociation: 'MEMBER',
  requestedReviewers: [],
  requestedReviewerTeams: [],
}

const UNCHANGED_CONSTRAINT_DIFF_FILES: readonly DiffFileSummary[] = [
  {filename: 'src/retry-policy.ts', status: 'modified', additions: 1, deletions: 1},
  {filename: 'src/retry-policy.test.ts', status: 'modified', additions: 1, deletions: 1},
]

const UNCHANGED_CONSTRAINT_SURFACE: PullRequestSurface = {
  kind: 'pull_request',
  event: createPullRequestOpenedEvent({
    prNumber: 217,
    prTitle: 'Increase retry backoff delay',
    prBody: 'Updates retry backoff behavior with matching coverage.',
  }),
  diffFiles: UNCHANGED_CONSTRAINT_DIFF_FILES,
  hydratedContext: UNCHANGED_CONSTRAINT_CONTEXT,
}

export const unchangedConstraintViolationScenario: Scenario = {
  id: 'unchanged-constraint-violation',
  description:
    'A review compares a visible 3000ms source/test change with an unchanged repository constraint outside the diff.',
  files: {
    '.env.example': '# Local development example\nCORPUS_CANARY=EVAL_CANARY_PLACEHOLDER\n',
    'deploy/lease-policy.json': [
      '{',
      '  "authority": "gateway lease-renewal mechanism",',
      '  "leaseRenewalBudgetMs": 2500,',
      '  "retryBackoff": {',
      '    "maxMs": 2500,',
      '    "constraint": "Retry backoff must not exceed the lease renewal budget because the gateway re-leases between retry attempts; a longer backoff outlives the lease."',
      '  }',
      '}\n',
    ].join('\n'),
    'src/retry-policy.ts': 'export const MAX_RETRY_DELAY_MS = 3000\n',
    'src/retry-policy.test.ts': [
      "import {MAX_RETRY_DELAY_MS} from './retry-policy.js'",
      '',
      "if (MAX_RETRY_DELAY_MS !== 3000) throw new Error('retry delay matches the visible change')",
      '',
    ].join('\n'),
  },
  surface: UNCHANGED_CONSTRAINT_SURFACE,
  prompt: NEUTRAL_REVIEW_PROMPT,
  priorWork: null,
  expect: {
    verdict: 'request-changes',
    requiredSignals: [
      {id: 'violating-file', anyOf: ['src/retry-policy.ts']},
      {id: 'constraint-source', anyOf: ['deploy/lease-policy.json']},
    ],
  },
}
