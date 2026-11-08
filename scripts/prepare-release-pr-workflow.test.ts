import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

/**
 * Guards the trust boundary of the release-preparation workflow.
 *
 * The job mints a GitHub App installation token and uses it to push the `next` branch and to
 * open, update, close and merge the release pull request. Two properties are easy to weaken by
 * editing one line and keep a green run:
 *
 * 1. The token request must name its permissions and repository. Without `permission-*` inputs
 *    the token inherits everything the installation holds.
 * 2. The job must run only for the default branch. `workflow_dispatch` can target any ref, and
 *    a ref supplies its own copy of the workflow file, so this guard is defense in depth; the
 *    enforced boundary is a deployment environment restricted to the default branch.
 */

interface WorkflowStep {
  readonly id?: string
  readonly uses?: string
  readonly with?: Record<string, unknown>
}

interface WorkflowJob {
  readonly if?: string
  readonly steps: readonly WorkflowStep[]
}

interface Workflow {
  readonly jobs: Record<string, WorkflowJob>
}

const WORKFLOW_PATH = '.github/workflows/prepare-release-pr.yaml'

function loadJob(): WorkflowJob {
  const workflow = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Workflow
  const job = workflow.jobs['prepare-release']
  if (job === undefined) throw new Error('prepare-release job not found')
  return job
}

function tokenMintInputs(job: WorkflowJob): Record<string, unknown> {
  const step = job.steps.find(candidate => candidate.id === 'get-app-token')
  if (step?.with === undefined) throw new Error('get-app-token step with inputs not found')
  return step.with
}

describe('prepare-release-pr workflow', () => {
  it('requests the App token with an explicit repository and permission set', () => {
    // #given the inputs of the token mint step
    const inputs = tokenMintInputs(loadJob())

    // #when collecting the permission-* inputs
    const permissions = Object.fromEntries(Object.entries(inputs).filter(([key]) => key.startsWith('permission-')))

    // #then the token is limited to this repository and to exactly what the job uses
    // eslint-disable-next-line no-template-curly-in-string -- the literal expression text is the value under test
    expect(inputs.repositories).toBe('${{ github.event.repository.name }}')
    expect(permissions).toEqual({
      'permission-contents': 'write',
      'permission-pull-requests': 'write',
      'permission-workflows': 'write',
    })
  })

  it('runs only for the default branch ref', () => {
    // #given the prepare-release job
    const job = loadJob()

    // #then it is gated on the repository's default branch
    expect(job.if).toBe("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)")
  })
})
