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
      getWorkflowFileAtSha: async () => `uses: fro-bot/agent@${PIN_VERIFIED}`,
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
      getWorkflowFileAtSha: async () => `uses: fro-bot/agent@${PIN_BEHIND}`,
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
        return `uses: fro-bot/agent@${PIN_VERIFIED}`
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

  it('yields not-verified with pin-not-resolvable for a floating (non-40-hex) ref', async () => {
    // #given a workflow file pinned to a branch name instead of a full SHA
    const client = makeClient({
      listWorkflowRuns: async () => [run()],
      getWorkflowFileAtSha: async () => 'uses: fro-bot/agent@main',
    })

    // #when
    const result = await sweepRepository(client, 'o/r')

    // #then
    expect(result.status).toBe('not-verified')
    expect(result.detail).toBe('pin-not-resolvable')
    expect(result.pin).toBeNull()
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
})
