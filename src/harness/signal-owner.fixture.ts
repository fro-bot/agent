/**
 * A real process for `signal-owner.test.ts`: the real signal owner, tracer, exec adapter and (in `isolated` mode) sandbox
 * lifecycle, with the real process signals. What the owner does to a running child, to the export and to a write that was
 * already in flight is observed here, not assumed. Nothing here is imported by product code.
 *
 * Configured by the environment:
 *  - SIGNAL_FIXTURE_LOG        the file every step appends a line to
 *  - SIGNAL_FIXTURE_TEMP       a scratch directory
 *  - SIGNAL_FIXTURE_COLLECTOR  the trace endpoint, or empty for a run with tracing off
 *  - SIGNAL_FIXTURE_MODE       `plain` (no sandbox) or `isolated` (a sandbox lifecycle registered with the owner)
 *  - SIGNAL_FIXTURE_SCENARIO   `child` | `complete` | `read-then-write`
 *  - SIGNAL_FIXTURE_DEADLINE_MS    the export's deadline on a signal
 *  - SIGNAL_FIXTURE_STOP_MS    how long the sandbox's stop step takes
 *  - SIGNAL_FIXTURE_BUDGET_MS  the sandbox teardown's budget
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import process from 'node:process'
import {setTimeout as delay} from 'node:timers/promises'
import {ok} from '@bfra.me/es/result'
import {postComment} from '../features/comments/writer.js'
import {createExecAdapter} from '../services/setup/adapters.js'
import {createLifecycleTracer} from '../shared/lifecycle-tracer.js'
import {createSecretRegistry} from '../shared/secret-registry.js'
import {createSandboxLifecycle} from './phases/sandbox-lifecycle.js'
import {createSignalOwner} from './signal-owner.js'

const log = process.env.SIGNAL_FIXTURE_LOG ?? ''
const temp = process.env.SIGNAL_FIXTURE_TEMP ?? '/tmp'
const collector = process.env.SIGNAL_FIXTURE_COLLECTOR ?? ''
const mode = process.env.SIGNAL_FIXTURE_MODE ?? 'plain'
const scenario = process.env.SIGNAL_FIXTURE_SCENARIO ?? 'child'
const deadlineMs = Number(process.env.SIGNAL_FIXTURE_DEADLINE_MS ?? '2000')
const stopMs = Number(process.env.SIGNAL_FIXTURE_STOP_MS ?? '1000')
const budgetMs = Number(process.env.SIGNAL_FIXTURE_BUDGET_MS ?? '10000')

const mark = (line: string): void => {
  fs.appendFileSync(log, `${line}\n`)
}
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warning: (message: string) => mark(`log:${message}`),
  error: (message: string) => mark(`log:${message}`),
}

const registry = createSecretRegistry(() => undefined)
const tracer = createLifecycleTracer({
  inputs: collector === '' ? {enabled: false} : {enabled: true, url: collector, headers: []},
  logger,
  registry,
  env: {},
})

const owner = createSignalOwner({
  logger,
  onCancel: signal => {
    mark(`cancelled:${signal}`)
    tracer.cancel(signal === 'SIGINT' ? 'sigint' : 'sigterm')
  },
  flush: async options => {
    mark('flush-started')
    const result = await tracer.flush(options)
    mark('flush-settled')
    return result
  },
  flushDeadlineMs: deadlineMs,
})

const exec = createExecAdapter()

if (mode === 'isolated') {
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
      'ln',
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
    env: {HOME: '/tmp', RUNNER_TEMP: temp},
    runnerPath: undefined,
    runnerHome: '/tmp',
    workspacePath: '/tmp/ws',
    responseDir: null,
    attachmentDir: null,
    logger,
    exec: {
      exec: async () => 0,
      execWithTimeout: async () => 0,
      getExecOutput: async () => ({exitCode: 0, stdout: '', stderr: ''}),
    },
    signalOwner: owner,
    signalTeardownBudgetMs: budgetMs,
    recordState: state => mark(`state:${state}`),
    deps: {
      createAccount: async () => ok(account),
      handOff: async () =>
        ok({snapshotDir: '/tmp/x', touched: [], chowned: [], aclTrees: [], git: null, gitPresent: false}),
      stop: async () => {
        mark('stop-start')
        await delay(stopMs)
        mark('stop-done')
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
}

/** The run's own ending, as `run()` has it: the span, the shared flush, the drain, the exit. */
async function finishLikeRun(exitCode: number): Promise<never> {
  tracer.root.end({outcome: exitCode === 0 ? 'succeeded' : 'failed'})
  await tracer.flush()
  await owner.drain()
  owner.dispose()
  mark(`exit:${exitCode}`)
  process.exit(exitCode)
}

if (scenario === 'child') {
  const phase = tracer.startSpan('execution')
  const pidFile = path.join(temp, 'child.pid')
  const seconds = mode === 'isolated' ? 4 : 60
  process.stdout.write('READY\n')
  // A long-running command through the real adapter, as an install or a tool is.
  const code = await exec.execWithTimeout?.('sh', ['-c', `echo $$ > ${pidFile}; exec sleep ${seconds}`], 120_000, {
    silent: true,
  })
  mark(`child-exit:${String(code)}`)
  phase.end({outcome: 'failed', reason: 'child-ended'})
  await finishLikeRun(1)
} else if (scenario === 'complete') {
  tracer.startSpan('cleanup').end({outcome: 'succeeded'})
  process.stdout.write('READY\n')
  await finishLikeRun(0)
} else {
  // A GitHub read that is still in flight when the signal arrives, then the write that depended on it.
  const phase = tracer.startSpan('review reconciliation')
  process.stdout.write('READY\n')
  await delay(Number(process.env.SIGNAL_FIXTURE_READ_MS ?? '1500'))
  mark('read-finished')
  const client = {
    rest: {
      issues: {
        createComment: async () => {
          mark('comment-submitted')
          return {data: {id: 1, html_url: 'https://example.test/c/1'}}
        },
      },
    },
  } as never
  const posted = await postComment(
    client,
    {type: 'issue', owner: 'o', repo: 'r', number: 1} as never,
    {body: 'late comment'},
    logger,
  )
  mark(`post-result:${posted === null ? 'null' : 'posted'}`)
  phase.end({outcome: 'succeeded'})
  await finishLikeRun(0)
}
