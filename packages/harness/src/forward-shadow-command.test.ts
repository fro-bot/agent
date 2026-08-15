import type {ForwardShadowRecord} from './forward-shadow.js'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {runForwardShadowCommand} from './forward-shadow-command.js'
import {buildForwardShadowRecord} from './forward-shadow.js'

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)

function matchRecord(): ForwardShadowRecord {
  return buildForwardShadowRecord({
    baseVersion: '1.15.13',
    releaseRepo: 'anomalyco/opencode',
    integrationRefs: [],
    shadow: {ref: 'HEAD', commit: OID_A, tree: OID_B},
    authoritative: {ref: 'refs/harness-integrate/1.15.13', commit: OID_A, tree: OID_B},
    divergence: {summary: 'trees match', paths: [], shortstat: ''},
    conflictMetrics: {
      hadConflict: true,
      conflictPathCount: 1,
      conflictSizeBytes: 32,
      resolverAttempts: 1,
      contextRequestCount: 0,
    },
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:00:01.000Z',
    durationMs: 1000,
    runIdentity: 'run-1',
  })
}

describe('forward shadow command', () => {
  it('passes the distinct authoritative repository and writes a successful record', async () => {
    // #given
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forward-shadow-command-test-'))
    const resultPath = path.join(directory, 'result.json')
    const recordPath = path.join(directory, 'record.json')
    const seen: {authoritativeRepository?: string; resultOut?: string} = {}
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        startedAt: '2026-08-14T00:00:00.000Z',
        endedAt: '2026-08-14T00:00:01.000Z',
        elapsedMs: 1000,
        manifest: {
          baseVersion: '1.15.13',
          integrationRefs: [],
          integrationCommit: OID_A,
          buildSha: 'build',
        },
      }),
      'utf8',
    )

    // #when
    const code = await runForwardShadowCommand(
      [
        '--result-out',
        resultPath,
        '--record-out',
        recordPath,
        '--base-version',
        '1.15.13',
        '--shadow-work-dir',
        directory,
        '--release-repo',
        'anomalyco/opencode',
        '--authoritative-repository',
        'fro-bot/agent',
        '--authoritative-ref',
        'refs/harness-integrate/1.15.13',
        '--run-identity',
        'run-1',
      ],
      {
        readFile: async file => {
          seen.resultOut = file
          return fs.readFile(file, 'utf8')
        },
        compare: async input => {
          seen.authoritativeRepository = input.authoritativeRepository
          return matchRecord()
        },
        writeRecord: async (file, record) => fs.writeFile(file, JSON.stringify(record), 'utf8'),
        now: () => new Date('2026-08-14T00:00:02.000Z'),
      },
    )

    // #then
    expect(code).toBe(0)
    expect(seen.resultOut).toBe(resultPath)
    expect(seen.authoritativeRepository).toBe('fro-bot/agent')
    expect(await fs.readFile(recordPath, 'utf8')).toContain('"verdict":"match"')
    await fs.rm(directory, {recursive: true, force: true})
  })

  it('writes inconclusive evidence when the outcome is missing and never leaks its path or contents', async () => {
    // #given
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forward-shadow-command-test-'))
    const recordPath = path.join(directory, 'record.json')
    const secret = 'broker-secret-must-not-appear'
    let receivedRecord: ForwardShadowRecord | undefined

    // #when
    const code = await runForwardShadowCommand(
      [
        '--result-out',
        path.join(directory, secret),
        '--record-out',
        recordPath,
        '--base-version',
        '1.15.13',
        '--shadow-work-dir',
        directory,
        '--release-repo',
        'anomalyco/opencode',
        '--authoritative-repository',
        'fro-bot/agent',
        '--authoritative-ref',
        'refs/harness-integrate/1.15.13',
        '--run-identity',
        'run-1',
      ],
      {
        readFile: async () => {
          throw new Error(secret)
        },
        compare: async input => {
          expect(input.result.ok).toBe(false)
          return buildForwardShadowRecord({
            baseVersion: input.baseVersion,
            releaseRepo: input.releaseRepo,
            integrationRefs: [],
            shadow: {ref: input.shadowRef, commit: null, tree: null},
            authoritative: {ref: input.authoritativeRef, commit: null, tree: null},
            divergence: {summary: '', paths: [], shortstat: ''},
            conflictMetrics: input.conflictMetrics ?? {
              hadConflict: false,
              conflictPathCount: 0,
              conflictSizeBytes: 0,
              resolverAttempts: 0,
              contextRequestCount: 0,
            },
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            durationMs: 0,
            runIdentity: input.runIdentity,
            failureStage: 'shadow-outcome',
            failureError: 'shadow outcome is missing or unreadable',
          })
        },
        writeRecord: async (_file, record) => {
          receivedRecord = record
        },
        now: () => new Date('2026-08-14T00:00:02.000Z'),
      },
    )

    // #then
    expect(code).toBe(0)
    expect(receivedRecord?.verdict).toBe('inconclusive')
    expect(JSON.stringify(receivedRecord)).not.toContain(secret)
    await fs.rm(directory, {recursive: true, force: true})
  })

  it('writes inconclusive evidence when the comparator itself fails', async () => {
    // #given
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forward-shadow-command-test-'))
    const recordPath = path.join(directory, 'record.json')
    let receivedRecord: ForwardShadowRecord | undefined

    // #when
    const code = await runForwardShadowCommand(
      [
        '--result-out',
        path.join(directory, 'missing-result.json'),
        '--record-out',
        recordPath,
        '--base-version',
        '1.15.13',
        '--shadow-work-dir',
        directory,
        '--release-repo',
        'anomalyco/opencode',
        '--authoritative-repository',
        'fro-bot/agent',
        '--authoritative-ref',
        'refs/harness-integrate/1.15.13',
        '--run-identity',
        'run-1',
      ],
      {
        readFile: async () => {
          throw new Error('missing')
        },
        compare: async () => {
          throw new Error('comparator failed')
        },
        writeRecord: async (_file, record) => {
          receivedRecord = record
        },
        now: () => new Date('2026-08-14T00:00:02.000Z'),
      },
    )

    // #then
    expect(code).toBe(0)
    expect(receivedRecord?.verdict).toBe('inconclusive')
    await fs.rm(directory, {recursive: true, force: true})
  })

  it('treats a malformed successful outcome as inconclusive rather than matching', async () => {
    // #given
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forward-shadow-command-test-'))
    const recordPath = path.join(directory, 'record.json')
    let receivedRecord: ForwardShadowRecord | undefined

    // #when
    const code = await runForwardShadowCommand(
      [
        '--result-out',
        path.join(directory, 'invalid-result.json'),
        '--record-out',
        recordPath,
        '--base-version',
        '1.15.13',
        '--shadow-work-dir',
        directory,
        '--release-repo',
        'anomalyco/opencode',
        '--authoritative-repository',
        'fro-bot/agent',
        '--authoritative-ref',
        'refs/harness-integrate/1.15.13',
        '--run-identity',
        'run-1',
      ],
      {
        readFile: async () => JSON.stringify({schemaVersion: 1, ok: true, manifest: {baseVersion: 'wrong'}}),
        compare: async input => {
          expect(input.result.ok).toBe(false)
          return buildForwardShadowRecord({
            baseVersion: input.baseVersion,
            releaseRepo: input.releaseRepo,
            integrationRefs: [],
            shadow: {ref: input.shadowRef, commit: null, tree: null},
            authoritative: {ref: input.authoritativeRef, commit: null, tree: null},
            divergence: {summary: '', paths: [], shortstat: ''},
            conflictMetrics: input.conflictMetrics ?? {
              hadConflict: false,
              conflictPathCount: 0,
              conflictSizeBytes: 0,
              resolverAttempts: 0,
              contextRequestCount: 0,
            },
            startedAt: input.startedAt,
            endedAt: input.endedAt,
            durationMs: 0,
            runIdentity: input.runIdentity,
            failureStage: 'shadow-outcome',
            failureError: 'shadow outcome is invalid',
          })
        },
        writeRecord: async (_file, record) => {
          receivedRecord = record
        },
        now: () => new Date('2026-08-14T00:00:02.000Z'),
      },
    )

    // #then
    expect(code).toBe(0)
    expect(receivedRecord?.verdict).toBe('inconclusive')
    await fs.rm(directory, {recursive: true, force: true})
  })
})
