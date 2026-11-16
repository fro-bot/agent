import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {STATE_KEYS} from '../config/state-keys.js'
import {recordRunGhConfigDir, releaseRunGhConfig} from './gh-config.js'

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
    recordRunGhConfigDir(null)
    vi.mocked(core.saveState).mockClear()
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

  describe('recordRunGhConfigDir', () => {
    it('writes the directory to the action state for the post hook, and an empty string to forget it', () => {
      // #when
      recordRunGhConfigDir('/runner/gh-config-abc')
      recordRunGhConfigDir(null)

      // #then
      expect(vi.mocked(core.saveState).mock.calls).toEqual([
        [STATE_KEYS.GH_CONFIG_DIR, '/runner/gh-config-abc'],
        [STATE_KEYS.GH_CONFIG_DIR, ''],
      ])
    })
  })

  describe('releaseRunGhConfig', () => {
    it('removes the recorded directory and clears the process env and the post-hook record when the sandbox is trusted', async () => {
      // #given
      const dir = await makeConfigDir()
      recordRunGhConfigDir(dir)
      process.env.GH_CONFIG_DIR = dir
      process.env.GH_TOKEN = 'ghs_x'
      vi.mocked(core.saveState).mockClear()

      // #when
      await releaseRunGhConfig({sandboxTrusted: true, logger: createMockLogger()})

      // #then
      expect(await exists(dir)).toBe(false)
      expect(process.env.GH_CONFIG_DIR).toBeUndefined()
      expect(process.env.GH_TOKEN).toBeUndefined()
      expect(core.saveState).toHaveBeenCalledWith(STATE_KEYS.GH_CONFIG_DIR, '')
    })

    it('removes the recorded directory even when GH_CONFIG_DIR was never published (a login that was cut short)', async () => {
      // #given a directory recorded at creation, with the env never pointed at it
      const dir = await makeConfigDir()
      recordRunGhConfigDir(dir)

      // #when
      await releaseRunGhConfig({sandboxTrusted: true, logger: createMockLogger()})

      // #then
      expect(await exists(dir)).toBe(false)
    })

    it('never touches a directory that was not recorded, whatever GH_CONFIG_DIR says', async () => {
      // #given an earlier step's directory in the env, and nothing recorded by this run
      const ambient = await makeConfigDir()
      process.env.GH_CONFIG_DIR = ambient

      // #when
      await releaseRunGhConfig({sandboxTrusted: true, logger: createMockLogger()})

      // #then
      expect(await exists(path.join(ambient, 'hosts.yml'))).toBe(true)
      expect(core.saveState).not.toHaveBeenCalled()
    })

    it('leaves the directory in place when the sandbox take-back was not confirmed', async () => {
      // #given a directory the sandbox user may still own or hold open
      const dir = await makeConfigDir()
      recordRunGhConfigDir(dir)
      process.env.GH_CONFIG_DIR = dir
      process.env.GH_TOKEN = 'ghs_x'
      vi.mocked(core.saveState).mockClear()
      const logger = createMockLogger()

      // #when
      await releaseRunGhConfig({sandboxTrusted: false, logger})

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
      await releaseRunGhConfig({sandboxTrusted: true, logger: createMockLogger()})

      // #then
      expect(process.env.GH_TOKEN).toBeUndefined()
      expect(core.saveState).not.toHaveBeenCalled()
    })

    it('does not fail the run, and keeps the post-hook record, when the removal is refused', async () => {
      // #given a recorded path that is not a gh-config-* directory under RUNNER_TEMP
      const stray = await fs.mkdtemp(path.join(runnerTemp, 'not-ours-'))
      recordRunGhConfigDir(stray)
      vi.mocked(core.saveState).mockClear()
      const logger = createMockLogger()

      // #when
      await expect(releaseRunGhConfig({sandboxTrusted: true, logger})).resolves.toBeUndefined()

      // #then
      expect(await exists(stray)).toBe(true)
      expect(core.saveState).not.toHaveBeenCalled()
      expect(logger.warning).toHaveBeenCalled()
    })
  })
})
