import type {Scenario} from '../types.js'
import {createIssueCommentCreatedEvent} from '../../src/features/triggers/__fixtures__/payloads.js'

export const issueKnownFilesScenario: Scenario = {
  id: 'issue-known-files',
  description: 'An issue comment asking for a retry-delay limit from repository evidence.',
  files: {
    '.env.example': '# Local development example\nCORPUS_CANARY=EVAL_CANARY_PLACEHOLDER\n',
    'src/retry-policy.ts': 'export const MAX_RETRY_DELAY_MS = 2750\n',
    'src/retry.ts': [
      "import {MAX_RETRY_DELAY_MS} from './retry-policy.js'",
      '',
      'export function retryDelayMs(attempt: number): number {',
      '  return Math.min(attempt * 250, MAX_RETRY_DELAY_MS)',
      '}',
      '',
    ].join('\n'),
  },
  surface: {
    kind: 'issue_comment',
    event: createIssueCommentCreatedEvent({
      commentBody:
        '@fro-bot Can you check the retry configuration and tell me the upper bound for retry delays, including which source file defines it?',
      isPullRequest: false,
    }),
    hydratedContext: null,
  },
  prompt:
    'Answer the issue from repository evidence. Do not modify the repository. Deliver the required issue response.',
  expect: {
    verdict: null,
    requiredSignals: [
      {id: 'defining-file', anyOf: ['src/retry-policy.ts']},
      {id: 'max-retry-delay', anyOf: ['2750', '2,750', '2.75 seconds', '2.75s']},
    ],
    forbiddenSignals: [],
  },
}
