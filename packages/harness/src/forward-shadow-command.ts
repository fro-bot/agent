/**
 * Thin workflow-facing command for one forward-shadow comparison.
 *
 * The integration driver owns the shadow outcome. This command only reads that
 * bounded result, compares the shadow worktree with the authoritative ref, and
 * writes one validated record. A missing or failed outcome is evidence of an
 * inconclusive shadow, never a match.
 */

import type {ForwardShadowComparisonInput, ForwardShadowConflictMetrics, ForwardShadowRecord} from './forward-shadow.js'
import type {IntegrationResult, IntegrationStage, ProvenanceManifest} from './integrate.js'
import fs from 'node:fs/promises'
import process from 'node:process'
import {buildForwardShadowRecord, compareForwardShadow, writeForwardShadowRecord} from './forward-shadow.js'
import {isValidBaseVersion} from './integrate-command.js'
import {isValidCarryManifest} from './sources.js'

interface ParsedFlags {
  readonly resultOut: string
  readonly recordOut: string
  readonly baseVersion: string
  readonly shadowWorkDir: string
  readonly releaseRepo: string
  readonly authoritativeRepository: string
  readonly authoritativeRef: string
  readonly shadowRef: string
  readonly runIdentity: string
}

interface OutcomeSnapshot {
  readonly result: IntegrationResult
  readonly conflictMetrics: ForwardShadowConflictMetrics
  readonly startedAt: string
  readonly endedAt: string
  readonly integrationRefs: readonly {readonly ref: string; readonly resolvedSha: string}[]
}

export interface ForwardShadowCommandDependencies {
  readonly readFile: (path: string) => Promise<string>
  readonly compare: (input: ForwardShadowComparisonInput) => Promise<ForwardShadowRecord>
  readonly writeRecord: (path: string, record: ForwardShadowRecord) => Promise<void>
  readonly now: () => Date
}

const DEFAULT_DEPENDENCIES: ForwardShadowCommandDependencies = {
  readFile: async path => fs.readFile(path, 'utf8'),
  compare: async input => compareForwardShadow(input),
  writeRecord: writeForwardShadowRecord,
  now: () => new Date(),
}

const OID_PATTERN = /^[0-9a-f]{40}$/i
const MAX_RUN_IDENTITY_LENGTH = 512
// The Record keys are exhaustive: adding an IntegrationStage requires updating this map.
const INTEGRATION_STAGES: Readonly<Record<IntegrationStage, true>> = {
  sources: true,
  clone: true,
  'fetch-tags': true,
  branch: true,
  fetch: true,
  merge: true,
  squash: true,
  'workflow-strip': true,
  commit: true,
  build: true,
  version: true,
  tree: true,
  provenance: true,
  cleanup: true,
  push: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDateString(value: unknown): value is string {
  return isString(value) && Number.isNaN(Date.parse(value)) === false
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isIntegrationStage(value: unknown): value is IntegrationStage {
  return typeof value === 'string' && Object.hasOwn(INTEGRATION_STAGES, value)
}

function parseFailure(value: unknown): {readonly stage: IntegrationStage; readonly error: string} | undefined {
  if (isRecord(value) === false || isIntegrationStage(value.stage) === false || isString(value.error) === false)
    return undefined
  return {stage: value.stage, error: value.error}
}

function emptyMetrics(): ForwardShadowConflictMetrics {
  return {hadConflict: false, conflictPathCount: 0, conflictSizeBytes: 0, resolverAttempts: 0, contextRequestCount: 0}
}

function parseMetrics(value: unknown): ForwardShadowConflictMetrics | undefined {
  if (value === undefined) return emptyMetrics()
  if (isRecord(value) === false) return undefined
  if (
    typeof value.hadConflict !== 'boolean' ||
    isNonNegativeInteger(value.conflictPathCount) === false ||
    isNonNegativeInteger(value.conflictSizeBytes) === false ||
    isNonNegativeInteger(value.resolverAttempts) === false ||
    isNonNegativeInteger(value.contextRequestCount) === false
  ) {
    return undefined
  }
  return {
    hadConflict: value.hadConflict,
    conflictPathCount: value.conflictPathCount,
    conflictSizeBytes: value.conflictSizeBytes,
    resolverAttempts: value.resolverAttempts,
    contextRequestCount: value.contextRequestCount,
  }
}

function parseManifest(value: unknown, baseVersion: string): ProvenanceManifest | undefined {
  if (isRecord(value) === false || value.baseVersion !== baseVersion || isString(value.buildSha) === false) {
    return undefined
  }
  if (
    OID_PATTERN.test(String(value.integrationCommit)) === false ||
    isValidCarryManifest(value.carryManifest) === false ||
    value.carryManifest.base !== `v${baseVersion}` ||
    Array.isArray(value.integrationRefs) === false ||
    value.carryManifest.carries.length !== value.integrationRefs.length
  ) {
    return undefined
  }
  const integrationRefs: {readonly ref: string; readonly resolvedSha: string}[] = []
  for (const [index, entry] of value.integrationRefs.entries()) {
    if (
      isRecord(entry) === false ||
      isString(entry.ref) === false ||
      typeof entry.resolvedSha !== 'string' ||
      OID_PATTERN.test(entry.resolvedSha) === false ||
      value.carryManifest.carries[index]?.ref !== entry.ref ||
      value.carryManifest.carries[index]?.resolvedSha.toLowerCase() !== entry.resolvedSha.toLowerCase()
    ) {
      return undefined
    }
    integrationRefs.push({ref: entry.ref, resolvedSha: entry.resolvedSha.toLowerCase()})
  }
  return {
    baseVersion,
    carryManifest: {
      base: value.carryManifest.base,
      carries: value.carryManifest.carries.map(carry => ({
        ref: carry.ref,
        resolvedSha: carry.resolvedSha.toLowerCase(),
      })),
    },
    integrationRefs,
    integrationCommit: String(value.integrationCommit).toLowerCase(),
    buildSha: value.buildSha,
  }
}

function invalidOutcome(now: Date, message: string): OutcomeSnapshot {
  const timestamp = now.toISOString()
  return {
    result: {ok: false, kind: 'failure', error: message},
    conflictMetrics: {
      hadConflict: false,
      conflictPathCount: 0,
      conflictSizeBytes: 0,
      resolverAttempts: 0,
      contextRequestCount: 0,
    },
    startedAt: timestamp,
    endedAt: timestamp,
    integrationRefs: [],
  }
}

async function readOutcome(
  path: string,
  baseVersion: string,
  dependencies: ForwardShadowCommandDependencies,
): Promise<OutcomeSnapshot> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await dependencies.readFile(path))
  } catch {
    return invalidOutcome(dependencies.now(), 'shadow outcome is missing or unreadable')
  }
  if (isRecord(parsed) === false || parsed.schemaVersion !== 1 || typeof parsed.ok !== 'boolean') {
    return invalidOutcome(dependencies.now(), 'shadow outcome is invalid')
  }
  const startedAt = isDateString(parsed.startedAt) ? parsed.startedAt : dependencies.now().toISOString()
  const endedAt = isDateString(parsed.endedAt) ? parsed.endedAt : dependencies.now().toISOString()
  const conflictMetrics = parseMetrics(parsed.conflictMetrics)
  if (conflictMetrics === undefined)
    return invalidOutcome(dependencies.now(), 'shadow outcome conflict metrics are invalid')
  if (parsed.ok === false) {
    const failure = parseFailure(parsed.failure)
    return {
      result:
        failure === undefined
          ? {ok: false, kind: 'failure', error: 'shadow integration outcome reported failure'}
          : {ok: false, kind: 'failure', stage: failure.stage, error: failure.error},
      conflictMetrics,
      startedAt,
      endedAt,
      integrationRefs: [],
    }
  }
  const manifest = parseManifest(parsed.manifest, baseVersion)
  if (manifest === undefined || manifest.carryManifest === undefined) {
    return invalidOutcome(dependencies.now(), 'shadow outcome manifest is invalid')
  }
  return {
    result: {ok: true, manifest, conflictDiagnostics: []},
    conflictMetrics,
    startedAt,
    endedAt,
    integrationRefs: manifest.carryManifest.carries,
  }
}

function parseFlags(argv: readonly string[]): ParsedFlags | undefined {
  const values = new Map<string, string>()
  const allowed = new Set([
    '--result-out',
    '--record-out',
    '--base-version',
    '--shadow-work-dir',
    '--release-repo',
    '--authoritative-repository',
    '--authoritative-ref',
    '--shadow-ref',
    '--run-identity',
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === undefined || allowed.has(flag) === false) return undefined
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--') || value.length === 0) return undefined
    values.set(flag, value)
    index += 1
  }
  const resultOut = values.get('--result-out')
  const recordOut = values.get('--record-out')
  const baseVersion = values.get('--base-version')
  const shadowWorkDir = values.get('--shadow-work-dir')
  const releaseRepo = values.get('--release-repo')
  const authoritativeRepository = values.get('--authoritative-repository')
  const authoritativeRef = values.get('--authoritative-ref')
  const shadowRef = values.get('--shadow-ref') ?? 'HEAD'
  const runIdentity = values.get('--run-identity')
  if (
    resultOut === undefined ||
    recordOut === undefined ||
    baseVersion === undefined ||
    shadowWorkDir === undefined ||
    releaseRepo === undefined ||
    authoritativeRepository === undefined ||
    authoritativeRef === undefined ||
    runIdentity === undefined ||
    isValidBaseVersion(baseVersion) === false ||
    runIdentity.length > MAX_RUN_IDENTITY_LENGTH
  ) {
    return undefined
  }
  return {
    resultOut,
    recordOut,
    baseVersion,
    shadowWorkDir,
    releaseRepo,
    authoritativeRepository,
    authoritativeRef,
    shadowRef,
    runIdentity,
  }
}

export async function runForwardShadowCommand(
  argv: readonly string[],
  dependencies: ForwardShadowCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const flags = parseFlags(argv)
  if (flags === undefined) return 1
  const outcome = await readOutcome(flags.resultOut, flags.baseVersion, dependencies)
  const comparisonInput: ForwardShadowComparisonInput = {
    baseVersion: flags.baseVersion,
    releaseRepo: flags.releaseRepo,
    authoritativeRepository: flags.authoritativeRepository,
    integrationRefs: outcome.integrationRefs,
    shadowWorkDir: flags.shadowWorkDir,
    shadowRef: flags.shadowRef,
    authoritativeRef: flags.authoritativeRef,
    runIdentity: flags.runIdentity,
    startedAt: outcome.startedAt,
    endedAt: outcome.endedAt,
    conflictMetrics: outcome.conflictMetrics,
    result: outcome.result,
  }
  let record: ForwardShadowRecord
  try {
    record = await dependencies.compare(comparisonInput)
  } catch {
    record = buildForwardShadowRecord({
      baseVersion: comparisonInput.baseVersion,
      releaseRepo: comparisonInput.releaseRepo,
      integrationRefs: comparisonInput.integrationRefs,
      shadow: {ref: comparisonInput.shadowRef, commit: null, tree: null},
      authoritative: {ref: comparisonInput.authoritativeRef, commit: null, tree: null},
      divergence: {summary: '', paths: [], shortstat: ''},
      conflictMetrics: comparisonInput.conflictMetrics ?? emptyMetrics(),
      startedAt: comparisonInput.startedAt,
      endedAt: comparisonInput.endedAt,
      durationMs: 0,
      runIdentity: comparisonInput.runIdentity,
      failureStage: 'shadow-compare',
      failureError: 'shadow comparison failed',
    })
  }
  try {
    await dependencies.writeRecord(flags.recordOut, record)
    return 0
  } catch {
    return 1
  }
}

async function main(): Promise<void> {
  process.exitCode = await runForwardShadowCommand(process.argv.slice(2))
}

if (process.argv[1]?.endsWith('forward-shadow-command.ts') === true) {
  main().catch(() => {
    process.exitCode = 1
  })
}
