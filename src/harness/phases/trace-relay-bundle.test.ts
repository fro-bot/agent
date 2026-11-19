import type {InstallLocationDeps} from '../../services/setup/sandbox-preflight.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createInstallLocationDeps} from '../../services/setup/sandbox-preflight.js'
import {checkTraceRelayBundle, TRACE_RELAY_BUNDLE_FILE} from './trace-relay-bundle.js'

describe('checkTraceRelayBundle', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-relay-bundle-'))
  })

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true})
  })

  /** The real lstat over a real directory standing in for the running bundle's `dist/`. */
  function depsFor(bundleDir: string | null): InstallLocationDeps {
    return {...createInstallLocationDeps(), bundleDir, invokedAs: path.join(dir, 'main.js')}
  }

  describe('without isolation (a local or published install; nothing says the install is immutable)', () => {
    it('accepts a regular file next to the running bundle, which is the file the supervisor would spawn', async () => {
      await fs.writeFile(path.join(dir, TRACE_RELAY_BUNDLE_FILE), '// stand-in\n')

      expect(await checkTraceRelayBundle({isolated: false, deps: depsFor(dir)})).toBe(true)
    })

    it('refuses a missing file', async () => {
      expect(await checkTraceRelayBundle({isolated: false, deps: depsFor(dir)})).toBe(false)
    })

    it('refuses a symlink, even one that points at a real script', async () => {
      await fs.writeFile(path.join(dir, 'real.js'), '// real\n')
      await fs.symlink(path.join(dir, 'real.js'), path.join(dir, TRACE_RELAY_BUNDLE_FILE))

      expect(await checkTraceRelayBundle({isolated: false, deps: depsFor(dir)})).toBe(false)
    })

    it('refuses a dangling symlink', async () => {
      await fs.symlink(path.join(dir, 'nowhere.js'), path.join(dir, TRACE_RELAY_BUNDLE_FILE))

      expect(await checkTraceRelayBundle({isolated: false, deps: depsFor(dir)})).toBe(false)
    })

    it('refuses a directory', async () => {
      await fs.mkdir(path.join(dir, TRACE_RELAY_BUNDLE_FILE))

      expect(await checkTraceRelayBundle({isolated: false, deps: depsFor(dir)})).toBe(false)
    })

    it('refuses, and never throws, when the bundle directory is unknown', async () => {
      expect(await checkTraceRelayBundle({isolated: false, deps: depsFor(null)})).toBe(false)
    })

    it('refuses, and never throws, when the filesystem call fails', async () => {
      const failing: InstallLocationDeps = {
        ...depsFor(dir),
        lstat: async () => {
          throw new Error('EIO')
        },
      }

      expect(await checkTraceRelayBundle({isolated: false, deps: failing})).toBe(false)
    })

    it('does not apply the published-install rules: a local install in a checkout is fine', async () => {
      await fs.writeFile(path.join(dir, TRACE_RELAY_BUNDLE_FILE), '// stand-in\n')

      // RUNNER_TEMP, the _actions layout and the provenance variables are all absent, which the isolated check refuses
      expect(await checkTraceRelayBundle({isolated: false, deps: {...depsFor(dir), env: {}}})).toBe(true)
    })
  })

  describe('with isolation (the install must be a published one the agent cannot write)', () => {
    const WORK = '/home/runner/work'
    const ROOT = `${WORK}/_actions/fro-bot/agent/v1`

    function published(entries: Map<string, 'directory' | 'file' | 'other' | 'symlink'>): InstallLocationDeps {
      return {
        env: {RUNNER_TEMP: `${WORK}/_temp`, GITHUB_ACTION_REPOSITORY: 'fro-bot/agent', GITHUB_ACTION_REF: 'v1'},
        bundleDir: `${ROOT}/dist`,
        invokedAs: `${ROOT}/dist/main.js`,
        cwd: `${WORK}/repo/repo`,
        lstat: async absolutePath => entries.get(absolutePath) ?? null,
        realpath: async absolutePath => absolutePath,
      }
    }

    function fullInstall(): Map<string, 'directory' | 'file' | 'other' | 'symlink'> {
      const entries = new Map<string, 'directory' | 'file' | 'other' | 'symlink'>()
      for (const directory of [
        WORK,
        `${WORK}/_actions`,
        `${WORK}/_actions/fro-bot`,
        `${WORK}/_actions/fro-bot/agent`,
        ROOT,
        `${ROOT}/dist`,
      ])
        entries.set(directory, 'directory')
      for (const file of [
        'action.yaml',
        ...['main', 'post', 'key-proxy', 'sandbox-view', 'trace-relay'].map(n => `dist/${n}.js`),
      ])
        entries.set(`${ROOT}/${file}`, 'file')
      return entries
    }

    it('accepts the relay bundle in a published install', async () => {
      expect(await checkTraceRelayBundle({isolated: true, deps: published(fullInstall())})).toBe(true)
    })

    it.each([
      ['missing', undefined],
      ['a symlink', 'symlink'],
      ['a directory', 'directory'],
    ] as const)('refuses the relay bundle when it is %s', async (_label, kind) => {
      const entries = fullInstall()
      entries.delete(`${ROOT}/dist/trace-relay.js`)
      if (kind !== undefined) entries.set(`${ROOT}/dist/trace-relay.js`, kind)

      expect(await checkTraceRelayBundle({isolated: true, deps: published(entries)})).toBe(false)
    })

    it('refuses a local install, which the agent could write, even though the relay file in it is a regular file', async () => {
      const entries = fullInstall()
      entries.set(`${WORK}/repo/repo/dist`, 'directory')
      entries.set(`${WORK}/repo/repo/dist/trace-relay.js`, 'file')
      const local: InstallLocationDeps = {
        ...published(entries),
        bundleDir: `${WORK}/repo/repo/dist`,
        invokedAs: `${WORK}/repo/repo/dist/main.js`,
      }

      expect(await checkTraceRelayBundle({isolated: true, deps: local})).toBe(false)
      // the same files pass without isolation
      expect(await checkTraceRelayBundle({isolated: false, deps: local})).toBe(true)
    })

    it('refuses when another entry file of the install is a symlink, though the relay file is fine', async () => {
      const entries = fullInstall()
      entries.set(`${ROOT}/dist/key-proxy.js`, 'symlink')

      expect(await checkTraceRelayBundle({isolated: true, deps: published(entries)})).toBe(false)
      expect(await checkTraceRelayBundle({isolated: false, deps: published(entries)})).toBe(true)
    })
  })
})
