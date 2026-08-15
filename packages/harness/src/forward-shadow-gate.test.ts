import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {describe, expect, it} from 'vitest'
import {runForwardShadowGate} from './forward-shadow-gate.js'
import {buildForwardShadowRecord, writeForwardShadowRecord} from './forward-shadow.js'

const TREE = 'a'.repeat(40)

function record(baseVersion: string) {
  return buildForwardShadowRecord({
    baseVersion,
    releaseRepo: 'anomalyco/opencode',
    integrationRefs: [],
    shadow: {ref: `refs/harness-shadow/${baseVersion}`, commit: TREE, tree: TREE},
    authoritative: {ref: `refs/tags/v${baseVersion}`, commit: TREE, tree: TREE},
    conflictMetrics: {
      hadConflict: true,
      conflictPathCount: 1,
      conflictSizeBytes: 1,
      resolverAttempts: 1,
      contextRequestCount: 0,
    },
    divergence: {summary: 'trees match', paths: [], shortstat: ''},
    startedAt: '2026-08-14T00:00:00.000Z',
    endedAt: '2026-08-14T00:00:01.000Z',
    durationMs: 1000,
    runIdentity: `run-${baseVersion}`,
  })
}

describe('forward-shadow-gate CLI', () => {
  it('reads records from a directory and emits only the machine-readable gate result', async () => {
    // #given
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forward-shadow-gate-test-'))
    const output: string[] = []
    try {
      for (const version of ['1.15.13', '1.15.14', '1.15.15']) {
        await writeForwardShadowRecord(path.join(directory, `${version}.json`), record(version))
      }

      // #when
      const code = await runForwardShadowGate(['--records-dir', directory], {
        stdout: value => output.push(value),
        stderr: value => output.push(value),
      })

      // #then
      expect(code).toBe(0)
      expect(output.join('')).toContain('"matchCount": 3')
      expect(output.join('')).not.toMatch(/token|password|prompt|log/i)
    } finally {
      await fs.rm(directory, {recursive: true, force: true})
    }
  })

  it('fails honestly when the records directory flag is missing', async () => {
    // #when
    const output: string[] = []
    const code = await runForwardShadowGate([], {
      stdout: value => output.push(value),
      stderr: value => output.push(value),
    })

    // #then
    expect(code).toBe(1)
    expect(output.join(' ')).toContain('--records-dir')
  })
})
