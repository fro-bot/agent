import {describe, expect, it} from 'vitest'
import {
  AFFECTED_EVENTS,
  aggregatePrivate,
  buildArtifact,
  collectRuntimeVerification,
  createGitHubAdapters,
  CREDENTIAL_PREFLIGHT_COMMIT,
  DAILY_SCHEDULE_CRON,
  determineCollectorStatus,
  extractActionReferences,
  FORK_PULL_REQUEST_OBSERVATION,
  isQualifiableActionReference,
  isSchemaV2Envelope,
  LIMITS,
  MINIMUM_RELEASE,
  MINIMUM_RELEASE_PUBLISHED_AT,
  parseActionReferences,
  parsePrivateInventory,
  PRIVATE_INVENTORY_TOTAL,
  PUBLIC_INVENTORY,
  SCHEMA_VERSION,
  serializeArtifact,
  type AncestryResult,
  type CollectInput,
  type CollectorAdapters,
  type InventoryEntry,
  type ProducerIdentity,
  type PublicObservation,
  type RepositoryResult,
  type RunJobsResult,
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
const PREFLIGHT_SHA = CREDENTIAL_PREFLIGHT_COMMIT

const PUBLIC_ENTRY: InventoryEntry = {
  owner: 'example',
  repo: 'widget',
  workflowPaths: ['.github/workflows/fro-bot.yaml'],
}

const ADAPTER_INVENTORY = {publicInventory: [PUBLIC_ENTRY], privateInventory: null} as const

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
  readonly runJobs?: (
    entry: InventoryEntry,
    runId: number,
    runAttempt: number,
  ) => RunJobsResult | Promise<RunJobsResult>
  readonly descendantOfPreflight?: (sha: string) => AncestryResult | Promise<AncestryResult>
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
    getRunJobs: async (entry, runId, runAttempt) => config.runJobs?.(entry, runId, runAttempt) ?? {ok: true, jobs: []},
    isDescendantOfPreflight: async sha => config.descendantOfPreflight?.(sha) ?? {ok: true, descendant: true},
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

function publicRecord(records: readonly PublicObservation[]): PublicObservation {
  const record = records.find(candidate => candidate.repository === 'example/widget')
  if (record === undefined) {
    throw new Error('expected a public observation for example/widget')
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
    expect(SCHEMA_VERSION).toBe(2)
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

// ---------------------------------------------------------------------------
// Aggregation and closure
// ---------------------------------------------------------------------------

describe('aggregatePrivate', () => {
  it('buckets dispositions into unresolved/unavailable counts with observed always zero', () => {
    // #given / #when
    const aggregate = aggregatePrivate(['unresolved', 'preflight-failed', 'unavailable'])

    // #then: this collector has no path to a terminal disposition, so `observed` can never move.
    expect(aggregate).toEqual({total: 3, observed: 0, unresolved: 2, unavailable: 1})
  })

  it('counts preflight failures as unresolved', () => {
    // #given / #when
    const aggregate = aggregatePrivate(['preflight-failed', 'preflight-failed', 'unresolved'])

    // #then
    expect(aggregate).toEqual({total: 3, observed: 0, unresolved: 3, unavailable: 0})
  })
})

describe('determineCollectorStatus', () => {
  it('is partial for any mix of non-unavailable evidence and unavailable only when everything is unavailable', () => {
    // #given / #when / #then: `ready` was removed from `CollectorStatus` now that nothing can
    // produce a terminal disposition; `unresolved`/`preflight-failed` mixes are always `partial`.
    expect(determineCollectorStatus(['unresolved', 'preflight-failed'])).toBe('partial')
    expect(determineCollectorStatus(['unresolved'])).toBe('partial')
    expect(determineCollectorStatus(['preflight-failed'])).toBe('partial')
    expect(determineCollectorStatus(['unavailable', 'unavailable'])).toBe('unavailable')
    expect(determineCollectorStatus([])).toBe('unavailable')
  })
})

// ---------------------------------------------------------------------------
// Artifact envelope
// ---------------------------------------------------------------------------

describe('buildArtifact and serializeArtifact', () => {
  it('produces a schema-v2 envelope bound to producer and baseline', () => {
    // #given
    const record: PublicObservation = {
      repository: 'example/widget',
      state: 'unresolved',
      observedAt: '2026-09-11T21:00:00Z',
      fetchStatusClass: 'success',
      observation: null,
      event: 'issue_comment',
      runId: 1001,
      runAttempt: 1,
      runUrl: 'https://github.com/example/widget/actions/runs/1001',
      workflowPath: '.github/workflows/fro-bot.yaml',
      declaredActionRef: V0_SHA,
      resolvedActionSha: V0_SHA,
      reportedJobs: null,
      ancestryFromPreflight: null,
    }
    const privateAggregate = aggregatePrivate(['unresolved', 'unresolved', 'unresolved'])

    // #when
    const artifact = buildArtifact({
      producer: PRODUCER,
      baseline: {
        minimumRelease: MINIMUM_RELEASE,
        minimumReleasePublishedAt: MINIMUM_RELEASE_PUBLISHED_AT,
        credentialPreflightCommit: PREFLIGHT_SHA,
      },
      collectorStatus: 'partial',
      publicObservations: [record],
      privateAggregate,
    })

    // #then
    expect(isSchemaV2Envelope(artifact)).toBe(true)
    expect(artifact.producer).toEqual(PRODUCER)
    expect(artifact.baseline.credentialPreflightCommit).toBe(PREFLIGHT_SHA)
    expect(serializeArtifact(artifact).includes('private-canary')).toBe(false)
  })
})

describe('isSchemaV2Envelope', () => {
  const record: PublicObservation = {
    repository: 'example/widget',
    state: 'unresolved',
    observedAt: '2026-09-11T21:00:00Z',
    fetchStatusClass: 'success',
    observation: null,
    event: 'issue_comment',
    runId: 1001,
    runAttempt: 1,
    runUrl: 'https://github.com/example/widget/actions/runs/1001',
    workflowPath: '.github/workflows/fro-bot.yaml',
    declaredActionRef: V0_SHA,
    resolvedActionSha: V0_SHA,
    reportedJobs: null,
    ancestryFromPreflight: null,
  }
  const artifact = buildArtifact({
    producer: PRODUCER,
    baseline: {
      minimumRelease: MINIMUM_RELEASE,
      minimumReleasePublishedAt: MINIMUM_RELEASE_PUBLISHED_AT,
      credentialPreflightCommit: PREFLIGHT_SHA,
    },
    collectorStatus: 'partial',
    publicObservations: [record],
    privateAggregate: aggregatePrivate(['unresolved', 'unresolved', 'unresolved']),
  })

  it('validates every public entry field and type, not just the container', () => {
    // #given / #when / #then
    expect(isSchemaV2Envelope(artifact)).toBe(true)
    expect(isSchemaV2Envelope({...artifact, public: [{...record, runId: 'one'}]})).toBe(false)
    expect(isSchemaV2Envelope({...artifact, public: [{repository: 'example/widget', state: 'qualified'}]})).toBe(false)
    expect(isSchemaV2Envelope({...artifact, public: [{...record, state: 'bogus'}]})).toBe(false)
    expect(isSchemaV2Envelope({...artifact, public: [{...record, fetchStatusClass: 'not-a-class'}]})).toBe(false)
    expect(isSchemaV2Envelope({...artifact, public: ['not-an-object']})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// End-to-end orchestration with injected adapters
// ---------------------------------------------------------------------------

describe('collectRuntimeVerification', () => {
  it('leaves a post-release affected-event success non-terminal even with a direct v0 reference', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then: a direct, qualifiable reference is evidence, not proof of terminal qualification.
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('direct-reference-observed')
    expect(record.fetchStatusClass).toBe('success')
    expect(record.event).toBe('issue_comment')
    expect(record.runId).toBe(1001)
    expect(record.runAttempt).toBe(1)
    expect(record.runUrl).toBe('https://github.com/example/widget/actions/runs/1001')
    expect(record.declaredActionRef).toBe(V0_SHA)
    expect(artifact.collectorStatus).toBe('partial')
    expect(artifact.private).toEqual({total: 3, observed: 0, unresolved: 3, unavailable: 0})
  })

  it('accepts a freely pinned @v0 reference as qualifiable but still non-terminal', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.declaredActionRef).toBe('v0')
  })

  it('carries job and step identity through into reported jobs', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      runJobs: () => ({
        ok: true,
        jobs: [
          {
            name: 'fro-bot',
            status: 'completed',
            conclusion: 'success',
            steps: [{name: 'Run fro-bot/agent', number: 3, status: 'completed', conclusion: 'success'}],
          },
        ],
      }),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.reportedJobs).toEqual([
      {
        name: 'fro-bot',
        status: 'completed',
        conclusion: 'success',
        steps: [{name: 'Run fro-bot/agent', number: 3, status: 'completed', conclusion: 'success'}],
      },
    ])
  })

  it('records reportedJobs as null on a jobs-fetch failure, never an empty success', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      runJobs: () => ({ok: false, fetchStatusClass: 'error'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.reportedJobs).toBeNull()
    expect(record.state).toBe('unresolved')
  })

  it('checks preflight ancestry for a literal full-SHA action reference', async () => {
    // #given
    const ancestryCalls: string[] = []
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      descendantOfPreflight: sha => {
        ancestryCalls.push(sha)
        return {ok: true, descendant: false}
      },
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(ancestryCalls).toEqual([V0_SHA])
    expect(record.resolvedActionSha).toBe(V0_SHA)
    expect(record.ancestryFromPreflight).toBe(false)
  })

  it('never resolves a floating reference to a SHA or checks its ancestry', async () => {
    // #given
    const ancestryCalls: string[] = []
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
      descendantOfPreflight: sha => {
        ancestryCalls.push(sha)
        return {ok: true, descendant: true}
      },
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(ancestryCalls).toEqual([])
    expect(record.resolvedActionSha).toBeNull()
    expect(record.ancestryFromPreflight).toBeNull()
  })

  it('stays non-terminal even when every reported job looks fully successful', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      runJobs: () => ({
        ok: true,
        jobs: [
          {
            name: 'fro-bot',
            status: 'completed',
            conclusion: 'success',
            steps: [{name: 'Run fro-bot/agent', number: 1, status: 'completed', conclusion: 'success'}],
          },
        ],
      }),
      descendantOfPreflight: () => ({ok: true, descendant: true}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('direct-reference-observed')
  })

  it('rejects a fork pull request without fetching workflow content', async () => {
    // #given
    let contentRequested = false
    const adapters = makeAdapters({
      runPages: () => ({
        ok: true,
        runs: [run({event: 'pull_request', headRepositoryFullName: 'attacker/widget'})],
        nextPage: null,
      }),
      workflowContent: () => {
        contentRequested = true
        return {ok: true, content: workflowContent()}
      },
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe(FORK_PULL_REQUEST_OBSERVATION)
    expect(contentRequested).toBe(false)
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
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('ineligible-action-reference')
  })

  it('fails closed on malformed workflow YAML', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => ({ok: true, content: 'jobs:\n  build:\n    steps: [\n'}),
    })

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.state).toBe('unavailable')
    expect(record.fetchStatusClass).toBe('malformed')
  })

  it('treats an archived repository as inconclusive rather than removed', async () => {
    // #given
    const adapters = makeAdapters({
      repository: () => ({ok: true, fullName: 'example/widget', archived: true, defaultBranch: 'main', private: false}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then: archival is recorded information, not proof the repository stopped invoking Fro Bot.
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('repository-archived')
    expect(record.fetchStatusClass).toBe('success')
  })

  it('resolves a default branch with no direct reference as unresolved, not removed', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowContent: () => ({ok: true, content: 'jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n'}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('no-direct-reference-observed')
  })

  it('does not infer anything from configured paths when another current workflow consumes Fro Bot', async () => {
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
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('direct-reference-observed')
  })

  it('scans every current workflow path before concluding no direct reference was observed', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowPaths: () => ['.github/workflows/ci.yaml', '.github/workflows/release.yaml'],
      workflowContent: () => ({ok: true, content: 'jobs: {}'}),
    })

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('no-direct-reference-observed')
  })

  it('never treats an external step-level composite action as evidence of qualification or removal', async () => {
    // #given: the workflow only ever invokes an unrelated external action directly; whatever that
    // action does internally is outside this collector's authenticated visibility, and there is no
    // recursive traversal left to go find out.
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [], nextPage: null}),
      workflowContent: () => ({
        ok: true,
        content: ['jobs:', '  build:', '    steps:', '      - uses: some-owner/some-repo@v1', ''].join('\n'),
      }),
    })

    // #when
    const artifact = await collect({adapters})

    // #then: absence of a directly-discovered reference is unresolved, never a removal conclusion.
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('no-direct-reference-observed')
  })

  it('never asks any adapter to fetch an external reusable-workflow target', async () => {
    // #given: the workflow references an arbitrary external reusable workflow at the job level.
    // Recursive external `uses:` traversal was deleted as an unfixable trust-boundary defect that
    // steered a private-capable credential at attacker-controlled repositories; this proves it
    // cannot come back by recording every repository any adapter method is invoked with.
    const calls: {readonly method: string; readonly owner: string; readonly repo: string}[] = []
    const recordCall = (method: string, entry: InventoryEntry): void => {
      calls.push({method, owner: entry.owner, repo: entry.repo})
    }
    const externalWrapperContent = [
      'jobs:',
      '  bot:',
      '    uses: attacker-owner/attacker-repo/.github/workflows/x.yaml@main',
      '',
    ].join('\n')
    const adapters: CollectorAdapters = {
      getRepository: async entry => {
        recordCall('getRepository', entry)
        return entry.owner === PUBLIC_ENTRY.owner
          ? {ok: true, fullName: `${entry.owner}/${entry.repo}`, archived: false, defaultBranch: 'main', private: false}
          : {ok: true, fullName: `${entry.owner}/${entry.repo}`, archived: false, defaultBranch: 'main', private: true}
      },
      listRunPage: async entry => {
        recordCall('listRunPage', entry)
        return {ok: true, runs: [], nextPage: null}
      },
      listWorkflowPaths: async entry => {
        recordCall('listWorkflowPaths', entry)
        return {ok: true, paths: entry.workflowPaths}
      },
      getWorkflowContent: async entry => {
        recordCall('getWorkflowContent', entry)
        return {ok: true, content: externalWrapperContent}
      },
      getRunJobs: async entry => {
        recordCall('getRunJobs', entry)
        return {ok: true, jobs: []}
      },
      isDescendantOfPreflight: async () => ({ok: true, descendant: true}),
    }

    // #when
    const artifact = await collect({adapters})

    // #then
    const publicResult = publicRecord(artifact.public)
    expect(publicResult.state).toBe('unresolved')
    expect(publicResult.observation).toBe('no-direct-reference-observed')
    const knownRepositories = new Set([
      `${PUBLIC_ENTRY.owner}/${PUBLIC_ENTRY.repo}`,
      ...privateEntries().map(entry => `${entry.owner}/${entry.repo}`),
    ])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(knownRepositories.has(`${call.owner}/${call.repo}`)).toBe(true)
    }
    expect(calls.some(call => call.owner === 'attacker-owner' || call.repo === 'attacker-repo')).toBe(false)
  })

  it('treats a Fro Bot step guarded by if: false as non-terminal evidence, not a qualifying run', async () => {
    // #given: the step is statically present in the workflow document regardless of its runtime
    // `if:` guard, since this collector never executes or resolves conditions.
    const guardedContent = [
      'jobs:',
      '  fro-bot:',
      '    steps:',
      '      - if: false',
      '        uses: fro-bot/agent@v0',
      '',
    ].join('\n')
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run({conclusion: 'success'})], nextPage: null}),
      workflowContent: () => ({ok: true, content: guardedContent}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.declaredActionRef).toBe('v0')
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
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('ineligible-action-reference')
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
    expect(record.state).toBe('unresolved')
    expect(record.observation).toBe('direct-reference-observed')
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
    expect(record.state).toBe('unavailable')
    expect(record.observation).toBe('pagination-bound-exhausted')
    expect(LIMITS.maxRunPages).toBeGreaterThan(0)
  })

  it('continues across run pages until a candidate is evaluated', async () => {
    // #given
    const adapters = makeAdapters({
      runPages: (_entry, page) =>
        page === 1
          ? {ok: true, runs: [run({id: 7001, event: 'push'})], nextPage: 2}
          : {ok: true, runs: [run({id: 7002})], nextPage: null},
      workflowContent: () => ({ok: true, content: workflowContent('v0')}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.runId).toBe(7002)
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
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.runId).toBe(8001)
  })

  it('does not let runs from unrelated workflow paths terminate pagination', async () => {
    // #given: page one holds only an unrelated-path pre-release run; the candidate for this
    // entry lives on page two and must still be reached.
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
    expect(record.state).toBe('unresolved')
    expect(record.runId).toBe(9002)
  })

  it('does not spend the candidate budget on unrelated workflow paths', async () => {
    // #given: more unrelated-path runs than the candidate budget, plus one relevant run.
    const unrelated = Array.from({length: LIMITS.maxCandidateLogs + 2}, (_value, index) =>
      run({
        id: 9100 + index,
        path: UNRELATED_WORKFLOW_PATH,
        createdAt: `2026-09-11T20:${String(index).padStart(2, '0')}:00Z`,
      }),
    )
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [...unrelated, run({id: 9200})], nextPage: null}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then: the unrelated-path runs never enter the candidate list, so the budget stays intact.
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unresolved')
    expect(record.runId).toBe(9200)
  })

  it('returns unavailable when candidate evaluation work exhausts the configured bound', async () => {
    // #given
    const candidates = Array.from({length: LIMITS.maxCandidateLogs + 1}, (_value, index) =>
      run({id: 4000 + index, createdAt: `2026-09-11T20:${String(index).padStart(2, '0')}:00Z`}),
    )
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: candidates, nextPage: null}),
    })

    // #when
    const artifact = await collect({adapters})

    // #then
    const record = publicRecord(artifact.public)
    expect(record.state).toBe('unavailable')
    expect(record.observation).toBe('candidate-log-bound-exhausted')
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
    expect(publicRecord(artifact.public).state).toBe('unresolved')
    expect(artifact.private).toEqual({total: 3, observed: 0, unresolved: 0, unavailable: 3})
    expect(artifact.collectorStatus).toBe('partial')
  })

  it('keeps a public repository 404 unavailable rather than classifying deletion', async () => {
    // #given
    const adapters = makeAdapters({repository: () => ({ok: false, fetchStatusClass: 'not-found'})})

    // #when / #then
    const record = publicRecord((await collect({adapters})).public)
    expect(record.state).toBe('unavailable')
    expect(record.observation).toBe('repository-unavailable')
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
    expect(identityRecord.state).toBe('unavailable')
    expect(identityRecord.observation).toBe('repository-identity-mismatch')
    expect(runsRequested).toBe(false)

    const visibilityMismatch = makeAdapters({
      repository: () => ({ok: true, fullName: 'example/widget', archived: false, defaultBranch: 'main', private: true}),
      runPages: () => {
        throw new Error('run collection must not start')
      },
    })
    const visibilityRecord = publicRecord((await collect({adapters: visibilityMismatch})).public)
    expect(visibilityRecord.state).toBe('unavailable')
    expect(visibilityRecord.observation).toBe('repository-visibility-mismatch')
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
    expect(record.state).toBe('unavailable')
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
    expect(artifact.private).toEqual({total: 3, observed: 0, unresolved: 0, unavailable: 3})
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
    expect(Object.keys(artifact.private)).toEqual(['total', 'observed', 'unresolved', 'unavailable'])
  })

  it('emits a schema-valid artifact on every recoverable path', async () => {
    // #given
    const configs: readonly FakeAdapterConfig[] = [
      {runPages: () => ({ok: true, runs: [run()], nextPage: null})},
      {runPages: () => ({ok: false, fetchStatusClass: 'timeout'})},
      {workflowContent: () => ({ok: false, fetchStatusClass: 'rate-limited'})},
    ]

    // #when / #then
    for (const config of configs) {
      const artifact = await collect({
        adapters: makeAdapters({
          ...config,
          runPages: config.runPages ?? (() => ({ok: true, runs: [run()], nextPage: null})),
        }),
      })
      expect(isSchemaV2Envelope(artifact)).toBe(true)
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

  it('reports workflow content unavailable when the candidate provenance fetch fails', async () => {
    // #given
    let contentCalls = 0
    const adapters = makeAdapters({
      runPages: () => ({ok: true, runs: [run()], nextPage: null}),
      workflowContent: () => {
        contentCalls += 1
        return {ok: false, fetchStatusClass: 'forbidden'}
      },
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.state).toBe('unavailable')
    expect(record.observation).toBe('workflow-content-unavailable')
    expect(contentCalls).toBeGreaterThan(0)
  })

  it('reports unavailable when a newer candidate is unavailable, even though an older candidate is definitive', async () => {
    // #given: the newest candidate's workflow content cannot be retrieved; an older candidate
    // resolves cleanly. The newer candidate's unavailability may have been the qualifying run, so
    // that uncertainty must not be discarded in favor of the older, more definitive-looking result.
    const newestSha = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1'
    const olderSha = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
    const adapters = makeAdapters({
      runPages: () => ({
        ok: true,
        runs: [
          run({id: 6001, createdAt: '2026-09-11T20:30:00Z', headSha: newestSha}),
          run({id: 6002, createdAt: '2026-09-11T20:00:00Z', headSha: olderSha}),
        ],
        nextPage: null,
      }),
      workflowContent: (_entry, _path, ref) =>
        ref === newestSha ? {ok: false, fetchStatusClass: 'timeout'} : {ok: true, content: workflowContent()},
    })

    // #when
    const record = publicRecord((await collect({adapters})).public)

    // #then
    expect(record.state).toBe('unavailable')
    expect(record.observation).toBe('workflow-content-unavailable')
    expect(record.fetchStatusClass).toBe('timeout')
    expect(record.runId).toBe(6001)
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
    expect(record.state).toBe('unavailable')
    expect(record.observation).toBe('workflow-read-unavailable')
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
      ...ADAPTER_INVENTORY,
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
    const adapters = createGitHubAdapters({
      ...ADAPTER_INVENTORY,
      token: 'fixture-token',
      fetchImpl: async () => response,
    })

    // #when / #then
    await expect(adapters.getRepository(PUBLIC_ENTRY)).resolves.toEqual({ok: false, fetchStatusClass: 'redirect'})
  })

  it('bounds response size before parsing', async () => {
    // #given
    const adapters = createGitHubAdapters({
      ...ADAPTER_INVENTORY,
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
      ...ADAPTER_INVENTORY,
      token: 'fixture-token',
      fetchImpl: async () => {
        throw timeoutError
      },
    })
    const malformed = createGitHubAdapters({
      ...ADAPTER_INVENTORY,
      token: 'fixture-token',
      fetchImpl: async () => new Response('not json', {status: 200}),
    })

    // #when / #then
    expect(await timedOut.getRepository(PUBLIC_ENTRY)).toEqual({ok: false, fetchStatusClass: 'timeout'})
    expect(await malformed.getRepository(PUBLIC_ENTRY)).toEqual({ok: false, fetchStatusClass: 'malformed'})
  })

  it('classifies HTTP failures without echoing response bodies', async () => {
    // #given
    const adapters = createGitHubAdapters({
      ...ADAPTER_INVENTORY,
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
      ...ADAPTER_INVENTORY,
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

  it('fails closed without issuing a network request for a target outside the trusted inventories', async () => {
    // #given
    const calls: string[] = []
    const adapters = createGitHubAdapters({
      token: 'fixture-token',
      publicInventory: [PUBLIC_ENTRY],
      privateInventory: privateEntries(),
      fetchImpl: async input => {
        calls.push(String(input))
        return new Response(JSON.stringify({archived: false}), {status: 200})
      },
    })
    const rogueEntry: InventoryEntry = {
      owner: 'rogue-owner',
      repo: 'rogue-repo',
      workflowPaths: ['.github/workflows/fro-bot.yaml'],
    }

    // #when
    const result = await adapters.getRepository(rogueEntry)

    // #then
    expect(result).toEqual({ok: false, fetchStatusClass: 'forbidden'})
    expect(calls).toHaveLength(0)
  })

  it('normalizes owner/repo casing when checking inventory membership', async () => {
    // #given: the inventory is lowercase but the entry under evaluation is not.
    const adapters = createGitHubAdapters({
      ...ADAPTER_INVENTORY,
      token: 'fixture-token',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({full_name: 'Example/Widget', private: false, archived: false, default_branch: 'trunk'}),
          {status: 200},
        ),
    })
    const differentlyCasedEntry: InventoryEntry = {
      owner: PUBLIC_ENTRY.owner.toUpperCase(),
      repo: PUBLIC_ENTRY.repo.toUpperCase(),
      workflowPaths: PUBLIC_ENTRY.workflowPaths,
    }

    // #when
    const result = await adapters.getRepository(differentlyCasedEntry)

    // #then
    expect(result.ok).toBe(true)
  })

  it('abandons an oversized response body instead of fully buffering it', async () => {
    // #given: three 20-byte chunks are available (well past the 10-byte limit); fully draining
    // the stream would require pulling all three plus a final close, i.e. at least 4 pulls.
    let pulls = 0
    const totalChunks = 3
    const remainingChunks = [new Uint8Array(20), new Uint8Array(20), new Uint8Array(20)]
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        const chunk = remainingChunks.shift()
        if (chunk === undefined) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    })
    const adapters = createGitHubAdapters({
      ...ADAPTER_INVENTORY,
      token: 'fixture-token',
      maxResponseBytes: 10,
      fetchImpl: async () => new Response(stream, {status: 200}),
    })

    // #when
    const result = await adapters.getRepository(PUBLIC_ENTRY)

    // #then: the body was abandoned well short of a full drain, not merely measured after the fact.
    expect(result).toEqual({ok: false, fetchStatusClass: 'oversized'})
    expect(pulls).toBeLessThan(totalChunks + 1)
  })
})
