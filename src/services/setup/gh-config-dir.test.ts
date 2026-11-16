import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {GH_CONFIG_DIR_PREFIX, ghConfigBaseDir, removeGhConfigDir} from './gh-config-dir.js'

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(
    () => true,
    () => false,
  )
}

describe('gh-config-dir', () => {
  let runnerTemp: string
  let elsewhere: string

  beforeEach(async () => {
    // realpath: macOS reports tmpdir() under a symlinked /var
    runnerTemp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-config-dir-runner-')))
    elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-config-dir-elsewhere-')))
  })

  afterEach(async () => {
    await fs.rm(runnerTemp, {recursive: true, force: true})
    await fs.rm(elsewhere, {recursive: true, force: true})
  })

  async function makeConfigDir(parent = runnerTemp, name = `${GH_CONFIG_DIR_PREFIX}abc123`): Promise<string> {
    const dir = path.join(parent, name)
    await fs.mkdir(dir, {mode: 0o700})
    await fs.writeFile(path.join(dir, 'hosts.yml'), 'github.com:\n  oauth_token: ghs_secret\n', {mode: 0o600})
    return dir
  }

  describe('ghConfigBaseDir', () => {
    it('is RUNNER_TEMP when set, the OS temp dir otherwise (matching where configureGhAuth creates it)', () => {
      expect(ghConfigBaseDir({RUNNER_TEMP: '/runner/tmp'})).toBe('/runner/tmp')
      expect(ghConfigBaseDir({RUNNER_TEMP: ''})).toBe(os.tmpdir())
      expect(ghConfigBaseDir({})).toBe(os.tmpdir())
    })
  })

  describe('removeGhConfigDir', () => {
    it('removes a gh-config-* directory directly under RUNNER_TEMP, hosts.yml included', async () => {
      // #given
      const dir = await makeConfigDir()
      const logger = createMockLogger()

      // #when
      const outcome = await removeGhConfigDir(dir, {RUNNER_TEMP: runnerTemp}, logger)

      // #then
      expect(outcome).toBe('removed')
      expect(await exists(dir)).toBe(false)
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('reports a directory that is already gone as absent, without a warning', async () => {
      // #given
      const dir = path.join(runnerTemp, `${GH_CONFIG_DIR_PREFIX}gone`)
      const logger = createMockLogger()

      // #when
      const outcome = await removeGhConfigDir(dir, {RUNNER_TEMP: runnerTemp}, logger)

      // #then
      expect(outcome).toBe('absent')
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('refuses a symlink root and leaves both the link and its target alone', async () => {
      // #given a gh-config-* name that is a symlink to a directory holding something that matters
      const victim = path.join(elsewhere, 'precious')
      await fs.mkdir(victim)
      await fs.writeFile(path.join(victim, 'keep.txt'), 'keep')
      const link = path.join(runnerTemp, `${GH_CONFIG_DIR_PREFIX}link`)
      await fs.symlink(victim, link)
      const logger = createMockLogger()

      // #when
      const outcome = await removeGhConfigDir(link, {RUNNER_TEMP: runnerTemp}, logger)

      // #then
      expect(outcome).toBe('refused')
      expect(await exists(link)).toBe(true)
      expect(await exists(path.join(victim, 'keep.txt'))).toBe(true)
      expect(logger.warning).toHaveBeenCalledTimes(1)
    })

    it('refuses a regular file with the right name', async () => {
      // #given
      const file = path.join(runnerTemp, `${GH_CONFIG_DIR_PREFIX}file`)
      await fs.writeFile(file, 'x')

      // #when
      const outcome = await removeGhConfigDir(file, {RUNNER_TEMP: runnerTemp}, createMockLogger())

      // #then
      expect(outcome).toBe('refused')
      expect(await exists(file)).toBe(true)
    })

    it('refuses a directory whose name lacks the gh-config- prefix', async () => {
      // #given
      const dir = await makeConfigDir(runnerTemp, 'something-else')

      // #when
      const outcome = await removeGhConfigDir(dir, {RUNNER_TEMP: runnerTemp}, createMockLogger())

      // #then
      expect(outcome).toBe('refused')
      expect(await exists(dir)).toBe(true)
    })

    it('refuses the bare prefix as a name and RUNNER_TEMP itself', async () => {
      // #given
      const bare = await makeConfigDir(runnerTemp, GH_CONFIG_DIR_PREFIX)
      const logger = createMockLogger()

      // #when / #then
      expect(await removeGhConfigDir(bare, {RUNNER_TEMP: runnerTemp}, logger)).toBe('refused')
      expect(await removeGhConfigDir(runnerTemp, {RUNNER_TEMP: runnerTemp}, logger)).toBe('refused')
      expect(await exists(bare)).toBe(true)
      expect(await exists(runnerTemp)).toBe(true)
    })

    it('refuses a correctly named directory that is not directly under RUNNER_TEMP', async () => {
      // #given an ambient config dir from somewhere else, and one nested a level too deep
      const stray = await makeConfigDir(elsewhere)
      const nestedParent = path.join(runnerTemp, 'nested')
      await fs.mkdir(nestedParent)
      const nested = await makeConfigDir(nestedParent)

      // #when
      const strayOutcome = await removeGhConfigDir(stray, {RUNNER_TEMP: runnerTemp}, createMockLogger())
      const nestedOutcome = await removeGhConfigDir(nested, {RUNNER_TEMP: runnerTemp}, createMockLogger())

      // #then
      expect(strayOutcome).toBe('refused')
      expect(nestedOutcome).toBe('refused')
      expect(await exists(stray)).toBe(true)
      expect(await exists(nested)).toBe(true)
    })

    it('refuses a relative path', async () => {
      // #when
      const outcome = await removeGhConfigDir(
        `${GH_CONFIG_DIR_PREFIX}rel`,
        {RUNNER_TEMP: runnerTemp},
        createMockLogger(),
      )

      // #then
      expect(outcome).toBe('refused')
    })

    it('warns and does not throw when the removal itself fails', async () => {
      // #given
      const dir = await makeConfigDir()
      const logger = createMockLogger()
      const remove = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), {code: 'EBUSY'}))

      // #when
      const outcome = await removeGhConfigDir(dir, {RUNNER_TEMP: runnerTemp}, logger, remove)

      // #then
      expect(outcome).toBe('failed')
      expect(remove).toHaveBeenCalledWith(dir)
      expect(logger.warning).toHaveBeenCalledWith(expect.any(String), {error: 'EBUSY'})
    })
  })
})
