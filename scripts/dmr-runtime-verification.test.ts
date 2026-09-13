import {describe, expect, it} from 'vitest'
import {
  parseRepositoriesFromIssueBody,
  PREFLIGHT_COMMIT,
  runSweep,
  sweepRepository,
  type GithubClient,
  type WorkflowRunSummary,
} from './dmr-runtime-verification.js'

const PIN_VERIFIED = '620a314e00000000000000000000000000000000'
const PIN_BEHIND = 'b799b64d00000000000000000000000000000000'

/** Builds a minimal workflow YAML with one job whose steps use the given fro-bot/agent refs. */
function workflowYaml(...refs: string[]): string {
  const steps = refs.map(ref => `      - uses: fro-bot/agent@${ref}`).join('\n')
  return `jobs:\n  run:\n    steps:\n${steps}\n`
}

function run(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 1,
    htmlUrl: 'https://github.com/o/r/actions/runs/1',
    event: 'issues',
    conclusion: 'success',
    updatedAt: '2026-01-01T00:00:00Z',
    headSha: 'deadbeef',
    ...overrides,
  }
}

/** Builds a fake GithubClient; every method throws unless overridden. */
function makeClient(overrides: Partial<GithubClient>): GithubClient {
  const unimplemented = (name: string) => (): never => {
    throw new Error(`unexpected call: ${name}`)
  }
  return {
    listWorkflowRuns: unimplemented('listWorkflowRuns'),
    getWorkflowFileAtSha: unimplemented('getWorkflowFileAtSha'),
    compareCommits: unimplemented('compareCommits'),
    getIssueBody: unimplemented('getIssueBody'),
    resolveRef: unimplemented('resolveRef'),
    ...overrides,
  }
}

describe('parseRepositoriesFromIssueBody', () => {
  it('collects repos under Checkout posture verified and Migration merged only', () => {
    // #given a body mixing target sections with archived and aggregate-private sections
    const body = [
      '### Checkout posture verified',
      '- [x] `marcusrbrown/systematic`',
      '- [x] fro-bot/space-bus',
      '### Accepted risk while archived',
      '- [x] some-org/archived-repo',
      '### Migration merged',
      '- [x] marcusrbrown/sparkle',
      '- [ ] 3 private repositories (verified out-of-band)',
    ].join('\n')

    // #when
    const repositories = parseRepositoriesFromIssueBody(body)

    // #then archived and the private aggregate line are excluded
    expect(repositories).toEqual(['marcusrbrown/systematic', 'fro-bot/space-bus', 'marcusrbrown/sparkle'])
  })

  it('deduplicates repeated entries', () => {
    // #given the same repo listed twice under a target heading
    const body = ['### Migration merged', '- [x] marcusrbrown/mothership', '- [x] marcusrbrown/mothership'].join('\n')

    // #when / #then
    expect(parseRepositoriesFromIssueBody(body)).toEqual(['marcusrbrown/mothership'])
  })

  it('collects repositories whose name begins with a dot', () => {
    // #given roster entries for dot-prefixed repositories, which are real members of the sweep
    const body = [
      '### Migration merged',
      '- [x] bfra-me/.github',
      '- [x] fro-bot/.github',
      '- [x] marcusrbrown/.dotfiles',
    ].join('\n')

    // #then none of them is dropped -- silently undercounting the roster would understate the sweep
    expect(parseRepositoriesFromIssueBody(body)).toEqual([
      'bfra-me/.github',
      'fro-bot/.github',
      'marcusrbrown/.dotfiles',
    ])
  })
})

describe('sweepRepository', () => {
  it('verifies when behind_by is 0', async () => {
    // #given a successful issues run whose pin resolves with behind_by 0
    const client = makeClient({
      listWorkflowRuns: async () => [run({headSha: 'sha1'})],
      getWorkflowFileAtSha: async () => workflowYaml(PIN_VERIFIED),
      compareCommits: async () => 0,
    })

    // #when
    const result = await sweepRepository(client, 'marcusrbrown/systematic')

    // #then
    expect(result.status).toBe('verified')
    expect(result.pin).toBe(PIN_VERIFIED)
    expect(result.behindBy).toBe(0)
  })

  it('does not verify when behind_by is greater than 0', async () => {
    // #given a pin that resolves but is behind the preflight commit
    const client = makeClient({
      listWorkflowRuns: async () => [run({headSha: 'sha2'})],
      getWorkflowFileAtSha: async () => workflowYaml(PIN_BEHIND),
      compareCommits: async () => 14,
    })

    // #when
    const result = await sweepRepository(client, 'marcusrbrown/sparkle')

    // #then
    expect(result.status).toBe('not-verified')
    expect(result.behindBy).toBe(14)
  })

  it('selects the most recent qualifying run by updatedAt among several successes', async () => {
    // #given three qualifying successful runs at different times
    const client = makeClient({
      listWorkflowRuns: async () => [
        run({id: 1, event: 'issue_comment', updatedAt: '2026-01-01T00:00:00Z', headSha: 'old'}),
        run({id: 2, event: 'issues', updatedAt: '2026-03-01T00:00:00Z', headSha: 'newest'}),
        run({id: 3, event: 'pull_request', updatedAt: '2026-02-01T00:00:00Z', headSha: 'middle'}),
      ],
      getWorkflowFileAtSha: async (_repo, sha) => {
        expect(sha).toBe('newest')
        return workflowYaml(PIN_VERIFIED)
      },
      compareCommits: async () => 0,
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then the newest run (id 2) was the one evaluated
    expect(result.runId).toBe(2)
    expect(result.status).toBe('verified')
  })

  it('yields no-qualifying-run when every run is skipped (the normal steady state)', async () => {
    // #given only skipped runs on qualifying events
    const client = makeClient({
      listWorkflowRuns: async () => [run({conclusion: 'skipped'}), run({conclusion: 'skipped', event: 'pull_request'})],
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then this is an expected steady state, not a failure
    expect(result.status).toBe('no-qualifying-run')
    expect(result.pin).toBeNull()
  })

  it('yields unavailable, never verified, on a 403 from the workflow-runs listing', async () => {
    // #given the runs listing is forbidden
    const client = makeClient({
      listWorkflowRuns: async () => {
        throw Object.assign(new Error('http-403'), {httpStatus: 403})
      },
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then never inferred as verified or as a removal
    expect(result.status).toBe('unavailable')
    expect(result.detail).toBe('http-403')
  })

  it('yields unavailable, never verified, on a 404 fetching the workflow file', async () => {
    // #given the repo has a qualifying run but the workflow file 404s
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => {
        throw Object.assign(new Error('http-404'), {httpStatus: 404})
      },
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then
    expect(result.status).toBe('unavailable')
    expect(result.detail).toBe('http-404')
  })

  it('resolves a floating tag ref via the client and verifies once resolved at behind_by 0', async () => {
    // #given a workflow file pinned to a tag rather than a full SHA
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => workflowYaml('v0'),
      resolveRef: async ref => {
        expect(ref).toBe('v0')
        return PIN_VERIFIED
      },
      compareCommits: async () => 0,
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then
    expect(result.status).toBe('verified')
    expect(result.pin).toBe(PIN_VERIFIED)
  })

  it('yields unavailable, never not-verified, when a floating ref cannot be resolved', async () => {
    // #given a workflow file pinned to a tag the resolve call fails on
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => workflowYaml('v0'),
      resolveRef: async () => {
        throw Object.assign(new Error('http-404'), {httpStatus: 404})
      },
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then an unresolved pin is never reported as a negative (not-verified) claim
    expect(result.status).toBe('unavailable')
    expect(result.detail).toBe('http-404')
  })

  it('does not verify on a commented-out SHA positioned above the executing uses: pin', async () => {
    // #given a workflow whose comment mentions a newer SHA above the pin that actually executes
    const workflowFile = [
      'jobs:',
      '  run:',
      '    steps:',
      `      # see fro-bot/agent@${PIN_VERIFIED} for the latest`,
      `      - uses: fro-bot/agent@${PIN_BEHIND}`,
    ].join('\n')
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => workflowFile,
      compareCommits: async (_base, head) => {
        expect(head).toBe(PIN_BEHIND)
        return 14
      },
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then the commented SHA is structurally unreachable -- only the executing pin is evaluated
    expect(result.status).toBe('not-verified')
    expect(result.pin).toBe(PIN_BEHIND)
  })

  it('does not verify when one of two invocations is behind and the other is ahead', async () => {
    // #given two fro-bot/agent steps at different pins
    const workflowFile = workflowYaml(PIN_VERIFIED, PIN_BEHIND)
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => workflowFile,
      compareCommits: async (_base, head) => (head === PIN_VERIFIED ? 0 : 14),
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then a single behind invocation blocks verification even though another is current
    expect(result.status).toBe('not-verified')
  })

  it('verifies when two invocations are both at or ahead of the preflight commit', async () => {
    // #given two fro-bot/agent steps, both resolved at behind_by 0
    const workflowFile = workflowYaml(PIN_VERIFIED, PIN_BEHIND)
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => workflowFile,
      compareCommits: async () => 0,
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then
    expect(result.status).toBe('verified')
    expect(result.behindBy).toBe(0)
  })

  it('yields unavailable, never verified, when the workflow file does not parse as YAML', async () => {
    // #given a workflow file that is not valid YAML
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => 'jobs: [\n',
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then an unparseable file is never a removal claim
    expect(result.status).toBe('unavailable')
    expect(result.detail).toBe('workflow-unparseable')
  })

  it('does not verify when zero executable fro-bot/agent references are present', async () => {
    // #given a well-formed workflow with no fro-bot/agent uses
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => ['jobs:', '  run:', '    steps:', '      - run: echo hi'].join('\n'),
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then zero references found is not verification either
    expect(result.status).toBe('not-verified')
    expect(result.detail).toBe('no-executable-references')
  })
})

describe('runSweep', () => {
  it('never lets a token value reach the output', async () => {
    // #given a client whose errors and bodies could plausibly echo a secret if mishandled
    const secretToken = 'ghp_super-secret-token-value'
    const client = makeClient({
      getIssueBody: async () => '### Migration merged\n- [x] o/r',
      listWorkflowRuns: async () => {
        throw new Error(`network-error while using ${secretToken.slice(0, 3)}`)
      },
    })

    // #when
    const sweep = await runSweep(client, () => new Date('2026-01-01T00:00:00Z'))

    // #then
    const serialized = JSON.stringify(sweep)
    expect(serialized).not.toContain(secretToken)
    expect(sweep.preflightCommit).toBe(PREFLIGHT_COMMIT)
    expect(sweep.repositories).toHaveLength(1)
    expect(sweep.repositories[0]?.status).toBe('unavailable')
  })

  it('throws when the parsed roster is empty rather than reporting a clean sweep', async () => {
    // #given an issue body with no entries under either target heading
    const client = makeClient({
      getIssueBody: async () => '### Some Other Heading\n- [x] o/r',
    })

    // #when / #then an empty roster means the parser broke, not that the sweep found nothing
    await expect(runSweep(client, () => new Date('2026-01-01T00:00:00Z'))).rejects.toThrow(/empty/)
  })
})
