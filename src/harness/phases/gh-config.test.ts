import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {releaseRunGhConfig, trackRunGhConfigDir} from './gh-config.js'

vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
}))

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  )
}

describe('run gh config directory', () => {
  let runnerTemp: string
  const saved = {
    RUNNER_TEMP: process.env.RUNNER_TEMP,
    GH_TOKEN: process.env.GH_TOKEN,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    runnerTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-config-phase-')))
    process.env.RUNNER_TEMP = runnerTemp
    delete process.env.GH_TOKEN
    delete process.env.GH_CONFIG_DIR
  })

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(runnerTemp, {recursive: true, force: true})
  })

  async function makeConfigDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(runnerTemp, 'gh-config-'))
    await fs.writeFile(path.join(dir, 'hosts.yml'), 'token', {mode: 0o600})
    return dir
  }

  describe('trackRunGhConfigDir', () => {
    it('returns the directory setup pointed GH_CONFIG_DIR at and records it for the post hook', async () => {
      // #given
      const dir = await makeConfigDir()
      process.env.GH_CONFIG_DIR = dir

      // #when
      const tracked = trackRunGhConfigDir(undefined)

      // #then
      expect(tracked).toBe(dir)
      expect(core.saveState).toHaveBeenCalledWith(STATE_KEYS.GH_CONFIG_DIR, dir)
    })

    it('returns null when GH_CONFIG_DIR is unset (withheld credential, or a failed gh login)', () => {
      expect(trackRunGhConfigDir(undefined)).toBeNull()
      expect(core.saveState).not.toHaveBeenCalled()
    })

    it('returns null for a GH_CONFIG_DIR that was already in the environment when the run started', async () => {
      // #given an earlier step's config dir, which this run did not create
      const ambient = await makeConfigDir()
      process.env.GH_CONFIG_DIR = ambient

      // #when
      const tracked = trackRunGhConfigDir(ambient)

      // #then
      expect(tracked).toBeNull()
      expect(core.saveState).not.toHaveBeenCalled()
    })
  })

  describe('releaseRunGhConfig', () => {
    it('removes the directory and clears the process env and the post-hook record when the sandbox is trusted', async () => {
      // #given
      const dir = await makeConfigDir()
      process.env.GH_CONFIG_DIR = dir
      process.env.GH_TOKEN = 'ghs_x'

      // #when
      await releaseRunGhConfig({dir, sandboxTrusted: true, logger: createMockLogger()})

      // #then
      expect(await exists(dir)).toBe(false)
      expect(process.env.GH_CONFIG_DIR).toBeUndefined()
      expect(process.env.GH_TOKEN).toBeUndefined()
      expect(core.saveState).toHaveBeenCalledWith(STATE_KEYS.GH_CONFIG_DIR, '')
    })

    it('leaves the directory in place when the sandbox take-back was not confirmed', async () => {
      // #given a directory the sandbox user may still own or hold open
      const dir = await makeConfigDir()
      process.env.GH_CONFIG_DIR = dir
      process.env.GH_TOKEN = 'ghs_x'
      const logger = createMockLogger()

      // #when
      await releaseRunGhConfig({dir, sandboxTrusted: false, logger})

      // #then it is not touched, and the post hook's record is not cleared
      expect(await exists(path.join(dir, 'hosts.yml'))).toBe(true)
      expect(core.saveState).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalledTimes(1)
      // #and the Action's own process still drops its copies
      expect(process.env.GH_CONFIG_DIR).toBeUndefined()
      expect(process.env.GH_TOKEN).toBeUndefined()
    })

    it('only clears the env when the run created no directory', async () => {
      // #given
      process.env.GH_TOKEN = 'ghs_x'

      // #when
      await releaseRunGhConfig({dir: null, sandboxTrusted: true, logger: createMockLogger()})

      // #then
      expect(process.env.GH_TOKEN).toBeUndefined()
      expect(core.saveState).not.toHaveBeenCalled()
    })

    it('does not fail the run, and keeps the post-hook record, when the removal is refused', async () => {
      // #given a path that is not a gh-config-* directory under RUNNER_TEMP
      const stray = await fs.mkdtemp(path.join(runnerTemp, 'not-ours-'))
      const logger = createMockLogger()

      // #when
      await expect(releaseRunGhConfig({dir: stray, sandboxTrusted: true, logger})).resolves.toBeUndefined()

      // #then
      expect(await exists(stray)).toBe(true)
      expect(core.saveState).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalled()
    })
  })
})
