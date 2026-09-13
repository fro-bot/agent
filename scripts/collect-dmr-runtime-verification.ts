#!/usr/bin/env node

// Deterministic runtime-evidence collector for the temporary #1598 verification sweep.
//
// Contract (docs/plans/2026-09-11-001-feat-daily-runtime-verification-plan.md, U1):
//   1. The fixed 24-public-repository inventory is a single exported constant; the three
//      private entries are parsed from a JSON GitHub Actions secret and never serialized.
//   2. Pure classification, sanitization, and provenance parsing are separated from live
//      GitHub I/O through injected adapters so the test suite never needs credentials.
//   3. Qualification requires an affected-event run after the v0.111.0 boundary, a run-revision
//      workflow that consumes a v0-line `fro-bot/agent` action, an unambiguous resolved action
//      SHA in the full run logs, ancestry from #1597's merge commit, and terminal success.
//   4. Every recoverable path emits a schema-v2 sanitized artifact. Private output is
//      aggregate-only: names, URLs, per-repository states, API bodies, and error strings never
//      reach a serialized surface. Every externally visible message is a constant class.
//
// Run via: node --experimental-strip-types scripts/collect-dmr-runtime-verification.ts [output.json]
//
// `main()` is only invoked by the direct-execution guard at the bottom, mirroring
// scripts/harness/mint-app-token.ts, so the module stays import-safe under Vitest.

import type {ReadableStreamDefaultReader} from 'node:stream/web'
import {writeFileSync} from 'node:fs'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {parse} from 'yaml'

// ---------------------------------------------------------------------------
// Inventory and baseline constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 2

/** Exact daily DMR cron from .github/workflows/fro-bot.yaml. */
export const DAILY_SCHEDULE_CRON = '30 15 * * *'

export const MINIMUM_RELEASE = 'v0.111.0'
export const MINIMUM_RELEASE_PUBLISHED_AT = '2026-09-11T19:28:19Z'
/** Merge commit of #1597 (`fix(setup)!: check effective Git credentials on withheld runs`). */
export const CREDENTIAL_PREFLIGHT_COMMIT = '9d971b4cc5d1e47cbbb4ea5cb60e2d703ceabf97'

export const PRIVATE_INVENTORY_TOTAL = 3

export const AFFECTED_EVENTS: readonly string[] = ['pull_request', 'issue_comment', 'issues']

export const LIMITS = {
  maxRunPages: 3,
  runsPerPage: 100,
  maxWorkflowPages: 3,
  workflowsPerPage: 100,
  maxJobPages: 2,
  jobsPerPage: 100,
  maxCandidateLogs: 5,
  maxResponseBytes: 1_000_000,
  requestTimeoutMs: 15_000,
} as const

export interface InventoryEntry {
  readonly owner: string
  readonly repo: string
  readonly workflowPaths: readonly string[]
}

/**
 * Fixed 24-public-repository inventory recorded by #1598. The two archived repositories
 * (`fro-bot/tokentoilet`, `marcusrbrown/copiloting`) are intentionally excluded until unarchived.
 */
export const PUBLIC_INVENTORY: readonly InventoryEntry[] = [
  {owner: 'bfra-me', repo: 'ha-addon-repository', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'bfra-me', repo: 'works', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'fro-bot', repo: 'dashboard', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'cortexkit_anthropic-auth', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'dev-like', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'infra', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'marcusrbrown', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'marcusrbrown.com', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'marcusrbrown.github.io', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'mothership', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'renovate-config', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'sparkle', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'systematic', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'tokentoilet', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'vbs', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'thejustinwalsh', repo: 'three-flatland', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'bfra-me', repo: '.github', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'bfra-me', repo: 'renovate-action', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {
    owner: 'fro-bot',
    repo: '.github',
    workflowPaths: [
      '.github/workflows/capture-learnings.yaml',
      '.github/workflows/capture-patterns.yaml',
      '.github/workflows/fro-bot.yaml',
      '.github/workflows/survey-repo.yaml',
    ],
  },
  {owner: 'fro-bot', repo: 'space-bus', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: '.dotfiles', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'containers', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'gpt', workflowPaths: ['.github/workflows/fro-bot.yaml']},
  {owner: 'marcusrbrown', repo: 'opencode-copilot-delegate', workflowPaths: ['.github/workflows/fro-bot.yaml']},
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Disposition = 'unresolved' | 'preflight-failed' | 'unavailable'

export type FetchStatusClass =
  'success' | 'not-found' | 'forbidden' | 'rate-limited' | 'timeout' | 'oversized' | 'malformed' | 'redirect' | 'error'

export type CollectorStatus = 'partial' | 'unavailable'

export interface ProducerIdentity {
  readonly runId: string
  readonly runAttempt: string
  readonly schedule: string
  readonly generatedAt: string
}

export interface Baseline {
  readonly minimumRelease: string
  readonly minimumReleasePublishedAt: string
  readonly credentialPreflightCommit: string
}

export const BASELINE: Baseline = {
  minimumRelease: MINIMUM_RELEASE,
  minimumReleasePublishedAt: MINIMUM_RELEASE_PUBLISHED_AT,
  credentialPreflightCommit: CREDENTIAL_PREFLIGHT_COMMIT,
}

export interface PublicObservation {
  readonly repository: string
  readonly state: Disposition
  readonly observedAt: string
  readonly fetchStatusClass: FetchStatusClass
  readonly observation: string | null
  readonly event: string | null
  readonly runId: number | null
  readonly runAttempt: number | null
  readonly runUrl: string | null
  readonly workflowPath: string | null
  readonly declaredActionRef: string | null
  readonly resolvedActionSha: string | null
  readonly reportedJobs: readonly RunJobEvidence[] | null
  readonly ancestryFromPreflight: boolean | null
}

export interface PrivateAggregate {
  readonly total: number
  readonly observed: number
  readonly unresolved: number
  readonly unavailable: number
}

export interface ArtifactEnvelope {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly producer: ProducerIdentity
  readonly baseline: Baseline
  readonly collectorStatus: CollectorStatus
  readonly public: readonly PublicObservation[]
  readonly private: PrivateAggregate
}

export interface WorkflowRun {
  readonly id: number
  readonly runAttempt: number
  readonly event: string
  readonly path: string
  readonly headSha: string
  readonly createdAt: string
  readonly conclusion: string | null
  readonly htmlUrl: string
  readonly headRepositoryFullName: string | null
}

export type RunPageResult =
  | {readonly ok: true; readonly runs: readonly WorkflowRun[]; readonly nextPage: number | null}
  | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export type RepositoryResult =
  | {
      readonly ok: true
      readonly fullName: string
      readonly archived: boolean
      readonly defaultBranch: string
      readonly private: boolean
    }
  | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export type WorkflowContentResult =
  {readonly ok: true; readonly content: string} | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export type WorkflowPathsResult =
  | {readonly ok: true; readonly paths: readonly string[]}
  | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export interface RunStepEvidence {
  readonly name: string
  readonly number: number | null
  readonly status: string
  readonly conclusion: string | null
}

export interface RunJobEvidence {
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly steps: readonly RunStepEvidence[]
}

export type RunJobsResult =
  | {readonly ok: true; readonly jobs: readonly RunJobEvidence[]}
  | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export type AncestryResult =
  {readonly ok: true; readonly descendant: boolean} | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export interface CollectorAdapters {
  readonly getRepository: (entry: InventoryEntry) => Promise<RepositoryResult>
  readonly listRunPage: (entry: InventoryEntry, page: number) => Promise<RunPageResult>
  readonly listWorkflowPaths: (entry: InventoryEntry) => Promise<WorkflowPathsResult>
  readonly getWorkflowContent: (entry: InventoryEntry, path: string, ref: string) => Promise<WorkflowContentResult>
  readonly getRunJobs: (entry: InventoryEntry, runId: number, runAttempt: number) => Promise<RunJobsResult>
  readonly isDescendantOfPreflight: (sha: string) => Promise<AncestryResult>
}

export interface CollectInput {
  readonly producer: ProducerIdentity
  readonly publicInventory: readonly InventoryEntry[]
  readonly privateInventory: readonly InventoryEntry[] | null
  readonly adapters: CollectorAdapters
  readonly now: () => Date
}

export interface BuildArtifactInput {
  readonly producer: ProducerIdentity
  readonly baseline: Baseline
  readonly collectorStatus: CollectorStatus
  readonly publicObservations: readonly PublicObservation[]
  readonly privateAggregate: PrivateAggregate
}

export type ParsePrivateInventoryResult =
  | {readonly ok: true; readonly entries: readonly InventoryEntry[]}
  | {
      readonly ok: false
      readonly reason: 'missing' | 'malformed-json' | 'not-array' | 'wrong-count' | 'invalid-entry' | 'duplicate-entry'
    }

export type ActionReferencesResult =
  | {readonly ok: true; readonly references: readonly string[]}
  | {readonly ok: false; readonly fetchStatusClass: 'malformed'}

export const FORK_PULL_REQUEST_OBSERVATION = 'fork-pull-request'

// ---------------------------------------------------------------------------
// Pure parsers, classifiers, and sanitizers
// ---------------------------------------------------------------------------

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/
const ACTION_REFERENCE_PATTERN = /^fro-bot\/agent@(.+)$/

function isFullSha(value: string): boolean {
  return FULL_SHA_PATTERN.test(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/** Parse executable `jobs.*.steps[].uses` values from a workflow document. */
export function parseActionReferences(workflowContent: string): ActionReferencesResult {
  let document: unknown
  try {
    document = parse(workflowContent)
  } catch {
    return {ok: false, fetchStatusClass: 'malformed'}
  }

  if (isObject(document) === false || isObject(document.jobs) === false) {
    return {ok: true, references: []}
  }

  const references: string[] = []
  for (const job of Object.values(document.jobs)) {
    if (isObject(job) === false || Array.isArray(job.steps) === false) {
      continue
    }
    for (const step of job.steps) {
      if (isObject(step) === false || typeof step.uses !== 'string') {
        continue
      }
      const match = ACTION_REFERENCE_PATTERN.exec(step.uses)
      if (match?.[1] !== undefined) {
        references.push(match[1])
      }
    }
  }
  return {ok: true, references}
}

/**
 * Distinct `fro-bot/agent@<ref>` references in executable workflow steps, in document order.
 * Malformed YAML is represented as an empty list for this compatibility helper; collection paths
 * use `parseActionReferences` so malformed content remains unavailable.
 */
export function extractActionReferences(workflowContent: string): readonly string[] {
  const result = parseActionReferences(workflowContent)
  if (result.ok === false) {
    return []
  }
  return [...new Set(result.references)]
}

/**
 * A qualifiable action reference is either the floating `v0` branch or a pinned full 40-hex commit
 * SHA. The migrated inventory pins SHAs and one stale workflow uses `v0.93.1`; any version tag,
 * other mutable branch, or short SHA is rejected.
 */
export function isQualifiableActionReference(reference: string): boolean {
  return reference === 'v0' || isFullSha(reference)
}

/**
 * Parse the private inventory secret: an array of exactly three distinct repository/workflow
 * records. Every failure is a constant class and never echoes the input, so a malformed secret
 * cannot leak a repository identity.
 */
export function parsePrivateInventory(raw: string | undefined): ParsePrivateInventoryResult {
  if (raw === undefined || raw.trim().length === 0) {
    return {ok: false, reason: 'missing'}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {ok: false, reason: 'malformed-json'}
  }
  if (Array.isArray(parsed) === false) {
    return {ok: false, reason: 'not-array'}
  }
  if (parsed.length !== PRIVATE_INVENTORY_TOTAL) {
    return {ok: false, reason: 'wrong-count'}
  }
  const entries: InventoryEntry[] = []
  const seen = new Set<string>()
  for (const value of parsed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return {ok: false, reason: 'invalid-entry'}
    }
    const record = value as Record<string, unknown>
    if (typeof record.owner !== 'string' || record.owner.length === 0) return {ok: false, reason: 'invalid-entry'}
    if (typeof record.repo !== 'string' || record.repo.length === 0) return {ok: false, reason: 'invalid-entry'}
    const workflowPaths = record.workflowPaths
    if (Array.isArray(workflowPaths) === false || workflowPaths.length === 0) {
      return {ok: false, reason: 'invalid-entry'}
    }
    const paths: string[] = []
    for (const path of workflowPaths) {
      if (typeof path !== 'string' || path.length === 0) return {ok: false, reason: 'invalid-entry'}
      paths.push(path)
    }
    const key = `${record.owner.toLowerCase()}/${record.repo.toLowerCase()}`
    if (seen.has(key)) return {ok: false, reason: 'duplicate-entry'}
    seen.add(key)
    entries.push({owner: record.owner, repo: record.repo, workflowPaths: paths})
  }
  return {ok: true, entries}
}

// No disposition the collector can now produce is positively terminal, so `observed` is always 0.
// The field stays in the schema shape; only its meaning changed (a later pass redesigns the
// envelope). `isPrivateClosureSatisfied` was deleted: it required `observed === PRIVATE_INVENTORY_TOTAL`,
// which nothing in this collector can ever produce anymore.
export function aggregatePrivate(dispositions: readonly Disposition[]): PrivateAggregate {
  let unresolved = 0
  let unavailable = 0
  for (const disposition of dispositions) {
    if (disposition === 'unavailable') {
      unavailable += 1
    } else {
      unresolved += 1
    }
  }
  return {total: dispositions.length, observed: 0, unresolved, unavailable}
}

export function determineCollectorStatus(dispositions: readonly Disposition[]): CollectorStatus {
  if (dispositions.length === 0) {
    return 'unavailable'
  }
  if (dispositions.every(disposition => disposition === 'unavailable')) {
    return 'unavailable'
  }
  return 'partial'
}

export function buildArtifact(input: BuildArtifactInput): ArtifactEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    producer: input.producer,
    baseline: input.baseline,
    collectorStatus: input.collectorStatus,
    public: input.publicObservations,
    private: input.privateAggregate,
  }
}

export function serializeArtifact(artifact: ArtifactEnvelope): string {
  return JSON.stringify(artifact)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function hasStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => typeof value[field] === 'string')
}

function hasNumberFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => typeof value[field] === 'number')
}

const DISPOSITION_VALUES: readonly Disposition[] = ['unresolved', 'preflight-failed', 'unavailable']

const FETCH_STATUS_CLASS_VALUES: readonly FetchStatusClass[] = [
  'success',
  'not-found',
  'forbidden',
  'rate-limited',
  'timeout',
  'oversized',
  'malformed',
  'redirect',
  'error',
]

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === 'string'
}

function isNullableNumber(value: unknown): boolean {
  return value === null || typeof value === 'number'
}

function isPublicObservationRecord(value: unknown): boolean {
  if (isRecord(value) === false) return false
  return (
    typeof value.repository === 'string' &&
    value.repository.length > 0 &&
    typeof value.state === 'string' &&
    DISPOSITION_VALUES.includes(value.state as Disposition) &&
    typeof value.observedAt === 'string' &&
    typeof value.fetchStatusClass === 'string' &&
    FETCH_STATUS_CLASS_VALUES.includes(value.fetchStatusClass as FetchStatusClass) &&
    isNullableString(value.observation) &&
    isNullableString(value.event) &&
    isNullableNumber(value.runId) &&
    isNullableNumber(value.runAttempt) &&
    isNullableString(value.runUrl) &&
    isNullableString(value.workflowPath) &&
    isNullableString(value.declaredActionRef) &&
    isNullableString(value.resolvedActionSha)
  )
}

/**
 * Structural validation of the version-2 envelope. `main()` runs this before writing the artifact
 * so a future shape regression fails closed with a constant-class message instead of publishing it.
 * Each public entry's required fields and types are validated, not merely the container shape.
 */
export function isSchemaV2Envelope(value: unknown): value is ArtifactEnvelope {
  if (isRecord(value) === false) return false
  const {schemaVersion, producer, baseline, collectorStatus, public: publicRecords, private: privateAggregate} = value
  return (
    schemaVersion === SCHEMA_VERSION &&
    isRecord(producer) &&
    hasStringFields(producer, ['runId', 'runAttempt', 'schedule', 'generatedAt']) &&
    isRecord(baseline) &&
    hasStringFields(baseline, ['minimumRelease', 'minimumReleasePublishedAt', 'credentialPreflightCommit']) &&
    (collectorStatus === 'partial' || collectorStatus === 'unavailable') &&
    Array.isArray(publicRecords) &&
    publicRecords.every(isPublicObservationRecord) &&
    isRecord(privateAggregate) &&
    hasNumberFields(privateAggregate, ['total', 'observed', 'unresolved', 'unavailable'])
  )
}

// ---------------------------------------------------------------------------
// Orchestration (pure control flow over injected adapters)
// ---------------------------------------------------------------------------

function baseRecord(entry: InventoryEntry, observedAt: string): PublicObservation {
  return {
    repository: `${entry.owner}/${entry.repo}`,
    state: 'unresolved',
    observedAt,
    fetchStatusClass: 'success',
    observation: null,
    event: null,
    runId: null,
    runAttempt: null,
    runUrl: null,
    workflowPath: null,
    declaredActionRef: null,
    resolvedActionSha: null,
    reportedJobs: null,
    ancestryFromPreflight: null,
  }
}

function withRun(base: PublicObservation, run: WorkflowRun, overrides: Partial<PublicObservation>): PublicObservation {
  return {
    ...base,
    event: run.event,
    runId: run.id,
    runAttempt: run.runAttempt,
    runUrl: run.htmlUrl,
    workflowPath: run.path,
    ...overrides,
  }
}

/**
 * Evaluate one candidate run and record what was directly observed. This collector has no
 * forgery-resistant way to authenticate a Fro Bot invocation (that required log-scraping and
 * recursive external-wrapper traversal, both removed as unfixable trust-boundary defects), so
 * every branch is deliberately non-terminal: `unresolved` for inconclusive evidence, `unavailable`
 * for evidence that could not be read, `preflight-failed` only for direct step-level detection.
 */
async function evaluateRun(
  base: PublicObservation,
  entry: InventoryEntry,
  run: WorkflowRun,
  adapters: CollectorAdapters,
): Promise<PublicObservation> {
  if (
    run.event === 'pull_request' &&
    (run.headRepositoryFullName === null ||
      run.headRepositoryFullName.toLowerCase() !== `${entry.owner}/${entry.repo}`.toLowerCase())
  ) {
    return withRun(base, run, {state: 'unresolved', observation: FORK_PULL_REQUEST_OBSERVATION})
  }
  if (run.conclusion !== 'success') {
    return withRun(base, run, {state: 'unresolved', observation: 'run-concluded-unsuccessful'})
  }
  const content = await adapters.getWorkflowContent(entry, run.path, run.headSha)
  if (content.ok === false) {
    return withRun(base, run, {
      state: 'unavailable',
      observation: 'workflow-content-unavailable',
      fetchStatusClass: content.fetchStatusClass,
    })
  }
  const parsedReferences = parseActionReferences(content.content)
  if (parsedReferences.ok === false) {
    return withRun(base, run, {
      state: 'unavailable',
      observation: 'workflow-content-unavailable',
      fetchStatusClass: parsedReferences.fetchStatusClass,
    })
  }
  const references = parsedReferences.references
  if (references.length === 0) {
    return withRun(base, run, {state: 'unresolved', observation: 'no-action-reference-in-workflow'})
  }
  if (references.some(reference => isQualifiableActionReference(reference) === false)) {
    return withRun(base, run, {state: 'unresolved', observation: 'ineligible-action-reference'})
  }
  const distinctReferences = [...new Set(references)]
  if (distinctReferences.length > 1) {
    return withRun(base, run, {state: 'unresolved', observation: 'multiple-distinct-action-references'})
  }
  const declaredActionRef = distinctReferences[0]
  if (declaredActionRef === undefined) {
    return withRun(base, run, {state: 'unresolved', observation: 'no-action-reference-in-workflow'})
  }
  // A direct, qualifiable action reference was observed in the workflow content the run itself
  // executed. That is evidence, not proof: without an authenticated resolution to a commit SHA and
  // an independently confirmed invocation outcome, this stops short of any terminal disposition.
  const jobsResult = await adapters.getRunJobs(entry, run.id, run.runAttempt)
  const reportedJobs = jobsResult.ok === true ? jobsResult.jobs : null
  // A floating reference (e.g. `v0`) must never be resolved to a SHA here and attributed to this
  // run's evidence: today's floating-ref content is not proof of what any given run executed.
  let resolvedActionSha: string | null = null
  let ancestryFromPreflight: boolean | null = null
  if (isFullSha(declaredActionRef)) {
    resolvedActionSha = declaredActionRef
    const ancestryResult = await adapters.isDescendantOfPreflight(declaredActionRef)
    ancestryFromPreflight = ancestryResult.ok === true ? ancestryResult.descendant : null
  }
  return withRun(base, run, {
    state: 'unresolved',
    observation: 'direct-reference-observed',
    declaredActionRef,
    resolvedActionSha,
    reportedJobs,
    ancestryFromPreflight,
  })
}

/**
 * Inspect only the direct `uses:` references in workflow content fetched from the inventoried
 * repository at its default branch. No traversal into local or external wrappers: that required
 * following `uses:` targets to arbitrary `owner/repo/path@ref` destinations and fetching them with
 * a private-capable credential, which is the recursive-traversal trust-boundary defect this
 * collector no longer has. Absence of a discovered direct reference is `unresolved`, never proof
 * of removal.
 */
async function classifyDefaultBranch(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  defaultBranch: string,
): Promise<Pick<PublicObservation, 'state' | 'observation' | 'fetchStatusClass'>> {
  const workflowPaths = await adapters.listWorkflowPaths(entry)
  if (workflowPaths.ok === false) {
    return {
      state: 'unavailable',
      observation: 'workflow-list-unavailable',
      fetchStatusClass: workflowPaths.fetchStatusClass,
    }
  }

  for (const path of workflowPaths.paths) {
    const content = await adapters.getWorkflowContent(entry, path, defaultBranch)
    if (content.ok === false) {
      return {
        state: 'unavailable',
        observation: 'workflow-read-unavailable',
        fetchStatusClass: content.fetchStatusClass,
      }
    }
    const parsedReferences = parseActionReferences(content.content)
    if (parsedReferences.ok === false) {
      return {
        state: 'unavailable',
        observation: 'workflow-read-unavailable',
        fetchStatusClass: parsedReferences.fetchStatusClass,
      }
    }
    if (parsedReferences.references.length > 0) {
      return {state: 'unresolved', observation: 'direct-reference-observed', fetchStatusClass: 'success'}
    }
  }
  return {state: 'unresolved', observation: 'no-direct-reference-observed', fetchStatusClass: 'success'}
}

async function collectEntry(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  isPrivate: boolean,
  observedAt: string,
): Promise<PublicObservation> {
  const base = baseRecord(entry, observedAt)

  const repository = await adapters.getRepository(entry)
  if (repository.ok === false) {
    return {
      ...base,
      state: 'unavailable',
      observation: 'repository-unavailable',
      fetchStatusClass: repository.fetchStatusClass,
    }
  }
  const expectedFullName = `${entry.owner}/${entry.repo}`
  if (repository.fullName.toLowerCase() !== expectedFullName.toLowerCase()) {
    return {...base, state: 'unavailable', observation: 'repository-identity-mismatch'}
  }
  if (repository.private !== isPrivate) {
    return {...base, state: 'unavailable', observation: 'repository-visibility-mismatch'}
  }
  if (repository.archived === true) {
    // Archive status is recorded information, not a terminal conclusion: an archived repository
    // could still hold a run that had already executed before archival.
    return {...base, state: 'unresolved', observation: 'repository-archived'}
  }

  // Workflow-path filtering happens per page, before the release boundary and every
  // event/date/log limit, so runs from unrelated workflow files cannot truncate the scan
  // or consume the candidate-log budget.
  const candidates: WorkflowRun[] = []
  let page = 1
  let reachedEnd = false
  while (reachedEnd === false) {
    const result = await adapters.listRunPage(entry, page)
    if (result.ok === false) {
      return {
        ...base,
        state: 'unavailable',
        observation: 'run-list-unavailable',
        fetchStatusClass: result.fetchStatusClass,
      }
    }
    const relevantRuns = result.runs.filter(run => entry.workflowPaths.includes(run.path))
    for (const run of relevantRuns) {
      candidates.push(run)
    }
    const atReleaseBoundary = relevantRuns.some(
      run => Date.parse(run.createdAt) < Date.parse(MINIMUM_RELEASE_PUBLISHED_AT),
    )
    if (atReleaseBoundary || result.runs.length === 0 || result.nextPage === null) {
      reachedEnd = true
      break
    }
    if (page >= LIMITS.maxRunPages) {
      break
    }
    page = result.nextPage
  }
  if (reachedEnd === false) {
    return {
      ...base,
      state: 'unavailable',
      observation: 'pagination-bound-exhausted',
      fetchStatusClass: 'success',
    }
  }

  const filtered = candidates
    .filter(run => AFFECTED_EVENTS.includes(run.event))
    .filter(run => run.conclusion !== null)
    .filter(run => Date.parse(run.createdAt) >= Date.parse(MINIMUM_RELEASE_PUBLISHED_AT))
    .sort((first, second) => {
      const delta = Date.parse(second.createdAt) - Date.parse(first.createdAt)
      return delta === 0 ? second.runAttempt - first.runAttempt : delta
    })

  let evaluations = 0
  let best: PublicObservation | null = null
  let unavailableFallback: PublicObservation | null = null
  for (const run of filtered) {
    if (evaluations >= LIMITS.maxCandidateLogs) {
      return {
        ...base,
        state: 'unavailable',
        observation: 'candidate-log-bound-exhausted',
        fetchStatusClass: 'success',
      }
    }
    evaluations += 1
    const evaluation = await evaluateRun(base, entry, run, adapters)
    if (evaluation.state === 'unavailable') {
      // An unavailable candidate may have been the qualifying one; that uncertainty must not be
      // silently discarded in favor of another candidate's more definitive-looking observation.
      if (unavailableFallback === null) {
        unavailableFallback = evaluation
      }
      continue
    }
    if (best === null || (best.state !== 'preflight-failed' && evaluation.state === 'preflight-failed')) {
      best = evaluation
    }
  }
  // Any in-budget unavailable candidate keeps the entry's result unavailable, even when another
  // candidate produced a more definitive-looking observation: the unavailable one may have been
  // the qualifying run, and that uncertainty must be surfaced rather than overridden.
  if (unavailableFallback !== null) {
    return unavailableFallback
  }
  if (best !== null) {
    return best
  }

  const branch = await classifyDefaultBranch(entry, adapters, repository.defaultBranch)
  return {...base, ...branch}
}

export async function collectRuntimeVerification(input: CollectInput): Promise<ArtifactEnvelope> {
  const observedAt = input.now().toISOString()
  const publicObservations: PublicObservation[] = []
  for (const entry of input.publicInventory) {
    publicObservations.push(await collectEntry(entry, input.adapters, false, observedAt))
  }

  const privateInventory = input.privateInventory
  const privateIsValid = privateInventory !== null && privateInventory.length === PRIVATE_INVENTORY_TOTAL
  const privateDispositions: Disposition[] = []
  let privateAggregate: PrivateAggregate
  if (privateInventory !== null && privateIsValid) {
    for (const entry of privateInventory) {
      privateDispositions.push((await collectEntry(entry, input.adapters, true, observedAt)).state)
    }
    privateAggregate = aggregatePrivate(privateDispositions)
  } else {
    privateAggregate = {
      total: PRIVATE_INVENTORY_TOTAL,
      observed: 0,
      unresolved: 0,
      unavailable: PRIVATE_INVENTORY_TOTAL,
    }
  }

  const collectorStatus = privateIsValid
    ? determineCollectorStatus([...publicObservations.map(record => record.state), ...privateDispositions])
    : 'unavailable'

  return buildArtifact({
    producer: input.producer,
    baseline: BASELINE,
    collectorStatus,
    publicObservations,
    privateAggregate,
  })
}

// ---------------------------------------------------------------------------
// Live GitHub adapters (injected I/O boundary)
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com'

type FetchTextResult =
  {readonly ok: true; readonly text: string} | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

type SafeJsonResult = {readonly ok: true; readonly value: unknown} | {readonly ok: false}

function safeJson(text: string): SafeJsonResult {
  try {
    return {ok: true, value: JSON.parse(text)}
  } catch {
    return {ok: false}
  }
}

function failureClass(status: number): FetchStatusClass {
  if (status === 404) return 'not-found'
  if (status === 403) return 'forbidden'
  if (status === 429) return 'rate-limited'
  return 'error'
}

export interface GitHubAdapterOptions {
  readonly token: string
  /** Trusted public target inventory; combined with `privateInventory` to confine outgoing requests. */
  readonly publicInventory: readonly InventoryEntry[]
  /** Trusted private target inventory, or `null` when the private secret failed to parse. */
  readonly privateInventory: readonly InventoryEntry[] | null
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

/**
 * Read a response body as a bounded byte stream, aborting as soon as the byte limit is exceeded
 * instead of buffering the full body first. A response with no body (or a runtime that never
 * exposes one) is treated as an empty body.
 */
async function readBoundedBody(response: Response, maxResponseBytes: number): Promise<FetchTextResult> {
  const body = response.body
  if (body === null) {
    return {ok: true, text: ''}
  }
  // `Response.body`'s upstream type parameter defaults to `any`; assert the concrete byte type
  // this stream actually produces so downstream reads stay type-checked.
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let totalBytes = 0
  while (true) {
    const {done, value} = await reader.read()
    if (done) {
      text += decoder.decode()
      return {ok: true, text}
    }
    totalBytes += value.byteLength
    if (totalBytes > maxResponseBytes) {
      await reader.cancel('response-body-oversized').catch(() => undefined)
      return {ok: false, fetchStatusClass: 'oversized'}
    }
    text += decoder.decode(value, {stream: true})
  }
}

export function createGitHubAdapters(options: GitHubAdapterOptions): CollectorAdapters {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? LIMITS.requestTimeoutMs
  const maxResponseBytes = options.maxResponseBytes ?? LIMITS.maxResponseBytes

  // The adapter layer must independently confine every outgoing request target to the trusted
  // inventories, rather than relying on callers never constructing an out-of-inventory entry.
  // Targets are normalized (lowercase owner/repo) before membership is checked.
  const allowedTargets = new Set<string>(
    [...options.publicInventory, ...(options.privateInventory ?? [])].map(
      entry => `${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}`,
    ),
  )
  const isAllowedEntry = (entry: InventoryEntry): boolean =>
    allowedTargets.has(`${entry.owner.toLowerCase()}/${entry.repo.toLowerCase()}`)

  const request = async (path: string, accept: string): Promise<FetchTextResult> => {
    try {
      const response = await fetchImpl(`${GITHUB_API}${path}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.redirected) {
        return {ok: false, fetchStatusClass: 'redirect'}
      }
      if (response.ok === false) {
        return {ok: false, fetchStatusClass: failureClass(response.status)}
      }
      return await readBoundedBody(response, maxResponseBytes)
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return {ok: false, fetchStatusClass: timedOut ? 'timeout' : 'error'}
    }
  }

  return {
    getRepository: async entry => {
      if (isAllowedEntry(entry) === false) {
        return {ok: false, fetchStatusClass: 'forbidden'}
      }
      const response = await request(`/repos/${entry.owner}/${entry.repo}`, 'application/vnd.github+json')
      if (response.ok === false) {
        return response
      }
      const parsed = safeJson(response.text)
      if (parsed.ok === false) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const value = parsed.value
      if (typeof value !== 'object' || value === null) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const record = value as Record<string, unknown>
      if (
        typeof record.full_name !== 'string' ||
        record.full_name.length === 0 ||
        typeof record.archived !== 'boolean' ||
        typeof record.default_branch !== 'string' ||
        record.default_branch.length === 0 ||
        typeof record.private !== 'boolean'
      ) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      return {
        ok: true,
        fullName: record.full_name,
        archived: record.archived,
        defaultBranch: record.default_branch,
        private: record.private,
      }
    },
    listRunPage: async (entry, page) => {
      if (isAllowedEntry(entry) === false) {
        return {ok: false, fetchStatusClass: 'forbidden'}
      }
      const path = `/repos/${entry.owner}/${entry.repo}/actions/runs?per_page=${LIMITS.runsPerPage}&page=${page}`
      const response = await request(path, 'application/vnd.github+json')
      if (response.ok === false) {
        return response
      }
      const parsed = safeJson(response.text)
      if (parsed.ok === false) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const value = parsed.value
      if (typeof value !== 'object' || value === null) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const workflowRuns = (value as Record<string, unknown>).workflow_runs
      if (Array.isArray(workflowRuns) === false) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const runs: WorkflowRun[] = []
      for (const candidate of workflowRuns) {
        const parsedRun = toWorkflowRun(candidate)
        if (parsedRun === null) {
          return {ok: false, fetchStatusClass: 'malformed'}
        }
        runs.push(parsedRun)
      }
      return {ok: true, runs, nextPage: runs.length === LIMITS.runsPerPage ? page + 1 : null}
    },
    listWorkflowPaths: async entry => {
      if (isAllowedEntry(entry) === false) {
        return {ok: false, fetchStatusClass: 'forbidden'}
      }
      const paths: string[] = []
      let page = 1
      while (true) {
        const response = await request(
          `/repos/${entry.owner}/${entry.repo}/actions/workflows?per_page=${LIMITS.workflowsPerPage}&page=${page}`,
          'application/vnd.github+json',
        )
        if (response.ok === false) {
          return response
        }
        const parsed = safeJson(response.text)
        if (
          parsed.ok === false ||
          isObject(parsed.value) === false ||
          Array.isArray(parsed.value.workflows) === false
        ) {
          return {ok: false, fetchStatusClass: 'malformed'}
        }
        for (const workflow of parsed.value.workflows) {
          if (isObject(workflow) === false || typeof workflow.path !== 'string' || workflow.path.length === 0) {
            return {ok: false, fetchStatusClass: 'malformed'}
          }
          paths.push(workflow.path)
        }
        if (parsed.value.workflows.length < LIMITS.workflowsPerPage) {
          return {ok: true, paths}
        }
        if (page >= LIMITS.maxWorkflowPages) {
          return {ok: false, fetchStatusClass: 'error'}
        }
        page += 1
      }
    },
    getWorkflowContent: async (entry, path, ref) => {
      if (isAllowedEntry(entry) === false) {
        return {ok: false, fetchStatusClass: 'forbidden'}
      }
      const encodedPath = path
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')
      const response = await request(
        `/repos/${entry.owner}/${entry.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
        'application/vnd.github.raw',
      )
      if (response.ok === false) {
        return response
      }
      return {ok: true, content: response.text}
    },
    getRunJobs: async (entry, runId, runAttempt) => {
      if (isAllowedEntry(entry) === false) {
        return {ok: false, fetchStatusClass: 'forbidden'}
      }
      const jobs: RunJobEvidence[] = []
      let page = 1
      while (true) {
        const response = await request(
          `/repos/${entry.owner}/${entry.repo}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=${LIMITS.jobsPerPage}&page=${page}`,
          'application/vnd.github+json',
        )
        if (response.ok === false) {
          return response
        }
        const parsed = safeJson(response.text)
        if (parsed.ok === false || isObject(parsed.value) === false || Array.isArray(parsed.value.jobs) === false) {
          return {ok: false, fetchStatusClass: 'malformed'}
        }
        for (const job of parsed.value.jobs) {
          const evidence = toRunJobEvidence(job)
          if (evidence === null) {
            return {ok: false, fetchStatusClass: 'malformed'}
          }
          jobs.push(evidence)
        }
        if (parsed.value.jobs.length < LIMITS.jobsPerPage) {
          return {ok: true, jobs}
        }
        if (page >= LIMITS.maxJobPages) {
          return {ok: false, fetchStatusClass: 'error'}
        }
        page += 1
      }
    },
    isDescendantOfPreflight: async sha => {
      const response = await request(
        `/repos/fro-bot/agent/compare/${CREDENTIAL_PREFLIGHT_COMMIT}...${sha}`,
        'application/vnd.github+json',
      )
      if (response.ok === false) {
        // An unknown head SHA is not a descendant; anything else is an inconclusive access failure.
        return response.fetchStatusClass === 'not-found' ? {ok: true, descendant: false} : response
      }
      const parsed = safeJson(response.text)
      if (parsed.ok === false) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const value = parsed.value
      if (typeof value !== 'object' || value === null) {
        return {ok: false, fetchStatusClass: 'malformed'}
      }
      const status = (value as Record<string, unknown>).status
      return {ok: true, descendant: status === 'ahead' || status === 'identical'}
    },
  }
}

function toRunJobEvidence(value: unknown): RunJobEvidence | null {
  if (isObject(value) === false) return null
  const name = value.name
  const status = value.status
  const conclusion = value.conclusion
  if (typeof name !== 'string') return null
  if (typeof status !== 'string') return null
  if (conclusion !== null && typeof conclusion !== 'string') return null
  // Missing per-step evidence is unknown/malformed, not an empty-and-successful step set: a jobs
  // response with no `steps` property must never be treated as a clean, evidence-free job.
  const rawSteps = value.steps
  if (Array.isArray(rawSteps) === false) return null
  const steps: RunStepEvidence[] = []
  for (const step of rawSteps) {
    if (isObject(step) === false) return null
    const stepName = step.name
    const stepNumber = step.number
    const stepStatus = step.status
    const stepConclusion = step.conclusion
    if (typeof stepName !== 'string') return null
    if (stepNumber !== null && typeof stepNumber !== 'number') return null
    if (typeof stepStatus !== 'string') return null
    if (stepConclusion !== null && typeof stepConclusion !== 'string') return null
    steps.push({name: stepName, number: stepNumber ?? null, status: stepStatus, conclusion: stepConclusion})
  }
  return {name, status, conclusion, steps}
}

function toWorkflowRun(value: unknown): WorkflowRun | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = record.id
  const runAttempt = record.run_attempt
  const event = record.event
  const path = record.path
  const headSha = record.head_sha
  const createdAt = record.created_at
  const htmlUrl = record.html_url
  const conclusion = record.conclusion
  const headRepository = record.head_repository
  if (typeof id !== 'number') return null
  if (typeof runAttempt !== 'number') return null
  if (typeof event !== 'string') return null
  if (typeof path !== 'string') return null
  if (typeof headSha !== 'string') return null
  if (typeof createdAt !== 'string') return null
  if (typeof htmlUrl !== 'string') return null
  if (conclusion !== null && typeof conclusion !== 'string') return null
  const headRepositoryFullName =
    isObject(headRepository) && typeof headRepository.full_name === 'string' ? headRepository.full_name : null
  return {id, runAttempt, event, path, headSha, createdAt, conclusion, htmlUrl, headRepositoryFullName}
}

// ---------------------------------------------------------------------------
// Main (real adapters + artifact write)
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  try {
    const producer: ProducerIdentity = {
      runId: process.env.GITHUB_RUN_ID ?? 'unknown',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
      schedule: DAILY_SCHEDULE_CRON,
      generatedAt: new Date().toISOString(),
    }
    const parsed = parsePrivateInventory(process.env.DMR_RUNTIME_VERIFICATION_PRIVATE_INVENTORY)
    const adapters = createGitHubAdapters({
      token: process.env.GH_TOKEN ?? '',
      publicInventory: PUBLIC_INVENTORY,
      privateInventory: parsed.ok ? parsed.entries : null,
    })
    const artifact = await collectRuntimeVerification({
      producer,
      publicInventory: PUBLIC_INVENTORY,
      privateInventory: parsed.ok ? parsed.entries : null,
      adapters,
      now: () => new Date(),
    })
    if (isSchemaV2Envelope(artifact) === false) {
      throw new Error('artifact-schema-invalid')
    }
    const outputPath =
      process.argv[2] ?? process.env.DMR_RUNTIME_VERIFICATION_OUTPUT ?? 'runtime-verification-evidence.json'
    writeFileSync(outputPath, serializeArtifact(artifact), 'utf8')
    if (parsed.ok === false) {
      // Constant class only — never the secret value or parser input.
      process.stderr.write(`[collect-dmr-runtime-verification] private-inventory-${parsed.reason}\n`)
    }
  } catch {
    // Unexpected failure: constant-class message only, never a raw caught error.
    process.stderr.write('[collect-dmr-runtime-verification] unexpected-failure\n')
    process.exitCode = 1
  }
}

// Only run when executed directly, not when imported by the test file under Vitest.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
