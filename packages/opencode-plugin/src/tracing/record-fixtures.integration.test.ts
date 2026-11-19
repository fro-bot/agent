/**
 * Records the turn model's fixtures from a real OpenCode binary. Skipped unless `FRO_BOT_OPENCODE_V2_BIN` names one AND
 * `FRO_BOT_RECORD_FIXTURES=1`: it takes about a minute and a half, so a plain real-binary run leaves it out. It rewrites
 * `turn-model.fixtures.ts`; review the diff, since a changed ordering is a changed OpenCode.
 */

import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {normalizeRecording, recordAll, renderFixturesModule} from './record-fixtures.js'
import {recordedFixtures} from './turn-model.fixtures.js'

const binary = process.env.FRO_BOT_OPENCODE_V2_BIN
const runnable =
  binary != null && binary.length > 0 && existsSync(binary) && process.env.FRO_BOT_RECORD_FIXTURES === '1'
const here = path.dirname(fileURLToPath(import.meta.url))

describe.skipIf(!runnable)('recording the turn model fixtures from a real opencode V2', () => {
  it('records every scenario', async () => {
    // #given a scratch directory and the pinned binary
    const workDir = mkdtempSync(path.join(tmpdir(), 'fro-bot-record-fixtures-'))
    try {
      // #when every scenario is driven against it
      // `FRO_BOT_RECORD_ONLY=name,name` records just those scenarios and keeps every other recording as committed, so adding a
      // scenario does not rewrite the timings of all the rest.
      const only = process.env.FRO_BOT_RECORD_ONLY?.split(',').filter(name => name.length > 0)
      const fresh = (await recordAll(binary ?? '', workDir, only)).map(normalizeRecording)
      const recordings =
        only === undefined
          ? fresh
          : [
              // Committed order is kept: a re-recorded scenario replaces its entry in place, a new one is appended.
              ...Object.entries(recordedFixtures).map(
                ([name, fixture]) => fresh.find(recording => recording.name === name) ?? {name, ...fixture},
              ),
              ...fresh.filter(recording => !(recording.name in recordedFixtures)),
            ]

      // #then the generate retry really made two provider attempts for its one request (the whole point of that scenario)
      expect(fresh.find(recording => recording.name === 'generate-retry')?.facts?.providerAttempts ?? 2).toBe(2)

      // #and each scenario recorded observations, and the module can be written
      for (const recording of recordings)
        expect({name: recording.name, count: recording.observations.length}).not.toEqual({
          name: recording.name,
          count: 0,
        })
      writeFileSync(path.join(here, 'turn-model.fixtures.ts'), renderFixturesModule(recordings))
    } finally {
      rmSync(workDir, {recursive: true, force: true})
    }
  }, 600_000)
})
