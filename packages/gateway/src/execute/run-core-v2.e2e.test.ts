/**
 * End-to-end: the V2 run loop against the real stock OpenCode v2.2.0 binary and a scripted provider. Skipped unless
 * `FRO_BOT_OPENCODE_V2_BIN` names the executable.
 *
 * The binary must be the pinned stock release, verified against `packages/runtime/src/shared/opencode-v2-pin.json`
 * (`assets["opencode-darwin-arm64.zip"]` for the zip it came from) before use:
 *
 *   FRO_BOT_OPENCODE_V2_BIN=/path/to/opencode bun run test packages/gateway/src/execute/run-core-v2.e2e
 *
 * One prompt runs through to completion with a Code Mode `execute` call whose inner call raises an approval; the test
 * answers it through the same reply route the gateway uses (`permission-reply-v2.ts`), so a wrong route, a wrong key or
 * a stream that never connects fails here and not in a fixture.
 *
 * Two more runs background a short `shell` job (bgshell probes p20 and p22): one completes after the job's notice and
 * the root turn it wakes, with the job's marker written; the other hits the wall-clock deadline while draining, and the
 * job is killed by `DELETE /api/shell/:id` before it can write its marker.
 *
 * A last group pins fro-bot/agent#1990 against the real server: an operator's Always is kept for the run and never
 * reaches the server's saved-permission store, so the next run on the same directory is asked again.
 */

import type {AddressInfo} from 'node:net'
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {PermissionCoordinator, PermissionRequest} from '../approvals/coordinator.js'

import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {createOwnershipLedger, createRemoteOpenCodeV2Client, startOpenCodeV2Server} from '@fro-bot/runtime'
import {afterAll, describe, expect, it, vi} from 'vitest'

import {createPermissionCoordinator} from '../approvals/coordinator.js'
import {createRunGrants, scopeAlwaysToRun} from '../approvals/run-grants.js'
import {createPostReplyFactoryV2} from './permission-reply-v2.js'
import {makeCoordinator, makeLogger, makeSink} from './run-core-v2.fixture.js'
import {runOpenCodeCoreV2} from './run-core-v2.js'
import {RunCoreError} from './run-core.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BINARY !== undefined && BINARY !== '' && existsSync(BINARY)

const FINAL_TEXT = 'worktree removed, all done'
const SHELL_STARTED_TEXT = 'background job started'
const SHELL_DONE_TEXT = 'background job reported back'
const EXECUTE_CODE =
  "const made = await tools.opencode.worktree_create({name: 'e2e-wt'}); " +
  "const dir = typeof made === 'string' ? JSON.parse(made).directory : made.directory; " +
  'return await tools.opencode.worktree_remove({directory: dir})'
const EXECUTE_CALL = {name: 'execute', args: {code: EXECUTE_CODE}} as const

/** One model turn: a single tool call, or plain text that ends the turn. */
type Turn =
  {readonly tool: {readonly name: string; readonly args: Readonly<Record<string, unknown>>}} | {readonly text: string}

interface ScriptedProvider {
  readonly baseURL: string
  readonly requests: () => number
  readonly stop: () => Promise<void>
}

function sse(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture-model',
    choices: [{index: 0, delta, finish_reason: finish}],
    ...(finish === null ? {} : {usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}),
  })}\n\n`
}

/**
 * Each chat request WITH tools plays the next scripted turn (the last one repeats). A request without tools (a title
 * generation) gets plain text and does not advance the script.
 */
async function startScriptedProvider(turns: readonly Turn[]): Promise<ScriptedProvider> {
  let requests = 0
  let toolRequests = 0
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
        return
      }
      requests += 1
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {tools?: unknown[]}
      const hasTools = (body.tools?.length ?? 0) > 0
      const turn: Turn = hasTools
        ? (turns[Math.min(toolRequests, turns.length - 1)] ?? {text: FINAL_TEXT})
        : {text: FINAL_TEXT}
      if (hasTools) toolRequests += 1
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      res.write(sse({role: 'assistant', content: ''}))
      if ('tool' in turn) {
        res.write(
          sse({
            tool_calls: [
              {
                index: 0,
                id: `call_e2e_${toolRequests}`,
                type: 'function',
                function: {name: turn.tool.name, arguments: JSON.stringify(turn.tool.args)},
              },
            ],
          }),
        )
        res.write(sse({}, 'tool_calls'))
      } else {
        res.write(sse({content: turn.text}))
        res.write(sse({}, 'stop'))
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function createRepo(root: string): string {
  const repo = path.join(root, 'repo')
  mkdirSync(repo, {recursive: true})
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@x',
  }
  writeFileSync(path.join(repo, 'a.txt'), 'hello\n')
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '.'],
    ['commit', '-qm', 'init'],
  ]) {
    execFileSync('git', args, {cwd: repo, env})
  }
  return repo
}

function createEnv(root: string): NodeJS.ProcessEnv {
  const home = path.join(root, 'home')
  const dirs = ['config', 'data', 'cache', 'state', 'tmp'].map(name => {
    const dir = path.join(home, name)
    mkdirSync(dir, {recursive: true})
    return dir
  })
  const [config, data, cache, state, tmp] = dirs
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    TMPDIR: tmp,
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  }
}

const cleanups: (() => Promise<void> | void)[] = []

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

interface StockServer {
  readonly repo: string
  readonly provider: ScriptedProvider
  readonly client: ReturnType<typeof createRemoteOpenCodeV2Client>
  /** The loopback base URL and bearer, for a call the gateway never makes (reading the saved-permission store). */
  readonly baseUrl: string
  readonly authorization: string
}

/**
 * The stock server at a fresh git repo, with a provider that plays the turns `script` returns (it is given the repo path,
 * so a turn can name a file in it) and edits gated behind an approval.
 */
async function startStockServer(
  script: (repo: string) => readonly Turn[],
  permissions: readonly {action: string; resource: string; effect: 'allow' | 'ask' | 'deny'}[] = [
    {action: 'edit', resource: '*', effect: 'ask'},
  ],
): Promise<StockServer> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'run-core-v2-e2e-'))
  cleanups.push(() => rmSync(root, {recursive: true, force: true}))
  const repo = createRepo(root)
  const provider = await startScriptedProvider(script(repo))
  cleanups.push(provider.stop)
  const started = await startOpenCodeV2Server(
    {
      binaryPath: BINARY as string,
      directory: repo,
      expectedPluginIds: [],
      env: createEnv(root),
      timeouts: {agentReadyTimeoutMs: 60_000, pluginGateTimeoutMs: 1500, exitTimeoutMs: 10_000},
      config: {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        provider: {
          fake: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Fake',
            options: {baseURL: provider.baseURL, apiKey: 'fake-e2e-key-not-a-credential'},
            models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
          },
        },
        model: 'fake/fixture-model',
        permissions,
      },
    },
    makeLogger() as never,
  )
  expect(started.success).toBe(true)
  if (!started.success) throw new Error('the stock server did not start')
  const server: OpenCodeV2ServerHandle = started.data
  cleanups.push(async () => {
    await server.shutdown()
  })
  const client = createRemoteOpenCodeV2Client({
    baseUrl: server.url,
    headers: {authorization: server.authorizationHeader()},
  })
  return {repo, provider, client, baseUrl: server.url, authorization: server.authorizationHeader()}
}

/** A coordinator that answers every approval `once` through the same reply route the gateway uses. */
function answeringCoordinator(stock: StockServer): {
  readonly coordinator: PermissionCoordinator
  readonly asked: {requestID: string; permission: string}[]
  readonly replies: string[]
} {
  const postReply = createPostReplyFactoryV2(stock.client)
  const base = makeCoordinator()
  const replies: string[] = []
  const asked: {requestID: string; permission: string}[] = []
  const coordinator: PermissionCoordinator = {
    ...base,
    onPermissionAsked: vi.fn(async (request: PermissionRequest) => {
      asked.push({requestID: request.requestID, permission: request.permission})
      // The same call the Discord decision makes: reply by request id on the asking session.
      const result = await postReply(request.sessionID)(request.requestID, stock.repo, 'once')
      replies.push(result.ok ? 'ok' : (result.error ?? 'failed'))
      return 'once' as const
    }),
  }
  return {coordinator, asked, replies}
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

describe.skipIf(!hasBinary)('runOpenCodeCoreV2 against the real OpenCode v2.2.0 server', () => {
  it('runs a prompt to completion through a Code Mode call and an approval answered by request id', async () => {
    // #given — the stock server at a git repo, a provider that calls `execute` once, edits gated behind an approval
    const stock = await startStockServer(() => [{tool: EXECUTE_CALL}, {text: FINAL_TEXT}])
    const {coordinator, asked, replies} = answeringCoordinator(stock)
    const sink = makeSink()
    const onActivity = vi.fn()

    // #when
    await runOpenCodeCoreV2({
      client: stock.client,
      directory: stock.repo,
      promptText: 'remove the worktree',
      sink,
      signal: AbortSignal.timeout(90_000),
      logger: makeLogger(),
      coordinator,
      onActivity,
      inactivityTimeoutMs: 60_000,
      streamSilenceTimeoutMs: 45_000,
    })

    // #then — completed with one reply that carries the model's text, the approval was raised once and answered ok
    expect(sink.text()).toContain(FINAL_TEXT)
    expect(asked).toHaveLength(1)
    expect(replies).toEqual(['ok'])
    expect(onActivity).toHaveBeenCalledWith(expect.stringContaining('worktree'))
    expect(stock.provider.requests()).toBeGreaterThanOrEqual(2)
  }, 120_000)

  it('waits for a backgrounded shell, completes after its notice and the root turn it wakes, with its marker written', async () => {
    // #given — the model backgrounds a 3 s job that writes a marker, then ends its turn; the notice wakes it again
    let marker = ''
    const stock = await startStockServer(repo => {
      marker = path.join(repo, 'bg-marker.txt')
      return [
        {tool: {name: 'shell', args: {command: `sleep 3 && touch ${marker}`, background: true}}},
        {text: SHELL_STARTED_TEXT},
        {text: SHELL_DONE_TEXT},
      ]
    })
    const ledger = createOwnershipLedger()
    const {coordinator} = answeringCoordinator(stock)
    const sink = makeSink()

    // #when
    await runOpenCodeCoreV2({
      client: stock.client,
      directory: stock.repo,
      promptText: 'run the background job',
      sink,
      signal: AbortSignal.timeout(90_000),
      logger: makeLogger(),
      coordinator,
      ownershipLedger: ledger,
      inactivityTimeoutMs: 60_000,
      streamSilenceTimeoutMs: 45_000,
    })

    // #then — the run did not end on the first idle: the job finished, its marker is on disk, and the woken turn spoke
    expect(existsSync(marker)).toBe(true)
    expect(sink.text()).toContain(SHELL_STARTED_TEXT)
    expect(sink.text()).toContain(SHELL_DONE_TEXT)
    expect(ledger.snapshot().map(entry => [entry.sessionId.startsWith('shell:sh_'), entry.state])).toEqual([
      [true, 'settled'],
    ])
    expect(await stock.client.listShells({directory: stock.repo})).toEqual({success: true, data: []})
  }, 120_000)

  it('kills the backgrounded shell at the wall-clock deadline: no marker is written', async () => {
    // #given — an 8 s job and a 4 s deadline
    let marker = ''
    const stock = await startStockServer(repo => {
      marker = path.join(repo, 'bg-marker.txt')
      return [
        {tool: {name: 'shell', args: {command: `sleep 8 && touch ${marker}`, background: true}}},
        {text: SHELL_STARTED_TEXT},
        {text: SHELL_DONE_TEXT},
      ]
    })
    const ledger = createOwnershipLedger()
    const {coordinator} = answeringCoordinator(stock)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 4_000)

    // #when
    const outcome = await runOpenCodeCoreV2({
      client: stock.client,
      directory: stock.repo,
      promptText: 'run the background job',
      sink: makeSink(),
      signal: controller.signal,
      logger: makeLogger(),
      coordinator,
      ownershipLedger: ledger,
    }).then(
      () => null,
      (error: unknown) => error,
    )
    clearTimeout(deadline)

    // #then — a drain that ran out of time. The kill's error notice woke the root; the stop interrupted it and the
    // directory then stayed quiet for the whole window, so the stop is confirmed and the run is not quarantined.
    expect(outcome).toBeInstanceOf(RunCoreError)
    expect((outcome as RunCoreError).kind).toBe('drain-timeout')
    expect((outcome as RunCoreError).quarantined).toBe(false)
    expect(await stock.client.listShells({directory: stock.repo})).toEqual({success: true, data: []})

    // #when — long enough for the job to have finished had it been left alone
    await sleep(8_000)

    // #then
    expect(existsSync(marker)).toBe(false)
  }, 120_000)
})

const RM_PERMISSIONS = [{action: 'shell', resource: '*', effect: 'ask'}] as const

/* eslint-disable no-void */
/** A run's coordinator wired as `run.ts` wires it, with an operator who answers every approval with `decision`. */
function operatedRun(stock: StockServer, runId: string, decision: 'always' | 'once') {
  const logger = makeLogger()
  const grants = createRunGrants({logger, runId})
  const upstream = createPostReplyFactoryV2(stock.client)
  const operatorPost = scopeAlwaysToRun(upstream, grants)
  const asked: {requestID: string; permission: string; patterns: readonly string[]; save: readonly string[]}[] = []
  const autoAnswered: string[] = []
  const operatorReplies: string[] = []
  const coordinator = createPermissionCoordinator({
    logger,
    runGrants: {
      grants,
      runId,
      answer: async (request, decision) => {
        autoAnswered.push(request.requestID)
        return upstream(request.sessionID)(request.requestID, stock.repo, decision)
      },
    },
    onPending: request => {
      asked.push({
        requestID: request.requestID,
        permission: request.permission,
        patterns: request.patterns,
        save: request.alwaysPatterns ?? [],
      })
      // The operator surface: reply by request id on the asking session, through the scoped factory.
      void operatorPost(request.sessionID)(request.requestID, stock.repo, decision).then(result => {
        operatorReplies.push(result.ok ? 'ok' : (result.error ?? 'failed'))
      })
    },
  })
  return {coordinator, grants, asked, autoAnswered, operatorReplies}
}

async function savedPermissions(stock: StockServer): Promise<unknown[]> {
  // The project id is the session's own (the repo root commit), as the saved store keys it.
  const sessions = await fetch(`${stock.baseUrl}/api/session?directory=${encodeURIComponent(stock.repo)}`, {
    headers: {authorization: stock.authorization},
  })
  const body = (await sessions.json()) as {data?: {projectID?: string}[]}
  const projectID = body.data?.find(session => typeof session.projectID === 'string')?.projectID
  const url = new URL(`${stock.baseUrl}/api/permission/saved`)
  url.searchParams.set('directory', stock.repo)
  expect(projectID).toEqual(expect.any(String))
  url.searchParams.set('projectID', projectID as string)
  const response = await fetch(url, {headers: {authorization: stock.authorization}})
  expect(response.status).toBe(200)
  const saved = (await response.json()) as {data: unknown[]}
  return saved.data
}

describe.skipIf(!hasBinary)('an operator Always against the real OpenCode v2.2.0 server (#1990)', () => {
  it('answers the same run’s later rm itself, saves nothing upstream, and asks again in the next run', async () => {
    // #given — three files, a provider that removes a, then b (run B), then c (run C), edits and shell gated
    const files: Record<'a' | 'b' | 'c', string> = {a: '', b: '', c: ''}
    const stock = await startStockServer(repo => {
      for (const name of ['a', 'b', 'c'] as const) {
        files[name] = path.join(repo, `victim-${name}.txt`)
        writeFileSync(files[name], name)
      }
      return [
        {tool: {name: 'shell', args: {command: `rm ${files.a}`}}},
        {tool: {name: 'shell', args: {command: `rm ${files.b}`}}},
        {text: 'run B done'},
        {tool: {name: 'shell', args: {command: `rm ${files.c}`}}},
        {text: 'run C done'},
      ]
    }, RM_PERMISSIONS)
    const common = {client: stock.client, directory: stock.repo, logger: makeLogger()}

    // #when — run B: the operator picks Always on `rm` of file a
    const runB = operatedRun(stock, 'run_b', 'always')
    const sinkB = makeSink()
    await runOpenCodeCoreV2({
      ...common,
      promptText: 'remove a and b',
      sink: sinkB,
      signal: AbortSignal.timeout(90_000),
      coordinator: runB.coordinator,
      inactivityTimeoutMs: 60_000,
      streamSilenceTimeoutMs: 45_000,
    })

    // #then — the second rm in the same run was answered by the gateway, with once, and succeeded
    expect(sinkB.text()).toContain('run B done')
    expect(runB.asked).toHaveLength(1)
    expect(runB.asked[0]?.permission).toBe('bash')
    expect(runB.asked[0]?.save.length).toBeGreaterThan(0)
    expect(runB.operatorReplies).toEqual(['ok'])
    expect(runB.autoAnswered).toHaveLength(1)
    expect(existsSync(files.a)).toBe(false)
    expect(existsSync(files.b)).toBe(false)

    // #when — run B ends the way run.ts ends it
    runB.coordinator.dispose('run ended')
    runB.grants.drop()

    // #then — the server stored no grant for the project, so nothing can leak to another run
    expect(await savedPermissions(stock)).toEqual([])

    // #when — run C, a new session on the same directory, tries `rm` of file c
    const runC = operatedRun(stock, 'run_c', 'once')
    const sinkC = makeSink()
    await runOpenCodeCoreV2({
      ...common,
      promptText: 'remove c',
      sink: sinkC,
      signal: AbortSignal.timeout(90_000),
      coordinator: runC.coordinator,
      inactivityTimeoutMs: 60_000,
      streamSilenceTimeoutMs: 45_000,
    })

    // #then — it is asked again, as if Always had never been picked, and only then does the rm run
    expect(runC.asked).toHaveLength(1)
    expect(runC.asked[0]).toMatchObject({permission: 'bash'})
    expect(runC.autoAnswered).toEqual([])
    expect(existsSync(files.c)).toBe(false)
    expect(await savedPermissions(stock)).toEqual([])
  }, 180_000)

  it('control: an always sent upstream does persist a project-wide grant, which is what #1990 reported', async () => {
    // #given — the same script, but the operator's Always goes to the server unchanged
    let victims: string[] = []
    const stock = await startStockServer(repo => {
      victims = ['a', 'b'].map(name => path.join(repo, `control-${name}.txt`))
      for (const victim of victims) writeFileSync(victim, 'x')
      return [
        {tool: {name: 'shell', args: {command: `rm ${victims[0]}`}}},
        {tool: {name: 'shell', args: {command: `rm ${victims[1]}`}}},
        {text: 'control done'},
      ]
    }, RM_PERMISSIONS)
    const asked: string[] = []
    const coordinator = createPermissionCoordinator({
      logger: makeLogger(),
      onPending: request => {
        asked.push(request.requestID)
        void stock.client.replyPermission({
          sessionId: request.sessionID,
          requestId: request.requestID,
          decision: 'always',
        })
      },
    })

    // #when
    await runOpenCodeCoreV2({
      client: stock.client,
      directory: stock.repo,
      logger: makeLogger(),
      promptText: 'remove both',
      sink: makeSink(),
      signal: AbortSignal.timeout(90_000),
      coordinator,
      inactivityTimeoutMs: 60_000,
      streamSilenceTimeoutMs: 45_000,
    })

    // #then — upstream answered the second rm on its own, and kept a row any later run in the project matches
    expect(asked).toHaveLength(1)
    expect(await savedPermissions(stock)).not.toEqual([])
  }, 180_000)
})
/* eslint-enable no-void */
