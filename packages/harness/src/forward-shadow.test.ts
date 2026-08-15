import type {IntegrationResult} from './integrate.js'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {
  buildForwardShadowRecord,
  buildIntegrationOutcomeFile,
  compareForwardShadow,
  deriveForwardShadowConflictMetrics,
  evaluateForwardShadowGate,
  makeAnonymousGitEnv,
  validateForwardShadowRecord,
  writeForwardShadowRecord,
} from './forward-shadow.js'

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    baseVersion: '1.15.13',
    releaseRepo: 'anomalyco/opencode',
    integrationRefs: [{ref: 'refs/pull/30182/head', resolvedSha: OID_A}],
    shadow: {ref: 'refs/harness-shadow/1.15.13', commit: OID_A, tree: OID_B},
    authoritative: {ref: 'refs/tags/v1.15.13', commit: OID_A, tree: OID_B},
    conflictMetrics: {
      hadConflict: true,
      conflictPathCount: 1,
      conflictSizeBytes: 128,
      resolverAttempts: 1,
      contextRequestCount: 0,
    },
    divergence: {summary: 'trees match', paths: [], shortstat: ''},
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:00:01.000Z',
    durationMs: 1000,
    runIdentity: 'run-123',
    ...overrides,
  }
}

function successfulIntegrationResult(): IntegrationResult {
  return {
    ok: true,
    manifest: {
      baseVersion: '1.15.13',
      integrationRefs: [{ref: 'refs/pull/30182/head', resolvedSha: OID_A}],
      integrationCommit: OID_A,
      buildSha: 'build-sha',
    },
    conflictDiagnostics: [
      {
        ok: true,
        attempts: 1,
        resolvedPaths: ['packages/opencode/src/session/prompt.ts'],
        resolvedDigests: {
          'packages/opencode/src/session/prompt.ts': crypto.createHash('sha256').update('ok').digest('hex'),
        },
        diagnostics: [
          {
            attempt: 1,
            conflictPathCount: 1,
            conflictSize: 128,
            outOfScopeContextRequests: [],
            validationViolations: [],
          },
        ],
      },
    ],
  }
}

describe('forward shadow records', () => {
  it('derives strict match, mismatch, and inconclusive verdicts from tree OIDs', () => {
    // #given
    const match = buildForwardShadowRecord(baseInput())
    const mismatch = buildForwardShadowRecord(
      baseInput({authoritative: {ref: 'refs/tags/v1.15.13', commit: OID_A, tree: OID_C}}),
    )
    const inconclusive = buildForwardShadowRecord(
      baseInput({shadow: {ref: 'refs/harness-shadow/1.15.13', commit: OID_A, tree: 'not-a-tree'}}),
    )

    // #then
    expect(match.verdict).toBe('match')
    expect(mismatch.verdict).toBe('mismatch')
    expect(inconclusive.verdict).toBe('inconclusive')
  })

  it('rejects a record whose verdict contradicts its validated tree OIDs', () => {
    // #given
    const record = buildForwardShadowRecord(baseInput())

    // #when
    const validation = validateForwardShadowRecord({...record, verdict: 'mismatch'})

    // #then
    expect(validation.ok).toBe(false)
  })

  it('writes stable atomic JSON without secret or log fields', async () => {
    // #given
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forward-shadow-test-'))
    const outputPath = path.join(directory, 'record.json')
    const record = buildForwardShadowRecord(baseInput())

    try {
      // #when
      await writeForwardShadowRecord(outputPath, record)
      const content = await fs.readFile(outputPath, 'utf8')
      const parsed: unknown = JSON.parse(content)

      // #then
      expect(content.endsWith('\n')).toBe(true)
      expect(content).toContain('"schemaVersion": 1')
      expect(content).not.toMatch(/brokerAuthJson|HARNESS_BROKER_AUTH_JSON|token|password|prompt|narration|log/i)
      expect(validateForwardShadowRecord(parsed).ok).toBe(true)
    } finally {
      await fs.rm(directory, {recursive: true, force: true})
    }
  })

  it('preserves manifest and conflict metrics when a later command stage fails', () => {
    // #when
    const outcome = buildIntegrationOutcomeFile(
      successfulIntegrationResult(),
      '2026-08-14T00:00:00.000Z',
      '2026-08-14T00:00:01.000Z',
      {stage: 'artifact', error: 'archive failed'},
    )

    // #then
    expect(outcome.ok).toBe(false)
    expect(outcome.manifest?.integrationCommit).toBe(OID_A)
    expect(outcome.conflictMetrics).toEqual(deriveForwardShadowConflictMetrics(successfulIntegrationResult()))
    expect(outcome.failure?.stage).toBe('artifact')
  })
})

describe('forward shadow comparator', () => {
  it('fetches the authoritative ref anonymously and matches exact tree OIDs', async () => {
    // #given
    const calls: string[] = []
    const adapter = {
      fetchAuthoritativeRef: async (request: {readonly env: NodeJS.ProcessEnv}) => {
        calls.push('fetch')
        expect(request.env.GITHUB_TOKEN).toBeUndefined()
        expect(request.env.GH_TOKEN).toBeUndefined()
        expect(request.env.GIT_CONFIG_COUNT).toBeUndefined()
        return 'refs/harness-shadow/authoritative'
      },
      resolveCommitTree: async (_workDir: string, ref: string) => {
        calls.push(`resolve:${ref}`)
        return {commit: OID_A, tree: OID_B}
      },
      diffTrees: async () => {
        calls.push('diff')
        return {summary: 'trees match', paths: [], shortstat: ''}
      },
    }

    // #when
    const record = await compareForwardShadow(
      {
        baseVersion: '1.15.13',
        releaseRepo: 'anomalyco/opencode',
        authoritativeRepository: 'fro-bot/agent',
        integrationRefs: [{ref: 'refs/pull/30182/head', resolvedSha: OID_A}],
        shadowWorkDir: '/tmp/shadow',
        shadowRef: 'HEAD',
        authoritativeRef: 'refs/tags/v1.15.13',
        runIdentity: 'run-123',
        startedAt: '2026-08-14T00:00:00.000Z',
        endedAt: '2026-08-14T00:00:01.000Z',
        conflictMetrics: baseInput().conflictMetrics,
        result: successfulIntegrationResult(),
      },
      adapter,
    )

    // #then
    expect(record.verdict).toBe('match')
    expect(calls).toEqual(['resolve:HEAD', 'fetch', 'resolve:refs/harness-shadow/authoritative'])
  })

  it('fetches the authoritative ref from the explicit authoritative repository', async () => {
    // #given
    const repositories: string[] = []
    const adapter = {
      fetchAuthoritativeRef: async (request: {readonly repository: string}) => {
        repositories.push(request.repository)
        return 'refs/harness-shadow/authoritative'
      },
      resolveCommitTree: async () => ({commit: OID_A, tree: OID_B}),
      diffTrees: async () => ({summary: 'trees match', paths: [], shortstat: ''}),
    }

    // #when
    const record = await compareForwardShadow(
      {
        baseVersion: '1.15.13',
        releaseRepo: 'anomalyco/opencode',
        authoritativeRepository: 'fro-bot/agent',
        integrationRefs: [],
        shadowWorkDir: '/tmp/shadow',
        shadowRef: 'HEAD',
        authoritativeRef: 'refs/harness-integrate/1.15.13',
        runIdentity: 'run-123',
        startedAt: '2026-08-14T00:00:00.000Z',
        endedAt: '2026-08-14T00:00:01.000Z',
        conflictMetrics: baseInput().conflictMetrics,
        result: successfulIntegrationResult(),
      },
      adapter,
    )

    // #then
    expect(record.verdict).toBe('match')
    expect(repositories).toEqual(['fro-bot/agent'])
  })

  it('reports bounded divergence for unequal trees and never turns comparator errors into matches', async () => {
    // #given
    const adapter = {
      fetchAuthoritativeRef: async () => 'refs/harness-shadow/authoritative',
      resolveCommitTree: async (_workDir: string, ref: string) =>
        ref === 'HEAD' ? {commit: OID_A, tree: OID_B} : {commit: OID_C, tree: OID_C},
      diffTrees: async () => ({
        summary: '1 divergent path',
        paths: [{status: 'M', path: 'src/file.ts'}],
        shortstat: '1 file changed',
      }),
    }

    // #when
    const mismatch = await compareForwardShadow(
      {
        baseVersion: '1.15.13',
        releaseRepo: 'anomalyco/opencode',
        authoritativeRepository: 'fro-bot/agent',
        integrationRefs: [],
        shadowWorkDir: '/tmp/shadow',
        shadowRef: 'HEAD',
        authoritativeRef: 'refs/tags/v1.15.13',
        runIdentity: 'run-123',
        startedAt: '2026-08-14T00:00:00.000Z',
        endedAt: '2026-08-14T00:00:01.000Z',
        conflictMetrics: baseInput().conflictMetrics,
        result: successfulIntegrationResult(),
      },
      adapter,
    )
    const inconclusive = await compareForwardShadow(
      {
        baseVersion: '1.15.13',
        releaseRepo: 'anomalyco/opencode',
        authoritativeRepository: 'fro-bot/agent',
        integrationRefs: [],
        shadowWorkDir: '/tmp/shadow',
        shadowRef: 'HEAD',
        authoritativeRef: 'refs/tags/v1.15.13',
        runIdentity: 'run-123',
        startedAt: '2026-08-14T00:00:00.000Z',
        endedAt: '2026-08-14T00:00:01.000Z',
        conflictMetrics: baseInput().conflictMetrics,
        result: successfulIntegrationResult(),
      },
      {
        ...adapter,
        fetchAuthoritativeRef: async () => {
          throw new Error('anonymous fetch failed')
        },
      },
    )

    // #then
    expect(mismatch.verdict).toBe('mismatch')
    expect(mismatch.divergence.paths).toEqual([{status: 'M', path: 'src/file.ts'}])
    expect(inconclusive.verdict).toBe('inconclusive')
  })
})

describe('forward shadow gate', () => {
  it('passes only with three distinct strict matches and conflict evidence', () => {
    // #given
    const records = ['1.15.13', '1.15.14', '1.15.15'].map(baseVersion =>
      buildForwardShadowRecord({...baseInput(), baseVersion}),
    )

    // #when
    const result = evaluateForwardShadowGate(records)

    // #then
    expect(result.ok).toBe(true)
    expect(result.matchCount).toBe(3)
    expect(result.distinctBaseVersions).toEqual(['1.15.13', '1.15.14', '1.15.15'])
  })

  it('fails on insufficient matches, duplicates, malformed records, or missing conflict evidence', () => {
    // #given
    const match = buildForwardShadowRecord(baseInput())
    const inconclusive = buildForwardShadowRecord(
      baseInput({shadow: {ref: 'refs/harness-shadow/1.15.13', commit: null, tree: null}}),
    )
    const duplicateRecords = [
      match,
      buildForwardShadowRecord({...baseInput(), baseVersion: '1.15.14'}),
      buildForwardShadowRecord({...baseInput(), baseVersion: '1.15.14'}),
    ]

    // #then
    expect(evaluateForwardShadowGate([match, inconclusive]).ok).toBe(false)
    expect(evaluateForwardShadowGate(duplicateRecords).reasons.join(' ')).toContain('duplicate')
    expect(evaluateForwardShadowGate([match, match, match, {missing: 'schema'}]).ok).toBe(false)

    const noConflict = ['1.15.13', '1.15.14', '1.15.15'].map(baseVersion =>
      buildForwardShadowRecord({
        ...baseInput(),
        baseVersion,
        conflictMetrics: {...baseInput().conflictMetrics, hadConflict: false},
      }),
    )
    expect(evaluateForwardShadowGate(noConflict).ok).toBe(false)
    expect(evaluateForwardShadowGate(noConflict, {ackNoConflictEvidence: true}).ok).toBe(true)
  })
})

describe('anonymous comparator environment', () => {
  it('uses an allowlisted environment without inherited Git or credential controls', () => {
    // #when
    const env = makeAnonymousGitEnv({
      PATH: '/bin',
      GIT_DIR: '/secret/repo',
      GIT_CONFIG_COUNT: '1',
      GITHUB_TOKEN: 'secret',
      GH_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    })

    // #then
    expect(env.PATH).toBe('/bin')
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})
