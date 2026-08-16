/**
 * Forward-shadow evidence primitives.
 *
 * This module deliberately keeps the evidence contract small: exact source
 * SHAs, exact commit/tree identities, bounded divergence, and a conservative
 * gate. It does not contain release-workflow authority or a second integration
 * driver.
 */

import type {ConflictResolverResult} from './conflict-resolver.js'
import type {IntegrationResult, ProvenanceManifest} from './integrate.js'
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

export const FORWARD_SHADOW_SCHEMA_VERSION = 1 as const
export const FORWARD_SHADOW_MIN_MATCHES = 3
export const FORWARD_SHADOW_MAX_DIVERGENCE_PATHS = 200
export const FORWARD_SHADOW_MAX_TEXT = 512
const FORWARD_SHADOW_GIT_MAX_BUFFER = 8 * 1024 * 1024

export type ForwardShadowVerdict = 'match' | 'mismatch' | 'inconclusive'

export interface ForwardShadowRef {
  readonly ref: string
  readonly resolvedSha: string
}

export interface ForwardShadowEndpoint {
  readonly ref: string
  readonly commit: string | null
  readonly tree: string | null
}

export interface ForwardShadowDivergencePath {
  readonly status: string
  readonly path: string
}

export interface ForwardShadowDivergence {
  readonly summary: string
  readonly paths: readonly ForwardShadowDivergencePath[]
  readonly shortstat: string
}

export interface ForwardShadowConflictMetrics {
  readonly hadConflict: boolean
  readonly conflictPathCount: number
  readonly conflictSizeBytes: number
  readonly resolverAttempts: number
  readonly contextRequestCount: number
}

export interface ForwardShadowRecord {
  readonly schemaVersion: typeof FORWARD_SHADOW_SCHEMA_VERSION
  readonly verdict: ForwardShadowVerdict
  readonly baseVersion: string
  readonly releaseRepo: string
  readonly integrationRefs: readonly ForwardShadowRef[]
  readonly shadow: ForwardShadowEndpoint
  readonly authoritative: ForwardShadowEndpoint
  readonly divergence: ForwardShadowDivergence
  readonly conflictMetrics: ForwardShadowConflictMetrics
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly manualIntervention: false
  readonly manualInterventionNote: ''
  readonly runIdentity: string
  readonly failureStage?: string
  readonly failureError?: string
}

export type ForwardShadowGateStatus = 'ready' | 'insufficient-evidence' | 'evidence-contradicts'

export interface ForwardShadowRecordInput {
  readonly baseVersion: string
  readonly releaseRepo: string
  readonly integrationRefs: readonly ForwardShadowRef[]
  readonly shadow: ForwardShadowEndpoint
  readonly authoritative: ForwardShadowEndpoint
  readonly divergence: ForwardShadowDivergence
  readonly conflictMetrics: ForwardShadowConflictMetrics
  readonly startedAt: string
  readonly endedAt: string
  readonly durationMs: number
  readonly runIdentity: string
  readonly failureStage?: string
  readonly failureError?: string
}

export interface ForwardShadowValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly value?: ForwardShadowRecord
}

export interface ForwardShadowGitAdapter {
  readonly fetchAuthoritativeRef: (request: {
    readonly workDir: string
    readonly repository: string
    readonly ref: string
    readonly env: NodeJS.ProcessEnv
  }) => Promise<string>
  readonly resolveCommitTree: (
    workDir: string,
    ref: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{readonly commit: string; readonly tree: string}>
  readonly diffTrees: (
    workDir: string,
    shadowCommit: string,
    authoritativeCommit: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ForwardShadowDivergence>
}

export interface ForwardShadowComparisonInput {
  readonly baseVersion: string
  readonly releaseRepo: string
  readonly authoritativeRepository: string
  readonly integrationRefs: readonly ForwardShadowRef[]
  readonly shadowWorkDir: string
  readonly shadowRef: string
  readonly authoritativeRef: string
  readonly runIdentity: string
  readonly startedAt: string
  readonly endedAt: string
  readonly conflictMetrics?: ForwardShadowConflictMetrics
  readonly result: IntegrationResult
}

export interface ForwardShadowGateOptions {
  readonly ackNoConflictEvidence?: boolean
}

export interface ForwardShadowGateResult {
  readonly ok: boolean
  readonly status: ForwardShadowGateStatus
  readonly matchCount: number
  readonly distinctBaseVersions: readonly string[]
  readonly conflictEvidenceCount: number
  readonly invalidRecordCount: number
  readonly reasons: readonly string[]
}

function safeEvidencePathSegment(value: string): string {
  const sanitized = value.replaceAll(/[^\w.-]+/g, '-').replaceAll(/^-+|-+$/g, '')
  return sanitized.length === 0 ? 'unknown' : sanitized.slice(0, 128)
}

export function forwardShadowEvidencePath(
  directory: string,
  record: Pick<ForwardShadowRecord, 'baseVersion' | 'verdict'>,
  evidenceKey: string,
): string {
  const baseVersion = safeEvidencePathSegment(record.baseVersion)
  if (record.verdict === 'match') return path.join(directory, `${baseVersion}.json`)
  return path.join(directory, 'non-matches', `${baseVersion}-${safeEvidencePathSegment(evidenceKey)}.json`)
}

export interface IntegrationOutcomeFile {
  readonly schemaVersion: typeof FORWARD_SHADOW_SCHEMA_VERSION
  readonly ok: boolean
  readonly startedAt: string
  readonly endedAt: string
  readonly elapsedMs: number
  readonly manifest?: ProvenanceManifest
  readonly conflictDiagnostics?: readonly ConflictResolverResult[]
  readonly conflictMetrics?: ForwardShadowConflictMetrics
  readonly failure?: {
    readonly stage: string
    readonly error: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

function boundedText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  let sanitized = ''
  for (const character of text) {
    const code = character.charCodeAt(0)
    sanitized += code <= 31 || code === 127 ? ' ' : character
  }
  return sanitized.replaceAll(/\s+/g, ' ').trim().slice(0, FORWARD_SHADOW_MAX_TEXT)
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, errors: string[]): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (allowedSet.has(key) === false) errors.push(`${label} contains unknown field ${key}`)
  }
}

function validateEndpoint(value: unknown, label: string, errors: string[]): value is ForwardShadowEndpoint {
  if (!isRecord(value)) {
    errors.push(`${label} is not an object`)
    return false
  }
  checkKeys(value, ['ref', 'commit', 'tree'], label, errors)
  if (typeof value.ref !== 'string' || value.ref.length === 0) errors.push(`${label}.ref is invalid`)
  if (value.commit !== null && !isOid(value.commit)) errors.push(`${label}.commit is not a 40-hex OID or null`)
  if (value.tree !== null && !isOid(value.tree)) errors.push(`${label}.tree is not a 40-hex OID or null`)
  return true
}

function validateConflictMetrics(value: unknown, errors: string[]): value is ForwardShadowConflictMetrics {
  if (!isRecord(value)) {
    errors.push('conflictMetrics is not an object')
    return false
  }
  checkKeys(
    value,
    ['hadConflict', 'conflictPathCount', 'conflictSizeBytes', 'resolverAttempts', 'contextRequestCount'],
    'conflictMetrics',
    errors,
  )
  if (typeof value.hadConflict !== 'boolean') errors.push('conflictMetrics.hadConflict is invalid')
  for (const key of ['conflictPathCount', 'conflictSizeBytes', 'resolverAttempts', 'contextRequestCount']) {
    if (!isNonNegativeInteger(value[key])) errors.push(`conflictMetrics.${key} is invalid`)
  }
  return true
}

function validateDivergence(value: unknown, errors: string[]): value is ForwardShadowDivergence {
  if (!isRecord(value)) {
    errors.push('divergence is not an object')
    return false
  }
  checkKeys(value, ['summary', 'paths', 'shortstat'], 'divergence', errors)
  if (typeof value.summary !== 'string' || value.summary.length > FORWARD_SHADOW_MAX_TEXT) {
    errors.push('divergence.summary is invalid')
  }
  if (typeof value.shortstat !== 'string' || value.shortstat.length > FORWARD_SHADOW_MAX_TEXT) {
    errors.push('divergence.shortstat is invalid')
  }
  if (!Array.isArray(value.paths) || value.paths.length > FORWARD_SHADOW_MAX_DIVERGENCE_PATHS) {
    errors.push('divergence.paths is invalid')
    return false
  }
  for (const [index, entry] of value.paths.entries()) {
    if (!isRecord(entry)) {
      errors.push(`divergence.paths[${index}] is not an object`)
      continue
    }
    checkKeys(entry, ['status', 'path'], `divergence.paths[${index}]`, errors)
    if (typeof entry.status !== 'string' || entry.status.length === 0 || entry.status.length > 16) {
      errors.push(`divergence.paths[${index}].status is invalid`)
    }
    if (typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.length > FORWARD_SHADOW_MAX_TEXT) {
      errors.push(`divergence.paths[${index}].path is invalid`)
    }
  }
  return true
}

export function validateForwardShadowRecord(value: unknown): ForwardShadowValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return {ok: false, errors: ['record is not an object']}
  checkKeys(
    value,
    [
      'schemaVersion',
      'verdict',
      'baseVersion',
      'releaseRepo',
      'integrationRefs',
      'shadow',
      'authoritative',
      'divergence',
      'conflictMetrics',
      'startedAt',
      'endedAt',
      'durationMs',
      'manualIntervention',
      'manualInterventionNote',
      'runIdentity',
      'failureStage',
      'failureError',
    ],
    'record',
    errors,
  )
  if (value.schemaVersion !== FORWARD_SHADOW_SCHEMA_VERSION) errors.push('schemaVersion is not 1')
  if (value.verdict !== 'match' && value.verdict !== 'mismatch' && value.verdict !== 'inconclusive') {
    errors.push('verdict is invalid')
  }
  if (typeof value.baseVersion !== 'string' || value.baseVersion.length === 0) errors.push('baseVersion is invalid')
  if (typeof value.releaseRepo !== 'string' || value.releaseRepo.length === 0) errors.push('releaseRepo is invalid')
  if (Array.isArray(value.integrationRefs)) {
    const refs = new Set<string>()
    for (const [index, entry] of value.integrationRefs.entries()) {
      if (!isRecord(entry)) {
        errors.push(`integrationRefs[${index}] is not an object`)
        continue
      }
      checkKeys(entry, ['ref', 'resolvedSha'], `integrationRefs[${index}]`, errors)
      if (typeof entry.ref !== 'string' || entry.ref.length === 0)
        errors.push(`integrationRefs[${index}].ref is invalid`)
      if (!isOid(entry.resolvedSha)) errors.push(`integrationRefs[${index}].resolvedSha is invalid`)
      if (typeof entry.ref === 'string' && refs.has(entry.ref))
        errors.push(`integrationRefs contains duplicate ref ${entry.ref}`)
      if (typeof entry.ref === 'string') refs.add(entry.ref)
    }
  } else {
    errors.push('integrationRefs is invalid')
  }
  validateEndpoint(value.shadow, 'shadow', errors)
  validateEndpoint(value.authoritative, 'authoritative', errors)
  validateDivergence(value.divergence, errors)
  validateConflictMetrics(value.conflictMetrics, errors)
  if (!isDateString(value.startedAt) || !isDateString(value.endedAt)) errors.push('startedAt/endedAt are invalid')
  if (!isNonNegativeInteger(value.durationMs)) errors.push('durationMs is invalid')
  if (typeof value.manualIntervention !== 'boolean' || value.manualIntervention !== false) {
    errors.push('manualIntervention must be false')
  }
  if (value.manualInterventionNote !== '') errors.push('manualInterventionNote must be empty')
  if (typeof value.runIdentity !== 'string' || value.runIdentity.length === 0) errors.push('runIdentity is invalid')
  if (
    value.failureStage !== undefined &&
    (typeof value.failureStage !== 'string' || value.failureStage.length > FORWARD_SHADOW_MAX_TEXT)
  ) {
    errors.push('failureStage is invalid')
  }
  if (
    value.failureError !== undefined &&
    (typeof value.failureError !== 'string' || value.failureError.length > FORWARD_SHADOW_MAX_TEXT)
  ) {
    errors.push('failureError is invalid')
  }

  const shadow = value.shadow as ForwardShadowEndpoint | undefined
  const authoritative = value.authoritative as ForwardShadowEndpoint | undefined
  const comparable =
    shadow !== undefined &&
    authoritative !== undefined &&
    isOid(shadow.commit) &&
    isOid(shadow.tree) &&
    isOid(authoritative.commit) &&
    isOid(authoritative.tree)
  const expectedVerdict = comparable
    ? shadow.tree?.toLowerCase() === authoritative.tree?.toLowerCase()
      ? 'match'
      : 'mismatch'
    : 'inconclusive'
  if (value.verdict !== expectedVerdict)
    errors.push(`verdict does not match endpoint OIDs; expected ${expectedVerdict}`)
  if (value.verdict !== 'inconclusive' && (value.failureStage !== undefined || value.failureError !== undefined)) {
    errors.push('match/mismatch records must not contain failure fields')
  }

  return errors.length === 0
    ? {ok: true, errors: [], value: value as unknown as ForwardShadowRecord}
    : {ok: false, errors}
}

function validateIntegrationOutcomeFile(value: unknown): readonly string[] {
  const errors: string[] = []
  if (!isRecord(value)) return ['outcome is not an object']
  checkKeys(
    value,
    [
      'schemaVersion',
      'ok',
      'startedAt',
      'endedAt',
      'elapsedMs',
      'manifest',
      'conflictDiagnostics',
      'conflictMetrics',
      'failure',
    ],
    'outcome',
    errors,
  )
  if (value.schemaVersion !== FORWARD_SHADOW_SCHEMA_VERSION) errors.push('outcome.schemaVersion is not 1')
  if (typeof value.ok !== 'boolean') errors.push('outcome.ok is invalid')
  if (!isDateString(value.startedAt) || !isDateString(value.endedAt))
    errors.push('outcome.startedAt/endedAt are invalid')
  if (!isNonNegativeInteger(value.elapsedMs)) errors.push('outcome.elapsedMs is invalid')

  if (value.manifest !== undefined) {
    if (isRecord(value.manifest)) {
      checkKeys(
        value.manifest,
        ['baseVersion', 'integrationRefs', 'integrationCommit', 'buildSha'],
        'outcome.manifest',
        errors,
      )
      if (typeof value.manifest.baseVersion !== 'string' || value.manifest.baseVersion.length === 0) {
        errors.push('outcome.manifest.baseVersion is invalid')
      }
      if (value.manifest.integrationCommit !== null && typeof value.manifest.integrationCommit !== 'string') {
        errors.push('outcome.manifest.integrationCommit is invalid')
      }
      if (typeof value.manifest.buildSha !== 'string') errors.push('outcome.manifest.buildSha is invalid')
      if (Array.isArray(value.manifest.integrationRefs) === false) {
        errors.push('outcome.manifest.integrationRefs is invalid')
      }
    } else {
      errors.push('outcome.manifest is not an object')
    }
  }

  if (value.conflictDiagnostics !== undefined && Array.isArray(value.conflictDiagnostics) === false) {
    errors.push('outcome.conflictDiagnostics is invalid')
  }
  if (value.conflictMetrics !== undefined) validateConflictMetrics(value.conflictMetrics, errors)
  if (value.failure !== undefined) {
    if (isRecord(value.failure)) {
      checkKeys(value.failure, ['stage', 'error'], 'outcome.failure', errors)
      if (typeof value.failure.stage !== 'string' || value.failure.stage.length === 0) {
        errors.push('outcome.failure.stage is invalid')
      }
      if (typeof value.failure.error !== 'string' || value.failure.error.length > FORWARD_SHADOW_MAX_TEXT) {
        errors.push('outcome.failure.error is invalid')
      }
    } else {
      errors.push('outcome.failure is not an object')
    }
  }
  return errors
}

function endpointValue(value: ForwardShadowEndpoint): ForwardShadowEndpoint {
  return {
    ref: boundedText(value.ref),
    commit: typeof value.commit === 'string' ? value.commit.toLowerCase() : null,
    tree: typeof value.tree === 'string' ? value.tree.toLowerCase() : null,
  }
}

export function buildForwardShadowRecord(input: ForwardShadowRecordInput): ForwardShadowRecord {
  const shadow = endpointValue(input.shadow)
  const authoritative = endpointValue(input.authoritative)
  const validEndpoints =
    isOid(shadow.commit) && isOid(shadow.tree) && isOid(authoritative.commit) && isOid(authoritative.tree)
  const verdict: ForwardShadowVerdict = validEndpoints
    ? shadow.tree === authoritative.tree
      ? 'match'
      : 'mismatch'
    : 'inconclusive'
  const record: ForwardShadowRecord = {
    schemaVersion: FORWARD_SHADOW_SCHEMA_VERSION,
    verdict,
    baseVersion: boundedText(input.baseVersion),
    releaseRepo: boundedText(input.releaseRepo),
    integrationRefs: input.integrationRefs.map(ref => ({
      ref: boundedText(ref.ref),
      resolvedSha: ref.resolvedSha.toLowerCase(),
    })),
    shadow,
    authoritative,
    divergence: {
      summary: boundedText(input.divergence.summary),
      paths: input.divergence.paths.slice(0, FORWARD_SHADOW_MAX_DIVERGENCE_PATHS).map(entry => ({
        status: boundedText(entry.status).slice(0, 16),
        path: boundedText(entry.path),
      })),
      shortstat: boundedText(input.divergence.shortstat),
    },
    conflictMetrics: {...input.conflictMetrics},
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMs: input.durationMs,
    manualIntervention: false,
    manualInterventionNote: '',
    runIdentity: boundedText(input.runIdentity),
    ...(input.failureStage === undefined ? {} : {failureStage: boundedText(input.failureStage)}),
    ...(input.failureError === undefined ? {} : {failureError: boundedText(input.failureError)}),
  }
  return record
}

async function writeAtomicJson(outputPath: string, value: unknown): Promise<void> {
  const parent = path.dirname(outputPath)
  await fs.mkdir(parent, {recursive: true})
  const scratch = await fs.mkdtemp(path.join(parent, '.forward-shadow-write-'))
  const temporaryPath = path.join(scratch, path.basename(outputPath))
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600})
    await fs.rename(temporaryPath, outputPath)
  } finally {
    await fs.rm(scratch, {recursive: true, force: true})
  }
}

export async function writeForwardShadowRecord(outputPath: string, record: ForwardShadowRecord): Promise<void> {
  const validation = validateForwardShadowRecord(record)
  if (validation.ok === false)
    throw new Error(`cannot write invalid forward shadow record: ${validation.errors.join('; ')}`)
  await writeAtomicJson(outputPath, record)
}

function allowedRuntimeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CI', 'NO_COLOR'])
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key) && value !== undefined) result[key] = value
  }
  result.GIT_TERMINAL_PROMPT = '0'
  result.GIT_CONFIG_NOSYSTEM = '1'
  result.GIT_CONFIG_GLOBAL = '/dev/null'
  result.GIT_CONFIG_SYSTEM = '/dev/null'
  result.GIT_OPTIONAL_LOCKS = '0'
  return result
}

export function makeAnonymousGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return allowedRuntimeEnvironment(source)
}

async function runGit(args: readonly string[], workDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd: workDir,
    env,
    encoding: 'utf8',
    maxBuffer: FORWARD_SHADOW_GIT_MAX_BUFFER,
    timeout: 120_000,
  })
  return result.stdout
}

function parseNameStatus(output: string): readonly ForwardShadowDivergencePath[] {
  const fields = output.split('\u0000')
  const paths: ForwardShadowDivergencePath[] = []
  for (let index = 0; index + 1 < fields.length && paths.length < FORWARD_SHADOW_MAX_DIVERGENCE_PATHS; index += 2) {
    const status = fields[index]
    const filePath = fields[index + 1]
    if (status === undefined || filePath === undefined || status.length === 0 || filePath.length === 0) continue
    paths.push({status: boundedText(status).slice(0, 16), path: boundedText(filePath)})
  }
  return paths
}

function anonymousRepositoryUrl(repository: string): string {
  const trimmed = repository.trim()
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return `https://github.com/${trimmed}.git`
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' || url.username.length > 0 || url.password.length > 0) {
    throw new Error('authoritative repository must be anonymous HTTPS')
  }
  return url.toString()
}

const defaultForwardShadowGitAdapter: ForwardShadowGitAdapter = {
  fetchAuthoritativeRef: async request => {
    const localRef = `refs/harness-shadow/authoritative-${Date.now().toString(36)}`
    await runGit(
      ['fetch', '--no-tags', '--no-prune', anonymousRepositoryUrl(request.repository), `${request.ref}:${localRef}`],
      request.workDir,
      request.env,
    )
    return localRef
  },
  resolveCommitTree: async (workDir, ref, env) => {
    const commit = (await runGit(['rev-parse', '--verify', `${ref}^{commit}`], workDir, env)).trim()
    const tree = (await runGit(['rev-parse', '--verify', `${ref}^{tree}`], workDir, env)).trim()
    return {commit, tree}
  },
  diffTrees: async (workDir, shadowCommit, authoritativeCommit, env) => {
    const paths = parseNameStatus(
      await runGit(['diff', '--name-status', '-z', '--no-renames', shadowCommit, authoritativeCommit], workDir, env),
    )
    const shortstat = boundedText(
      (await runGit(['diff', '--shortstat', shadowCommit, authoritativeCommit], workDir, env)).trim(),
    )
    return {
      summary: paths.length === 0 ? 'trees differ without named paths' : `${paths.length} divergent paths`,
      paths,
      shortstat,
    }
  },
}

function failureStage(result: IntegrationResult): string {
  if (result.ok) return 'integration'
  if (result.kind === 'conflict') return 'merge'
  if (result.stage !== undefined) return result.stage
  return 'integration'
}

function failureError(result: IntegrationResult): string | undefined {
  return result.ok ? undefined : boundedText(result.error)
}

export async function compareForwardShadow(
  input: ForwardShadowComparisonInput,
  adapter: ForwardShadowGitAdapter = defaultForwardShadowGitAdapter,
): Promise<ForwardShadowRecord> {
  const emptyDivergence: ForwardShadowDivergence = {summary: '', paths: [], shortstat: ''}
  const conflictMetrics = input.conflictMetrics ?? deriveForwardShadowConflictMetrics(input.result)
  if (input.result.ok === false) {
    return buildForwardShadowRecord({
      baseVersion: input.baseVersion,
      releaseRepo: input.releaseRepo,
      integrationRefs: input.integrationRefs,
      shadow: {ref: input.shadowRef, commit: null, tree: null},
      authoritative: {ref: input.authoritativeRef, commit: null, tree: null},
      divergence: emptyDivergence,
      conflictMetrics,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: Math.max(0, Date.parse(input.endedAt) - Date.parse(input.startedAt)),
      runIdentity: input.runIdentity,
      failureStage: failureStage(input.result),
      failureError: failureError(input.result),
    })
  }

  try {
    const env = makeAnonymousGitEnv()
    const shadow = await adapter.resolveCommitTree(input.shadowWorkDir, input.shadowRef, env)
    const authoritativeRef = await adapter.fetchAuthoritativeRef({
      workDir: input.shadowWorkDir,
      repository: input.authoritativeRepository,
      ref: input.authoritativeRef,
      env,
    })
    const authoritative = await adapter.resolveCommitTree(input.shadowWorkDir, authoritativeRef, env)
    const common = {
      baseVersion: input.baseVersion,
      releaseRepo: input.releaseRepo,
      integrationRefs: input.integrationRefs,
      shadow: {ref: input.shadowRef, ...shadow},
      authoritative: {ref: input.authoritativeRef, ...authoritative},
      conflictMetrics,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: Math.max(0, Date.parse(input.endedAt) - Date.parse(input.startedAt)),
      runIdentity: input.runIdentity,
    }
    if (isOid(shadow.commit) && isOid(shadow.tree) && isOid(authoritative.commit) && isOid(authoritative.tree)) {
      if (shadow.tree.toLowerCase() === authoritative.tree.toLowerCase()) {
        return buildForwardShadowRecord({...common, divergence: {summary: 'trees match', paths: [], shortstat: ''}})
      }
      const divergence = await adapter.diffTrees(input.shadowWorkDir, shadow.commit, authoritative.commit, env)
      return buildForwardShadowRecord({...common, divergence})
    }
    return buildForwardShadowRecord({
      ...common,
      divergence: emptyDivergence,
      failureStage: 'shadow-compare',
      failureError: 'resolved commit or tree identity was not a 40-hex OID',
    })
  } catch (error) {
    return buildForwardShadowRecord({
      baseVersion: input.baseVersion,
      releaseRepo: input.releaseRepo,
      integrationRefs: input.integrationRefs,
      shadow: {ref: input.shadowRef, commit: null, tree: null},
      authoritative: {ref: input.authoritativeRef, commit: null, tree: null},
      divergence: emptyDivergence,
      conflictMetrics,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMs: Math.max(0, Date.parse(input.endedAt) - Date.parse(input.startedAt)),
      runIdentity: input.runIdentity,
      failureStage: 'shadow-compare',
      failureError: boundedText(error instanceof Error ? error.message : error),
    })
  }
}

export function evaluateForwardShadowGate(
  values: readonly unknown[],
  options: ForwardShadowGateOptions = {},
): ForwardShadowGateResult {
  const reasons: string[] = []
  const validRecords: ForwardShadowRecord[] = []
  let invalidRecordCount = 0
  for (const [index, value] of values.entries()) {
    const validation = validateForwardShadowRecord(value)
    if (validation.ok === false || validation.value === undefined) {
      invalidRecordCount++
      reasons.push(`record ${index + 1} is invalid: ${validation.errors[0] ?? 'unknown error'}`)
      continue
    }
    validRecords.push(validation.value)
    if (validation.value.verdict !== 'match') reasons.push(`record ${index + 1} is ${validation.value.verdict}`)
  }

  const matches = validRecords.filter(record => record.verdict === 'match')
  const versions = [...new Set(matches.map(record => record.baseVersion))].sort((left, right) =>
    left.localeCompare(right),
  )
  const versionCounts = new Map<string, number>()
  for (const record of matches) versionCounts.set(record.baseVersion, (versionCounts.get(record.baseVersion) ?? 0) + 1)
  for (const [version, count] of versionCounts) {
    if (count > 1) reasons.push(`duplicate matching base version: ${version}`)
  }
  if (versions.length < FORWARD_SHADOW_MIN_MATCHES) {
    reasons.push(`requires ${FORWARD_SHADOW_MIN_MATCHES} distinct matching base versions; found ${versions.length}`)
  }
  const conflictEvidenceCount = matches.filter(record => record.conflictMetrics.hadConflict).length
  if (options.ackNoConflictEvidence !== true && conflictEvidenceCount === 0) {
    reasons.push('no conflict evidence; pass --ack-no-conflict-evidence only with explicit review')
  }
  const hasDuplicate = [...versionCounts.values()].some(count => count > 1)
  const ok =
    invalidRecordCount === 0 &&
    matches.length === validRecords.length &&
    versions.length >= FORWARD_SHADOW_MIN_MATCHES &&
    hasDuplicate === false &&
    (options.ackNoConflictEvidence === true || conflictEvidenceCount > 0)
  const hasContradictoryEvidence = invalidRecordCount > 0 || matches.length !== validRecords.length
  const status: ForwardShadowGateStatus = ok
    ? 'ready'
    : hasContradictoryEvidence
      ? 'evidence-contradicts'
      : 'insufficient-evidence'
  return {
    ok,
    status,
    matchCount: matches.length,
    distinctBaseVersions: versions,
    conflictEvidenceCount,
    invalidRecordCount,
    reasons,
  }
}

export async function evaluateForwardShadowDirectory(
  directory: string,
  options: ForwardShadowGateOptions = {},
): Promise<ForwardShadowGateResult> {
  const entries = await fs.readdir(directory, {withFileTypes: true})
  const values: unknown[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile() === false || entry.name.endsWith('.json') === false) continue
    try {
      values.push(JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8')) as unknown)
    } catch {
      values.push(undefined)
    }
  }
  return evaluateForwardShadowGate(values, options)
}

function outcomeConflictDiagnostics(result: IntegrationResult): readonly ConflictResolverResult[] | undefined {
  if (result.ok) return result.conflictDiagnostics
  if (result.kind === 'conflict' && result.conflict.resolver !== undefined) return [result.conflict.resolver]
  return undefined
}

export function deriveForwardShadowConflictMetrics(result: IntegrationResult): ForwardShadowConflictMetrics {
  const resolverResults: readonly ConflictResolverResult[] =
    result.ok === true
      ? (result.conflictDiagnostics ?? [])
      : result.kind === 'conflict' && result.conflict.resolver !== undefined
        ? [result.conflict.resolver]
        : []
  const diagnostics = resolverResults.flatMap(resolver => resolver.diagnostics)
  return {
    hadConflict: (result.ok === false && result.kind === 'conflict') || resolverResults.length > 0,
    conflictPathCount:
      result.ok === false && result.kind === 'conflict'
        ? Math.max(result.conflict.conflictPaths.length, ...diagnostics.map(entry => entry.conflictPathCount), 0)
        : Math.max(...diagnostics.map(entry => entry.conflictPathCount), 0),
    conflictSizeBytes: Math.max(...diagnostics.map(entry => entry.conflictSize), 0),
    resolverAttempts: resolverResults.reduce((total, resolver) => total + resolver.attempts, 0),
    contextRequestCount: diagnostics.reduce((total, entry) => total + entry.outOfScopeContextRequests.length, 0),
  }
}

export function buildIntegrationOutcomeFile(
  result: IntegrationResult,
  startedAt: string,
  endedAt: string,
  failure?: {readonly stage: string; readonly error: string},
): IntegrationOutcomeFile {
  const elapsedMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
  const resolvedFailure =
    failure ??
    (result.ok
      ? undefined
      : {
          stage: failureStage(result),
          error: boundedText(result.error),
        })
  return {
    schemaVersion: FORWARD_SHADOW_SCHEMA_VERSION,
    ok: failure === undefined ? result.ok : false,
    startedAt,
    endedAt,
    elapsedMs,
    ...(result.ok ? {manifest: result.manifest} : {}),
    ...(outcomeConflictDiagnostics(result) === undefined
      ? {}
      : {conflictDiagnostics: outcomeConflictDiagnostics(result)}),
    conflictMetrics: deriveForwardShadowConflictMetrics(result),
    ...(resolvedFailure === undefined
      ? {}
      : {failure: {stage: boundedText(resolvedFailure.stage), error: boundedText(resolvedFailure.error)}}),
  }
}

export async function writeIntegrationOutcomeFile(outputPath: string, outcome: IntegrationOutcomeFile): Promise<void> {
  const errors = validateIntegrationOutcomeFile(outcome)
  if (errors.length > 0) throw new Error(`cannot write invalid integration outcome: ${errors.join('; ')}`)
  await writeAtomicJson(outputPath, outcome)
}
