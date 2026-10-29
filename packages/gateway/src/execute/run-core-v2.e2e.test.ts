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
import {createRemoteOpenCodeV2Client, startOpenCodeV2Server} from '@fro-bot/runtime'
import {afterAll, describe, expect, it, vi} from 'vitest'

import {createPostReplyFactoryV2} from './permission-reply-v2.js'
import {makeCoordinator, makeLogger, makeSink} from './run-core-v2.fixture.js'
import {runOpenCodeCoreV2} from './run-core-v2.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BINARY !== undefined && BINARY !== '' && existsSync(BINARY)

const FINAL_TEXT = 'worktree removed, all done'
const EXECUTE_CODE =
  "const made = await tools.opencode.worktree_create({name: 'e2e-wt'}); " +
  "const dir = typeof made === 'string' ? JSON.parse(made).directory : made.directory; " +
  'return await tools.opencode.worktree_remove({directory: dir})'

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

/** First chat request with tools: one `execute` call. Every later one: the final text. */
async function startScriptedProvider(): Promise<ScriptedProvider> {
  let requests = 0
  let toolTurnSent = false
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
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      res.write(sse({role: 'assistant', content: ''}))
      if (hasTools && !toolTurnSent) {
        toolTurnSent = true
        res.write(
          sse({
            tool_calls: [
              {
                index: 0,
                id: 'call_e2e_0',
                type: 'function',
                function: {name: 'execute', arguments: JSON.stringify({code: EXECUTE_CODE})},
              },
            ],
          }),
        )
        res.write(sse({}, 'tool_calls'))
      } else {
        res.write(sse({content: FINAL_TEXT}))
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

describe.skipIf(!hasBinary)('runOpenCodeCoreV2 against the real OpenCode v2.2.0 server', () => {
  it('runs a prompt to completion through a Code Mode call and an approval answered by request id', async () => {
    // #given — the stock server at a git repo, a provider that calls `execute` once, edits gated behind an approval
    const root = mkdtempSync(path.join(os.tmpdir(), 'run-core-v2-e2e-'))
    cleanups.push(() => rmSync(root, {recursive: true, force: true}))
    const repo = createRepo(root)
    const provider = await startScriptedProvider()
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
          permissions: [{action: 'edit', resource: '*', effect: 'ask'}],
        },
      },
      makeLogger() as never,
    )
    expect(started.success).toBe(true)
    if (!started.success) return
    const server: OpenCodeV2ServerHandle = started.data
    cleanups.push(async () => {
      await server.shutdown()
    })

    const client = createRemoteOpenCodeV2Client({
      baseUrl: server.url,
      headers: {authorization: server.authorizationHeader()},
    })
    const postReply = createPostReplyFactoryV2(client)
    const base = makeCoordinator()
    const replies: string[] = []
    const asked: {requestID: string; permission: string}[] = []
    const coordinator: PermissionCoordinator = {
      ...base,
      onPermissionAsked: vi.fn(async (request: PermissionRequest) => {
        asked.push({requestID: request.requestID, permission: request.permission})
        // The same call the Discord decision makes: reply by request id on the asking session.
        const result = await postReply(request.sessionID)(request.requestID, repo, 'once')
        replies.push(result.ok ? 'ok' : (result.error ?? 'failed'))
        return 'once' as const
      }),
    }
    const sink = makeSink()
    const onActivity = vi.fn()

    // #when
    await runOpenCodeCoreV2({
      client,
      directory: repo,
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
    expect(provider.requests()).toBeGreaterThanOrEqual(2)
  }, 120_000)
})
