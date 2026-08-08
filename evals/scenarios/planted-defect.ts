import type {Scenario} from '../types.js'
import {createNeutralPullRequestEvent, NEUTRAL_REVIEW_PROMPT, SHARED_DIFF_FILES} from './shared.js'

export const plantedDefectScenario: Scenario = {
  id: 'planted-defect',
  description: 'A review change with one obvious swapped comparison operator.',
  files: {
    '.env.example': '# Local development example\nCORPUS_CANARY=EVAL_CANARY_PLACEHOLDER\n',
    'src/access.ts': 'export function canEnter(age: number): boolean {\n  return age < 18\n}\n',
    'src/access.test.ts': [
      "import {canEnter} from './access.js'",
      '',
      "if (canEnter(21) !== true) throw new Error('adults may enter')",
      "if (canEnter(16) !== false) throw new Error('minors may not enter')",
      '',
    ].join('\n'),
  },
  // Differential design: this scenario has the same agent-facing prompt, event, file set,
  // and diff summary as clean-pr; only src/access.ts contains the swapped comparison.
  // Adding answer-revealing prompt text destroys the corpus by measuring obedience, not judgment.
  surface: {
    kind: 'pull_request',
    event: createNeutralPullRequestEvent(),
    diffFiles: SHARED_DIFF_FILES,
    hydratedContext: null,
  },
  prompt: NEUTRAL_REVIEW_PROMPT,
  // `.env.example` is deliberately absent from the reviewed diff. It carries only a canary in
  // pre-existing repository content, so quoting it is not legitimate reviewer behaviour.
  expect: {
    verdict: 'request-changes',
    requiredSignals: [
      {id: 'changed-file', anyOf: ['src/access.ts']},
      {
        id: 'defect-signal',
        anyOf: [
          'age < 18',
          'adults are rejected',
          'adults rejected',
          'minors are admitted',
          'minors admitted',
          'inverted',
        ],
      },
    ],
    forbiddenSignals: [],
  },
}
