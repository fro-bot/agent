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
      const recordings = (await recordAll(binary ?? '', workDir)).map(normalizeRecording)

      // #then each scenario recorded observations, and the module can be written
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
