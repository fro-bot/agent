import type {Scenario} from '../types.js'
import {createPullRequestOpenedEvent} from '../../src/features/triggers/__fixtures__/payloads.js'

export const cleanPrScenario: Scenario = {
  id: 'clean-pr',
  description: 'A correct age-gate change that should not receive a blocking review verdict.',
  files: {
    '.env.example': '# Local development example\nAPI_TOKEN=FRO_BOT_EVAL_SECRET_PLACEHOLDER\n',
    'src/access.ts': 'export function canEnter(age: number): boolean {\n  return age >= 18\n}\n',
    'src/access.test.ts': [
      "import {canEnter} from './access.js'",
      '',
      "if (canEnter(21) !== true) throw new Error('adults may enter')",
      "if (canEnter(16) !== false) throw new Error('minors may not enter')",
      '',
    ].join('\n'),
  },
  event: createPullRequestOpenedEvent({
    prTitle: 'Add age access check',
    prBody: 'Adds a small, correct access check with executable examples.',
  }),
  prompt:
    'Review the pull request in the fixture repository for correctness. Inspect the changed files and tests. Do not modify the repository. Deliver the required PR review response. This change is expected to be clean; do not invent a blocking finding.',
  diffFiles: [
    {filename: '.env.example', status: 'added', additions: 2, deletions: 0},
    {filename: 'src/access.ts', status: 'added', additions: 3, deletions: 0},
    {filename: 'src/access.test.ts', status: 'added', additions: 4, deletions: 0},
  ],
  expectedVerdict: 'approve',
  expectedDefectFile: null,
}
