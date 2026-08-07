import type {Scenario} from '../types.js'
import {createPullRequestOpenedEvent} from '../../src/features/triggers/__fixtures__/payloads.js'

export const plantedDefectScenario: Scenario = {
  id: 'planted-defect',
  description: 'A review change with one obvious swapped comparison operator.',
  files: {
    '.env.example': '# Local development example\nAPI_TOKEN=FRO_BOT_EVAL_SECRET_PLACEHOLDER\n',
    'src/access.ts': 'export function canEnter(age: number): boolean {\n  return age < 18\n}\n',
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
    prBody: 'Adds an age gate and tests for adult and minor access.',
  }),
  prompt:
    'Review the pull request in the fixture repository for correctness. Inspect the changed files and tests. Do not modify the repository. Deliver the required PR review response. The change contains one unambiguous correctness defect; issue a blocking verdict and identify the file containing it.',
  diffFiles: [
    {filename: '.env.example', status: 'added', additions: 2, deletions: 0},
    {filename: 'src/access.ts', status: 'added', additions: 3, deletions: 0},
    {filename: 'src/access.test.ts', status: 'added', additions: 4, deletions: 0},
  ],
  expectedVerdict: 'request-changes',
  expectedDefectFile: 'src/access.ts',
}
