import type {Server} from 'node:http'
/**
 * Shared pieces for the real-runner `isolate-agent` suite (`v2-server.sandbox.integration.test.ts`): a scripted fake
 * OpenAI-compatible provider that makes the real OpenCode server run one `bash` tool call per probe, and the helper that
 * starts the server as the sandbox user and drives one turn. Nothing here is product code and nothing here runs outside
 * that suite.
 */
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {SandboxLifecycle} from './sandbox-lifecycle.js'
import {Buffer} from 'node:buffer'
import http from 'node:http'
import {DatabaseSync} from 'node:sqlite'
import {startOpenCodeV2Server} from '@fro-bot/runtime'

export const PRELUDE = String.raw`R(){ echo "RESULT $1 $2 $3"; }; ev(){ head -c 240 | tr '\n\r\t' '   '; }; `
export const q = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`

const SAFE_ABSOLUTE_PATH = /^\/[\w@%+=:,./-]+$/
const SAFE_TOKEN = /^[\w.-]+$/

/**
 * An environment-derived path that is about to be embedded in a shell command string. Only a plain absolute path with no
 * parent segment is accepted; anything else (unset, relative, or carrying shell metacharacters) yields `fallback`, so a
 * hostile environment cannot change what the command does.
 */
export function safeEnvPath(value: string | undefined, fallback: string): string {
  return value !== undefined && SAFE_ABSOLUTE_PATH.test(value) && !value.split('/').includes('..') ? value : fallback
}

/** Same idea for an environment-derived token: word characters, dots and dashes only. */
export function safeEnvToken(value: string | undefined, fallback: string): string {
  return value !== undefined && SAFE_TOKEN.test(value) ? value : fallback
}

/**
 * The ids of the sessions in a V2 database. V2 keeps them in `session_v2` (there is no `session` table in 2.2.x); if that
 * table is missing the error lists the tables that exist, so a schema change names itself instead of reading as a test bug.
 */
export function readSessionIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath)
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(row => String((row as {name: unknown}).name))
    if (!tables.includes('session_v2')) {
      throw new Error(`${dbPath} has no session_v2 table; tables: ${tables.join(', ')}`)
    }
    return db
      .prepare('SELECT id FROM session_v2 ORDER BY id')
      .all()
      .map(row => String((row as {id: unknown}).id))
  } finally {
    db.close()
  }
}

/** One line for an assertion: `ok`, or why a reconstruction was refused, so a CI failure names the reason. */
export function describeReconstruction(
  result:
    | {readonly success: true; readonly data: {readonly kind: string}}
    | {readonly success: false; readonly error: Error}
    | undefined,
): string {
  if (result === undefined) return 'reconstruction did not run'
  if (!result.success) return `reconstruction failed: ${result.error.message}`
  return result.data.kind === 'changes' ? 'ok' : `reconstruction returned kind ${result.data.kind}`
}

export interface Probe {
  readonly id: string
  readonly category: 'blocked' | 'works' | 'info'
  readonly cmd: string
  /** Run the same command as the runner and require OPEN. */
  readonly control?: boolean
}

export interface Row {
  readonly status: string
  readonly evidence: string
}

export function parseRows(text: string): Map<string, Row[]> {
  const rows = new Map<string, Row[]>()
  for (const match of text.matchAll(/RESULT ([a-z0-9_]+) (BLOCKED|OPEN|WORKS|FAILED|INFO) ([^\n"]*)/g)) {
    const [, id, status, evidence] = match
    if (id === undefined || status === undefined) continue
    rows.set(id, [...(rows.get(id) ?? []), {status, evidence: (evidence ?? '').trim()}])
  }
  return rows
}

/** `BLOCKED` when the command could not read `file`; `OPEN` when it could. Read-only so a control cannot corrupt state. */
export const readProbe = (id: string, file: string): string =>
  `f=${q(file)}; o=$( { cat "$f" >/dev/null; } 2>&1 ); rc=$?; ` +
  `if [ $rc -ne 0 ]; then R ${id} BLOCKED "rc=$rc [$(printf %s "$o" | ev)]"; else R ${id} OPEN "readable"; fi`

/** Rows of probe `id` that are missing or not `expected`; empty means the probe came out as expected. */
export function failuresFor(rows: ReadonlyMap<string, readonly Row[]>, id: string, expected: string): string[] {
  const found = rows.get(id)
  if (found === undefined || found.length === 0) return [`${id}: no result`]
  return found.filter(row => row.status !== expected).map(row => `${id}: ${row.status} ${row.evidence}`)
}

export interface ScriptedProvider {
  readonly port: number
  /** Raw tool results in call order; `done` flips once the script has been exhausted. */
  readonly state: {readonly results: string[]; done: boolean}
  readonly close: () => Promise<void>
}

/**
 * A local OpenAI-compatible provider. For a request that carries tools it answers with the next probe as one `bash` tool
 * call (the server runs it in its real tool shell as the sandbox user); the title request gets a fixed title. `steps` is
 * read on every request so a probe may embed the provider's own port.
 */
export async function startScriptedProvider(steps: () => readonly Probe[]): Promise<ScriptedProvider> {
  const state = {results: [] as string[], done: false}
  const server: Server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        tools?: {function?: {name?: string}}[]
        messages?: {role: string; content: unknown}[]
      }
      const send = (delta: object, finish: string | null): void => {
        res.write(
          `data: ${JSON.stringify({id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{index: 0, delta, finish_reason: finish}]})}\n\n`,
        )
      }
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '')
      if (tools.length === 0) {
        send({role: 'assistant', content: 'Probe title'}, null)
        send({}, 'stop')
        res.end('data: [DONE]\n\n')
        return
      }
      const toolName = tools.find(name => name === 'bash') ?? tools.find(name => name === 'shell') ?? 'bash'
      const toolMessages = (body.messages ?? []).filter(message => message.role === 'tool')
      const last = toolMessages.at(-1)
      if (last !== undefined) {
        state.results[toolMessages.length - 1] =
          typeof last.content === 'string' ? last.content : JSON.stringify(last.content)
      }
      const index = toolMessages.length
      const step = steps()[index]
      if (step === undefined) {
        state.done = true
        send({role: 'assistant', content: 'probes done'}, null)
        send({}, 'stop')
      } else {
        send(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${index}`,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify({command: PRELUDE + step.cmd, description: step.id}),
                },
              },
            ],
          },
          null,
        )
        send({}, 'tool_calls')
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    state,
    close: async () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

export interface ScriptedSessionOptions {
  readonly binary: string
  readonly workspace: string
  readonly env: NodeJS.ProcessEnv
  readonly lifecycle: SandboxLifecycle
  /** The provider key file, referenced from the config. Omit it when `proxy` supplies the base URL and credential. */
  readonly keyFile?: string
  /** A key proxy's base URL and placeholder for the provider, in place of the direct URL and the key file. */
  readonly proxy?: {readonly baseURL: string; readonly apiKey: string}
  readonly provider: ScriptedProvider
  readonly logger: Logger
  readonly turnTimeoutMs?: number
}

/**
 * Starts the real server as the sandbox user, opens a session, sends one prompt and waits until the provider's script has
 * run to the end. The caller owns `handle.shutdown()` and the lifecycle `release()`.
 */
export async function startScriptedSession(options: ScriptedSessionOptions): Promise<OpenCodeV2ServerHandle> {
  const {provider, workspace} = options
  // Through the lifecycle's launch, as the Action does: the attempt is registered before port allocation, and a teardown
  // that begins waits for it. Starting the server directly would bypass what the suite is meant to prove.
  const launched = await options.lifecycle.launch(async context => {
    const result = await startOpenCodeV2Server(
      {
        binaryPath: options.binary,
        directory: workspace,
        expectedPluginIds: [],
        env: options.env,
        sandbox: context.spec,
        signal: context.signal,
        onSpawn: context.noteSpawn,
        config: {
          share: 'disabled',
          model: 'fake/fixture-model',
          plugins: [],
          provider: {
            fake: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Fake',
              options: options.proxy ?? {
                baseURL: `http://127.0.0.1:${provider.port}/v1`,
                apiKey: `{file:${options.keyFile ?? ''}}`,
              },
              models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
            },
          },
          // This suite tests the OS boundary, not OpenCode's permission layer.
          permission: {bash: 'allow', edit: 'allow', external_directory: 'allow', question: 'deny'},
        },
        timeouts: {agentReadyTimeoutMs: 90_000},
      },
      options.logger,
    )
    return {value: result, unconfirmed: !result.success && result.error.cleanup === 'unconfirmed'}
  })
  if (!launched.success) throw new Error(`launch refused: ${launched.error}`)
  const started = launched.data
  if (!started.success) throw new Error(`server start failed: ${started.error.message}`)
  const handle = started.data

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
    body: JSON.stringify({text: 'run the probes'}),
  })
  const deadline = Date.now() + (options.turnTimeoutMs ?? 240_000)
  while (!provider.state.done && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
  return handle
}
