import {describe, expect, it} from 'vitest'
import {
  AFFECTED_EVENTS,
  aggregatePrivate,
  areRunJobsSuccessful,
  buildArtifact,
  classifyGhFailure,
  collectRuntimeVerification,
  createGitHubAdapters,
  CREDENTIAL_PREFLIGHT_COMMIT,
  CREDENTIAL_REFUSAL_MARKER,
  DAILY_SCHEDULE_CRON,
  determineCollectorStatus,
  extractActionReferences,
  FORK_PULL_REQUEST_REJECTION_REASON,
  isPrivateClosureSatisfied,
  isQualifiableActionReference,
  isSchemaV1Envelope,
  LIMITS,
  MINIMUM_RELEASE,
  MINIMUM_RELEASE_PUBLISHED_AT,
  parseActionReferences,
  parsePrivateInventory,
  parseResolvedActionSha,
  parseWorkflowIndirections,
  PRIVATE_INVENTORY_TOTAL,
  PUBLIC_INVENTORY,
  SCHEMA_VERSION,
  serializeArtifact,
  SETUP_STEP_NAME,
  type AncestryResult,
  type CollectInput,
  type CollectorAdapters,
  type InventoryEntry,
  type ProducerIdentity,
  type PublicDisposition,
  type RepositoryResult,
  type RunJobEvidence,
  type RunJobsResult,
  type RunLogsResult,
  type RunPageResult,
  type WorkflowContentResult,
  type WorkflowPathsResult,
  type WorkflowRun,
} from './collect-dmr-runtime-verification.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const V0_SHA = '620a314e241ec2f4a72167eb1ad2c5a3a909cc86'
const OLD_V0_SHA = 'a31e0ad13a77e4f815b73c25dbcb214e82796728'
const OTHER_SHA = '11bd71901bbe5b1630ceea73d27597364c9af683'
const PREFLIGHT_SHA = CREDENTIAL_PREFLIGHT_COMMIT

const PUBLIC_ENTRY: InventoryEntry = {
  owner: 'example',
  repo: 'widget',
  workflowPaths: ['.github/workflows/fro-bot.yaml'],
}

const PRIVATE_OWNER = 'private-canary-owner'
const PRIVATE_REPO_PREFIX = 'private-canary-repo'

function privateEntries(): readonly InventoryEntry[] {
  return [1, 2, 3].map(index => ({
    owner: PRIVATE_OWNER,
    repo: `${PRIVATE_REPO_PREFIX}-${index}`,
    workflowPaths: ['.github/workflows/fro-bot.yaml'],
  }))
}

const PRODUCER: ProducerIdentity = {
  runId: '4242',
  runAttempt: '2',
  schedule: DAILY_SCHEDULE_CRON,
  generatedAt: '2026-09-11T21:00:00Z',
}

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 1001,
    runAttempt: 1,
    event: 'issue_comment',
    path: '.github/workflows/fro-bot.yaml',
    headSha: 'abc123def456abc123def456abc123def456abcd',
    createdAt: '2026-09-11T20:00:00Z',
    conclusion: 'success',
    htmlUrl: 'https://github.com/example/widget/actions/runs/1001',
    headRepositoryFullName: 'example/widget',
    ...overrides,
  }
}

function resolvedLine(sha: string, ref = V0_SHA): string {
  // Mirrors a genuine `gh run view --log` line: the runner emits the download record during job
  // setup and gh attributes it to its sentinel setup step, so that step field is the anchor.
  return `fro-bot\t${SETUP_STEP_NAME}\t2026-09-11T20:00:00.0000000Z Download action repository 'fro-bot/agent@${ref}' (SHA:${sha})\n`
}

function forgedLine(sha: string, ref = V0_SHA): string {
  // A repository-controlled step can print this text, and `gh run view --log` prefixes EVERY line
  // with `job\tstep\ttimestamp` — so a forged line carries a full prefix under an ordinary step name.
  return `Fro Bot\tRun echo\t2026-09-11T20:00:00.0000000Z Download action repository 'fro-bot/agent@${ref}' (SHA:${sha})\n`
}

function workflowContent(ref = V0_SHA): string {
  return ['jobs:', '  fro-bot:', '    steps:', `      - uses: fro-bot/agent@${ref} # v0.111.0`, ''].join('\n')
}

interface FakeAdapterConfig {
  readonly repository?: (entry: InventoryEntry) => RepositoryResult | Promise<RepositoryResult>
  readonly runPages?: (entry: InventoryEntry, page: number) => RunPageResult | Promise<RunPageResult>
  readonly workflowPaths?: (
    entry: InventoryEntry,
  ) => readonly string[] | WorkflowPathsResult | Promise<readonly string[] | WorkflowPathsResult>
  readonly workflowContent?: (
    entry: InventoryEntry,
    path: string,
    ref: string,
  ) => WorkflowContentResult | Promise<WorkflowContentResult>
  readonly logs?: (entry: InventoryEntry, runId: number, attempt: number) => RunLogsResult | Promise<RunLogsResult>
  readonly jobs?: (entry: InventoryEntry, runId: number, attempt: number) => RunJobsResult | Promise<RunJobsResult>
  readonly ancestry?: (sha: string) => AncestryResult | Promise<AncestryResult>
}

function successfulJob(): RunJobEvidence {
  return {status: 'completed', conclusion: 'success', steps: [{status: 'completed', conclusion: 'success'}]}
}

const UNRELATED_WORKFLOW_PATH = '.github/workflows/unrelated.yaml'

function makeAdapters(config: FakeAdapterConfig = {}): CollectorAdapters {
  const repository =
    config.repository ??
    ((entry: InventoryEntry): RepositoryResult =>
      entry.owner === PUBLIC_ENTRY.owner
        ? {ok: true, fullName: `${entry.owner}/${entry.repo}`, archived: false, defaultBranch: 'main', private: false}
        : {ok: true, fullName: `${entry.owner}/${entry.repo}`, archived: true, defaultBranch: 'main', private: true})
  return {
    getRepository: async entry => repository(entry),
    listRunPage: async (entry, page) => config.runPages?.(entry, page) ?? {ok: true, runs: [], nextPage: null},
    listWorkflowPaths: async entry => {
      const paths = await (config.workflowPaths?.(entry) ?? entry.workflowPaths)
      return isWorkflowPathsResult(paths) ? paths : {ok: true, paths}
    },
    getWorkflowContent: async (entry, path, ref) =>
      config.workflowContent?.(entry, path, ref) ?? {ok: true, content: workflowContent()},
    getRunLogs: async (entry, runId, attempt) =>
      config.logs?.(entry, runId, attempt) ?? {ok: true, text: resolvedLine(V0_SHA)},
    getRunJobs: async (entry, runId, attempt) =>
      config.jobs?.(entry, runId, attempt) ?? {ok: true, jobs: [successfulJob()]},
    isDescendantOfPreflight: async sha => config.ancestry?.(sha) ?? {ok: true, descendant: true},
  }
}

function isWorkflowPathsResult(value: readonly string[] | WorkflowPathsResult): value is WorkflowPathsResult {
  return typeof value === 'object' && value !== null && 'ok' in value
}

async function collect(overrides: Partial<CollectInput> & {readonly adapters: CollectorAdapters}) {
  return collectRuntimeVerification({
    producer: PRODUCER,
    publicInventory: [PUBLIC_ENTRY],
    privateInventory: privateEntries(),
    now: () => new Date('2026-09-11T21:00:00Z'),
    ...overrides,
  })
}

function publicRecord(records: readonly PublicDisposition[]): PublicDisposition {
  const record = records.find(candidate => candidate.repository === 'example/widget')
  if (record === undefined) {
    throw new Error('expected a public disposition for example/widget')
  }
  return record
}

// ---------------------------------------------------------------------------
// Inventory contract
// ---------------------------------------------------------------------------

describe('PUBLIC_INVENTORY', () => {
  it('pins exactly 24 unique public repository/workflow entries', () => {
    // #given / #when
    const keys = PUBLIC_INVENTORY.map(entry => `${entry.owner}/${entry.repo}`)

    // #then
    expect(PUBLIC_INVENTORY).toHaveLength(24)
    expect(new Set(keys).size).toBe(24)
    for (const entry of PUBLIC_INVENTORY) {
      expect(entry.owner.length).toBeGreaterThan(0)
      expect(entry.repo.length).toBeGreaterThan(0)
      expect(entry.workflowPaths.length).toBeGreaterThan(0)
      for (const workflow of entry.workflowPaths) {
        expect(workflow.startsWith('.github/workflows/')).toBe(true)
      }
    }
  })

  it('pins the three-private-entry total and the release baseline', () => {
    // #given / #when / #then
    expect(PRIVATE_INVENTORY_TOTAL).toBe(3)
    expect(SCHEMA_VERSION).toBe(1)
    expect(MINIMUM_RELEASE).toBe('v0.111.0')
    expect(MINIMUM_RELEASE_PUBLISHED_AT).toBe('2026-09-11T19:28:19Z')
    expect(PREFLIGHT_SHA).toMatch(/^[0-9a-f]{40}$/)
    expect(AFFECTED_EVENTS).toEqual(['pull_request', 'issue_comment', 'issues'])
  })
})

// ---------------------------------------------------------------------------
// Private inventory parsing
// ---------------------------------------------------------------------------

describe('parsePrivateInventory', () => {
  it('parses a well-formed three-entry JSON secret', () => {
    // #given
    const raw = JSON.stringify(privateEntries())

    // #when
    const result = parsePrivateInventory(raw)

    // #then
    expect(result.ok).toBe(true)
    const entries = result.ok ? result.entries : []
    expect(entries).toHaveLength(3)
    expect(entries[0]?.owner).toBe(PRIVATE_OWNER)
  })

  it('rejects malformed JSON without echoing the input', () => {
    // #given
    const raw = `[{"owner":"${PRIVATE_OWNER}","repo":"${PRIVATE_REPO_PREFIX}`

    // #when
    const result = parsePrivateInventory(raw)

    // #then
    expect(result.ok).toBe(false)
    const reason = result.ok ? '' : result.reason
    expect(reason).toBe('malformed-json')
    expect(reason.includes(PRIVATE_OWNER)).toBe(false)
  })

  it('rejects a non-array, a wrong count, entries missing workflowPaths, and duplicate entries', () => {
    // #given / #when / #then
    expect(parsePrivateInventory(JSON.stringify({})).ok).toBe(false)
    expect(parsePrivateInventory(JSON.stringify([privateEntries()[0]])).ok).toBe(false)
    expect(
      parsePrivateInventory(JSON.stringify([{owner: 'a', repo: 'b'}, privateEntries()[1], privateEntries()[2]])).ok,
    ).toBe(false)
    expect(parsePrivateInventory(undefined).ok).toBe(false)
    const duplicate = [privateEntries()[0], privateEntries()[0], privateEntries()[1]]
    const duplicateResult = parsePrivateInventory(JSON.stringify(duplicate))
    expect(duplicateResult.ok).toBe(false)
    expect(duplicateResult.ok ? '' : duplicateResult.reason).toBe('duplicate-entry')
  })

  it('rejects case-variant duplicates using case-insensitive identity semantics', () => {
    // #given: three entries that differ only by owner/repo casing cannot contribute three
    // terminal dispositions toward closure.
    const [base] = privateEntries()
    if (base === undefined) {
      throw new Error('expected a private entry fixture')
    }
    const variant = {owner: base.owner.toUpperCase(), repo: base.repo.toUpperCase(), workflowPaths: base.workflowPaths}

    // #when
    const result = parsePrivateInventory(JSON.stringify([base, variant, privateEntries()[1]]))

    // #then
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.reason).toBe('duplicate-entry')
  })
})

// ---------------------------------------------------------------------------
// Action reference and provenance parsing
// ---------------------------------------------------------------------------

describe('extractActionReferences', () => {
  it('extracts a floating v0 reference and a pinned SHA reference', () => {
    // #given / #when / #then
    expect(extractActionReferences(workflowContent('v0'))).toEqual(['v0'])
    expect(extractActionReferences(workflowContent(V0_SHA))).toEqual([V0_SHA])
  })

  it('returns every distinct reference and ignores prose mentions', () => {
    // #given
    const content = [
      '# Fro Bot version: compare `fro-bot/agent@` SHA if present.',
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: fro-bot/agent@v0',
      `      - uses: fro-bot/agent@${OLD_V0_SHA}`,
      "      - uses: 'fro-bot/agent@v0'",
      '      - run: "prose fro-bot/agent@not-a-reference"',
    ].join('\n')

    // #when
    const refs = extractActionReferences(content)

    // #then
    expect(refs).toEqual(['v0', OLD_V0_SHA])
  })

  it('returns an empty list when the action is absent', () => {
    // #given / #when / #then
    expect(extractActionReferences('jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n')).toEqual([])
  })

  it('ignores commented, inert, and run-string mentions', () => {
    // #given
    const content = [
      '# - uses: fro-bot/agent@v0',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: "uses: fro-bot/agent@v0"',
      '      - name: inert prose',
      '        run: echo "fro-bot/agent@v0"',
    ].join('\n')

    // #when / #then
    expect(extractActionReferences(content)).toEqual([])
  })

  it('reports malformed YAML instead of treating text as executable evidence', () => {
    // #given / #when / #then
    expect(parseActionReferences('jobs:\n  build:\n    steps: [\n')).toEqual({ok: false, fetchStatusClass: 'malformed'})
  })
})

describe('parseWorkflowIndirections', () => {
  it('separates direct references from local and external indirections', () => {
    // #given
    const content = [
      'jobs:',
      '  bot:',
      '    uses: ./.github/workflows/fro-bot.yaml',
      '  remote:',
      '    uses: some-org/wrappers/.github/workflows/fro-bot.yaml@v1',
      '  build:',
      '    steps:',
      '      - uses: ./local-action',
      '      - uses: fro-bot/agent@v0',
      '',
    ].join('\n')

    // #when
    const result = parseWorkflowIndirections(content)

    // #then
    expect(result.ok).toBe(true)
    const value = result.ok ? result.value : undefined
    expect(value?.directReferences).toEqual(['v0'])
    expect(value?.localWorkflowPaths).toEqual(['.github/workflows/fro-bot.yaml'])
    expect(value?.localActionPaths).toEqual(['local-action'])
    expect(value?.externalJobWrappers).toEqual(['some-org/wrappers/.github/workflows/fro-bot.yaml@v1'])
  })

  it('finds direct references inside a composite action runs.steps manifest', () => {
    // #given
    const content = ['runs:', '  using: composite', '  steps:', '    - uses: fro-bot/agent@v0', ''].join('\n')

    // #when
    const result = parseWorkflowIndirections(content)

    // #then
    expect(result.ok ? result.value.directReferences : []).toEqual(['v0'])
  })

  it('normalizes a repository-root local reference instead of ignoring it', () => {
    // #given
    const content = ['jobs:', '  build:', '    steps:', '      - uses: ./', ''].join('\n')

    // #when
    const result = parseWorkflowIndirections(content)

    // #then
    expect(result.ok ? result.value.localActionPaths : []).toEqual([''])
  })

  it('fails closed on malformed YAML', () => {
    // #given / #when / #then
    expect(parseWorkflowIndirections('jobs:\n  build:\n    steps: [\n')).toEqual({ok: false, reason: 'malformed'})
  })
})

describe('isQualifiableActionReference', () => {
  it('accepts v0 and full commit SHAs but rejects tags, branches, and short SHAs', () => {
    // #given / #when / #then
    expect(isQualifiableActionReference('v0')).toBe(true)
    expect(isQualifiableActionReference(V0_SHA)).toBe(true)
    expect(isQualifiableActionReference('v0.93.1')).toBe(false)
    expect(isQualifiableActionReference('main')).toBe(false)
    expect(isQualifiableActionReference('620a314')).toBe(false)
  })
})

describe('parseResolvedActionSha', () => {
  it('resolves a single unambiguous action download line', () => {
    // #given
    const logs = `Run started\n${resolvedLine(V0_SHA, 'v0')}`

    // #when
    const result = parseResolvedActionSha(logs, 'v0')

    // #then
    expect(result).toEqual({ok: true, sha: V0_SHA})
  })

  it('tolerates duplicated and reordered lines plus unrelated actions', () => {
    // #given
    const logs = [
      "Download action repository 'actions/checkout@v4' (SHA:11bd71901bbe5b1630ceea73d27597364c9af683)",
      resolvedLine(V0_SHA, 'v0').trim(),
      'some interleaved output',
      resolvedLine(V0_SHA, 'v0').trim(),
    ].join('\n')

    // #when
    const result = parseResolvedActionSha(logs, 'v0')

    // #then
    expect(result).toEqual({ok: true, sha: V0_SHA})
  })

  it('rejects a forged line whose full prefix names an ordinary step', () => {
    // #given: a repository step echoes the phrase; gh prefixes it with that step's own name.
    const logs = forgedLine(V0_SHA, 'v0')

    // #when
    const result = parseResolvedActionSha(logs, 'v0')

    // #then
    expect(result).toEqual({ok: false, reason: 'missing'})
  })

  it('rejects a timestamped download line attributed to a named step', () => {
    // #given: a valid timestamp is not enough; the step field must be the runner setup sentinel.
    const logs = `fro-bot\tBuild\t2026-09-11T20:00:00.0000000Z Download action repository 'fro-bot/agent@v0' (SHA:${V0_SHA})\n`

    // #when / #then
    expect(parseResolvedActionSha(logs, 'v0')).toEqual({ok: false, reason: 'missing'})
  })

  it('fails closed on a truncated line or when no line exists', () => {
    // #given / #when / #then
    expect(parseResolvedActionSha(`Download action repository 'fro-bot/agent@v0' (SHA:${V0_SHA}`, 'v0')).toEqual({
      ok: false,
      reason: 'missing',
    })
    expect(parseResolvedActionSha('no provenance here', 'v0')).toEqual({ok: false, reason: 'missing'})
  })

  it('fails closed when multiple candidate SHAs disagree', () => {
    // #given
    const logs = `${resolvedLine(V0_SHA, 'v0')}${resolvedLine(OTHER_SHA, 'v0')}`

    // #when
    const result = parseResolvedActionSha(logs, 'v0')

    // #then
    expect(result).toEqual({ok: false, reason: 'ambiguous'})
  })
})

// ---------------------------------------------------------------------------
// Aggregation and closure
// ---------------------------------------------------------------------------

describe('aggregatePrivate', () => {
  it('buckets dispositions into aggregate-only counts', () => {
    // #given / #when
    const aggregate = aggregatePrivate(['qualified', 'no-longer-applicable', 'unavailable'])

    // #then
    expect(aggregate).toEqual({total: 3, resolved: 2, unresolved: 0, unavailable: 1})
  })

  it('counts preflight failures as unresolved', () => {
    // #given / #when
    const aggregate = aggregatePrivate(['qualified', 'preflight-failed', 'unresolved'])

    // #then
    expect(aggregate).toEqual({total: 3, resolved: 1, unresolved: 2, unavailable: 0})
  })
})

describe('areRunJobsSuccessful', () => {
  it('accepts completed success, skipped, and neutral jobs and steps', () => {
    // #given / #when / #then
    expect(areRunJobsSuccessful([successfulJob()])).toBe(true)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'skipped', steps: []}])).toBe(true)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'neutral', steps: []}])).toBe(true)
    expect(
      areRunJobsSuccessful([
        {
          status: 'completed',
          conclusion: 'success',
          steps: [
            {status: 'completed', conclusion: 'success'},
            {status: 'completed', conclusion: 'skipped'},
            {status: 'completed', conclusion: 'neutral'},
          ],
        },
      ]),
    ).toBe(true)
  })

  it('rejects bad terminal conclusions and jobs that are not yet completed', () => {
    // #given / #when / #then
    expect(areRunJobsSuccessful([])).toBe(false)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'failure', steps: []}])).toBe(false)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'cancelled', steps: []}])).toBe(false)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'timed_out', steps: []}])).toBe(false)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'action_required', steps: []}])).toBe(false)
    expect(areRunJobsSuccessful([{status: 'completed', conclusion: 'stale', steps: []}])).toBe(false)
    expect(areRunJobsSuccessful([{status: 'in_progress', conclusion: null, steps: []}])).toBe(false)
  })

  it('requires every step of an accepted job to be acceptable', () => {
    // #given / #when / #then
    expect(
      areRunJobsSuccessful([
        {
          status: 'completed',
          conclusion: 'success',
          steps: [
            {status: 'completed', conclusion: 'success'},
            {status: 'completed', conclusion: 'failure'},
          ],
        },
      ]),
    ).toBe(false)
    expect(
      areRunJobsSuccessful([
        {
          status: 'completed',
          conclusion: 'success',
          steps: [
            {status: 'completed', conclusion: 'neutral'},
            {status: 'in_progress', conclusion: null},
          ],
        },
      ]),
    ).toBe(false)
  })
})

describe('isPrivateClosureSatisfied', () => {
  it('requires all three private entries positively terminal in the current artifact', () => {
    // #given / #when / #then
    expect(isPrivateClosureSatisfied({total: 3, resolved: 3, unresolved: 0, unavailable: 0})).toBe(true)
    expect(isPrivateClosureSatisfied({total: 3, resolved: 2, unresolved: 0, unavailable: 1})).toBe(false)
    expect(isPrivateClosureSatisfied({total: 3, resolved: 0, unresolved: 0, unavailable: 3})).toBe(false)
    expect(isPrivateClosureSatisfied({total: 3, resolved: 2, unresolved: 1, unavailable: 0})).toBe(false)
  })
})

describe('determineCollectorStatus', () => {
  it('is ready for all-terminal evidence, partial for mixed, unavailable for all-unavailable', () => {
    // #given / #when / #then
    expect(determineCollectorStatus(['qualified', 'no-longer-applicable'])).toBe('ready')
    expect(determineCollectorStatus(['qualified', 'unresolved'])).toBe('partial')
    expect(determineCollectorStatus(['qualified', 'preflight-failed'])).toBe('partial')
    expect(determineCollectorStatus(['unavailable', 'unavailable'])).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// Artifact envelope
// ---------------------------------------------------------------------------

describe('buildArtifact and serializeArtifact', () => {
  it('produces a schema-v1 envelope bound to producer and baseline', () => {
    // #given
    const record: PublicDisposition = {
      repository: 'example/widget',
      disposition: 'qualified',
      observedAt: '2026-09-11T21:00:00Z',
      fetchStatusClass: 'success',
      rejectionReason: null,
      event: 'issue_comment',
      runId: 1001,
      runAttempt: 1,
      runUrl: 'https://github.com/example/widget/actions/runs/1001',
      workflowPath: '.github/workflows/fro-bot.yaml',
      actionRef: V0_SHA,
      resolvedActionSha: V0_SHA,
    }
    const privateAggregate = aggregatePrivate(['qualified', 'qualified', 'qualified'])

    // #when
    const artifact = buildArtifact({
      producer: PRODUCER,
      baseline: {
        minimumRelease: MINIMUM_RELEASE,
        minimumReleasePublishedAt: MINIMUM_RELEASE_PUBLISHED_AT,
        credentialPreflightCommit: PREFLIGHT_SHA,
      },
      collectorStatus: 'ready',
      publicDispositions: [record],
      privateAggregate,
    })

    // #then
    expect(isSchemaV1Envelope(artifact)).toBe(true)
    expect(artifact.producer).toEqual(PRODUCER)
    expect(artifact.baseline.credentialPreflightCommit).toBe(PREFLIGHT_SHA)
    expect(serializeArtifact(artifact).includes('private-canary')).toBe(false)
  })
})

describe('isSchemaV1Envelope', () => {
  const record: PublicDisposition = {
    repository: 'example/widget',
    disposition: 'qualified',
    observedAt: '2026-09-11T21:00:00Z',
    fetchStatusClass: 'success',
    rejectionReason: null,
    event: 'issue_comment',
    runId: 1001,
    runAttempt: 1,
    runUrl: 'https://github.com/example/widget/actions/runs/1001',
    workflowPath: '.github/workflows/fro-bot.yaml',
    actionRef: V0_SHA,
    resolvedActionSha: V0_SHA,
  }
  const artifact = buildArtifact({
    producer: PRODUCER,
    baseline: {
      minimumRelease: MINIMUM_RELEASE,
      minimumReleasePublishedAt: MINIMUM_RELEASE_PUBLISHED_AT,
      credentialPreflightCommit: PREFLIGHT_SHA,
    },
    collectorStatus: 'ready',
    publicDispositions: [record],
    privateAggregate: aggregatePrivate(['qualified', 'qualified', 'qualified']),
  })

  it('validates every public entry field and type, not just the container', () => {
    // #given / #when / #then
    expect(isSchemaV1Envelope(artifact)).toBe(true)
    expect(isSchemaV1Envelope({...artifact, public: [{...record, runId: 'one'}]})).toBe(false)
    expect(isSchemaV1Envelope({...artifact, public: [{repository: 'example/widget', disposition: 'qualified'}]})).toBe(
      false,
    )
    expect(isSchemaV1Envelope({...artifact, public: [{...record, disposition: 'bogus'}]})).toBe(false)
    expect(isSchemaV1Envelope({...artifact, public: [{...record, fetchStatusClass: 'not-a-class'}]})).toBe(false)
    expect(isSchemaV1Envelope({...artifact, public: ['not-an-object']})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// End-to-end orchestration with injected adapters
// ---------------------------------------------------------------------------

describe('collectRuntimeVerification', () => {
  it('qualifies a post-release affected-event success with v0 provenance', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('qualified')
    expect(record.fetchStatusClass).toBe('success')
    expect(record.event).toBe('issue_comment')
    expect(record.runId).toBe(1001)
    expect(record.runAttempt).toBe(1)
    expect(record.runUrl).toBe('https://github.com/example/widget/actions/runs/1001')
    expect(record.actionRef).toBe(V0_SHA)
    expect(record.resolvedActionSha).toBe(V0_SHA)
    expect(artifact.collectorStatus).toBe('ready')
    expect(artifact.private).toEqual({total: 3, resolved: 3, unresolved: 0, unavailable: 0})
  })

  it('qualifies a freely pinned @v0 reference too', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
      logs: () => ({ok: true, text: resolvedLine(V0_SHA, 'v0')}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    expect(publicRecord(artifact.public).disposition).toBe('qualified')
    expect(publicRecord(artifact.public).actionRef).toBe('v0')
  })

  it('rejects a fork pull request even when logs contain a forged download line', async () => {
    // #given
    let logsRequested = false
    const adapters = makeAdapters({
      runPages: () => ({
        ok: true,
        runs: [run({event: 'pull_request', headRepositoryFullName: 'attacker/widget'})],
        nextPage: null,
      }),
      logs: () => {
        logsRequested = true
        return {ok: true, text: resolvedLine(V0_SHA)}
      },
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe(FORK_PULL_REQUEST_REJECTION_REASON)
    expect(logsRequested).toBe(false)
  })

  it('requires every executable Fro Bot reference to be qualifiable', async () => {
    // #given
    const mixedReferences = [
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: fro-bot/agent@v0',
      '      - uses: fro-bot/agent@v0.93.1',
    ].join('\n')
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: mixedReferences}),
    })

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('non-qualifiable-action-reference')
  })

  it('fails closed on malformed workflow YAML', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: 'jobs:\n  build:\n    steps: [\n'}),
    })

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.disposition).toBe('unavailable')
    expect(record.fetchStatusClass).toBe('malformed')
  })

  it('resolves an archived repository as no-longer-applicable', async () => {
    // #given
    const adapters = makeAdapters({
      repository: () => ({ok: true, fullName: 'example/widget', archived: true, defaultBranch: 'main', private: false}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('no-longer-applicable')
    expect(record.rejectionReason).toBe('repository-archived')
    expect(record.fetchStatusClass).toBe('success')
  })

  it('resolves a default branch with no remaining Fro Bot consumer as no-longer-applicable', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowContent: () => ({ok: true, content: 'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('no-longer-applicable')
    expect(record.rejectionReason).toBe('workflow-removed')
  })

  it('does not infer workflow removal from configured paths when another current workflow consumes Fro Bot', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/renamed.yaml'],
      workflowContent: (_entry, path) =>
        path === '.github/workflows/renamed.yaml'
          ? {ok: true, content: workflowContent('v0')}
          : {ok: true, content: 'jobs: {}'},
    })

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('no-qualifying-run')
  })

  it('permits workflow removal only after full current-workflow enumeration succeeds', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml', '.github/workflows/release.yaml'],
      workflowContent: () => ({ok: true, content: 'jobs: {}'}),
    })

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.disposition).toBe('no-longer-applicable')
    expect(record.rejectionReason).toBe('workflow-removed')
  })

  it('classifies a success without an unambiguous action line as unresolved', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      logs: () => ({ok: true, text: 'run succeeded but no action download line was retained\n'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('missing-action-resolution')
  })

  it('fails closed on realistic duplicated/truncated/reordered log fixtures', async () => {
    // #given
    const ambiguous = `${resolvedLine(V0_SHA, 'v0')}${resolvedLine(OTHER_SHA, 'v0')}`
    const adaptersAmbiguous = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
      logs: () => ({ok: true, text: ambiguous}),
    })
    const adaptersTruncated = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
      logs: () => ({ok: true, text: `Download action repository 'fro-bot/agent@v0' (SHA:${V0_SHA}`}),
    })

    // #when
    const artifactAmbiguous = await collect({adapters: adaptersAmbiguous})
    const artifactTruncated = await collect({adapters: adaptersTruncated})

    // #then
    expect(publicRecord(artifactAmbiguous.public).rejectionReason).toBe('ambiguous-action-resolution')
    expect(publicRecord(artifactTruncated.public).rejectionReason).toBe('missing-action-resolution')
  })

  it('does not qualify a non-descendant resolved action SHA', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      logs: () => ({ok: true, text: resolvedLine(OLD_V0_SHA, OLD_V0_SHA)}),
      workflowContent: () => ({ok: true, content: workflowContent(OLD_V0_SHA)}),
      ancestry: () => ({ok: true, descendant: false}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('non-descendant-action-sha')
  })

  it('does not qualify a non-v0 action reference', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: workflowContent('v0.93.1')}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('non-qualifiable-action-reference')
  })

  it('reports a preflight refusal as preflight-failed without qualifying', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({conclusion: 'failure'})], nextPage: null}),
      logs: () => ({ok: true, text: `##[error]${CREDENTIAL_REFUSAL_MARKER}: origin URL carries a credential\n`}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('preflight-failed')
    expect(record.rejectionReason).toBe('credential-preflight-refused')
    expect(record.fetchStatusClass).toBe('success')
  })

  it('lets a later successful rerun attempt qualify and carry its attempt metadata', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({
        ok: true,
        runs: [
          run({id: 2001, runAttempt: 1, conclusion: 'failure', createdAt: '2026-09-11T20:00:00Z'}),
          run({id: 2001, runAttempt: 2, conclusion: 'success', createdAt: '2026-09-11T20:30:00Z'}),
        ],
        nextPage: null,
      }),
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
      logs: (_entry, _runId, attempt) =>
        attempt === 1
          ? {ok: true, text: `##[error]${CREDENTIAL_REFUSAL_MARKER}\n`}
          : {ok: true, text: resolvedLine(V0_SHA, 'v0')},
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('qualified')
    expect(record.runId).toBe(2001)
    expect(record.runAttempt).toBe(2)
  })

  it('ignores pre-release and non-affected runs', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({
        ok: true,
        runs: [
          run({id: 3001, createdAt: '2026-09-11T19:00:00Z'}),
          run({id: 3002, event: 'push'}),
          run({id: 3003, path: '.github/workflows/unrelated.yaml'}),
        ],
        nextPage: null,
      }),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('no-qualifying-run')
  })

  it('returns unavailable when pagination exhausts the configured bound', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: (_entry, page) => ({ok: true, runs: [run({id: page})], nextPage: page + 1}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('pagination-bound-exhausted')
    expect(LIMITS.maxRunPages).toBeGreaterThan(0)
  })

  it('continues across run pages until a candidate qualifies', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: (_entry, page) =>
        page === 1
          ? {ok: true, runs: [run({id: 7001, event: 'push'})], nextPage: 2}
          : {ok: true, runs: [run({id: 7002})], nextPage: null},
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
      logs: () => ({ok: true, text: resolvedLine(V0_SHA, 'v0')}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    expect(publicRecord(artifact.public).disposition).toBe('qualified')
    expect(publicRecord(artifact.public).runId).toBe(7002)
  })

  it('stops paginating at the release boundary instead of trusting later pages', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: (_entry, page) =>
        page === 1
          ? {
              ok: true,
              runs: [
                run({id: 8001, createdAt: '2026-09-11T20:00:00Z'}),
                run({id: 8000, createdAt: '2026-09-11T19:00:00Z'}),
              ],
              nextPage: 2,
            }
          : {ok: false, fetchStatusClass: 'error'},
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    expect(publicRecord(artifact.public).disposition).toBe('qualified')
    expect(publicRecord(artifact.public).runId).toBe(8001)
  })

  it('does not let runs from unrelated workflow paths terminate pagination', async () => {
    // #given: page one holds only an unrelated-path pre-release run; the qualifying run for
    // this entry lives on page two and must still be reached.
    const adapters = makeAdapters({
      runPages: (_entry, page) =>
        page === 1
          ? {
              ok: true,
              runs: [run({id: 9001, path: UNRELATED_WORKFLOW_PATH, createdAt: '2026-09-11T19:00:00Z'})],
              nextPage: 2,
            }
          : {ok: true, runs: [run({id: 9002, createdAt: '2026-09-11T20:00:00Z'})], nextPage: null},
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('qualified')
    expect(record.runId).toBe(9002)
  })

  it('does not spend the candidate-log budget on unrelated workflow paths', async () => {
    // #given: more unrelated-path runs than the log budget, plus one qualifying relevant run.
    const unrelated = Array.from({length: LIMITS.maxCandidateLogs + 2}, (_value, index) =>
      run({
        id: 9100 + index,
        path: UNRELATED_WORKFLOW_PATH,
        createdAt: `2026-09-11T20:${String(index).padStart(2, '0')}:00Z`,
      }),
    )
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [...unrelated, run({id: 9200})], nextPage: null}),
      logs: () => ({ok: true, text: resolvedLine(V0_SHA)}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('qualified')
    expect(record.runId).toBe(9200)
  })

  it('returns unavailable when candidate log work exhausts the configured bound', async () => {
    // #given
    const candidates = Array.from({length: LIMITS.maxCandidateLogs + 1}, (_value, index) =>
      run({id: 4000 + index, createdAt: `2026-09-11T20:${String(index).padStart(2, '0')}:00Z`}),
    )
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: candidates, nextPage: null}),
      logs: () => ({ok: true, text: 'no action line\n'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('candidate-log-bound-exhausted')
  })

  it('keeps private 403 and 404 unavailable', async () => {
    // #given
    const adapters = makeAdapters({
      repository: entry =>
        entry.owner === PUBLIC_ENTRY.owner
          ? {ok: true, fullName: 'example/widget', archived: false, defaultBranch: 'main', private: false}
          : {ok: false, fetchStatusClass: 'not-found'},
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    expect(publicRecord(artifact.public).disposition).toBe('unresolved')
    expect(artifact.private).toEqual({total: 3, resolved: 0, unresolved: 0, unavailable: 3})
    expect(artifact.collectorStatus).toBe('partial')
  })

  it('keeps a public repository 404 unavailable rather than classifying deletion', async () => {
    // #given
    const adapters = makeAdapters({repository: () => ({ok: false, fetchStatusClass: 'not-found'})})

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('repository-unavailable')
    expect(record.fetchStatusClass).toBe('not-found')
  })

  it('rejects canonical identity and visibility mismatches before collecting runs', async () => {
    // #given
    let runsRequested = false
    const identityMismatch = makeAdapters({
      repository: () => ({
        ok: true,
        fullName: 'redirected/elsewhere',
        archived: false,
        defaultBranch: 'main',
        private: false,
      }),
      runPages: () => {
        runsRequested = true
        return {ok: true, runs: [], nextPage: null}
      },
    })

    // #when / #then
    const identityRecord = publicRecord((await collect({adapters: identityMismatch})).public)
    expect(identityRecord.disposition).toBe('unavailable')
    expect(identityRecord.rejectionReason).toBe('repository-identity-mismatch')
    expect(runsRequested).toBe(false)

    const visibilityMismatch = makeAdapters({
      repository: () => ({ok: true, fullName: 'example/widget', archived: false, defaultBranch: 'main', private: true}),
      runPages: () => {
        throw new Error('run collection must not start')
      },
    })
    const visibilityRecord = publicRecord((await collect({adapters: visibilityMismatch})).public)
    expect(visibilityRecord.disposition).toBe('unavailable')
    expect(visibilityRecord.rejectionReason).toBe('repository-visibility-mismatch')
    expect(visibilityRecord.runId).toBeNull()
    expect(visibilityRecord.runUrl).toBeNull()
    expect(serializeArtifact(await collect({adapters: visibilityMismatch})).includes('/actions/runs/')).toBe(false)
  })

  it('reports adapter failures as unavailable for public repositories', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: false, fetchStatusClass: 'malformed'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unavailable')
    expect(record.fetchStatusClass).toBe('malformed')
  })

  it('yields an unavailable artifact for invalid private inventory without exposing it', async () => {
    // #given
    const adapters = makeAdapters({})

    // #when
    const artifact = await collect({adapters, privateInventory: null})
    const serialized = serializeArtifact(artifact)

    // #then
    expect(artifact.collectorStatus).toBe('unavailable')
    expect(artifact.private).toEqual({total: 3, resolved: 0, unresolved: 0, unavailable: 3})
    expect(serialized.includes(PRIVATE_OWNER)).toBe(false)
    expect(serialized.includes(PRIVATE_REPO_PREFIX)).toBe(false)
  })

  it('never serializes private names, URLs, or per-repository state', async () => {
    // #given
    const adapters = makeAdapters({
      repository: () => ({ok: true, fullName: 'example/widget', archived: false, defaultBranch: 'main', private: true}),
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
    })

    // #when
    const artifact = await collect({
      adapters,
      // A private failure whose raw error would otherwise carry identity canaries.
      privateInventory: privateEntries(),
    })
    const serialized = serializeArtifact(artifact)

    // #then
    expect(serialized.includes(PRIVATE_OWNER)).toBe(false)
    expect(serialized.includes(PRIVATE_REPO_PREFIX)).toBe(false)
    expect(artifact.private.total).toBe(3)
    expect(Object.keys(artifact.private)).toEqual(['total', 'resolved', 'unresolved', 'unavailable'])
  })

  it('emits a schema-valid artifact on every recoverable path', async () => {
    // #given
    const configs: readonly FakeAdapterConfig[] = [
      {runPages: () => ({ok: true, runs: [run()], nextPage: null})},
      {runPages: () => ({ok: false, fetchStatusClass: 'timeout'})},
      {logs: () => ({ok: false, fetchStatusClass: 'rate-limited'})},
    ]

    // #when / #then
    for (const config of configs) {
      const artifact = await collect({
        adapters: makeAdapters({
          ...config,
          runPages: config.runPages ?? (() => ({ok: true, runs: [run()], nextPage: null})),
        }),
      })
      expect(isSchemaV1Envelope(artifact)).toBe(true)
    }
  })

  it('binds the artifact to the producer run identity and release baseline', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    expect(artifact.producer).toEqual(PRODUCER)
    expect(artifact.baseline.minimumRelease).toBe(MINIMUM_RELEASE)
    expect(artifact.baseline.minimumReleasePublishedAt).toBe(MINIMUM_RELEASE_PUBLISHED_AT)
    expect(artifact.baseline.credentialPreflightCommit).toBe(PREFLIGHT_SHA)
  })

  it('is deterministic across repeated runs with the same fixtures', async () => {
    // #given
    const build = () => makeAdapters({runPages: () => ({ok: true, runs: [run()], nextPage: null})})

    // #when
    const first = await collect({adapters: build()})
    const second = await collect({adapters: build()})

    // #then
    expect(serializeArtifact(first)).toBe(serializeArtifact(second))
  })

  it('does not qualify a forged bare action-download echo on an issue_comment run', async () => {
    // #given: a repository-controlled step echoes the phrase; gh prefixes it with an ordinary step name.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({event: 'issue_comment'})], nextPage: null}),
      logs: () => ({ok: true, text: forgedLine(V0_SHA)}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('missing-action-resolution')
  })

  it('does not qualify a forged bare action-download echo on an issues run', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({event: 'issues'})], nextPage: null}),
      logs: () => ({ok: true, text: forgedLine(V0_SHA)}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('missing-action-resolution')
  })

  it('does not qualify a forged bare action-download echo on a same-repository pull_request run', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({event: 'pull_request'})], nextPage: null}),
      logs: () => ({ok: true, text: forgedLine(V0_SHA)}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('missing-action-resolution')
  })

  it('does not qualify a successful overall run whose Fro Bot step refused credentials', async () => {
    // #given: a downstream continue-on-error step refuses credentials while the run concludes success.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({conclusion: 'success'})], nextPage: null}),
      logs: () => ({ok: true, text: `${resolvedLine(V0_SHA)}\n##[error]${CREDENTIAL_REFUSAL_MARKER}\n`}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('preflight-failed')
    expect(record.rejectionReason).toBe('credential-preflight-refused')
  })

  it('classifies unavailable when authenticated job evidence cannot be retrieved', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      jobs: () => ({ok: false, fetchStatusClass: 'forbidden'}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('run-jobs-unavailable')
    expect(record.fetchStatusClass).toBe('forbidden')
  })

  it('does not qualify a successful overall run whose job evidence shows a failure', async () => {
    // #given: overall run success with a failed job (for example a continue-on-error step).
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({conclusion: 'success'})], nextPage: null}),
      jobs: () => ({ok: true, jobs: [{status: 'completed', conclusion: 'failure', steps: []}]}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('run-jobs-not-successful')
  })

  it('qualifies a run whose conditional step was legitimately skipped', async () => {
    // #given: an `if:`-guarded downstream step concluded skipped, which is a normal outcome.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({conclusion: 'success'})], nextPage: null}),
      jobs: () => ({
        ok: true,
        jobs: [
          {
            status: 'completed',
            conclusion: 'success',
            steps: [
              {status: 'completed', conclusion: 'success'},
              {status: 'completed', conclusion: 'skipped'},
            ],
          },
        ],
      }),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('qualified')
  })

  it('does not qualify when one of several jobs failed', async () => {
    // #given: the overall run succeeded but one job recorded a failure conclusion.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({conclusion: 'success'})], nextPage: null}),
      jobs: () => ({
        ok: true,
        jobs: [
          {status: 'completed', conclusion: 'success', steps: [{status: 'completed', conclusion: 'success'}]},
          {status: 'completed', conclusion: 'failure', steps: [{status: 'completed', conclusion: 'failure'}]},
        ],
      }),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('run-jobs-not-successful')
  })

  it('does not fetch job evidence for a candidate that fails provenance first', async () => {
    // #given: workflow content is unavailable, so provenance fails before job evidence is needed.
    let jobsCalls = 0
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: false, fetchStatusClass: 'forbidden'}),
      jobs: () => {
        jobsCalls += 1
        return {ok: true, jobs: [successfulJob()]}
      },
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('workflow-content-unavailable')
    expect(jobsCalls).toBe(0)
  })

  it('surfaces a log retrieval timeout as unavailable', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      logs: () => ({ok: false, fetchStatusClass: 'timeout'}),
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('run-logs-unavailable')
    expect(record.fetchStatusClass).toBe('timeout')
  })

  it('does not classify a local composite-action consumer as workflow-removed', async () => {
    // #given: the only Fro Bot reference lives behind a local composite action directory.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml'],
      workflowContent: (_entry, path) => {
        if (path === '.github/workflows/ci.yaml') {
          return {ok: true, content: ['jobs:', '  build:', '    steps:', '      - uses: ./local-action', ''].join('\n')}
        }
        if (path === 'local-action/action.yml') {
          return {
            ok: true,
            content: ['runs:', '  using: composite', '  steps:', '    - uses: fro-bot/agent@v0', ''].join('\n'),
          }
        }
        return {ok: false, fetchStatusClass: 'not-found'}
      },
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('no-qualifying-run')
  })

  it('does not classify a local reusable-workflow consumer as workflow-removed', async () => {
    // #given: the only Fro Bot reference lives behind a local reusable workflow.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml'],
      workflowContent: (_entry, path) =>
        path === '.github/workflows/ci.yaml'
          ? {ok: true, content: ['jobs:', '  bot:', '    uses: ./.github/workflows/fro-bot.yaml', ''].join('\n')}
          : {ok: true, content: workflowContent('v0')},
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('no-qualifying-run')
  })

  it('does not classify workflow-removed when a readable external wrapper consumes Fro Bot', async () => {
    // #given: a non-local reusable workflow is resolved and inspected; it invokes Fro Bot.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml'],
      workflowContent: (entry, path) => {
        if (entry.owner === 'some-org' && entry.repo === 'wrappers') {
          return path === '.github/workflows/fro-bot.yaml'
            ? {ok: true, content: workflowContent('v0')}
            : {ok: false, fetchStatusClass: 'not-found'}
        }
        return {
          ok: true,
          content: ['jobs:', '  bot:', '    uses: some-org/wrappers/.github/workflows/fro-bot.yaml@v1', ''].join('\n'),
        }
      },
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unresolved')
    expect(record.rejectionReason).toBe('no-qualifying-run')
  })

  it('classifies workflow-removed when a readable external wrapper has no Fro Bot reference', async () => {
    // #given: the external wrapper is fully readable and free of Fro Bot references.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml'],
      workflowContent: (entry, path) => {
        if (entry.owner === 'some-org' && entry.repo === 'wrappers') {
          return path === '.github/workflows/fro-bot.yaml'
            ? {ok: true, content: ['jobs:', '  build:', '    steps:', '      - run: echo clean', ''].join('\n')}
            : {ok: false, fetchStatusClass: 'not-found'}
        }
        return {
          ok: true,
          content: ['jobs:', '  bot:', '    uses: some-org/wrappers/.github/workflows/fro-bot.yaml@v1', ''].join('\n'),
        }
      },
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('no-longer-applicable')
    expect(record.rejectionReason).toBe('workflow-removed')
  })

  it('fails closed when an external reusable-workflow wrapper cannot be resolved', async () => {
    // #given: the external wrapper cannot be fetched, so removal cannot be proven.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml'],
      workflowContent: entry => {
        if (entry.owner === 'some-org' && entry.repo === 'wrappers') {
          return {ok: false, fetchStatusClass: 'forbidden'}
        }
        return {
          ok: true,
          content: ['jobs:', '  bot:', '    uses: some-org/wrappers/.github/workflows/fro-bot.yaml@v1', ''].join('\n'),
        }
      },
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('indirect-wrapper-unresolved')
    expect(record.fetchStatusClass).toBe('forbidden')
  })

  it('continues to an older candidate when the newest candidate is unavailable', async () => {
    // #given: the newest candidate's logs cannot be retrieved; an older candidate qualifies.
    const adapters = makeAdapters({
      runPages: () => ({
        ok: true,
        runs: [run({id: 6001, createdAt: '2026-09-11T20:30:00Z'}), run({id: 6002, createdAt: '2026-09-11T20:00:00Z'})],
        nextPage: null,
      }),
      logs: (_entry, runId) =>
        runId === 6001 ? {ok: false, fetchStatusClass: 'timeout'} : {ok: true, text: resolvedLine(V0_SHA)},
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.disposition).toBe('qualified')
    expect(record.runId).toBe(6002)
  })

  it('reports an uncertain default-branch workflow read as unavailable', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowContent: () => ({ok: false, fetchStatusClass: 'forbidden'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.disposition).toBe('unavailable')
    expect(record.rejectionReason).toBe('workflow-read-unavailable')
    expect(record.fetchStatusClass).toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// Live adapter boundary (response size, request duration, HTTP classification)
// ---------------------------------------------------------------------------

describe('createGitHubAdapters', () => {
  it('returns the validated canonical repository identity and visibility fields', async () => {
    // #given
    const adapters = createGitHubAdapters({
      token: 'fixture-token',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({full_name: 'Example/Widget', private: false, archived: false, default_branch: 'trunk'}),
          {status: 200},
        ),
    })

    // #when / #then
    await expect(adapters.getRepository(PUBLIC_ENTRY)).resolves.toEqual({
      ok: true,
      fullName: 'Example/Widget',
      private: false,
      archived: false,
      defaultBranch: 'trunk',
    })
  })

  it('fails closed on a redirected repository response', async () => {
    // #given
    const response = new Response('{}', {status: 200})
    Object.defineProperty(response, 'redirected', {value: true})
    const adapters = createGitHubAdapters({token: 'fixture-token', fetchImpl: async () => response})

    // #when / #then
    await expect(adapters.getRepository(PUBLIC_ENTRY)).resolves.toEqual({ok: false, fetchStatusClass: 'redirect'})
  })

  it('bounds response size before parsing', async () => {
    // #given
    const adapters = createGitHubAdapters({
      token: 'fixture-token',
      maxResponseBytes: 8,
      fetchImpl: async () => new Response(JSON.stringify({archived: false}), {status: 200}),
    })

    // #when
    const result = await adapters.getRepository(PUBLIC_ENTRY)

    // #then
    expect(result).toEqual({ok: false, fetchStatusClass: 'oversized'})
  })

  it('classifies request timeouts and malformed JSON as constant failure classes', async () => {
    // #given
    const timeoutError = new Error('timed out')
    timeoutError.name = 'TimeoutError'
    const timedOut = createGitHubAdapters({
      token: 'fixture-token',
      fetchImpl: async () => {
        throw timeoutError
      },
    })
    const malformed = createGitHubAdapters({
      token: 'fixture-token',
      fetchImpl: async () => new Response('not json', {status: 200}),
    })

    // #when / #then
    expect(await timedOut.getRepository(PUBLIC_ENTRY)).toEqual({ok: false, fetchStatusClass: 'timeout'})
    expect(await malformed.getRepository(PUBLIC_ENTRY)).toEqual({ok: false, fetchStatusClass: 'malformed'})
  })

  it('classifies gh log subprocess timeouts distinctly from other failures', () => {
    // #given / #when / #then
    expect(classifyGhFailure({code: 'ETIMEDOUT'})).toBe('timeout')
    expect(classifyGhFailure({signal: 'SIGKILL'})).toBe('timeout')
    expect(classifyGhFailure({code: 'ENOBUFS'})).toBe('oversized')
    expect(classifyGhFailure({status: 403})).toBe('forbidden')
    expect(classifyGhFailure({status: 429})).toBe('rate-limited')
    expect(classifyGhFailure(new Error('boom'))).toBe('error')
  })

  it('classifies HTTP failures without echoing response bodies', async () => {
    // #given
    const adapters = createGitHubAdapters({
      token: 'fixture-token',
      fetchImpl: async () => new Response(`private-canary-body`, {status: 403}),
    })

    // #when
    const result = await adapters.getRepository(PUBLIC_ENTRY)

    // #then
    expect(result).toEqual({ok: false, fetchStatusClass: 'forbidden'})
    expect(JSON.stringify(result).includes('private-canary-body')).toBe(false)
  })

  it('maps workflow runs and derives the next page from a full page', async () => {
    // #given
    const fullPage = {
      workflow_runs: Array.from({length: LIMITS.runsPerPage}, (_value, index) => ({
        id: index + 1,
        run_attempt: 1,
        event: 'issues',
        path: '.github/workflows/fro-bot.yaml',
        head_sha: 'abc123def456abc123def456abc123def456abcd',
        created_at: '2026-09-11T20:00:00Z',
        conclusion: 'success',
        html_url: `https://github.com/example/widget/actions/runs/${index + 1}`,
      })),
    }
    const adapters = createGitHubAdapters({
      token: 'fixture-token',
      fetchImpl: async () => new Response(JSON.stringify(fullPage), {status: 200}),
    })

    // #when
    const result = await adapters.listRunPage(PUBLIC_ENTRY, 1)

    // #then
    expect(result.ok).toBe(true)
    const runs = result.ok ? result.runs : []
    const nextPage = result.ok ? result.nextPage : null
    expect(runs).toHaveLength(LIMITS.runsPerPage)
    expect(runs[0]?.event).toBe('issues')
    expect(nextPage).toBe(2)
  })
})
