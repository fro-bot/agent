/**
 * A real process for `sandbox-signal.test.ts`: a sandbox lifecycle with fake account steps, the real exec adapter, and the
 * real process signals. The stop step runs a real child through the adapter (as the real stop runs `pkill`), so what
 * happens to an in-flight exec when a signal arrives is observed, not assumed. Nothing here is imported by product code.
 */
import * as fs from 'node:fs'
import process from 'node:process'
import {ok} from '@bfra.me/es/result'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {createMockLogger} from '../../shared/test-helpers.js'
import {createSandboxLifecycle} from './sandbox-lifecycle.js'

const log = process.env.SIGNAL_FIXTURE_LOG ?? ''
const mark = (line: string): void => {
  fs.appendFileSync(log, `${line}\n`)
}
const exec = createExecAdapter()
// The lifecycle's own privileged calls (mkdir, git config) are stubbed; `stop` below uses the real adapter.
const stubbedExec = {
  exec: async () => 0,
  execWithTimeout: async () => 0,
  getExecOutput: async () => ({exitCode: 0, stdout: '', stderr: ''}),
}

const account = {name: 'fixture', uid: 998, gid: 997, home: '/nonexistent'}
const tools = Object.fromEntries(
  [
    'sudo',
    'setpriv',
    'setfacl',
    'getfacl',
    'useradd',
    'userdel',
    'pkill',
    'pgrep',
    'find',
    'chown',
    'chmod',
    'mkdir',
    'env',
    'git',
    'unshare',
    'mount',
    'umount',
    'pivot_root',
    'sh',
    'lsns',
    'readlink',
    'sleep',
  ].map(name => [name, `/usr/bin/${name}`]),
) as never

const lifecycle = createSandboxLifecycle({
  tools,
  env: {HOME: '/tmp', RUNNER_TEMP: process.env.SIGNAL_FIXTURE_TEMP ?? '/tmp'},
  runnerHome: '/tmp',
  workspacePath: '/tmp/ws',
  responseDir: null,
  attachmentDir: null,
  logger: createMockLogger(),
  exec: stubbedExec,
  signalTeardownBudgetMs: 20_000,
  recordState: state => mark(`state:${state}`),
  deps: {
    createAccount: async () => ok(account),
    handOff: async () =>
      ok({snapshotDir: '/tmp/x', touched: [], chowned: [], aclTrees: [], git: null, gitPresent: false}),
    stop: async () => {
      mark('stop-start')
      // A real child through the real adapter, like pkill: it must be allowed to finish.
      const code = await exec.execWithTimeout?.('sleep', ['1'], 10_000, {silent: true})
      mark(`stop-done:${String(code)}`)
      return 'stopped'
    },
    takeBack: async () => {
      mark('takeback')
      return {status: 'restored'}
    },
    deleteAccount: async () => {
      mark('delete')
      return 'deleted'
    },
    readText: async () => null,
    createViewRoot: async () => ({
      newRoot: '/tmp/fixture-view/root',
      gateRoot: '/tmp/fixture-view/gates',
      remove: async () => undefined,
    }),
    readMountInfo: async () => '',
    ids: () => ({uid: process.getuid?.() ?? 1, gid: process.getgid?.() ?? 1}),
  },
})

const prepared = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
if (!prepared.success) {
  mark(`prepare-failed:${prepared.error}`)
  process.exit(3)
}
// Keep the process alive, like a run waiting on the model.
setInterval(() => undefined, 1000)
process.stdout.write('READY\n')
