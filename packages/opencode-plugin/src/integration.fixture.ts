/** Harness for `integration.test.ts`: a scripted OpenAI-compatible provider and a real `opencode serve --stdio` process. */

import {Buffer} from 'node:buffer'
import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import path from 'node:path'
import process from 'node:process'

const LISTEN_TIMEOUT_MS = 60_000
const EXIT_TIMEOUT_MS = 8_000
const STDERR_KEEP = 64 * 1024

export interface FakeStep {
  /** Every string must appear in the request body. */
  readonly all?: readonly string[]
  /** None of these may appear in the request body. */
  readonly none?: readonly string[]
  readonly text?: string
  readonly reasoning?: string
  readonly tools?: readonly {readonly name: string; readonly args: unknown}[]
  /** Answer with this HTTP status and an error body instead of a stream. */
  readonly status?: number
  /** Wait this long before answering, so a test can act while the request is in flight. */
  readonly delayMs?: number
  /** After the text, stall this long before finishing the stream (cut short when the client goes away). */
  readonly hangMs?: number
  /** Provider-reported prompt, cached and completion token counts. */
  readonly usage?: {readonly prompt: number; readonly cached?: number; readonly completion: number}
}

export interface RecordedRequest {
  readonly body: string
  readonly toolNames: readonly string[]
  readonly messages: readonly {
    readonly role: string
    readonly content: unknown
    readonly tool_call_id?: string
    readonly tool_calls?: readonly {readonly id: string; readonly function: {readonly name: string}}[]
  }[]
}

export interface FakeProvider {
  readonly baseURL: string
  readonly requests: readonly RecordedRequest[]
  readonly script: (steps: readonly FakeStep[]) => void
  readonly stop: () => Promise<void>
}

function sse(delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'fixture-model',
    choices: [{index: 0, delta, finish_reason: finish}],
    ...extra,
  })}\n\n`
}

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export async function startFakeProvider(): Promise<FakeProvider> {
  const queue: FakeStep[] = []
  const requests: RecordedRequest[] = []

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    const gone = {value: false}
    res.on('close', () => {
      gone.value = true
    })
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    const respond = async (): Promise<void> => {
      if (req.url?.endsWith('/models') === true) {
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
        return
      }
      if (req.url?.endsWith('/chat/completions') !== true) {
        res.writeHead(404, {'content-type': 'application/json'})
        res.end(JSON.stringify({error: {message: 'fake: no such route'}}))
        return
      }

      const body = Buffer.concat(chunks).toString('utf8')
      const parsed = JSON.parse(body) as {
        tools?: {function?: {name?: string}}[]
        messages?: RecordedRequest['messages']
      }
      const toolNames = (parsed.tools ?? []).flatMap(tool => (tool.function?.name == null ? [] : [tool.function.name]))
      requests.push({body, toolNames, messages: parsed.messages ?? []})

      // Requests with no tools are title or summary generation; they get the default reply.
      const index =
        toolNames.length === 0
          ? -1
          : queue.findIndex(
              step =>
                (step.all ?? []).every(needle => body.includes(needle)) &&
                (step.none ?? []).every(needle => !body.includes(needle)),
            )
      const step: FakeStep = index === -1 ? {text: 'ok'} : (queue.splice(index, 1)[0] ?? {text: 'ok'})

      if (step.delayMs != null) await sleep(step.delayMs)
      if (step.status != null && step.status !== 200) {
        res.writeHead(step.status, {'content-type': 'application/json'})
        res.end(JSON.stringify({error: {message: `scripted ${step.status}`, type: 'server_error'}}))
        return
      }
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive'})
      res.write(sse({role: 'assistant', content: ''}, null))
      if (step.reasoning != null) res.write(sse({reasoning_content: step.reasoning}, null))
      if (step.text != null) res.write(sse({content: step.text}, null))
      if (step.hangMs != null) {
        for (let waited = 0; waited < step.hangMs && !gone.value; waited += 100) await sleep(100)
        if (gone.value) return
      }
      const usage = {
        usage: {
          prompt_tokens: step.usage?.prompt ?? 10,
          completion_tokens: step.usage?.completion ?? 5,
          total_tokens: (step.usage?.prompt ?? 10) + (step.usage?.completion ?? 5),
          ...(step.usage?.cached == null ? {} : {prompt_tokens_details: {cached_tokens: step.usage.cached}}),
        },
      }
      if (step.tools != null && step.tools.length > 0) {
        step.tools.forEach((tool, i) => {
          const args = typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args)
          res.write(
            sse(
              {
                tool_calls: [
                  {
                    index: i,
                    id: `call_${requests.length}_${i}`,
                    type: 'function',
                    function: {name: tool.name, arguments: args},
                  },
                ],
              },
              null,
            ),
          )
        })
        res.write(sse({}, 'tool_calls', usage))
      } else {
        res.write(sse({}, 'stop', usage))
      }
      res.write('data: [DONE]\n\n')
      res.end()
    }
    req.on('end', () => {
      respond().catch(() => {
        res.destroy()
      })
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('fake provider did not bind a TCP port')

  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    script: steps => {
      queue.push(...steps)
    },
    stop: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface SinkRequest {
  readonly method: string
  readonly path: string
  readonly contentType: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly body: unknown
  /** The raw request body, for walking every string that was sent. */
  readonly text: string
  /** The status this request was answered with. */
  readonly status: number
}

export interface SinkResponse {
  readonly status: number
  readonly headers?: Record<string, string>
  readonly body?: string
  /** Wait this long before answering. */
  readonly delayMs?: number
}

export interface OtlpSink {
  /** The full traces URL, for example `http://127.0.0.1:4318/v1/traces`. */
  readonly url: string
  /** Every request, in arrival order, whatever it was answered with. */
  readonly requests: SinkRequest[]
  /** Requests answered with a status below 300. */
  readonly accepted: () => SinkRequest[]
  /** Most requests that were in flight at once. */
  readonly peakConcurrent: () => number
  readonly stop: () => Promise<void>
}

export interface OtlpSinkOptions {
  /** Decides the answer to request number `n` (from 1). Default: 200 with an empty JSON body. */
  readonly respond?: (n: number, request: Omit<SinkRequest, 'status'>) => SinkResponse
}

/** A loopback OTLP/HTTP collector that records every request and answers as scripted. */
export async function startOtlpSink(options: OtlpSinkOptions = {}): Promise<OtlpSink> {
  const requests: SinkRequest[] = []
  let inFlight = 0
  let peak = 0
  let count = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    inFlight += 1
    peak = Math.max(peak, inFlight)
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // Keep the text.
      }
      count += 1
      const seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        contentType: req.headers['content-type'] ?? '',
        headers: {...req.headers},
        body,
        text,
      }
      const answer = options.respond?.(count, seen) ?? {status: 200, body: '{}'}
      const finish = (): void => {
        requests.push({...seen, status: answer.status})
        res.writeHead(answer.status, {'content-type': 'application/json', ...answer.headers})
        res.end(answer.body ?? '{}')
        inFlight -= 1
      }
      if (answer.delayMs === undefined) finish()
      else setTimeout(finish, answer.delayMs)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('OTLP sink did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}/v1/traces`,
    requests,
    accepted: () => requests.filter(request => request.status < 300),
    peakConcurrent: () => peak,
    stop: async () =>
      new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface RunningServer {
  readonly url: string
  /** What the server wrote to stderr so far (the last 64 KiB). */
  readonly stderr: () => string
  /** Authenticated JSON request. `directory` selects the location. */
  readonly api: (
    method: string,
    pathname: string,
    options?: {readonly body?: unknown; readonly directory?: string},
  ) => Promise<{readonly status: number; readonly data: unknown}>
  readonly stop: () => Promise<void>
}

export interface SandboxPaths {
  readonly root: string
  readonly home: string
  readonly repo: string
}

/** A throwaway HOME and a one-file git-less project directory. The caller removes `root`. */
export function makeSandbox(): SandboxPaths {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'fro-bot-opencode-plugin-it-')))
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  for (const dir of [home, repo, path.join(home, 'config'), path.join(home, 'data'), path.join(home, 'cache')]) {
    mkdirSync(dir, {recursive: true})
  }
  writeFileSync(path.join(repo, 'README.md'), 'plugin integration project\n')
  return {root, home, repo}
}

export function removeSandbox(sandbox: SandboxPaths): void {
  rmSync(sandbox.root, {recursive: true, force: true})
}

export async function startOpenCodeServer(options: {
  readonly binary: string
  readonly sandbox: SandboxPaths
  readonly pluginDir: string
  readonly providerBaseURL: string
  /** Extra server environment, applied last. */
  readonly env?: Readonly<Record<string, string>>
  /** Extra top-level server config (for example `permissions`), merged over the base config. */
  readonly config?: Readonly<Record<string, unknown>>
  /**
   * Start like a local session: no `OPENCODE_PASSWORD` and no `OPENCODE_CONFIG_CONTENT`, with the config in the user's
   * global config file instead. Without it the server always has both headless markers, which this harness needs.
   */
  readonly localMode?: boolean
}): Promise<RunningServer> {
  const {binary, sandbox, pluginDir, providerBaseURL} = options
  const password = randomBytes(24).toString('base64url')
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    provider: {
      fake: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Fake',
        options: {baseURL: providerBaseURL, apiKey: 'fake-key-not-a-credential'},
        models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
      },
    },
    model: 'fake/fixture-model',
    plugins: [pluginDir],
    ...options.config,
  }

  if (options.localMode === true) {
    const configDir = path.join(sandbox.home, 'config', 'opencode')
    mkdirSync(configDir, {recursive: true})
    writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify(config))
  }

  const child = spawn(binary, ['serve', '--stdio', '--port', '0'], {
    cwd: sandbox.repo,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: sandbox.home,
      XDG_CONFIG_HOME: path.join(sandbox.home, 'config'),
      XDG_DATA_HOME: path.join(sandbox.home, 'data'),
      XDG_CACHE_HOME: path.join(sandbox.home, 'cache'),
      XDG_STATE_HOME: path.join(sandbox.home, 'state'),
      TMPDIR: sandbox.root,
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      ...(options.localMode === true
        ? {}
        : {OPENCODE_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config)}),
      ...options.env,
    },
  })

  let stderrText = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrText = (stderrText + chunk.toString('utf8')).slice(-STDERR_KEEP)
  })

  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid != null) process.kill(-child.pid, signal)
    } catch {
      // Already gone.
    }
  }

  const url = await new Promise<string>((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => {
      killGroup('SIGKILL')
      reject(new Error('timed out waiting for the opencode listening line'))
    }, LISTEN_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      for (const line of buffered.split('\n')) {
        try {
          const parsed = JSON.parse(line) as {url?: unknown}
          if (typeof parsed.url === 'string') {
            clearTimeout(timer)
            resolve(parsed.url)
            return
          }
        } catch {
          // Not the JSON line yet.
        }
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`opencode exited before listening (code ${String(code)})`))
    })
  })

  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  return {
    url,
    stderr: () => stderrText,
    api: async (method, pathname, requestOptions = {}) => {
      const response = await fetch(url + pathname, {
        method,
        headers: {
          authorization: auth,
          'content-type': 'application/json',
          'x-opencode-directory': requestOptions.directory ?? sandbox.repo,
        },
        body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
      })
      const text = await response.text()
      let data: unknown = text
      try {
        data = JSON.parse(text)
      } catch {
        // Keep the text.
      }
      return {status: response.status, data}
    },
    stop: async () => {
      child.stdin.end()
      const winner = await Promise.race([
        exited.then(() => 'exited' as const),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), EXIT_TIMEOUT_MS)),
      ])
      if (winner === 'timeout') killGroup('SIGKILL')
      killGroup('SIGKILL') // reap stragglers in the group
      await exited
    },
  }
}
