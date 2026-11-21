/**
 * Drives the scripted provider and a real `opencode serve --stdio` through every scenario the turn model must handle,
 * with the observation recorder loaded as a plugin, and returns each scenario's observations normalized for committing.
 * Used by `record-fixtures.integration.test.ts` (real binary only); never imported by the plugin.
 */

import type {FakeStep, RecordedRequest} from '../integration.fixture.js'
import type {Observation} from './observation.js'

import {execFileSync} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {makeSandbox, removeSandbox, startFakeProvider, startOpenCodeServer} from '../integration.fixture.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const NOT_TOOL = '"role":"tool"'
/** What the sandbox's README.md reads as: marks a request that already carries that tool's result. */
const README_TEXT = 'plugin integration project'
const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export interface Recording {
  readonly name: string
  readonly description: string
  readonly observations: readonly Observation[]
  /** Counts read off the scripted provider, which the observations cannot show (for example provider attempts). */
  readonly facts?: Readonly<Record<string, number>>
  /**
   * Whose each step was, from the scripted provider and not from any time: the i-th primary request hook of a session is the one
   * its i-th `step.started` belongs to (`request` is that 0-based i). Checked at recording time against the request number each
   * text and tool call carries.
   */
  readonly truth?: readonly {readonly session: string; readonly message: string; readonly request: number}[]
}

interface Scenario {
  readonly name: string
  readonly description: string
  readonly steps: readonly FakeStep[]
  readonly config?: Record<string, unknown>
  readonly run: (c: Context) => Promise<void>
  /** Read after the run, from the provider's own record, and checked here so a recording that did not do what it says fails. */
  readonly facts?: (c: Context) => Record<string, number>
}

interface Context {
  readonly repo: string
  readonly observations: () => Observation[]
  readonly api: (
    method: string,
    pathname: string,
    body?: unknown,
  ) => Promise<{readonly status: number; readonly data: unknown}>
  readonly create: () => Promise<string>
  readonly prompt: (sessionId: string, text: string, extra?: Record<string, unknown>) => Promise<void>
  /** Prompts and waits for the session's next terminal execution event. */
  readonly turn: (sessionId: string, text: string) => Promise<void>
  readonly waitFor: (label: string, done: () => boolean, timeoutMs?: number) => Promise<void>
  readonly executionsEnded: (sessionId: string) => number
  readonly permission: (sessionId: string) => Promise<string>
  /** Provider requests whose body names `needle`: one per attempt. */
  readonly providerRequests: (needle: string) => number
}

/** Builds the recorder as a standalone plugin: the real normalizers and registration, bundled with Bun. */
export function buildRecorderPlugin(dir: string): string {
  mkdirSync(dir, {recursive: true})
  const entry = path.join(dir, 'entry.ts')
  writeFileSync(
    entry,
    [
      "import {appendFileSync} from 'node:fs'",
      "import {Plugin} from '@opencode/plugin'",
      `import {registerObservers} from ${JSON.stringify(path.join(here, 'record-observations.ts'))}`,
      'export default Plugin.define({',
      "  id: 'fro-bot.trace-recorder',",
      '  setup: async ctx => {',
      '    const file = process.env.OPENCODE_FROBOT_RECORD_FILE',
      "    if (file === undefined) throw new Error('OPENCODE_FROBOT_RECORD_FILE is not set')",
      String.raw`    await registerObservers(ctx, observation => appendFileSync(file, JSON.stringify(observation) + '\n'))`,
      '  },',
      '})',
      '',
    ].join('\n'),
  )
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fro-bot-trace-recorder',
      version: '0.0.0',
      type: 'module',
      exports: {'.': {import: './index.mjs'}},
    }),
  )
  execFileSync(
    'bun',
    [
      'build',
      entry,
      '--outfile',
      path.join(dir, 'index.mjs'),
      '--target',
      'node',
      '--external',
      '@opencode/plugin',
      '--external',
      'effect',
    ],
    {stdio: 'pipe'},
  )
  return dir
}

const SUMMARY =
  '## Objective\n- J\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- (none)\n\n### Active\n- (none)\n\n### Blocked\n- (none)\n\n## Next Move\n1. (none)\n\n## Relevant Files\n- (none)\n\n## Important Context\n- (none)'

const subagent = (description: string, prompt: string, agent = 'general'): {name: string; args: unknown} => ({
  name: 'subagent',
  args: {agent, description, prompt},
})

const readTool = (file: string): {name: string; args: unknown} => ({name: 'read', args: {path: file}})

/** The built plugin in this package: its reuse guard is what the guard scenario exercises. */
function guardPluginDir(): string {
  return path.resolve(here, '../..')
}

function scenarios(): Scenario[] {
  return [
    {
      name: 'text-turn',
      description: 'One prompt, one model request with reasoning and usage, and the title request.',
      steps: [
        {
          all: ['A-TEXT'],
          text: 'hello back',
          reasoning: 'thinking about hello',
          usage: {prompt: 100, cached: 30, completion: 20},
        },
      ],
      run: async c => {
        await c.turn(await c.create(), 'A-TEXT hello')
      },
    },
    {
      name: 'tool-success-and-error',
      description: 'A read that succeeds and a read of a missing file, in two turns of one session.',
      steps: [
        {all: ['B-TOOL'], none: [NOT_TOOL], tools: [readTool('README.md')]},
        {all: ['B-TOOL', NOT_TOOL], text: 'read done'},
        {all: ['B-ERR'], none: ['missing-file.txt'], tools: [readTool('missing-file.txt')]},
        {all: ['B-ERR', 'missing-file.txt'], text: 'read failed done'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'B-TOOL read it')
        await c.turn(session, 'B-ERR read missing')
      },
    },
    {
      name: 'subagent-quick',
      description: 'A subagent that finishes while the parent is idle; its report starts a new parent execution.',
      steps: [
        {all: ['REPORT-KID-QUICK'], text: 'parent follow-on after report'},
        {all: ['PARENT-QUICK'], none: [NOT_TOOL, 'KID-QUICK'], tools: [subagent('quick kid', 'KID-QUICK reply done')]},
        {all: ['PARENT-QUICK', NOT_TOOL], none: ['REPORT-KID-QUICK'], text: 'parent dispatched'},
        {all: ['KID-QUICK'], none: ['PARENT-QUICK'], text: 'REPORT-KID-QUICK done', delayMs: 300},
      ],
      run: async c => {
        await c.turn(await c.create(), 'PARENT-QUICK dispatch')
        await sleep(2500)
      },
    },
    {
      name: 'prompt-while-subagent-runs-report-after',
      description: "A new prompt while the first turn's subagent runs; the report arrives after the second turn ended.",
      steps: [
        {all: ['REPORT-KID-SLOW'], text: 'parent report follow-on'},
        {all: ['PARENT-ONE'], none: [NOT_TOOL, 'KID-SLOW'], tools: [subagent('slow kid', 'KID-SLOW work')]},
        {all: ['PARENT-ONE', NOT_TOOL], none: ['REPORT-KID-SLOW', 'PARENT-TWO'], text: 'parent dispatched one'},
        {all: ['KID-SLOW'], none: ['PARENT-ONE'], text: 'REPORT-KID-SLOW done', delayMs: 3500},
        {all: ['PARENT-TWO'], none: ['REPORT-KID-SLOW'], text: 'parent answers two'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'PARENT-ONE dispatch slow child')
        await c.turn(session, 'PARENT-TWO quick question')
        await sleep(5500)
      },
    },
    {
      name: 'prompt-while-subagent-runs-report-during',
      description:
        "A new prompt while the first turn's subagent runs; the report lands inside the second turn's execution.",
      steps: [
        {all: ['REPORT-KID-SLOW'], text: 'parent report follow-on', delayMs: 200},
        {all: ['PARENT-ONE'], none: [NOT_TOOL, 'KID-SLOW'], tools: [subagent('slow kid', 'KID-SLOW work')]},
        {all: ['PARENT-ONE', NOT_TOOL], none: ['REPORT-KID-SLOW', 'PARENT-TWO'], text: 'parent dispatched one'},
        {all: ['KID-SLOW'], none: ['PARENT-ONE'], text: 'REPORT-KID-SLOW done', delayMs: 2500},
        {all: ['PARENT-TWO'], none: ['REPORT-KID-SLOW', README_TEXT], tools: [readTool('README.md')], delayMs: 3500},
        {all: ['PARENT-TWO', README_TEXT], none: ['REPORT-KID-SLOW'], text: 'parent answers two after tool'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'PARENT-ONE dispatch slow child')
        await sleep(300)
        await c.turn(session, 'PARENT-TWO another question while the child runs')
        await sleep(2500)
      },
    },
    {
      name: 'subagents-parallel',
      description: 'Two subagents dispatched from one model response; they report at different times.',
      steps: [
        {all: ['REPORT-KID-A', 'REPORT-KID-B'], text: 'parent follow-on both'},
        {all: ['REPORT-KID-B'], none: ['REPORT-KID-A'], text: 'parent follow-on b only'},
        {all: ['REPORT-KID-A'], none: ['REPORT-KID-B'], text: 'parent follow-on a only'},
        {
          all: ['PARENT-PAR'],
          none: [NOT_TOOL, 'KID-A', 'KID-B'],
          tools: [subagent('kid a', 'KID-A task'), subagent('kid b', 'KID-B task')],
        },
        {all: ['PARENT-PAR', NOT_TOOL], none: ['REPORT-KID'], text: 'parent dispatched both'},
        {all: ['KID-A'], none: ['PARENT-PAR'], text: 'REPORT-KID-A done', delayMs: 1500},
        {all: ['KID-B'], none: ['PARENT-PAR'], text: 'REPORT-KID-B done', delayMs: 800},
      ],
      run: async c => {
        await c.turn(await c.create(), 'PARENT-PAR dispatch two')
        await sleep(3500)
      },
    },
    {
      name: 'subagent-nested',
      description: 'A subagent that dispatches its own subagent (needs a custom agent and depth 2).',
      steps: [
        {all: ['REPORT-KID-MID'], text: 'parent follow-on'},
        {all: ['KID-MID', 'REPORT-GRAND'], none: ['PARENT-NEST'], text: 'REPORT-KID-MID done after grand'},
        {
          all: ['PARENT-NEST'],
          none: [NOT_TOOL, 'KID-MID'],
          tools: [subagent('mid kid', 'KID-MID dispatch a grandchild', 'nester')],
        },
        {all: ['PARENT-NEST', NOT_TOOL], none: ['REPORT-KID-MID'], text: 'parent dispatched mid'},
        {
          all: ['KID-MID'],
          none: [NOT_TOOL, 'GRAND-TASK', 'REPORT-GRAND'],
          tools: [subagent('grand kid', 'GRAND-TASK reply')],
        },
        {all: ['KID-MID', NOT_TOOL], none: ['PARENT-NEST', 'REPORT-GRAND'], text: 'mid dispatched grand'},
        {all: ['GRAND-TASK'], none: ['PARENT-NEST', 'KID-MID'], text: 'REPORT-GRAND done', delayMs: 500},
      ],
      config: {
        experimental: {subagent_depth: 2},
        agent: {nester: {mode: 'subagent', description: 'Agent that may dispatch its own subagents'}},
      },
      run: async c => {
        await c.turn(await c.create(), 'PARENT-NEST dispatch')
        await sleep(2500)
      },
    },
    {
      name: 'prompt-queued-mid-execution',
      description: 'A prompt sent with delivery "queue" while the first execution is running.',
      steps: [
        {all: ['G-ONE'], text: 'answer one', delayMs: 2000},
        {all: ['G-TWO'], text: 'answer two'},
      ],
      run: async c => {
        const session = await c.create()
        await c.prompt(session, 'G-ONE first')
        await sleep(500)
        await c.prompt(session, 'G-TWO queued second', {delivery: 'queue'})
        await c.waitFor('both prompts answered', () => c.executionsEnded(session) >= 1)
        await sleep(1500)
      },
    },
    {
      name: 'prompt-steered-mid-execution',
      description: 'A second prompt (default delivery) while the first execution is running.',
      steps: [
        {all: ['G-ONE'], text: 'answer one', delayMs: 2000},
        {all: ['G-TWO'], text: 'answer two'},
      ],
      run: async c => {
        const session = await c.create()
        await c.prompt(session, 'G-ONE first')
        await sleep(500)
        await c.prompt(session, 'G-TWO steered second')
        await c.waitFor('turn ended', () => c.executionsEnded(session) >= 1)
        await sleep(1500)
      },
    },
    {
      name: 'model-failure-retry',
      description: 'A 503 before the step starts and a successful retry, then a non-retryable 400.',
      steps: [
        {all: ['H-RETRY'], status: 503},
        {all: ['H-RETRY'], text: 'recovered after retry'},
        {all: ['H-FAIL'], status: 400},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'H-RETRY please')
        await c.turn(session, 'H-FAIL please')
      },
    },
    {
      name: 'tool-rejected-by-rule',
      description: 'A tool the permission rules deny: the after hook reports an error.',
      steps: [
        {all: ['I-DENY'], none: [NOT_TOOL], tools: [{name: 'shell', args: {command: 'echo nope'}}]},
        {all: ['I-DENY', NOT_TOOL], text: 'deny handled'},
      ],
      config: {permissions: [{action: 'shell', resource: 'echo *', effect: 'deny'}]},
      run: async c => {
        await c.turn(await c.create(), 'I-DENY shell')
      },
    },
    {
      name: 'tool-declined-by-user',
      description: 'A tool the user declines at the permission prompt: no after hook, the execution is interrupted.',
      steps: [{all: ['I-REJECT'], none: [NOT_TOOL], tools: [readTool('README.md')]}],
      config: {permissions: [{action: 'read', resource: '*', effect: 'ask'}]},
      run: async c => {
        const session = await c.create()
        await c.prompt(session, 'I-REJECT read')
        const request = await c.permission(session)
        await c.api('POST', `/api/session/${session}/permission/${request}/reply`, {decision: 'reject'})
        await c.waitFor('execution ended', () => c.executionsEnded(session) >= 1)
      },
    },
    {
      name: 'tool-interrupted-pending-permission',
      description: 'The user interrupts while a tool waits on a permission prompt.',
      steps: [{all: ['I-PEND'], none: [NOT_TOOL], tools: [readTool('README.md')]}],
      config: {permissions: [{action: 'read', resource: '*', effect: 'ask'}]},
      run: async c => {
        const session = await c.create()
        await c.prompt(session, 'I-PEND read')
        await c.permission(session)
        await sleep(400)
        await c.api('POST', `/api/session/${session}/interrupt`)
        await c.waitFor('execution ended', () => c.executionsEnded(session) >= 1)
      },
    },
    {
      name: 'tool-interrupted-running',
      description: 'The user interrupts a shell command that is running.',
      steps: [{all: ['I-RUN'], none: [NOT_TOOL], tools: [{name: 'shell', args: {command: 'sleep 20'}}]}],
      run: async c => {
        const session = await c.create()
        await c.prompt(session, 'I-RUN sleeping')
        await c.waitFor('tool started', () => c.observations().some(o => o.kind === 'tool.before'))
        await sleep(1200)
        await c.api('POST', `/api/session/${session}/interrupt`)
        await c.waitFor('execution ended', () => c.executionsEnded(session) >= 1)
      },
    },
    {
      name: 'tool-rejected-by-reuse-guard',
      description:
        "A subagent call that carries a session id: this plugin's own reuse guard throws in the before hook (the built plugin is loaded beside the recorder).",
      steps: [
        {
          all: ['M-GUARD'],
          none: [NOT_TOOL],
          tools: [
            {
              name: 'subagent',
              args: {
                agent: 'general',
                description: 'resume',
                prompt: 'M-CHILD again',
                sessionID: 'ses_00000000000000000000000000',
              },
            },
          ],
        },
        {all: ['M-GUARD', NOT_TOOL], text: 'guard handled'},
      ],
      config: {plugins: [guardPluginDir(), 'RECORDER']},
      run: async c => {
        await c.turn(await c.create(), 'M-GUARD resume a session')
      },
    },
    {
      name: 'tool-calls-inside-code-execution',
      description:
        'The model runs JavaScript in the code-execution tool; the code calls a tool that is not in its catalog. One tool call, one set of events and hooks: no nested call is published (the built-in tools are not in the catalog on 2.3.2).',
      steps: [
        {
          all: ['N-EXEC'],
          none: [NOT_TOOL],
          tools: [{name: 'execute', args: {code: 'return await tools.read({path: "README.md"})'}}],
        },
        {all: ['N-EXEC', NOT_TOOL], text: 'execute handled'},
      ],
      run: async c => {
        await c.turn(await c.create(), 'N-EXEC run code that reads a file')
      },
    },
    {
      name: 'compaction-manual',
      description: 'A manual compaction outside any turn: its own execution with no prompt.',
      steps: [
        {all: ['J-ONE'], text: 'answer one'},
        {text: SUMMARY, reasoning: 'compaction reasoning'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'J-ONE first')
        await sleep(1000)
        await c.api('POST', `/api/session/${session}/compact`, {})
        await c.waitFor('compaction ended', () => c.observations().some(o => o.kind === 'compaction.ended'))
        await sleep(1000)
      },
    },
    {
      name: 'generate-standalone',
      description: 'A generate request outside any execution: a hook and no events but cumulative usage.',
      steps: [
        {all: ['J2-ONE'], text: 'answer one'},
        {all: ['J2-GEN'], text: 'GENERATED TEXT'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'J2-ONE first')
        await sleep(1000)
        await c.api('POST', `/api/session/${session}/generate`, {prompt: 'J2-GEN write something'})
        await sleep(1500)
      },
    },
    {
      name: 'generate-retry',
      description:
        'A generate request whose first provider attempt fails with a 503 and whose second succeeds: the retry happens below request preparation, where no hook sees it.',
      steps: [
        {all: ['J3-ONE'], text: 'answer one'},
        {all: ['J3-GEN'], status: 503},
        {all: ['J3-GEN'], text: 'GENERATED AFTER RETRY'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'J3-ONE first')
        await sleep(1000)
        await c.api('POST', `/api/session/${session}/generate`, {prompt: 'J3-GEN write something'})
        // The retry waits about two seconds before the second attempt.
        await c.waitFor('both provider attempts', () => c.providerRequests('J3-GEN') >= 2, 30_000)
        await sleep(2500)
      },
      facts: c => ({providerAttempts: c.providerRequests('J3-GEN')}),
    },
    {
      name: 'tool-heavy',
      description: 'One prompt, eight sequential tool steps and a final answer: many steps in one session.',
      steps: [
        ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => ({
          all: ['H-HEAVY'],
          none: [`H-DONE-${String(n)}`],
          tools: [readTool('README.md')],
        })),
        {all: ['H-HEAVY'], text: 'all eight done'},
      ],
      run: async c => {
        await c.turn(await c.create(), 'H-HEAVY go')
      },
    },
    {
      name: 'failure-after-output',
      description: 'A model request whose stream drops AFTER text started, then a normal retry or a second prompt.',
      steps: [
        {all: ['P-POST'], text: 'partial text', abortAfterText: true},
        {all: ['P-POST'], text: 'recovered text'},
      ],
      run: async c => {
        const session = await c.create()
        await c.turn(session, 'P-POST first')
        await sleep(2500)
      },
    },
    {
      name: 'long-session',
      description: 'A retry, parallel large reads, a background subagent and a manual compaction in one session.',
      steps: [
        {all: ['REPORT-LONG-KID'], text: 'follow-on after the long kid'},
        {all: ['L-ONE'], status: 503},
        {all: ['L-ONE'], text: 'one answered after a retry'},
        {
          all: ['L-TWO'],
          none: [NOT_TOOL, 'L-THREE'],
          tools: [readTool('big-1.txt'), readTool('big-2.txt'), readTool('README.md')],
        },
        {all: ['L-TWO', 'line of text'], none: ['L-THREE'], text: 'two answered after tools'},
        {all: ['L-THREE'], none: ['LONG-KID'], tools: [subagent('long kid', 'LONG-KID work')]},
        {all: ['L-THREE', 'LONG-KID'], none: ['REPORT-LONG-KID'], text: 'three dispatched'},
        {all: ['LONG-KID'], none: ['L-ONE'], text: 'REPORT-LONG-KID done', delayMs: 1500},
        {text: SUMMARY},
      ],
      run: async c => {
        writeFileSync(path.join(c.repo, 'big-1.txt'), `${'line of text\n'.repeat(20_000)}`)
        writeFileSync(path.join(c.repo, 'big-2.txt'), `${'another line\n'.repeat(20_000)}`)
        const session = await c.create()
        await c.turn(session, 'L-ONE first')
        await c.turn(session, 'L-TWO read the big files')
        await c.turn(session, 'L-THREE dispatch')
        await sleep(3500)
        await c.api('POST', `/api/session/${session}/compact`, {})
        await c.waitFor('compaction ended', () => c.observations().some(o => o.kind === 'compaction.ended'))
        await sleep(800)
      },
    },
  ]
}

async function record(scenario: Scenario, recorderDir: string, binary: string, workDir: string): Promise<Recording> {
  const file = path.join(workDir, `${scenario.name}.jsonl`)
  writeFileSync(file, '')
  const sandbox = makeSandbox()
  const provider = await startFakeProvider({tagResponses: true})
  provider.script(scenario.steps)
  const server = await startOpenCodeServer({
    binary,
    sandbox,
    pluginDir: recorderDir,
    providerBaseURL: provider.baseURL,
    env: {OPENCODE_FROBOT_RECORD_FILE: file},
    ...(scenario.config === undefined
      ? {}
      : {
          config: {
            ...scenario.config,
            // `RECORDER` stands for the recorder plugin's directory, which is only known here.
            ...(Array.isArray(scenario.config.plugins)
              ? {
                  plugins: (scenario.config.plugins as unknown[]).map(entry =>
                    entry === 'RECORDER' ? recorderDir : entry,
                  ),
                }
              : {}),
          },
        }),
  })
  const observations = (): Observation[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as Observation)
  const executionsEnded = (sessionId: string): number =>
    observations().filter(o => o.kind === 'execution.ended' && o.sessionId === sessionId).length
  const api: Context['api'] = async (method, pathname, body) =>
    server.api(method, pathname, body === undefined ? undefined : {body})
  const waitFor: Context['waitFor'] = async (label, done, timeoutMs = 40_000) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (done()) return
      await sleep(100)
    }
    throw new Error(`${scenario.name}: timed out waiting for ${label}`)
  }
  const context: Context = {
    repo: sandbox.repo,
    providerRequests: needle => provider.requests.filter(request => request.body.includes(needle)).length,
    observations,
    api,
    executionsEnded,
    waitFor,
    create: async () => {
      const created = await api('POST', '/api/session', {location: {directory: sandbox.repo}})
      const data = (created.data as {data?: {id?: unknown}}).data
      return String(data?.id)
    },
    prompt: async (sessionId, text, extra = {}) => {
      const sent = await api('POST', `/api/session/${sessionId}/prompt`, {text, ...extra})
      if (sent.status !== 200) throw new Error(`prompt failed: ${sent.status}`)
    },
    turn: async (sessionId, text) => {
      const before = executionsEnded(sessionId)
      await context.prompt(sessionId, text)
      await waitFor(`turn "${text}"`, () => executionsEnded(sessionId) > before)
    },
    permission: async sessionId => {
      let request: string | undefined
      for (let i = 0; i < 100 && request === undefined; i += 1) {
        const listed = await api('GET', `/api/session/${sessionId}/permission`)
        const first = (listed.data as {data?: {id?: unknown}[]}).data?.[0]
        if (first?.id === undefined) {
          await sleep(100)
        } else {
          request = String(first.id)
        }
      }
      if (request === undefined) throw new Error('no permission request appeared')
      return request
    },
  }
  try {
    // The server boots a location, and so loads the plugin, on the first API call.
    await api('GET', '/api/plugin')
    await scenario.run(context)
    await sleep(800)
  } finally {
    await server.stop()
    await provider.stop()
    removeSandbox(sandbox)
  }
  const facts = scenario.facts?.(context)
  return {
    name: scenario.name,
    description: scenario.description,
    observations: observations(),
    truth: computeTruth(observations(), provider.requests),
    ...(facts === undefined ? {} : {facts}),
  }
}

/** The restored-session scenario needs two servers on one sandbox: history without the recorder, then a new turn with it. */
async function recordRestored(recorderDir: string, binary: string, workDir: string): Promise<Recording> {
  const file = path.join(workDir, 'restored-session.jsonl')
  writeFileSync(file, '')
  const sandbox = makeSandbox()
  const provider = await startFakeProvider({tagResponses: true})
  provider.script([
    {all: ['K-HIST'], text: 'history answer'},
    {all: ['K-NEW'], text: 'new answer'},
  ])
  try {
    const noopDir = path.join(workDir, 'noop-plugin')
    mkdirSync(noopDir, {recursive: true})
    writeFileSync(
      path.join(noopDir, 'index.mjs'),
      "import {Plugin} from '@opencode/plugin'\nexport default Plugin.define({id: 'noop', setup: () => {}})\n",
    )
    writeFileSync(
      path.join(noopDir, 'package.json'),
      JSON.stringify({name: 'noop', version: '0.0.0', type: 'module', exports: {'.': {import: './index.mjs'}}}),
    )
    const first = await startOpenCodeServer({binary, sandbox, pluginDir: noopDir, providerBaseURL: provider.baseURL})
    await first.api('GET', '/api/plugin')
    const created = await first.api('POST', '/api/session', {body: {location: {directory: sandbox.repo}}})
    const sessionId = String((created.data as {data: {id: unknown}}).data.id)
    await first.api('POST', `/api/session/${sessionId}/prompt`, {body: {text: 'K-HIST earlier work'}})
    await sleep(3000)
    await first.stop()
    const second = await startOpenCodeServer({
      binary,
      sandbox,
      pluginDir: recorderDir,
      providerBaseURL: provider.baseURL,
      env: {OPENCODE_FROBOT_RECORD_FILE: file},
    })
    await second.api('GET', '/api/plugin')
    await second.api('POST', `/api/session/${sessionId}/prompt`, {
      body: {text: 'K-NEW new turn on the restored session'},
    })
    await sleep(3000)
    await second.stop()
  } finally {
    await provider.stop()
    removeSandbox(sandbox)
  }
  const observations = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as Observation)
  return {
    name: 'restored-session',
    description:
      "A restored session's first new turn: the request carries the restored history, and there is no title request.",
    observations,
    truth: computeTruth(observations, provider.requests),
  }
}

/**
 * Which request hook each step belongs to, read off the sequential runner and cross-checked against the provider. Per session the
 * i-th primary `request` hook and the i-th `step.started` are a pair (a session's steps run one after another; the counts must
 * agree or the scenario cannot be trusted). Each text carries `#r<n>` and each tool call id is `call_<n>_<i>`, where n is the
 * number of the provider request that answered it: that request arrived after its own hook and before the next one, so the hook
 * with the greatest receive time at or before its arrival must be the same pair. A step whose message was started twice (a
 * pre-output retry reuses it) is checked by the count alone.
 */
export function computeTruth(
  observations: readonly Observation[],
  requests: readonly RecordedRequest[],
): {session: string; message: string; request: number}[] {
  const hooks = new Map<string, number[]>()
  const steps = new Map<string, string[]>()
  for (const o of observations) {
    if (o.kind === 'request' && o.requestKind === 'primary')
      hooks.set(o.sessionId, [...(hooks.get(o.sessionId) ?? []), o.at])
    if (o.kind === 'step.started') steps.set(o.sessionId, [...(steps.get(o.sessionId) ?? []), o.messageId])
  }
  const tags = new Map<string, number>()
  for (const o of observations) {
    if (o.kind === 'output' && o.part === 'text') {
      const tag = /#r(\d+)$/.exec(o.text)
      if (tag?.[1] !== undefined) tags.set(`${o.sessionId}/${o.messageId}`, Number(tag[1]))
    }
    if (o.kind === 'tool.called' && o.messageId !== undefined) {
      const tag = /^call_(\d+)_/.exec(o.callId)
      if (tag?.[1] !== undefined) tags.set(`${o.sessionId}/${o.messageId}`, Number(tag[1]))
    }
  }
  const truth: {session: string; message: string; request: number}[] = []
  for (const [session, messages] of steps) {
    const times = hooks.get(session) ?? []
    if (times.length !== messages.length) {
      throw new Error(`${session}: ${String(times.length)} primary hooks but ${String(messages.length)} step starts`)
    }
    messages.forEach((message, request) => {
      truth.push({session, message, request})
      const tagged = tags.get(`${session}/${message}`)
      const arrival = tagged === undefined ? undefined : requests[tagged - 1]?.receivedAt
      if (arrival === undefined || messages.filter(candidate => candidate === message).length > 1) return
      let owner = -1
      times.forEach((time, index) => {
        if (time <= arrival) owner = index
      })
      if (owner !== request) {
        throw new Error(
          `${session}/${message}: ordinal pairs it with hook ${String(request)}, the provider with ${String(owner)}`,
        )
      }
    })
  }
  return truth
}

/** Records every scenario, or only those named in `only`. */
export async function recordAll(binary: string, workDir: string, only?: readonly string[]): Promise<Recording[]> {
  mkdirSync(workDir, {recursive: true})
  const recorderDir = buildRecorderPlugin(path.join(workDir, 'recorder'))
  const wanted = (name: string): boolean => only === undefined || only.includes(name)
  const recordings: Recording[] = []
  for (const scenario of scenarios()) {
    if (wanted(scenario.name)) recordings.push(await record(scenario, recorderDir, binary, workDir))
  }
  if (wanted('restored-session')) recordings.push(await recordRestored(recorderDir, binary, workDir))
  return recordings
}

// ---------------------------------------------------------------------------------------------------------------------
// Normalization: stable placeholders for volatile ids, relative time, content replaced by its size.
// ---------------------------------------------------------------------------------------------------------------------

const ID_FIELDS: ReadonlySet<string> = new Set([
  'sessionId',
  'parentSessionId',
  'childSessionId',
  'messageId',
  'inboxId',
  'inputId',
  'callId',
])
const CONTENT_FIELDS: ReadonlySet<string> = new Set(['content', 'input', 'result', 'error', 'text', 'title', 'message'])

/** Replaces what is volatile or large. Order, timing relations and every field the model reads are kept. */
export function normalizeRecording(recording: Recording): Recording {
  const names = new Map<string, string>()
  const placeholder = (value: string): string => {
    const known = names.get(value)
    if (known !== undefined) return known
    const prefix = value.startsWith('ses_') ? 'ses' : value.startsWith('call') ? 'call' : 'msg'
    const count = [...names.values()].filter(name => name.startsWith(`${prefix}_`)).length + 1
    const next = `${prefix}_${count}`
    names.set(value, next)
    return next
  }
  const first = recording.observations.reduce((min, o) => Math.min(min, o.at), Number.POSITIVE_INFINITY)
  const observations = recording.observations.map(observation => {
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(observation)) {
      if ((key === 'at' || key === 'started') && typeof value === 'number') copy[key] = Math.round(value - first)
      else if (key === 'bytes' && typeof value === 'number') copy[key] = Math.round(value / 100) * 100
      else if (ID_FIELDS.has(key) && typeof value === 'string') copy[key] = placeholder(value)
      else if (key === 'error' && typeof value === 'object' && value !== null && observation.kind !== 'tool.after') {
        const {type, status} = value as {type?: unknown; status?: unknown}
        copy[key] = {type, ...(typeof status === 'number' ? {status} : {})}
      } else if (key === 'error' && observation.kind === 'tool.after')
        copy[key] = value === undefined ? undefined : '[omitted]'
      else if (CONTENT_FIELDS.has(key) && value !== undefined && observation.kind !== 'execution.ended') {
        const size = typeof value === 'string' ? value.length : JSON.stringify(value).length
        copy[key] = `[omitted ${size} bytes]`
      } else if (value !== undefined) copy[key] = value
    }
    return copy as unknown as Observation
  })
  // Every id the truth names appears in the observations, so the placeholders are already assigned.
  const truth = recording.truth?.map(entry => ({
    session: placeholder(entry.session),
    message: placeholder(entry.message),
    request: entry.request,
  }))
  return {...recording, observations, ...(truth === undefined ? {} : {truth})}
}

/** The committed fixtures module: one observation per line, so a review diff reads as a timeline. */
export function renderFixturesModule(recordings: readonly Recording[]): string {
  const body = recordings
    .map(recording => {
      const lines = recording.observations.map(observation => `      ${JSON.stringify(observation)},`)
      return [
        `  ${JSON.stringify(recording.name)}: {`,
        `    description: ${JSON.stringify(recording.description)},`,
        ...(recording.facts === undefined ? [] : [`    facts: ${JSON.stringify(recording.facts)},`]),
        ...(recording.truth === undefined ? [] : [`    truth: ${JSON.stringify(recording.truth)},`]),
        '    observations: [',
        ...lines,
        '    ],',
        '  },',
      ].join('\n')
    })
    .join('\n')
  return `/**
 * Observations recorded from the pinned OpenCode 2.3.2 binary by \`record-fixtures.integration.test.ts\`, normalized:
 * session, message and call ids are placeholders in order of appearance, time is milliseconds from the first
 * observation, and content (prompts, requests, tool inputs and results, text, error messages) is replaced by its size.
 * Order and timing relations are exactly as recorded. Regenerate with \`FRO_BOT_RECORD_FIXTURES=1\`.
 */

import type {Observation} from './observation.js'

export interface RecordedFixture {
  readonly description: string
  /** Counts the observations cannot show, read off the scripted provider when recording. */
  readonly facts?: Readonly<Record<string, number>>
  /** Whose each step was, from the scripted provider (see \`computeTruth\`): the 0-based request hook of the session it answers. */
  readonly truth?: readonly {readonly session: string; readonly message: string; readonly request: number}[]
  readonly observations: readonly Observation[]
}

// prettier-ignore
export const recordedFixtures: Readonly<Record<string, RecordedFixture>> = {
${body}
}
`
}
