import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {parse} from 'yaml'

/**
 * Guards the OSV-Scanner workflow's routing and enforcement invariants.
 *
 * Two properties are easy to break by editing one line and are expensive to
 * notice afterwards, because a wrong value still produces a green run:
 *
 * 1. `merge_group` must use the full scan. The upstream PR workflow reports what
 *    a change introduces by checking out `$GITHUB_BASE_REF` and diffing against
 *    it, and links results with `github.event.pull_request.number`. A merge queue
 *    supplies neither, so pointing `merge_group` at it compares against nothing.
 *
 * 2. Only the pull request path may fail on vulnerabilities. That path has a
 *    baseline to diff against, so a failure means the change itself introduced
 *    something. The full scan has no baseline; failing it would break unrelated
 *    pushes and queue entries whenever a new advisory is published against a
 *    dependency nobody touched.
 */

interface WorkflowJob {
  readonly if: string
  readonly uses: string
  readonly with: Record<string, unknown>
}

interface Workflow {
  readonly on: Record<string, unknown>
  readonly jobs: Record<string, WorkflowJob>
}

const WORKFLOW_PATH = '.github/workflows/osv-scanner.yaml'

const PR_DIFF_WORKFLOW = 'osv-scanner-reusable-pr.yml'
const FULL_SCAN_WORKFLOW = 'osv-scanner-reusable.yml'

function loadWorkflow(): Workflow {
  // `on` is parsed as the boolean `true` by YAML 1.1 semantics in some parsers;
  // read both spellings so this guard does not depend on that detail.
  const parsed = parse(readFileSync(WORKFLOW_PATH, 'utf8')) as Record<string, unknown>
  const triggers = (parsed.on ?? parsed[String(true)]) as Record<string, unknown>
  return {on: triggers, jobs: parsed.jobs as Record<string, WorkflowJob>}
}

/** Returns the job ids whose `if` expression names the given event. */
function jobsForEvent(workflow: Workflow, event: string): readonly string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => job.if.includes(`'${event}'`))
    .map(([id]) => id)
}

/** Returns the reusable workflow filename a job delegates to. */
function reusableWorkflowOf(job: WorkflowJob): string {
  const path = job.uses.split('@')[0] ?? job.uses
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Resolves the single job handling an event, failing loudly if that is not true. */
function soleJobForEvent(workflow: Workflow, event: string): WorkflowJob {
  const ids = jobsForEvent(workflow, event)
  if (ids.length !== 1) {
    throw new Error(`event '${event}' must route to exactly one job, found ${ids.length}`)
  }
  const [id] = ids
  const job = id === undefined ? undefined : workflow.jobs[id]
  if (job === undefined) {
    throw new Error(`event '${event}' routes to a job that does not exist`)
  }
  return job
}

describe('osv-scanner workflow — event routing', () => {
  it('routes every subscribed event to exactly one job', () => {
    // #given the workflow and the events it subscribes to
    const workflow = loadWorkflow()
    const events = Object.keys(workflow.on)

    // #when each event is matched against the job conditions
    const routing = events.map(event => [event, jobsForEvent(workflow, event)] as const)

    // #then no event is unhandled and none is claimed by two jobs
    for (const [event, jobs] of routing) {
      expect(jobs, `event '${event}' must route to exactly one job`).toHaveLength(1)
    }
  })

  it('sends merge_group to the full scan, which needs no pull request context', () => {
    // #given the workflow
    const workflow = loadWorkflow()

    // #when the merge queue event is routed
    const job = soleJobForEvent(workflow, 'merge_group')

    // #then it reaches the full scan rather than the base-vs-head diff
    expect(reusableWorkflowOf(job)).toBe(FULL_SCAN_WORKFLOW)
  })

  it('sends pull_request to the diff scan', () => {
    // #given the workflow
    const workflow = loadWorkflow()

    // #when the pull request event is routed
    const job = soleJobForEvent(workflow, 'pull_request')

    // #then it reaches the workflow that compares base against head
    expect(reusableWorkflowOf(job)).toBe(PR_DIFF_WORKFLOW)
  })
})

describe('osv-scanner workflow — failure policy', () => {
  it('fails only on the path that has a baseline to compare against', () => {
    // #given every job in the workflow
    const workflow = loadWorkflow()

    // #when each job's failure policy is read alongside the workflow it delegates to
    const policies = Object.values(workflow.jobs).map(job => ({
      reusable: reusableWorkflowOf(job),
      failOnVuln: job.with['fail-on-vuln'],
    }))

    // #then the diff scan enforces and the baseline-free full scan reports only
    for (const {reusable, failOnVuln} of policies) {
      const expected = reusable === PR_DIFF_WORKFLOW
      expect(failOnVuln, `${reusable} must have fail-on-vuln: ${String(expected)}`).toBe(expected)
    }
  })

  it('uploads findings to code scanning from every job', () => {
    // #given every job in the workflow
    const workflow = loadWorkflow()

    // #when the upload setting is read
    const uploads = Object.values(workflow.jobs).map(job => job.with['upload-sarif'])

    // #then findings stay visible regardless of whether the job can fail
    expect(uploads.length).toBeGreaterThan(0)
    for (const upload of uploads) {
      expect(upload).toBe(true)
    }
  })
})
