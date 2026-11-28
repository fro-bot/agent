/**
 * Real-binary check of the isolated agent's temp directory (fro-bot/agent#2404): the CI permission rules built with
 * `agentTmpDirectory` must let the real `write` and `shell` tools create a file in that directory, while a sibling
 * directory (and the parent) stay refused.
 *
 * Runs only when `FRO_BOT_OPENCODE_V2_BIN` names the stock OpenCode binary pinned in
 * `packages/runtime/src/shared/opencode-v2-pin.json` (see `ci-config-v2.integration.test.ts`). The model is a local
 * OpenAI-compatible stub that issues the tool calls; nothing leaves the machine.
 */
import type {AddressInfo} from 'node:net'
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import {ACTION_TRACING_OFF, startOpenCodeV2Server} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import pin from '../../../packages/runtime/src/shared/opencode-v2-pin.json'
import {createMockLogger} from '../../shared/test-helpers.js'
import {buildCIConfigV2} from './ci-config-v2.js'

const BIN = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BIN !== undefined && BIN !== '' && fs.existsSync(BIN)

interface ScriptStep {
  readonly tool: string
  readonly args: Record<string, unknown>
}

interface Provider {
  readonly baseURL: string
  /** The raw body of every tool-offering request, in order. */
  readonly turns: string[]
  readonly stop: () => Promise<void>
}

function sse(res: http.ServerResponse, delta: Record<string, unknown>, finish: string | null): void {
  res.write(
    `data: ${JSON.stringify({
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{index: 0, delta, finish_reason: finish}],
      ...(finish === null ? {} : {usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}}),
    })}\n\n`,
  )
}

/** A scripted OpenAI-compatible model: tool-offering requests walk `script`, then answer `done`. A request with no tools is the title. */
async function startScriptedProvider(script: readonly ScriptStep[]): Promise<Provider> {
  const turns: string[] = []
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
      const parsed = JSON.parse(raw) as {tools?: unknown[]}
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      sse(res, {role: 'assistant', content: ''}, null)
      if ((parsed.tools ?? []).length > 0) {
        const step = script[turns.length]
        turns.push(raw)
        if (step === undefined) {
          sse(res, {content: 'done'}, null)
          sse(res, {}, 'stop')
        } else {
          const call = {
            index: 0,
            id: `call_${turns.length}`,
            type: 'function',
            function: {name: step.tool, arguments: JSON.stringify(step.args)},
          }
          sse(res, {tool_calls: [call]}, null)
          sse(res, {}, 'tool_calls')
        }
      } else {
        sse(res, {content: 'Fixture title'}, null)
        sse(res, {}, 'stop')
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    turns,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return predicate()
}

describe.skipIf(!hasBinary)('isolated agent temp directory (real binary, fro-bot/agent#2404)', () => {
  let root = ''
  let scratch = ''
  let sibling = ''
  let provider: Provider
  let scriptLength = 0
  let handle: OpenCodeV2ServerHandle

  beforeAll(async () => {
    const reported = execFileSync(BIN as string, ['--version'], {encoding: 'utf8'}).trim()
    if (reported !== `opencode v${pin.version}`) {
      throw new Error(`FRO_BOT_OPENCODE_V2_BIN reports ${reported}, expected opencode v${pin.version}`)
    }

    // The realpath keeps the rule and the path the tool resolves the same string on a platform whose temp root is a link.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fro-bot-tmpdir-')))
    const home = path.join(root, 'home')
    const checkout = path.join(root, 'checkout')
    const runnerTemp = path.join(root, 'runner-temp')
    // Stands for the sandbox account's `~/tmp`, with a sibling whose name only differs after the same prefix.
    scratch = path.join(root, 'agent-tmp')
    sibling = path.join(root, 'agent-tmp-sibling')
    for (const dir of [home, checkout, runnerTemp, scratch, sibling]) fs.mkdirSync(dir, {recursive: true})
    execFileSync('git', ['init', '-q', '-b', 'main', checkout])
    fs.writeFileSync(path.join(checkout, 'a.txt'), 'hello\n')

    const built = buildCIConfigV2(
      {
        opencodeConfig: null,
        plugins: [],
        runnerTemp,
        runId: 2404,
        runAttempt: 1,
        credential: 'provision',
        agentTmpDirectory: scratch,
      },
      createMockLogger(),
    )
    if (!built.success) throw new Error(built.error)

    // The shell tool's external-directory check covers its working directory and a `cd`, so each case names one.
    const script: readonly ScriptStep[] = [
      {tool: 'write', args: {path: path.join(scratch, 'via-write.txt'), content: 'written'}},
      {tool: 'write', args: {path: path.join(sibling, 'via-write.txt'), content: 'refused'}},
      {tool: 'shell', args: {command: 'touch via-workdir.txt', workdir: scratch}},
      {tool: 'shell', args: {command: 'touch via-workdir.txt', workdir: sibling}},
      {tool: 'shell', args: {command: `cd ${scratch} && touch via-cd.txt`}},
      {tool: 'shell', args: {command: `cd ${sibling} && touch via-cd.txt`}},
      {tool: 'write', args: {path: path.join(root, 'parent.txt'), content: 'refused'}},
    ]
    scriptLength = script.length
    provider = await startScriptedProvider(script)

    const [config, data, cache, state] = ['config', 'data', 'cache', 'state'].map(name => {
      const dir = path.join(home, name)
      fs.mkdirSync(dir, {recursive: true})
      return dir
    }) as [string, string, string, string]
    const started = await startOpenCodeV2Server(
      {
        binaryPath: BIN as string,
        directory: checkout,
        expectedPluginIds: [],
        tracingHost: ACTION_TRACING_OFF,
        // The isolated agent's environment: its temp directory is the scratch directory.
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: config,
          XDG_DATA_HOME: data,
          XDG_CACHE_HOME: cache,
          XDG_STATE_HOME: state,
          TMPDIR: scratch,
          OPENCODE_DISABLE_MODELS_FETCH: '1',
        },
        config: {
          share: 'disabled',
          provider: {
            fake: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Fake',
              options: {baseURL: provider.baseURL, apiKey: 'fake-integration-key-not-a-credential'},
              models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
            },
          },
          model: 'fake/fixture-model',
          ...built.data.content,
        },
        timeouts: {agentReadyTimeoutMs: 90_000, pluginGateTimeoutMs: 1500, exitTimeoutMs: 10_000},
      },
      createMockLogger(),
    )
    if (!started.success) throw new Error(`server start failed: ${started.error.kind}: ${started.error.message}`)
    handle = started.data

    const created = (await (
      await handle.fetch('/api/session', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({location: {directory: checkout}}),
      })
    ).json()) as {data: {id: string}}
    const prompted = await handle.fetch(`/api/session/${created.data.id}/prompt`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'Write the scratch files.'}),
    })
    if (prompted.status >= 300) throw new Error(`prompt failed: HTTP ${prompted.status}`)
    // Every tool call has run once the model is asked for the turn after the last one.
    const finished = await waitFor(() => provider.turns.length > scriptLength, 90_000)
    if (!finished) throw new Error(`the scripted turn stalled after ${provider.turns.length} model requests`)
  }, 180_000)

  afterAll(async () => {
    if (handle !== undefined) await handle.shutdown()
    if (provider !== undefined) await provider.stop()
    fs.rmSync(root, {recursive: true, force: true})
  }, 60_000)

  it('creates a file in the scratch directory through `write`', () => {
    expect(fs.readFileSync(path.join(scratch, 'via-write.txt'), 'utf8')).toBe('written')
  })

  it('creates a file in the scratch directory through `shell`, by working directory and by `cd`', () => {
    expect(fs.existsSync(path.join(scratch, 'via-workdir.txt'))).toBe(true)
    expect(fs.existsSync(path.join(scratch, 'via-cd.txt'))).toBe(true)
  })

  it('refuses a sibling of the scratch directory for `write` and for `shell`', () => {
    expect(fs.existsSync(path.join(sibling, 'via-write.txt'))).toBe(false)
    expect(fs.existsSync(path.join(sibling, 'via-workdir.txt'))).toBe(false)
    expect(fs.existsSync(path.join(sibling, 'via-cd.txt'))).toBe(false)
  })

  it('refuses the scratch directory`s parent', () => {
    expect(fs.existsSync(path.join(root, 'parent.txt'))).toBe(false)
  })

  it('reports each of the four refusals to the model as an external-directory denial', () => {
    // The request after the last tool call carries every tool result.
    const history = provider.turns.at(-1) ?? ''
    expect(history.match(/external_directory/g)?.length ?? 0).toBe(4)
  })
})
