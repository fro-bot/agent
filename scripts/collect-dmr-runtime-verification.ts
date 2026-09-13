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
//   4. Every recoverable path emits a schema-v1 sanitized artifact. Private output is
//      aggregate-only: names, URLs, per-repository states, API bodies, and error strings never
//      reach a serialized surface. Every externally visible message is a constant class.
//
// Run via: node --experimental-strip-types scripts/collect-dmr-runtime-verification.ts [output.json]
//
// `main()` is only invoked by the direct-execution guard at the bottom, mirroring
// scripts/harness/mint-app-token.ts, so the module stays import-safe under Vitest.

import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {parse} from 'yaml'

// ---------------------------------------------------------------------------
// Inventory and baseline constants
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1

/** Exact daily DMR cron from .github/workflows/fro-bot.yaml. */
export const DAILY_SCHEDULE_CRON = '30 15 * * *'

export const MINIMUM_RELEASE = 'v0.111.0'
export const MINIMUM_RELEASE_PUBLISHED_AT = '2026-09-11T19:28:19Z'
/** Merge commit of #1597 (`fix(setup)!: check effective Git credentials on withheld runs`). */
export const CREDENTIAL_PREFLIGHT_COMMIT = '9d971b4cc5d1e47cbbb4ea5cb60e2d703ceabf97'

/** Marker emitted by the credential preflight when a withheld run is refused. */
export const CREDENTIAL_REFUSAL_MARKER = 'Refusing to proceed with credential withheld'

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
  maxIndirectionDepth: 3,
  maxResponseBytes: 1_000_000,
  maxLogBytes: 8_000_000,
  requestTimeoutMs: 15_000,
  logTimeoutMs: 30_000,
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

export type Disposition = 'qualified' | 'no-longer-applicable' | 'unresolved' | 'preflight-failed' | 'unavailable'

export type FetchStatusClass =
  'success' | 'not-found' | 'forbidden' | 'rate-limited' | 'timeout' | 'oversized' | 'malformed' | 'redirect' | 'error'

export type CollectorStatus = 'ready' | 'partial' | 'unavailable'

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

export interface PublicDisposition {
  readonly repository: string
  readonly disposition: Disposition
  readonly observedAt: string
  readonly fetchStatusClass: FetchStatusClass
  readonly rejectionReason: string | null
  readonly event: string | null
  readonly runId: number | null
  readonly runAttempt: number | null
  readonly runUrl: string | null
  readonly workflowPath: string | null
  readonly actionRef: string | null
  readonly resolvedActionSha: string | null
}

export interface PrivateAggregate {
  readonly total: number
  readonly resolved: number
  readonly unresolved: number
  readonly unavailable: number
}

export interface ArtifactEnvelope {
  readonly schemaVersion: typeof SCHEMA_VERSION
  readonly producer: ProducerIdentity
  readonly baseline: Baseline
  readonly collectorStatus: CollectorStatus
  readonly public: readonly PublicDisposition[]
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

export type RunLogsResult =
  {readonly ok: true; readonly text: string} | {readonly ok: false; readonly fetchStatusClass: FetchStatusClass}

export interface RunStepEvidence {
  readonly status: string
  readonly conclusion: string | null
}

export interface RunJobEvidence {
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
  readonly getRunLogs: (entry: InventoryEntry, runId: number, runAttempt: number) => Promise<RunLogsResult>
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
  readonly publicDispositions: readonly PublicDisposition[]
  readonly privateAggregate: PrivateAggregate
}

export type ParsePrivateInventoryResult =
  | {readonly ok: true; readonly entries: readonly InventoryEntry[]}
  | {
      readonly ok: false
      readonly reason: 'missing' | 'malformed-json' | 'not-array' | 'wrong-count' | 'invalid-entry' | 'duplicate-entry'
    }

export type ResolvedActionShaResult =
  {readonly ok: true; readonly sha: string} | {readonly ok: false; readonly reason: 'missing' | 'ambiguous'}

export type ActionReferencesResult =
  | {readonly ok: true; readonly references: readonly string[]}
  | {readonly ok: false; readonly fetchStatusClass: 'malformed'}

export interface WorkflowIndirections {
  readonly directReferences: readonly string[]
  readonly localWorkflowPaths: readonly string[]
  readonly localActionPaths: readonly string[]
  readonly externalJobWrappers: readonly string[]
}

export type WorkflowIndirectionsResult =
  {readonly ok: true; readonly value: WorkflowIndirections} | {readonly ok: false; readonly reason: 'malformed'}

export const FORK_PULL_REQUEST_REJECTION_REASON = 'fork-pull-request'

// ---------------------------------------------------------------------------
// Pure parsers, classifiers, and sanitizers
// ---------------------------------------------------------------------------

/**
 * `gh run view --log` attributes runner job-setup lines to this sentinel step name, which is where
 * the runner's own `Download action repository` records appear. Anchoring provenance to it keeps an
 * ordinary step that merely echoes that phrase from qualifying, since `gh` prefixes every log line
 * — forged or genuine — with `<job>\t<step>\t<timestamp>`.
 *
 * This is a `gh` implementation detail rather than a runner contract: if a future `gh` renames the
 * sentinel, every repository degrades to `missing-action-resolution` (unresolved) instead of
 * qualifying falsely. That is the safe direction, but it stalls progress silently, so a sweep that
 * reports no resolutions across the whole inventory should be checked against this constant first.
 */
export const SETUP_STEP_NAME = 'UNKNOWN STEP'

// A downloaded `gh run view --log` line is `job\tstep\ttimestamp message`. The runner emits the
// `Download action repository` record during job setup, which gh attributes to the setup sentinel
// step; a repository-controlled step echoing the phrase appears under its own step name.
const RESOLVED_ACTION_PATTERN = new RegExp(
  String.raw`(?:^|\n)[^\t\n]*\t${SETUP_STEP_NAME}\t\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z Download action repository 'fro-bot/agent@([^']+)' \(SHA:([0-9a-f]{40})\)`,
  'g',
)
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/
const ACTION_REFERENCE_PATTERN = /^fro-bot\/agent@(.+)$/

function isFullSha(value: string): boolean {
  return FULL_SHA_PATTERN.test(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/** Normalize a `uses: ./...` reference to a repository-relative path (`./` normalizes to the root). */
function normalizeLocalPath(uses: string): string {
  const raw = uses.slice(2).replace(/\/+$/, '')
  return raw === '.' ? '' : raw
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
 * Parse a workflow or composite-action manifest into the direct Fro Bot references plus every
 * indirection that must be resolved before a repository can be declared free of Fro Bot:
 * local reusable workflows (`jobs.*.uses: ./.github/workflows/<file>`), local action directories
 * (`steps[].uses: ./<path>`), and non-local (external) job-level reusable workflows that could
 * themselves invoke Fro Bot. Malformed YAML fails closed.
 */
export function parseWorkflowIndirections(workflowContent: string): WorkflowIndirectionsResult {
  let document: unknown
  try {
    document = parse(workflowContent)
  } catch {
    return {ok: false, reason: 'malformed'}
  }

  const directReferences: string[] = []
  const localWorkflowPaths: string[] = []
  const localActionPaths: string[] = []
  const externalJobWrappers: string[] = []

  const collectStep = (step: unknown): void => {
    if (isObject(step) === false || typeof step.uses !== 'string') {
      return
    }
    const uses = step.uses
    const match = ACTION_REFERENCE_PATTERN.exec(uses)
    if (match?.[1] !== undefined) {
      directReferences.push(match[1])
      return
    }
    if (uses.startsWith('./')) {
      localActionPaths.push(normalizeLocalPath(uses))
    }
  }

  if (isObject(document)) {
    const jobs = document.jobs
    if (isObject(jobs)) {
      for (const job of Object.values(jobs)) {
        if (isObject(job) === false) {
          continue
        }
        if (typeof job.uses === 'string' && job.uses.length > 0) {
          if (job.uses.startsWith('./')) {
            localWorkflowPaths.push(normalizeLocalPath(job.uses))
          } else {
            externalJobWrappers.push(job.uses)
          }
        }
        if (Array.isArray(job.steps)) {
          for (const step of job.steps) {
            collectStep(step)
          }
        }
      }
    }
    const runs = document.runs
    if (isObject(runs) && Array.isArray(runs.steps)) {
      for (const step of runs.steps) {
        collectStep(step)
      }
    }
  }

  return {ok: true, value: {directReferences, localWorkflowPaths, localActionPaths, externalJobWrappers}}
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
 * Search the complete run log text for the runner's `Download action repository` record for the
 * expected action ref. Duplicated lines are fine; disagreement is ambiguous; a missing or
 * truncated record fails closed.
 */
export function parseResolvedActionSha(logText: string, actionRef: string): ResolvedActionShaResult {
  const shas = new Set<string>()
  for (const match of logText.matchAll(RESOLVED_ACTION_PATTERN)) {
    const matchedRef = match[1]
    const matchedSha = match[2]
    if (matchedRef === actionRef && matchedSha !== undefined) {
      shas.add(matchedSha)
    }
  }
  if (shas.size === 0) {
    return {ok: false, reason: 'missing'}
  }
  if (shas.size > 1) {
    return {ok: false, reason: 'ambiguous'}
  }
  return {ok: true, sha: [...shas][0] as string}
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

/**
 * Bound the authenticated per-job evidence to a fail-closed rule that rejects only genuinely bad
 * terminal outcomes (`failure`, `cancelled`, `timed_out`, `action_required`, `stale`) at both job and
 * step level. `success`, `skipped`, and `neutral` are accepted: an `if:`-guarded step concluding
 * `skipped` is normal, and a skipped Fro Bot job or step is already fail-closed by provenance, since
 * the action download record would be absent. Jobs that are not yet `completed` are always rejected.
 */
export function areRunJobsSuccessful(jobs: readonly RunJobEvidence[]): boolean {
  if (jobs.length === 0) {
    return false
  }
  return jobs.every(
    job =>
      isAcceptableCompletion(job.status, job.conclusion) &&
      job.steps.every(step => isAcceptableCompletion(step.status, step.conclusion)),
  )
}

const ACCEPTED_COMPLETION_CONCLUSIONS: readonly string[] = ['success', 'skipped', 'neutral']

function isAcceptableCompletion(status: string, conclusion: string | null): boolean {
  return status === 'completed' && conclusion !== null && ACCEPTED_COMPLETION_CONCLUSIONS.includes(conclusion)
}

export function aggregatePrivate(dispositions: readonly Disposition[]): PrivateAggregate {
  let resolved = 0
  let unresolved = 0
  let unavailable = 0
  for (const disposition of dispositions) {
    if (disposition === 'qualified' || disposition === 'no-longer-applicable') {
      resolved += 1
    } else if (disposition === 'unavailable') {
      unavailable += 1
    } else {
      unresolved += 1
    }
  }
  return {total: dispositions.length, resolved, unresolved, unavailable}
}

/**
 * The canonical private closure rule: all three private entries positively terminal in the
 * current collector artifact. Historical aggregate progress alone never satisfies this.
 */
export function isPrivateClosureSatisfied(aggregate: PrivateAggregate): boolean {
  return (
    aggregate.total === PRIVATE_INVENTORY_TOTAL &&
    aggregate.resolved === PRIVATE_INVENTORY_TOTAL &&
    aggregate.unresolved === 0 &&
    aggregate.unavailable === 0
  )
}

export function determineCollectorStatus(dispositions: readonly Disposition[]): CollectorStatus {
  if (dispositions.length === 0) {
    return 'unavailable'
  }
  if (dispositions.every(disposition => disposition === 'unavailable')) {
    return 'unavailable'
  }
  if (dispositions.every(disposition => disposition === 'qualified' || disposition === 'no-longer-applicable')) {
    return 'ready'
  }
  return 'partial'
}

export function buildArtifact(input: BuildArtifactInput): ArtifactEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    producer: input.producer,
    baseline: input.baseline,
    collectorStatus: input.collectorStatus,
    public: input.publicDispositions,
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

const DISPOSITION_VALUES: readonly Disposition[] = [
  'qualified',
  'no-longer-applicable',
  'unresolved',
  'preflight-failed',
  'unavailable',
]

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

function isPublicDispositionRecord(value: unknown): boolean {
  if (isRecord(value) === false) return false
  return (
    typeof value.repository === 'string' &&
    value.repository.length > 0 &&
    typeof value.disposition === 'string' &&
    DISPOSITION_VALUES.includes(value.disposition as Disposition) &&
    typeof value.observedAt === 'string' &&
    typeof value.fetchStatusClass === 'string' &&
    FETCH_STATUS_CLASS_VALUES.includes(value.fetchStatusClass as FetchStatusClass) &&
    isNullableString(value.rejectionReason) &&
    isNullableString(value.event) &&
    isNullableNumber(value.runId) &&
    isNullableNumber(value.runAttempt) &&
    isNullableString(value.runUrl) &&
    isNullableString(value.workflowPath) &&
    isNullableString(value.actionRef) &&
    isNullableString(value.resolvedActionSha)
  )
}

/**
 * Structural validation of the version-1 envelope. `main()` runs this before writing the artifact
 * so a future shape regression fails closed with a constant-class message instead of publishing it.
 * Each public entry's required fields and types are validated, not merely the container shape.
 */
export function isSchemaV1Envelope(value: unknown): value is ArtifactEnvelope {
  if (isRecord(value) === false) return false
  const {schemaVersion, producer, baseline, collectorStatus, public: publicRecords, private: privateAggregate} = value
  return (
    schemaVersion === SCHEMA_VERSION &&
    isRecord(producer) &&
    hasStringFields(producer, ['runId', 'runAttempt', 'schedule', 'generatedAt']) &&
    isRecord(baseline) &&
    hasStringFields(baseline, ['minimumRelease', 'minimumReleasePublishedAt', 'credentialPreflightCommit']) &&
    (collectorStatus === 'ready' || collectorStatus === 'partial' || collectorStatus === 'unavailable') &&
    Array.isArray(publicRecords) &&
    publicRecords.every(isPublicDispositionRecord) &&
    isRecord(privateAggregate) &&
    hasNumberFields(privateAggregate, ['total', 'resolved', 'unresolved', 'unavailable'])
  )
}

// ---------------------------------------------------------------------------
// Orchestration (pure control flow over injected adapters)
// ---------------------------------------------------------------------------

function baseRecord(entry: InventoryEntry, observedAt: string): PublicDisposition {
  return {
    repository: `${entry.owner}/${entry.repo}`,
    disposition: 'unresolved',
    observedAt,
    fetchStatusClass: 'success',
    rejectionReason: null,
    event: null,
    runId: null,
    runAttempt: null,
    runUrl: null,
    workflowPath: null,
    actionRef: null,
    resolvedActionSha: null,
  }
}

function withRun(base: PublicDisposition, run: WorkflowRun, overrides: Partial<PublicDisposition>): PublicDisposition {
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
 * Evaluate one candidate run against the full provenance chain. Every branch returns a complete
 * public disposition so the caller only inspects `disposition`.
 */
async function evaluateRun(
  base: PublicDisposition,
  entry: InventoryEntry,
  run: WorkflowRun,
  adapters: CollectorAdapters,
): Promise<PublicDisposition> {
  if (
    run.event === 'pull_request' &&
    (run.headRepositoryFullName === null ||
      run.headRepositoryFullName.toLowerCase() !== `${entry.owner}/${entry.repo}`.toLowerCase())
  ) {
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: FORK_PULL_REQUEST_REJECTION_REASON})
  }

  const logs = await adapters.getRunLogs(entry, run.id, run.runAttempt)
  if (logs.ok === false) {
    return withRun(base, run, {
      disposition: 'unavailable',
      rejectionReason: 'run-logs-unavailable',
      fetchStatusClass: logs.fetchStatusClass,
    })
  }
  if (logs.text.includes(CREDENTIAL_REFUSAL_MARKER)) {
    // Evaluated before any success-based qualification: a downstream continue-on-error step can
    // refuse credentials while the overall run still concludes success.
    return withRun(base, run, {disposition: 'preflight-failed', rejectionReason: 'credential-preflight-refused'})
  }
  if (run.conclusion !== 'success') {
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: 'terminal-run-failed'})
  }
  const content = await adapters.getWorkflowContent(entry, run.path, run.headSha)
  if (content.ok === false) {
    return withRun(base, run, {
      disposition: 'unavailable',
      rejectionReason: 'workflow-content-unavailable',
      fetchStatusClass: content.fetchStatusClass,
    })
  }
  const parsedReferences = parseActionReferences(content.content)
  if (parsedReferences.ok === false) {
    return withRun(base, run, {
      disposition: 'unavailable',
      rejectionReason: 'workflow-content-unavailable',
      fetchStatusClass: parsedReferences.fetchStatusClass,
    })
  }
  const references = parsedReferences.references
  if (references.length === 0) {
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: 'missing-action-reference'})
  }
  if (references.some(reference => isQualifiableActionReference(reference) === false)) {
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: 'non-qualifiable-action-reference'})
  }
  const distinctReferences = [...new Set(references)]
  if (distinctReferences.length > 1) {
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: 'ambiguous-action-reference'})
  }
  const actionRef = distinctReferences[0]
  if (actionRef === undefined) {
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: 'missing-action-reference'})
  }
  const resolved = parseResolvedActionSha(logs.text, actionRef)
  if (resolved.ok === false) {
    const rejectionReason =
      resolved.reason === 'ambiguous' ? 'ambiguous-action-resolution' : 'missing-action-resolution'
    return withRun(base, run, {disposition: 'unresolved', rejectionReason, actionRef})
  }
  if (isFullSha(actionRef) && resolved.sha !== actionRef) {
    return withRun(base, run, {
      disposition: 'unresolved',
      rejectionReason: 'action-resolution-mismatch',
      actionRef,
      resolvedActionSha: resolved.sha,
    })
  }
  const ancestry = await adapters.isDescendantOfPreflight(resolved.sha)
  if (ancestry.ok === false) {
    return withRun(base, run, {
      disposition: 'unavailable',
      rejectionReason: 'ancestry-check-unavailable',
      fetchStatusClass: ancestry.fetchStatusClass,
      actionRef,
      resolvedActionSha: resolved.sha,
    })
  }
  if (ancestry.descendant === false) {
    return withRun(base, run, {
      disposition: 'unresolved',
      rejectionReason: 'non-descendant-action-sha',
      actionRef,
      resolvedActionSha: resolved.sha,
    })
  }
  // Provenance is satisfied; only now is the bounded per-job evidence fetch worth spending.
  const jobs = await adapters.getRunJobs(entry, run.id, run.runAttempt)
  if (jobs.ok === false) {
    return withRun(base, run, {
      disposition: 'unavailable',
      rejectionReason: 'run-jobs-unavailable',
      fetchStatusClass: jobs.fetchStatusClass,
    })
  }
  if (areRunJobsSuccessful(jobs.jobs) === false) {
    // Overall run success is not proof the Fro Bot invocation itself succeeded.
    return withRun(base, run, {disposition: 'unresolved', rejectionReason: 'run-jobs-not-successful'})
  }
  return withRun(base, run, {disposition: 'qualified', actionRef, resolvedActionSha: resolved.sha})
}

type WorkflowInspectionResult =
  | {readonly ok: true; readonly sawReference: boolean}
  | {readonly ok: false; readonly rejectionReason: string; readonly fetchStatusClass: FetchStatusClass}

interface ExternalWorkflowTarget {
  readonly owner: string
  readonly repo: string
  readonly path: string
  readonly ref: string
}

/** Parse `owner/repo/path@ref` job-level reusable-workflow `uses` values; anything else is unresolvable. */
const EXTERNAL_WORKFLOW_PATTERN = /^([^/@\s]+)\/([^/@\s]+)\/([^@\s]+)@(\S+)$/

function parseExternalWorkflowReference(uses: string): ExternalWorkflowTarget | null {
  const match = EXTERNAL_WORKFLOW_PATTERN.exec(uses)
  if (match === null) {
    return null
  }
  const owner = match[1]
  const repo = match[2]
  const path = match[3]
  const ref = match[4]
  if (owner === undefined || repo === undefined || path === undefined || ref === undefined) {
    return null
  }
  if (path.length === 0 || ref.length === 0) {
    return null
  }
  return {owner, repo, path, ref}
}

/**
 * Resolve an external reusable workflow from its own repository at the referenced ref and inspect it
 * within the same depth and visited-set bounds as local wrappers. An unresolvable fetch fails closed.
 */
async function inspectExternalWorkflow(
  target: ExternalWorkflowTarget,
  adapters: CollectorAdapters,
  visited: Set<string>,
  depth: number,
): Promise<WorkflowInspectionResult> {
  const visitKey = `workflow:${target.owner}/${target.repo}@${target.ref}:${target.path}`
  if (visited.has(visitKey)) {
    return {ok: true, sawReference: false}
  }
  visited.add(visitKey)
  if (depth + 1 > LIMITS.maxIndirectionDepth) {
    return {ok: false, rejectionReason: 'indirect-wrapper-unresolved', fetchStatusClass: 'success'}
  }
  const externalEntry: InventoryEntry = {owner: target.owner, repo: target.repo, workflowPaths: []}
  const result = await adapters.getWorkflowContent(externalEntry, target.path, target.ref)
  if (result.ok === false) {
    return {ok: false, rejectionReason: 'indirect-wrapper-unresolved', fetchStatusClass: result.fetchStatusClass}
  }
  return inspectManifestContent(externalEntry, adapters, target.ref, result.content, visited, depth + 1)
}

async function inspectManifestContent(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  ref: string,
  content: string,
  visited: Set<string>,
  depth: number,
): Promise<WorkflowInspectionResult> {
  const parsed = parseWorkflowIndirections(content)
  if (parsed.ok === false) {
    return {ok: false, rejectionReason: 'workflow-read-unavailable', fetchStatusClass: 'malformed'}
  }
  const indirections = parsed.value
  if (indirections.directReferences.length > 0) {
    return {ok: true, sawReference: true}
  }
  for (const wrapper of indirections.externalJobWrappers) {
    // A non-local wrapper could itself invoke Fro Bot; resolve and inspect it, or fail closed.
    const target = parseExternalWorkflowReference(wrapper)
    if (target === null) {
      return {ok: false, rejectionReason: 'indirect-wrapper-unresolved', fetchStatusClass: 'success'}
    }
    const nested = await inspectExternalWorkflow(target, adapters, visited, depth)
    if (nested.ok === false) {
      return nested
    }
    if (nested.sawReference) {
      return {ok: true, sawReference: true}
    }
  }
  for (const localPath of indirections.localWorkflowPaths) {
    const nested = await inspectWorkflow(entry, adapters, ref, localPath, visited, depth + 1)
    if (nested.ok === false) {
      return nested
    }
    if (nested.sawReference) {
      return {ok: true, sawReference: true}
    }
  }
  for (const actionDir of indirections.localActionPaths) {
    const nested = await inspectLocalAction(entry, adapters, ref, actionDir, visited, depth + 1)
    if (nested.ok === false) {
      return nested
    }
    if (nested.sawReference) {
      return {ok: true, sawReference: true}
    }
  }
  return {ok: true, sawReference: false}
}

async function inspectWorkflow(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  ref: string,
  path: string,
  visited: Set<string>,
  depth: number,
): Promise<WorkflowInspectionResult> {
  const visitKey = `workflow:${entry.owner}/${entry.repo}@${ref}:${path}`
  if (visited.has(visitKey)) {
    return {ok: true, sawReference: false}
  }
  visited.add(visitKey)
  if (depth > LIMITS.maxIndirectionDepth) {
    return {ok: false, rejectionReason: 'indirect-wrapper-unresolved', fetchStatusClass: 'success'}
  }
  const result = await adapters.getWorkflowContent(entry, path, ref)
  if (result.ok === false) {
    return {ok: false, rejectionReason: 'workflow-read-unavailable', fetchStatusClass: result.fetchStatusClass}
  }
  return inspectManifestContent(entry, adapters, ref, result.content, visited, depth)
}

async function inspectLocalAction(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  ref: string,
  actionDir: string,
  visited: Set<string>,
  depth: number,
): Promise<WorkflowInspectionResult> {
  const visitKey = `action:${entry.owner}/${entry.repo}@${ref}:${actionDir}`
  if (visited.has(visitKey)) {
    return {ok: true, sawReference: false}
  }
  visited.add(visitKey)
  if (depth > LIMITS.maxIndirectionDepth) {
    return {ok: false, rejectionReason: 'indirect-wrapper-unresolved', fetchStatusClass: 'success'}
  }
  const candidates =
    actionDir === '' ? ['action.yml', 'action.yaml'] : [`${actionDir}/action.yml`, `${actionDir}/action.yaml`]
  for (const candidate of candidates) {
    const result = await adapters.getWorkflowContent(entry, candidate, ref)
    if (result.ok === true) {
      return inspectManifestContent(entry, adapters, ref, result.content, visited, depth)
    }
    if (result.fetchStatusClass !== 'not-found') {
      return {ok: false, rejectionReason: 'indirect-wrapper-unavailable', fetchStatusClass: result.fetchStatusClass}
    }
  }
  // A local `uses: ./<path>` target with no action manifest cannot be resolved; fail closed.
  return {ok: false, rejectionReason: 'indirect-wrapper-unresolved', fetchStatusClass: 'not-found'}
}

async function classifyDefaultBranch(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  defaultBranch: string,
): Promise<Pick<PublicDisposition, 'disposition' | 'rejectionReason' | 'fetchStatusClass'>> {
  const workflowPaths = await adapters.listWorkflowPaths(entry)
  if (workflowPaths.ok === false) {
    return {
      disposition: 'unavailable',
      rejectionReason: 'workflow-list-unavailable',
      fetchStatusClass: workflowPaths.fetchStatusClass,
    }
  }

  const visited = new Set<string>()
  let sawReference = false
  for (const path of workflowPaths.paths) {
    const inspected = await inspectWorkflow(entry, adapters, defaultBranch, path, visited, 0)
    if (inspected.ok === false) {
      return {
        disposition: 'unavailable',
        rejectionReason: inspected.rejectionReason,
        fetchStatusClass: inspected.fetchStatusClass,
      }
    }
    if (inspected.sawReference) {
      sawReference = true
    }
  }
  return sawReference
    ? {disposition: 'unresolved', rejectionReason: 'no-qualifying-run', fetchStatusClass: 'success'}
    : {disposition: 'no-longer-applicable', rejectionReason: 'workflow-removed', fetchStatusClass: 'success'}
}

async function collectEntry(
  entry: InventoryEntry,
  adapters: CollectorAdapters,
  isPrivate: boolean,
  observedAt: string,
): Promise<PublicDisposition> {
  const base = baseRecord(entry, observedAt)

  const repository = await adapters.getRepository(entry)
  if (repository.ok === false) {
    return {
      ...base,
      disposition: 'unavailable',
      rejectionReason: 'repository-unavailable',
      fetchStatusClass: repository.fetchStatusClass,
    }
  }
  const expectedFullName = `${entry.owner}/${entry.repo}`
  if (repository.fullName.toLowerCase() !== expectedFullName.toLowerCase()) {
    return {...base, disposition: 'unavailable', rejectionReason: 'repository-identity-mismatch'}
  }
  if (repository.private !== isPrivate) {
    return {...base, disposition: 'unavailable', rejectionReason: 'repository-visibility-mismatch'}
  }
  if (repository.archived === true) {
    return {...base, disposition: 'no-longer-applicable', rejectionReason: 'repository-archived'}
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
        disposition: 'unavailable',
        rejectionReason: 'run-list-unavailable',
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
      disposition: 'unavailable',
      rejectionReason: 'pagination-bound-exhausted',
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
  let best: PublicDisposition | null = null
  let unavailableFallback: PublicDisposition | null = null
  for (const run of filtered) {
    if (evaluations >= LIMITS.maxCandidateLogs) {
      return {
        ...base,
        disposition: 'unavailable',
        rejectionReason: 'candidate-log-bound-exhausted',
        fetchStatusClass: 'success',
      }
    }
    evaluations += 1
    const evaluation = await evaluateRun(base, entry, run, adapters)
    if (evaluation.disposition === 'qualified') {
      return evaluation
    }
    if (evaluation.disposition === 'unavailable') {
      // Do not let one unavailable candidate mask a later in-budget candidate that qualifies;
      // surface unavailable only if nothing better is found.
      if (unavailableFallback === null) {
        unavailableFallback = evaluation
      }
      continue
    }
    if (best === null || (best.disposition !== 'preflight-failed' && evaluation.disposition === 'preflight-failed')) {
      best = evaluation
    }
  }
  if (best !== null) {
    return best
  }
  if (unavailableFallback !== null) {
    return unavailableFallback
  }

  const branch = await classifyDefaultBranch(entry, adapters, repository.defaultBranch)
  return {...base, ...branch}
}

export async function collectRuntimeVerification(input: CollectInput): Promise<ArtifactEnvelope> {
  const observedAt = input.now().toISOString()
  const publicDispositions: PublicDisposition[] = []
  for (const entry of input.publicInventory) {
    publicDispositions.push(await collectEntry(entry, input.adapters, false, observedAt))
  }

  const privateInventory = input.privateInventory
  const privateIsValid = privateInventory !== null && privateInventory.length === PRIVATE_INVENTORY_TOTAL
  const privateDispositions: Disposition[] = []
  let privateAggregate: PrivateAggregate
  if (privateInventory !== null && privateIsValid) {
    for (const entry of privateInventory) {
      privateDispositions.push((await collectEntry(entry, input.adapters, true, observedAt)).disposition)
    }
    privateAggregate = aggregatePrivate(privateDispositions)
  } else {
    privateAggregate = {
      total: PRIVATE_INVENTORY_TOTAL,
      resolved: 0,
      unresolved: 0,
      unavailable: PRIVATE_INVENTORY_TOTAL,
    }
  }

  const collectorStatus = privateIsValid
    ? determineCollectorStatus([...publicDispositions.map(record => record.disposition), ...privateDispositions])
    : 'unavailable'

  return buildArtifact({
    producer: input.producer,
    baseline: BASELINE,
    collectorStatus,
    publicDispositions,
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

type GhLogRunner = (entry: InventoryEntry, runId: number, runAttempt: number) => RunLogsResult

export interface GitHubAdapterOptions {
  readonly token: string
  readonly fetchImpl?: typeof fetch
  readonly runGh?: GhLogRunner
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxLogBytes?: number
  readonly logTimeoutMs?: number
  readonly logKillSignal?: NodeJS.Signals
}

/**
 * Classify a `gh run view --log` subprocess failure as a constant fetch-status class. A timeout is
 * classified distinctly from other failures so one stalled log retrieval cannot consume the job.
 */
export function classifyGhFailure(error: unknown): FetchStatusClass {
  const shape = error as {readonly code?: unknown; readonly status?: unknown; readonly signal?: unknown}
  if (shape.code === 'ENOBUFS') {
    return 'oversized'
  }
  if (shape.code === 'ETIMEDOUT' || shape.signal === 'SIGTERM' || shape.signal === 'SIGKILL') {
    return 'timeout'
  }
  if (typeof shape.status === 'number') {
    return failureClass(shape.status)
  }
  return 'error'
}

function defaultRunGh(token: string, maxBytes: number, timeoutMs: number, killSignal: NodeJS.Signals): GhLogRunner {
  return (entry, runId, runAttempt) => {
    try {
      const text = execFileSync(
        'gh',
        [
          'run',
          'view',
          String(runId),
          '--repo',
          `${entry.owner}/${entry.repo}`,
          '--log',
          '--attempt',
          String(runAttempt),
        ],
        {
          encoding: 'utf8',
          maxBuffer: maxBytes,
          timeout: timeoutMs,
          killSignal,
          env: {...process.env, GH_TOKEN: token},
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      return {ok: true, text}
    } catch (error: unknown) {
      return {ok: false, fetchStatusClass: classifyGhFailure(error)}
    }
  }
}

export function createGitHubAdapters(options: GitHubAdapterOptions): CollectorAdapters {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? LIMITS.requestTimeoutMs
  const maxResponseBytes = options.maxResponseBytes ?? LIMITS.maxResponseBytes
  const getRunLogs =
    options.runGh ??
    defaultRunGh(
      options.token,
      options.maxLogBytes ?? LIMITS.maxLogBytes,
      options.logTimeoutMs ?? LIMITS.logTimeoutMs,
      options.logKillSignal ?? 'SIGKILL',
    )

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
      const text = await response.text()
      if (text.length > maxResponseBytes) {
        return {ok: false, fetchStatusClass: 'oversized'}
      }
      return {ok: true, text}
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return {ok: false, fetchStatusClass: timedOut ? 'timeout' : 'error'}
    }
  }

  return {
    getRepository: async entry => {
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
    getRunLogs: async (entry, runId, runAttempt) => getRunLogs(entry, runId, runAttempt),
    getRunJobs: async (entry, runId, runAttempt) => {
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
  const status = value.status
  const conclusion = value.conclusion
  if (typeof status !== 'string') return null
  if (conclusion !== null && typeof conclusion !== 'string') return null
  const rawSteps = value.steps
  if (rawSteps !== undefined && Array.isArray(rawSteps) === false) return null
  const steps: RunStepEvidence[] = []
  if (Array.isArray(rawSteps)) {
    for (const step of rawSteps) {
      if (isObject(step) === false) return null
      const stepStatus = step.status
      const stepConclusion = step.conclusion
      if (typeof stepStatus !== 'string') return null
      if (stepConclusion !== null && typeof stepConclusion !== 'string') return null
      steps.push({status: stepStatus, conclusion: stepConclusion})
    }
  }
  return {status, conclusion, steps}
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
    const adapters = createGitHubAdapters({token: process.env.GH_TOKEN ?? ''})
    const artifact = await collectRuntimeVerification({
      producer,
      publicInventory: PUBLIC_INVENTORY,
      privateInventory: parsed.ok ? parsed.entries : null,
      adapters,
      now: () => new Date(),
    })
    if (isSchemaV1Envelope(artifact) === false) {
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
