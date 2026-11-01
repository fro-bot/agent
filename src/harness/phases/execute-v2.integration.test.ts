/**
 * Real-binary check of the Action's OpenCode V2 execution loop: one prompt end to end through `runExecute` against the
 * stock pinned binary and a scripted model that issues a `question` tool call, a read outside the checkout (a permission
 * ask), and then answers with reasoning followed by text.
 *
 * Runs only when `FRO_BOT_OPENCODE_V2_BIN` names the stock OpenCode binary pinned in
 * `packages/runtime/src/shared/opencode-v2-pin.json`. Fetch the archive, compare its sha256 with that file BEFORE running
 * anything from it, and delete the binary afterwards (see `v2-server.integration.test.ts` for the exact commands).
 *
 * The plugin install uses the npm registry, so the test needs network access. The model is a local OpenAI-compatible
 * stub: nothing leaves the machine except that install.
 *
 * The release tests (U12b) run the same loop and then `runReleaseV2` against the real server: a background `shell` whose
 * completion notice starts a second turn, and a deadline that lands mid-shell.
 */

import type {AddressInfo} from 'node:net'
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {BootstrapPhaseResult} from './bootstrap.js'
import type {CacheRestoreV2PhaseResult} from './cache-restore.js'
import type {RoutingPhaseResult} from './routing.js'
import type {SessionPrepPhaseResult} from './session-prep.js'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {buildSessionTitle} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import pin from '../../../packages/runtime/src/shared/opencode-v2-pin.json'
import {createActionClientV2} from '../../features/agent/execution-v2.js'
import {checkpointDatabase} from '../../services/cache/checkpoint.js'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {installPluginsV2, resolvePluginSpecsV2} from '../../services/setup/plugin-install-v2.js'
import {createMockLogger, unwrapOk} from '../../shared/test-helpers.js'
import {computeDrainDeadlineMs, runExecute} from './execute.js'
import {runReleaseV2} from './release-v2.js'
import {createSessionReaderV2, resolveSessionForLogicalKeyV2} from './session-v2.js'
import {startActionOpenCodeV2} from './v2-server.js'

const consoleMock = vi.hoisted(() => ({outputTextContent: vi.fn(), outputToolExecution: vi.fn()}))
vi.mock('../../shared/console.js', () => consoleMock)
vi.mock('@actions/core', async importOriginal => {
  const original = await importOriginal<typeof import('@actions/core')>()
  return {
    ...original,
    getInput: vi.fn(() => 'branch-pr'),
    saveState: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    setFailed: vi.fn(),
  }
})

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BINARY !== undefined && BINARY !== '' && existsSync(BINARY)

const CANARY = 'sk-fake-CANARY-execution-5b1d'
const MODEL = 'fake/fixture-model'
const REASONING = 'PRIVATE CHAIN OF THOUGHT 7c2e'
const ANSWER = 'The fixture answer is 42.'

interface Sandbox {
  readonly root: string
  readonly repo: string
  readonly dbPath: string
  readonly authPath: string
  readonly cacheHome: string
  readonly env: NodeJS.ProcessEnv
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v2-exec-it-'))
  const home = path.join(root, 'home')
  const [config, data, cache, state, tmp] = ['config', 'data', 'cache', 'state', 'tmp'].map(name => {
    const dir = path.join(home, name)
    mkdirSync(dir, {recursive: true})
    return dir
  }) as [string, string, string, string, string]
  const repo = path.join(root, 'repo')
  mkdirSync(repo, {recursive: true})
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@x',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@x',
      },
    })
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  git('add', '.')
  git('commit', '-qm', 'init')
  const runnerTemp = path.join(root, 'runner-temp')
  mkdirSync(runnerTemp, {recursive: true})
  const dataDir = path.join(data, 'opencode')
  mkdirSync(dataDir, {recursive: true})
  return {
    root,
    repo,
    dbPath: path.join(dataDir, 'opencode.db'),
    authPath: path.join(dataDir, 'auth.json'),
    cacheHome: cache,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      TMPDIR: tmp,
      RUNNER_TEMP: runnerTemp,
      OPENCODE_DISABLE_MODELS_FETCH: '1',
    },
  }
}

interface ModelRequest {
  readonly hasTools: boolean
  readonly toolNames: readonly string[]
  readonly raw: string
}

interface Provider {
  readonly baseURL: string
  readonly requests: ModelRequest[]
  readonly stop: () => Promise<void>
}

function sse(res: http.ServerResponse, delta: Record<string, unknown>, finish: string | null, usage = false): void {
  res.write(
    `data: ${JSON.stringify({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{index: 0, delta, finish_reason: finish}],
      ...(usage ? {usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}} : {}),
    })}\n\n`,
  )
}

/**
 * A scripted OpenAI-compatible model. Turns that offer tools are the run's: 1 asks a `question`, 2 reads a file outside
 * the checkout, 3 answers with reasoning then text. A request with no tools (the title) gets a short text.
 */
async function startProvider(outsideFile: string): Promise<Provider> {
  const requests: ModelRequest[] = []
  let toolTurn = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const parsed = JSON.parse(raw) as {tools?: {function?: {name?: string}}[]}
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '')
      const hasTools = toolNames.length > 0
      requests.push({hasTools, toolNames, raw})
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      sse(res, {role: 'assistant', content: ''}, null)
      if (hasTools) {
        toolTurn += 1
        if (toolTurn === 1) {
          const args = JSON.stringify({
            questions: [{question: 'Which one?', header: 'Pick', options: [{label: 'A', description: 'first'}]}],
          })
          sse(
            res,
            {tool_calls: [{index: 0, id: 'call_q', type: 'function', function: {name: 'question', arguments: args}}]},
            null,
          )
          sse(res, {}, 'tool_calls', true)
        } else if (toolTurn === 2) {
          const args = JSON.stringify({path: outsideFile})
          sse(
            res,
            {tool_calls: [{index: 0, id: 'call_r', type: 'function', function: {name: 'read', arguments: args}}]},
            null,
          )
          sse(res, {}, 'tool_calls', true)
        } else {
          sse(res, {reasoning_content: REASONING}, null)
          sse(res, {content: ANSWER}, null)
          sse(res, {}, 'stop', true)
        }
      } else {
        sse(res, {content: 'Fixture title'}, null)
        sse(res, {}, 'stop', true)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function operatorConfig(baseURL: string): string {
  return JSON.stringify({
    share: 'disabled',
    provider: {
      fake: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake',
        options: {baseURL},
        models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
      },
    },
  })
}

interface Seen {
  readonly method: string
  readonly path: string
  readonly body: string | null
}

const sandboxes: Sandbox[] = []
const providers: Provider[] = []
const handles: OpenCodeV2ServerHandle[] = []

type ScriptStep = {readonly tool: string; readonly args: Record<string, unknown>} | {readonly text: string}

/**
 * A scripted model for the release tests. Tool-offering requests walk `script` in order (past its end they answer
 * `fallback`); a request with no tools (the title) gets a short text. Every request body is kept.
 */
async function startScriptedProvider(script: readonly ScriptStep[], fallback = 'ok'): Promise<Provider> {
  const requests: ModelRequest[] = []
  let toolTurn = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      const parsed = JSON.parse(raw) as {tools?: {function?: {name?: string}}[]}
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '')
      const hasTools = toolNames.length > 0
      requests.push({hasTools, toolNames, raw})
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      sse(res, {role: 'assistant', content: ''}, null)
      if (hasTools) {
        const step = script[toolTurn] ?? {text: fallback}
        toolTurn += 1
        if ('tool' in step) {
          const call = {
            index: 0,
            id: `call_${toolTurn}`,
            type: 'function',
            function: {name: step.tool, arguments: JSON.stringify(step.args)},
          }
          sse(res, {tool_calls: [call]}, null)
          sse(res, {}, 'tool_calls', true)
        } else {
          sse(res, {content: step.text}, null)
          sse(res, {}, 'stop', true)
        }
      } else {
        sse(res, {content: 'Fixture title'}, null)
        sse(res, {}, 'stop', true)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function startRealServer(box: Sandbox, provider: Provider): Promise<OpenCodeV2ServerHandle> {
  process.env.RUNNER_TEMP = box.env.RUNNER_TEMP
  process.env.GITHUB_WORKSPACE = box.repo
  process.env.GITHUB_RUN_ID = '78'
  process.env.GITHUB_RUN_ATTEMPT = '1'
  const specs = unwrapOk(resolvePluginSpecsV2('latest')).specs
  unwrapOk(
    await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: createExecAdapter(),
      opencodeBinaryPath: BINARY as string,
      specs,
      cacheHome: box.cacheHome,
      env: box.env,
    }),
  )
  const started = await startActionOpenCodeV2({
    binaryPath: BINARY as string,
    workspacePath: box.repo,
    authJson: JSON.stringify({fake: {type: 'api', key: CANARY}}),
    opencodeConfig: operatorConfig(provider.baseURL),
    systematicVersion: 'latest',
    model: MODEL,
    dbPath: box.dbPath,
    authPath: box.authPath,
    env: box.env,
    runId: 78,
    runAttempt: 1,
    logger: createMockLogger(),
    deps: {
      startServer: async (spawnOptions, spawnLogger) => {
        const {startOpenCodeV2Server} = await import('@fro-bot/runtime')
        return startOpenCodeV2Server({...spawnOptions, timeouts: {agentReadyTimeoutMs: 90_000}}, spawnLogger)
      },
    },
  })
  const real = unwrapOk(started)
  handles.push(real)
  return real
}

/** The execute phase against a started server, with the minimum of routing context a prompt needs. */
async function executePhase(
  serverHandle: OpenCodeV2ServerHandle,
  box: Sandbox,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof runExecute>>> {
  const cacheRestore: CacheRestoreV2PhaseResult = {
    generation: 'v2',
    cacheResult: {hit: false, key: 'k', restoredPath: null, corrupted: false, source: null},
    cacheStatus: 'miss',
    serverHandle,
  }
  return runExecute(
    {
      inputs: {
        prompt: 'Run the background job.',
        outputMode: 'branch-pr',
        agent: null,
        model: {providerID: 'fake', modelID: 'fixture-model'},
        timeoutMs,
        responseMode: 'github',
      },
      logger: createMockLogger(),
      opencodeResult: {path: BINARY as string, version: pin.version, didSetup: false},
      delivery: 'model-gh',
      responseFilePath: null,
    } as unknown as BootstrapPhaseResult,
    {
      githubClient: {},
      triggerResult: {
        shouldProcess: true,
        context: {
          eventType: 'workflow_dispatch',
          eventName: 'workflow_dispatch',
          repo: {owner: 'o', repo: 'r'},
          ref: 'refs/heads/main',
          sha: 'sha',
          runId: 78,
          actor: 'actor',
          action: null,
          author: null,
          target: null,
          commentBody: null,
          commentId: null,
          hasMention: false,
          command: null,
          isBotReviewRequested: false,
          raw: {},
        },
      },
      agentContext: {
        eventName: 'workflow_dispatch',
        repo: 'o/r',
        ref: 'refs/heads/main',
        actor: 'actor',
        runId: '78',
        issueNumber: null,
        issueTitle: null,
        issueType: null,
        commentBody: null,
        commentAuthor: null,
        commentId: null,
        defaultBranch: 'main',
        diffContext: null,
        hydratedContext: null,
        authorAssociation: null,
        isRequestedReviewer: false,
      },
      botLogin: 'fro-bot',
    } as unknown as RoutingPhaseResult,
    cacheRestore,
    {
      recentSessions: [],
      priorWorkContext: [],
      attachmentResult: null,
      normalizedWorkspace: box.repo,
      logicalKey: null,
      continueSessionId: null,
      isContinuation: false,
      sessionTitle: 'Fro Bot: release fixture',
    } satisfies SessionPrepPhaseResult,
    {
      start: vi.fn(),
      end: vi.fn(),
      setCacheStatus: vi.fn(),
      setCacheSource: vi.fn(),
      addSessionUsed: vi.fn(),
      addSessionCreated: vi.fn(),
      addPRCreated: vi.fn(),
      addCommitCreated: vi.fn(),
      incrementComments: vi.fn(),
      setTokenUsage: vi.fn(),
      recordError: vi.fn(),
      getMetrics: vi.fn(),
    },
    Date.now(),
  )
}

/** Whether any process still runs a command line containing `needle` (`pgrep -f`; exit 1 means none). */
function processRunning(needle: string): boolean {
  try {
    execFileSync('pgrep', ['-f', needle], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

function sessionClaims(dbPath: string): readonly {id: string; suspended: number | null}[] {
  const db = new DatabaseSync(dbPath, {readOnly: true})
  try {
    return db.prepare('SELECT id, time_suspended AS suspended FROM session_v2').all() as unknown as {
      id: string
      suspended: number | null
    }[]
  } finally {
    db.close()
  }
}

/** A file's size, or 0 when it is not there. One call, so there is no check-then-use window on the path. */
function sizeOrZero(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

const SHELL_MARKER = 'release-fixture-job-d41'

describe.skipIf(!hasBinary)('runExecute on OpenCode V2 against the real stock binary', () => {
  beforeAll(() => {
    const reported = execFileSync(BINARY as string, ['--version'], {encoding: 'utf8'}).trim()
    if (reported !== `opencode v${pin.version}`) {
      throw new Error(`FRO_BOT_OPENCODE_V2_BIN reports "${reported}", expected opencode v${pin.version}`)
    }
  })

  afterAll(async () => {
    for (const handle of handles) await handle.shutdown()
    for (const provider of providers) await provider.stop()
    for (const box of sandboxes) rmSync(box.root, {recursive: true, force: true})
  })

  it('runs one prompt: the answer is captured without reasoning, the question tool is neutralized, the outside read is rejected', async () => {
    // #given a started and gated server, and a scripted model
    const box = createSandbox()
    sandboxes.push(box)
    const outsideFile = path.join(box.root, 'outside-secret.txt')
    writeFileSync(outsideFile, 'outside the checkout\n')
    const provider = await startProvider(outsideFile)
    providers.push(provider)
    process.env.RUNNER_TEMP = box.env.RUNNER_TEMP
    process.env.GITHUB_WORKSPACE = box.repo
    process.env.GITHUB_RUN_ID = '77'
    process.env.GITHUB_RUN_ATTEMPT = '1'

    const specs = unwrapOk(resolvePluginSpecsV2('latest')).specs
    unwrapOk(
      await installPluginsV2({
        logger: createMockLogger(),
        execAdapter: createExecAdapter(),
        opencodeBinaryPath: BINARY as string,
        specs,
        cacheHome: box.cacheHome,
        env: box.env,
      }),
    )
    const started = await startActionOpenCodeV2({
      binaryPath: BINARY as string,
      workspacePath: box.repo,
      authJson: JSON.stringify({fake: {type: 'api', key: CANARY}}),
      opencodeConfig: operatorConfig(provider.baseURL),
      systematicVersion: 'latest',
      model: MODEL,
      dbPath: box.dbPath,
      authPath: box.authPath,
      env: box.env,
      runId: 77,
      runAttempt: 1,
      logger: createMockLogger(),
      deps: {
        startServer: async (spawnOptions, spawnLogger) => {
          const {startOpenCodeV2Server} = await import('@fro-bot/runtime')
          return startOpenCodeV2Server({...spawnOptions, timeouts: {agentReadyTimeoutMs: 90_000}}, spawnLogger)
        },
      },
    })
    const real = unwrapOk(started)
    handles.push(real)

    // #and a handle that records every route the loop calls
    const seen: Seen[] = []
    let formCreateStatus = 0
    const serverHandle = {
      ...real,
      fetch: async (route: string, init?: RequestInit) => {
        seen.push({
          method: init?.method ?? 'GET',
          path: route,
          body: typeof init?.body === 'string' ? init.body : null,
        })
        const response = await real.fetch(route, init)
        // The model's own `question` tool is not offered under the CI config (R18), so a pending form is raised through the
        // server's form route as the prompt is admitted: the loop must cancel it at once and carry on.
        const prompted = /^\/api\/session\/([^/]+)\/prompt$/.exec(route)
        if (prompted !== null && response.ok) {
          const created = await real.fetch(`/api/session/${prompted[1]}/form`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              title: 'Questions',
              metadata: {kind: 'question'},
              fields: [{key: 'answer', type: 'string'}],
            }),
          })
          formCreateStatus = created.status
        }
        return response
      },
    } as OpenCodeV2ServerHandle
    const cacheRestore: CacheRestoreV2PhaseResult = {
      generation: 'v2',
      cacheResult: {hit: false, key: 'k', restoredPath: null, corrupted: false, source: null},
      cacheStatus: 'miss',
      serverHandle,
    }

    // #when the execute phase runs a prompt through the V2 loop
    const logger = createMockLogger()
    const result = await runExecute(
      {
        inputs: {
          prompt: 'Answer the fixture question.',
          outputMode: 'branch-pr',
          agent: null,
          model: {providerID: 'fake', modelID: 'fixture-model'},
          timeoutMs: 120_000,
          responseMode: 'github',
        },
        logger,
        opencodeResult: {path: BINARY as string, version: pin.version, didSetup: false},
        delivery: 'model-gh',
        responseFilePath: null,
      } as unknown as BootstrapPhaseResult,
      {
        githubClient: {},
        triggerResult: {
          shouldProcess: true,
          context: {
            eventType: 'workflow_dispatch',
            eventName: 'workflow_dispatch',
            repo: {owner: 'o', repo: 'r'},
            ref: 'refs/heads/main',
            sha: 'sha',
            runId: 77,
            actor: 'actor',
            action: null,
            author: null,
            target: null,
            commentBody: null,
            commentId: null,
            hasMention: false,
            command: null,
            isBotReviewRequested: false,
            raw: {},
          },
        },
        agentContext: {
          eventName: 'workflow_dispatch',
          repo: 'o/r',
          ref: 'refs/heads/main',
          actor: 'actor',
          runId: '77',
          issueNumber: null,
          issueTitle: null,
          issueType: null,
          commentBody: null,
          commentAuthor: null,
          commentId: null,
          defaultBranch: 'main',
          diffContext: null,
          hydratedContext: null,
          authorAssociation: null,
          isRequestedReviewer: false,
        },
        botLogin: 'fro-bot',
      } as unknown as RoutingPhaseResult,
      cacheRestore,
      {
        recentSessions: [],
        priorWorkContext: [],
        attachmentResult: null,
        normalizedWorkspace: box.repo,
        logicalKey: null,
        continueSessionId: null,
        isContinuation: false,
        sessionTitle: 'Fro Bot: fixture',
      } satisfies SessionPrepPhaseResult,
      {
        start: vi.fn(),
        end: vi.fn(),
        setCacheStatus: vi.fn(),
        setCacheSource: vi.fn(),
        addSessionUsed: vi.fn(),
        addSessionCreated: vi.fn(),
        addPRCreated: vi.fn(),
        addCommitCreated: vi.fn(),
        incrementComments: vi.fn(),
        setTokenUsage: vi.fn(),
        recordError: vi.fn(),
        getMetrics: vi.fn(),
      },
      Date.now(),
    )

    // #then the run completed successfully on its own session
    expect(result).toMatchObject({success: true, exitCode: 0, llmError: null})
    expect(result.sessionId).toMatch(/^ses_/)

    // #and the response text was captured and holds no reasoning
    const written = JSON.stringify(consoleMock.outputTextContent.mock.calls)
    expect(written).toContain(ANSWER)
    expect(written).not.toContain(REASONING)

    // #and the pending form was cancelled through the form route, and none is left pending
    expect(formCreateStatus).toBeLessThan(300)
    expect(seen.some(item => item.method === 'DELETE' && /\/form\/[^/?]+/.test(item.path))).toBe(true)
    const sessionId = result.sessionId as string
    const forms = (await (await real.fetch(`/api/session/${sessionId}/form`)).json()) as {data: unknown[]}
    expect(forms.data).toEqual([])

    // #and the permission ask for the outside read was answered with a reject, never once or always
    const replies = seen.filter(item => /\/permission\/[^/]+\/reply$/.test(item.path))
    for (const reply of replies) {
      expect(JSON.parse(reply.body ?? '{}')).toEqual({decision: 'reject'})
    }

    // #and the key never reached a log
    expect(
      JSON.stringify([...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warning).mock.calls]),
    ).not.toContain(CANARY)

    // #and the model's `question` call found no such tool, and its read outside the checkout was refused by the
    // permission rules before any ask reached the loop (so there was nothing to reject)
    const toolResults = provider.requests
      .filter(item => item.hasTools)
      .flatMap(item => (JSON.parse(item.raw) as {messages: {role: string; content: unknown}[]}).messages)
      .filter(message => message.role === 'tool')
      .map(message => JSON.stringify(message.content))
      .join('\n')
    expect(toolResults).toContain('No tool named')
    expect(toolResults).toContain('Permission denied: external_directory')

    // #and the reject reply the loop sends is a body the real server accepts: for a request that does not exist it
    // answers "not found", not a schema error
    const reply = await createActionClientV2(real).replyPermission({
      sessionId,
      requestId: 'per_00000000000000000000000000',
      decision: 'reject',
    })
    expect(reply).toEqual({success: false, error: {kind: 'http', status: 404}})

    // #and the V2 session reads the Action's continuity and prior-work context use work on the real server: the session
    // this run created is found by its title in the checkout, and archiving it (the overflow-recovery step) removes it
    const reader = createSessionReaderV2(real.fetch)
    const key = {key: 'fixture', entityType: 'issue', entityId: '1'} as const
    await createActionClientV2(real).updateSession({sessionId, title: buildSessionTitle(key)})
    const found = await resolveSessionForLogicalKeyV2(reader, box.repo, key, createMockLogger())
    expect(found).toEqual({status: 'found', sessionId})
    expect(await createActionClientV2(real).updateSession({sessionId, archived: true})).toEqual({
      success: true,
      data: undefined,
    })
    expect(await resolveSessionForLogicalKeyV2(reader, box.repo, key, createMockLogger())).toEqual({
      status: 'not-found',
    })

    expect(result.error).toBeNull()
  }, 300_000)

  it('holds the run for a background shell: the final answer arrives after it, and the saved database is consistent', async () => {
    // #given a model that starts a 5 s background shell, ends its turn, then answers once the shell's notice wakes it
    const box = createSandbox()
    sandboxes.push(box)
    const provider = await startScriptedProvider([
      {tool: 'shell', args: {command: `sleep 5 && echo ${SHELL_MARKER}`, background: true}},
      {text: 'The job is running in the background.'},
      {text: 'FINAL: the background job reported done.'},
    ])
    providers.push(provider)
    const real = await startRealServer(box, provider)
    consoleMock.outputTextContent.mockClear()
    const startedAt = Date.now()

    // #when the execute phase runs, and the run is then released the way `run.ts` releases it
    const result = await executePhase(real, box, 120_000)
    const executionMs = Date.now() - startedAt
    const release = await runReleaseV2({
      serverHandle: real,
      executionSucceeded: result.success,
      rootSessionId: result.sessionId,
      ledger: result.ownershipLedger,
      liveObservation: result.liveObservation,
      deferredSummary: result.deferredSummary,
      runStartedAt: startedAt,
      deadlineMs: computeDrainDeadlineMs(120_000, result.executionDurationMs),
      sessionRetention: 50,
      logger: createMockLogger(),
    })

    // #then the run waited for the shell and for the turn its notice started: it did not release on the first idle
    expect(result).toMatchObject({success: true, exitCode: 0})
    expect(executionMs).toBeGreaterThanOrEqual(4_000)
    const shellNoticeSeen = provider.requests.some(
      item => item.raw.includes('<shell id=') && item.raw.includes(SHELL_MARKER),
    )
    expect(shellNoticeSeen).toBe(true)
    expect(JSON.stringify(consoleMock.outputTextContent.mock.calls)).toContain(
      'FINAL: the background job reported done.',
    )
    expect(result.ownershipLedger?.isDrainComplete()).toBe(true)

    // #and the directory was confirmed quiet, nothing is declined, and the server exited
    expect(release.persistenceDeclineReason).toBeUndefined()
    expect(release.drain).toMatchObject({expired: false, unknownCount: 0})
    expect((await real.exited).code).toBe(0)
    expect(processRunning(SHELL_MARKER)).toBe(false)

    // #and the database is consistent once the server is gone: it checkpoints cleanly, passes the integrity check, and
    // no session was left holding an execution claim for the next run to resume
    const dbDir = path.dirname(box.dbPath)
    const checkpoint = await checkpointDatabase({
      dbPath: box.dbPath,
      walPath: path.join(dbDir, 'opencode.db-wal'),
      logger: createMockLogger(),
    })
    expect(checkpoint.status).not.toBe('failed')
    const db = new DatabaseSync(box.dbPath, {readOnly: true})
    try {
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({integrity_check: 'ok'})
    } finally {
      db.close()
    }
    expect(sessionClaims(box.dbPath).every(row => row.suspended === null)).toBe(true)
    expect(sizeOrZero(path.join(dbDir, 'opencode.db-wal'))).toBe(0)
  }, 300_000)

  it('kills a shell the deadline lands on, interrupts the sessions, and the server process exits', async () => {
    // #given a model that starts a long background shell, and an Action deadline that lands while it runs
    const box = createSandbox()
    sandboxes.push(box)
    const longJob = 'sleep 61'
    const provider = await startScriptedProvider([
      {tool: 'shell', args: {command: longJob, background: true}},
      {text: 'The job is running in the background.'},
    ])
    providers.push(provider)
    const real = await startRealServer(box, provider)
    const startedAt = Date.now()

    // #when the execute phase runs into its deadline, and the run is released the way `run.ts` releases it
    const result = await executePhase(real, box, 6_000)
    const runningBeforeRelease = processRunning(longJob)
    const release = await runReleaseV2({
      serverHandle: real,
      executionSucceeded: result.success,
      rootSessionId: result.sessionId,
      ledger: result.ownershipLedger,
      liveObservation: result.liveObservation,
      deferredSummary: result.deferredSummary,
      runStartedAt: startedAt,
      deadlineMs: 0,
      sessionRetention: 50,
      logger: createMockLogger(),
    })

    // #then the run timed out with the shell still running, and the release is a stop, not a drain
    expect(result.success).toBe(false)
    expect(result.exitCode).toBe(130)
    expect(runningBeforeRelease).toBe(true)
    expect(release.drain.expired).toBe(false)

    // #and the shell is gone, the directory was confirmed quiet, and the server process has exited
    expect(processRunning(longJob)).toBe(false)
    expect(release.persistenceDeclineReason).toBeUndefined()
    await real.exited
    expect(() => process.kill(real.pid, 0)).toThrow()

    // #and no session is left claiming an execution the next run would resume
    expect(sessionClaims(box.dbPath).every(row => row.suspended === null)).toBe(true)
  }, 300_000)
})
