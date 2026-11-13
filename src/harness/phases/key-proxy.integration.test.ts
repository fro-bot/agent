/**
 * Real-binary check of the key proxy: the stock OpenCode V2 server is configured the way an `isolate-agent` run configures
 * it (a loopback `baseURL` and a placeholder key) and sends real model requests through a real proxy child to a recording
 * HTTPS upstream. It pins the route table to what the pinned binary sends.
 *
 * Runs only when `FRO_BOT_OPENCODE_V2_BIN` names the stock OpenCode binary pinned in
 * `packages/runtime/src/shared/opencode-v2-pin.json` (see `v2-server.integration.test.ts` for how to fetch and verify it)
 * and `bun` and `openssl` are on the PATH. Nothing leaves the machine: the upstream is a loopback server.
 */

import type {KeyProxyProcess} from './key-proxy-process.js'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {startOpenCodeV2Server, type OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import {startTlsUpstream, type TlsUpstream} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
import {createMockLogger, unwrapOk} from '../../shared/test-helpers.js'
import {probeKeyProxy} from './key-proxy-probe.js'
import {startKeyProxyProcess} from './key-proxy-process.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const BUN = ((): string | null => {
  try {
    return execFileSync('which', ['bun'], {encoding: 'utf8'}).trim() || null
  } catch {
    return null
  }
})()
const enabled = BINARY !== undefined && BINARY !== '' && existsSync(BINARY) && BUN !== null
const SOURCE_ENTRY = fileURLToPath(new URL('../../../apps/action/src/key-proxy.ts', import.meta.url))

const REAL_KEY = 'sk-real-binary-canary-9c1d'

describe.skipIf(!enabled)('the key proxy against the real OpenCode V2 binary', () => {
  let tmp = ''
  let upstream: TlsUpstream
  let proxy: KeyProxyProcess
  let modelsStatus = 200

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'key-proxy-real-'))
    // A 400 is a final answer for the model but exercises the proxy's error-body path; the client retries a few times.
    upstream = await startTlsUpstream((request, res) => {
      if (request.method === 'GET' && request.url?.endsWith('/models') === true) {
        res.writeHead(modelsStatus, {'content-type': 'application/json'})
        res.end(JSON.stringify({error: {message: `echo ${REAL_KEY}`}}))
        return
      }
      res.writeHead(400, {'content-type': 'application/json'})
      res.end(JSON.stringify({error: {message: `echo ${REAL_KEY}`, type: 'invalid_request_error'}}))
    })
    const started = await startKeyProxyProcess({
      providers: [
        {providerId: 'anthropic', key: REAL_KEY, baseUrl: upstream.origin, protocols: ['anthropic-messages']},
        {providerId: 'claude-gw', key: REAL_KEY, baseUrl: upstream.origin, protocols: ['anthropic-messages']},
        {providerId: 'cliproxy', key: REAL_KEY, baseUrl: `${upstream.origin}/v1`, protocols: ['openai-chat']},
        {providerId: 'openai', key: REAL_KEY, baseUrl: `${upstream.origin}/v1`, protocols: ['openai-responses']},
      ],
      logger: createMockLogger(),
      launcher: {command: BUN ?? '', args: [SOURCE_ENTRY]},
      testing: {upstreamCa: upstream.ca},
    })
    proxy = unwrapOk(started)
  }, 180_000)

  afterAll(async () => {
    await proxy?.stop()
    await upstream?.close()
    if (tmp !== '') rmSync(tmp, {recursive: true, force: true})
  })

  /** Starts a throwaway server, sends one prompt and returns what the upstream saw in the meantime. */
  async function requestsFor(options: {
    readonly model: string
    readonly providerId: string
    readonly npm?: string
    readonly modelId?: string
  }) {
    upstream.requests.length = 0
    const home = path.join(tmp, options.providerId)
    const workspace = path.join(home, 'ws')
    mkdirSync(workspace, {recursive: true})
    const provider = {
      options: {baseURL: proxy.baseUrl(options.providerId), apiKey: proxy.placeholder},
      ...(options.npm === undefined || options.modelId === undefined
        ? {}
        : {
            npm: options.npm,
            name: options.providerId,
            models: {[options.modelId]: {name: 'm', tool_call: true, limit: {context: 100_000, output: 8000}}},
          }),
    }
    const started = await startOpenCodeV2Server(
      {
        binaryPath: BINARY ?? '',
        directory: workspace,
        expectedPluginIds: [],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_DATA_HOME: path.join(home, 'data'),
          XDG_CONFIG_HOME: path.join(home, 'config'),
          XDG_CACHE_HOME: path.join(home, 'cache'),
          XDG_STATE_HOME: path.join(home, 'state'),
        },
        config: {
          share: 'disabled',
          model: options.model,
          plugins: [],
          provider: {[options.providerId]: provider},
          permission: {question: 'deny'},
        },
      },
      createMockLogger(),
    )
    const handle: OpenCodeV2ServerHandle = unwrapOk(started)
    try {
      const created = (await (
        await handle.fetch('/api/session', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({location: {directory: workspace}}),
        })
      ).json()) as {data: {id: string}}
      handle.registerOwnedSession(created.data.id)
      await handle.fetch(`/api/session/${created.data.id}/prompt`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({text: 'hi'}),
      })
      await vi.waitFor(
        () => {
          expect(upstream.requests.length).toBeGreaterThan(0)
        },
        {timeout: 30_000, interval: 250},
      )
      return [...upstream.requests]
    } finally {
      await handle.shutdown()
    }
  }

  it('sends the anthropic provider id to /messages?beta=true and the proxy carries it upstream with the real key', async () => {
    const requests = await requestsFor({model: 'anthropic/claude-sonnet-4-5', providerId: 'anthropic'})

    for (const request of requests) {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/messages?beta=true')
      expect(request.headers['x-api-key']).toBe(REAL_KEY)
      expect(request.headers['anthropic-version']).toBeDefined()
      expect(JSON.stringify(request.headers)).not.toContain(proxy.placeholder)
    }
  }, 180_000)

  it('sends another Anthropic-package provider id to /messages with no query', async () => {
    const requests = await requestsFor({
      model: 'claude-gw/m1',
      providerId: 'claude-gw',
      npm: '@ai-sdk/anthropic',
      modelId: 'm1',
    })

    for (const request of requests) {
      expect(request.url).toBe('/messages')
      expect(request.headers['x-api-key']).toBe(REAL_KEY)
    }
  }, 180_000)

  it('sends an openai-compatible provider to /chat/completions with a Bearer key', async () => {
    const requests = await requestsFor({
      model: 'cliproxy/m1',
      providerId: 'cliproxy',
      npm: '@ai-sdk/openai-compatible',
      modelId: 'm1',
    })

    for (const request of requests) {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/v1/chat/completions')
      expect(request.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
      expect(JSON.stringify(request.headers)).not.toContain(proxy.placeholder)
    }
  }, 180_000)

  it('serves the openai Responses protocol past the WebSocket upgrade probe', async () => {
    // The built-in provider: a custom `npm` package would be installed from the registry at start.
    const requests = await requestsFor({model: 'openai/gpt-5', providerId: 'openai'})

    // The client may try a WebSocket upgrade first; the proxy answers that locally, so only the POST reaches the upstream.
    for (const request of requests) {
      expect(request.method).toBe('POST')
      expect(request.url).toBe('/v1/responses')
      expect(request.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
    }
  }, 180_000)

  it.each([
    [200, 'passed'],
    [401, 'failed'],
    [403, 'warned'],
    [429, 'warned'],
  ] as const)(
    'probes the models route through the real proxy: upstream %i is %s',
    async (status, expected) => {
      modelsStatus = status
      upstream.requests.length = 0

      const result = await probeKeyProxy({
        plan: {providerId: 'cliproxy', baseUrl: `${upstream.origin}/v1`, protocols: ['openai-chat']},
        proxy: {baseUrl: proxy.baseUrl, placeholder: proxy.placeholder},
        logger: createMockLogger(),
      })

      expect(result.status).toBe(expected)
      expect(upstream.requests).toHaveLength(1)
      expect(upstream.requests[0]?.url).toBe('/v1/models')
      expect(upstream.requests[0]?.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
      expect(JSON.stringify(result)).not.toContain(REAL_KEY)
    },
    30_000,
  )
})
