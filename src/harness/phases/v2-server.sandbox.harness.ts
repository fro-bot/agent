import type {Server} from 'node:http'
/**
 * Shared pieces for the real-runner `isolate-agent` suite (`v2-server.sandbox.integration.test.ts`): a scripted fake
 * OpenAI-compatible provider that makes the real OpenCode server run one `bash` tool call per probe, and the helper that
 * starts the server as the sandbox user and drives one turn. Nothing here is product code and nothing here runs outside
 * that suite.
 */
import type {OpenCodeV2ServerHandle, OpenCodeV2TracingSetting} from '@fro-bot/runtime'
import type {Logger} from '../../shared/logger.js'
import type {SandboxLifecycle} from './sandbox-lifecycle.js'
import {Buffer} from 'node:buffer'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {ACTION_TRACING_OFF, startOpenCodeV2Server} from '@fro-bot/runtime'

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
  return value !== undefined && isSafeAbsolutePath(value) ? value : fallback
}

function isSafeAbsolutePath(value: string): boolean {
  return SAFE_ABSOLUTE_PATH.test(value) && !value.split('/').includes('..')
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
  for (const match of text.matchAll(/RESULT ([a-z0-9_]+) (BLOCKED|OPEN|WORKS|FAILED|INFO|INCOMPLETE) ([^\n"]*)/g)) {
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

/** A plugin the server loads for a traced turn, and what the launcher tells it. Without one: no plugin, tracing off. */
export interface ScriptedTracing {
  /** Exact plugin specs for the config, already installed in the cache the server reads. */
  readonly specs: readonly string[]
  /** Plugin ids the server must list as active before it counts as started. */
  readonly expectedPluginIds: readonly string[]
  readonly host: OpenCodeV2TracingSetting
}

interface ScriptedServerInput {
  readonly binary: string
  readonly workspace: string
  readonly env: NodeJS.ProcessEnv
  /** The provider key file, referenced from the config. Omit it when `proxy` supplies the base URL and credential. */
  readonly keyFile?: string
  /** A key proxy's base URL and placeholder for the provider, in place of the direct URL and the key file. */
  readonly proxy?: {readonly baseURL: string; readonly apiKey: string}
  readonly provider: ScriptedProvider
  readonly tracing?: ScriptedTracing
}

/** The server start both launchers share: the config and the plugin and tracing declarations. The caller adds the sandbox. */
function scriptedServerOptions(input: ScriptedServerInput) {
  return {
    binaryPath: input.binary,
    directory: input.workspace,
    expectedPluginIds: input.tracing?.expectedPluginIds ?? [],
    tracingHost: input.tracing?.host ?? ACTION_TRACING_OFF,
    env: input.env,
    config: {
      share: 'disabled',
      model: 'fake/fixture-model',
      plugins: input.tracing?.specs ?? [],
      provider: {
        fake: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake',
          options: input.proxy ?? {
            baseURL: `http://127.0.0.1:${input.provider.port}/v1`,
            apiKey: `{file:${input.keyFile ?? ''}}`,
          },
          models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
        },
      },
      // This suite tests the OS boundary, not OpenCode's permission layer.
      permission: {bash: 'allow', edit: 'allow', external_directory: 'allow', question: 'deny'},
    },
    timeouts: {agentReadyTimeoutMs: 90_000},
  } satisfies Parameters<typeof startOpenCodeV2Server>[0]
}

/**
 * Opens a session on a started server, sends one prompt and waits until the provider's script has run to the end. A failure
 * stops the server before it is rethrown: the caller never received the handle, so nothing else could.
 */
async function driveScriptedTurn(
  handle: OpenCodeV2ServerHandle,
  workspace: string,
  provider: ScriptedProvider,
  turnTimeoutMs: number | undefined,
): Promise<void> {
  try {
    await promptAndWait(handle, workspace, provider, turnTimeoutMs)
  } catch (error) {
    // The turn's error is the one that matters; a shutdown that also fails adds nothing the caller can use.
    await handle.shutdown().catch(() => undefined)
    throw error
  }
}

async function promptAndWait(
  handle: OpenCodeV2ServerHandle,
  workspace: string,
  provider: ScriptedProvider,
  turnTimeoutMs: number | undefined,
): Promise<void> {
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
  const deadline = Date.now() + (turnTimeoutMs ?? 240_000)
  while (!provider.state.done && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
}

export interface ScriptedSessionOptions extends ScriptedServerInput {
  readonly lifecycle: SandboxLifecycle
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
        ...scriptedServerOptions(options),
        sandbox: context.spec,
        signal: context.signal,
        onSpawn: context.noteSpawn,
      },
      options.logger,
    )
    return {value: result, unconfirmed: !result.success && result.error.cleanup === 'unconfirmed'}
  })
  if (!launched.success) throw new Error(`launch refused: ${launched.error}`)
  const started = launched.data
  if (!started.success) throw new Error(`server start failed: ${started.error.message}`)
  const handle = started.data
  await driveScriptedTurn(handle, workspace, provider, options.turnTimeoutMs)
  return handle
}

export interface PlainScriptedSessionOptions extends Omit<ScriptedSessionOptions, 'lifecycle'> {
  /** The server start. Left out, the real one; a test passes its own. */
  readonly deps?: {readonly start?: typeof startOpenCodeV2Server}
}

/** The same server and turn as `startScriptedSession`, as the runner's own user and with no sandbox: `isolate-agent` off. */
export async function startPlainScriptedSession(options: PlainScriptedSessionOptions): Promise<OpenCodeV2ServerHandle> {
  const start = options.deps?.start ?? startOpenCodeV2Server
  const started = await start(scriptedServerOptions(options), options.logger)
  if (!started.success) throw new Error(`server start failed: ${started.error.message}`)
  await driveScriptedTurn(started.data, options.workspace, options.provider, options.turnTimeoutMs)
  return started.data
}

// --- The read-only view suite ------------------------------------------------------------------------------------------

/** Every file a view probe creates starts with this, so a sweep after the run finds what a failed run left behind. */
export const VIEW_IT_PREFIX = 'fro-bot-it'

/** The operations of one write-matrix row. A control must manage all four, or its blocked twin proves less than it claims. */
export const MATRIX_OPS = ['create', 'append', 'rename', 'unlink'] as const

export interface MatrixDirectoryInput {
  /** The runner's `PATH`. */
  readonly pathEnv: string | undefined
  /** `RUNNER_TOOL_CACHE`, or the hosted default. */
  readonly toolCache: string
  /** Further shared directories: `/opt`, `/usr/share`. */
  readonly extra: readonly string[]
}

export interface MatrixDirectoryDeps {
  readonly isDirectory: (target: string) => boolean
  /** True when the runner itself may create files there. */
  readonly isWritable: (target: string) => boolean
  readonly subdirectories: (target: string) => readonly string[]
}

/**
 * The shared directories the matrix covers: every plain absolute `PATH` entry, the extra directories, the tool cache and its first
 * subdirectory, in that order and without duplicates. Only those the runner can write are returned. A directory the runner
 * cannot write is not part of the threat, and a runner-side control could not show that a block means anything there.
 */
export function matrixDirectories(input: MatrixDirectoryInput, deps: MatrixDirectoryDeps): readonly string[] {
  const candidates = [
    // Each entry ends up inside a shell probe, so only plain absolute paths are kept (the same rule as `safeEnvPath`).
    ...(input.pathEnv ?? '').split(':').filter(isSafeAbsolutePath),
    ...input.extra,
    input.toolCache,
  ]
  const firstSubdirectory = deps
    .subdirectories(input.toolCache)
    .map(name => `${input.toolCache}/${name}`)
    .find(candidate => deps.isDirectory(candidate) && deps.isWritable(candidate))
  if (firstSubdirectory !== undefined) candidates.push(firstSubdirectory)
  const seen = new Set<string>()
  const directories: string[] = []
  for (const candidate of candidates) {
    const normalized = candidate.length > 1 ? candidate.replace(/\/+$/, '') : candidate
    if (seen.has(normalized)) continue
    seen.add(normalized)
    if (deps.isDirectory(normalized) && deps.isWritable(normalized)) directories.push(normalized)
  }
  return directories
}

/**
 * The disposable files the runner places in a matrix directory before the launch: for each actor (`ctl` is the runner's
 * control, `sbx` is the sandbox) one to append to and rename, and one to unlink. Both are mode 0666, so only the mount, not the
 * permission bits, can refuse the sandbox. The actor never shares a file with the other, so the control cannot use up the
 * sandbox's.
 */
export function matrixSentinels(dir: string, tag: string): readonly string[] {
  return (['ctl', 'sbx'] as const).flatMap(who => [
    `${dir}/${VIEW_IT_PREFIX}-${tag}-${who}`,
    `${dir}/${VIEW_IT_PREFIX}-${tag}-${who}-unlink`,
  ])
}

/**
 * One write-matrix row: create, append, rename and unlink in `dir`. It prints `OPEN` listing every operation that worked,
 * or `BLOCKED` when none did. The actor is told by uid, so the runner's control and the sandbox use different sentinels.
 */
export function writeMatrixProbe(id: string, dir: string, tag: string, runnerUid: number): Probe {
  return {
    id,
    category: 'blocked',
    control: true,
    cmd:
      `b=${q(dir)}/${VIEW_IT_PREFIX}-${tag}; ` +
      `if [ "$(id -u)" = ${runnerUid} ]; then who=ctl; else who=sbx; fi; s="$b-$who"; u="$b-$who-unlink"; got=""; ` +
      `( : > "$b-new-$who" ) 2>/dev/null && { got="$got create"; rm -f "$b-new-$who"; }; ` +
      `( echo x >> "$s" ) 2>/dev/null && got="$got append"; ` +
      `if mv "$s" "$s.moved" 2>/dev/null; then got="$got rename"; mv "$s.moved" "$s"; fi; ` +
      `if rm "$u" 2>/dev/null; then got="$got unlink"; fi; ` +
      `if [ -z "$got" ]; then R ${id} BLOCKED "no write operation succeeded"; else R ${id} OPEN "succeeded:$got"; fi`,
  }
}

/** True when a control row names all four matrix operations. */
export function controlCoversMatrix(rows: readonly Row[] | undefined): boolean {
  return (rows ?? []).some(row => row.status === 'OPEN' && MATRIX_OPS.every(op => row.evidence.includes(op)))
}

/** A `works` row: the actor can create and remove a file in `dirExpr` (a shell word, already quoted or an expansion). */
export const writeWorksProbe = (id: string, dirExpr: string): Probe => ({
  id,
  category: 'works',
  cmd:
    `d=${dirExpr}; t="$d/.${VIEW_IT_PREFIX}-w-$$"; ` +
    `if ( : > "$t" ) 2>/dev/null; then rm -f "$t"; R ${id} WORKS "wrote $d"; else R ${id} FAILED "no write to $d"; fi`,
})

/**
 * Copies `entry` of a bundle directory, and every file it imports (relative `./x.js`, static or dynamic, transitively), into
 * `target`: the stand-in published install a root process runs the view builder from. A missing import throws here, naming
 * the file, rather than failing later as a bare exit code of a process the test cannot see into. Returns the copied names.
 */
export function copyBundleWithImports(sourceDir: string, targetDir: string, entry: string): readonly string[] {
  const copied = new Set<string>()
  const pending = [entry]
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (copied.has(name)) continue
    const from = path.join(sourceDir, name)
    if (!fs.existsSync(from)) throw new Error(`${name} is imported by the bundle but is not in ${sourceDir}`)
    fs.copyFileSync(from, path.join(targetDir, name))
    copied.add(name)
    const text = fs.readFileSync(from, 'utf8')
    for (const match of text.matchAll(/(?:from|import)\s*(?:\(\s*)?["']\.\/([^"'/]+\.js)["']/g)) {
      if (match[1] !== undefined) pending.push(match[1])
    }
  }
  return [...copied]
}

// --- Inspections: read what the sandbox left, and fail loudly when the reading itself fails -------------------------------

/** What an inspection command did. A runner that cannot report all of it is not an inspection. */
export interface InspectionResult {
  readonly status: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the process could not be started, timed out or overflowed its buffer. */
  readonly error?: Error | undefined
}

export type InspectionRunner = (command: string, args: readonly string[]) => InspectionResult

/** The real runner. The buffer is large on purpose: a recursive `getfacl` of an install root is hundreds of kilobytes. */
export const runInspection: InspectionRunner = (command, args) => {
  const result = spawnSync(command, [...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  }
}

/** The end of a command's stderr as one short line, so a failure names its cause without flooding the log. */
function stderrTail(stderr: string): string {
  const line = stderr.replaceAll(/\s+/g, ' ').trim()
  return line.length > 200 ? `...${line.slice(-200)}` : line
}

/**
 * Runs an inspection and returns its stdout, but only when it completed: no spawn error, not killed by a signal, and an exit
 * status in `okStatuses`. An absence assertion (no ACL entry, no changed file, no stray process) must never be satisfied by
 * the output of a command that failed, so anything else throws, naming `description` and a bounded stderr tail.
 */
export function inspectOutput(
  command: string,
  args: readonly string[],
  description: string,
  run: InspectionRunner = runInspection,
  okStatuses: readonly number[] = [0],
): string {
  const result = run(command, args)
  const tail = stderrTail(result.stderr ?? '')
  const detail = tail.length === 0 ? '' : `; stderr: ${tail}`
  if (result.error !== undefined) {
    throw new Error(`${description}: ${command} could not complete (${result.error.message})${detail}`)
  }
  if (result.signal !== null) throw new Error(`${description}: ${command} was killed by ${result.signal}${detail}`)
  if (result.status === null || !okStatuses.includes(result.status)) {
    throw new Error(
      `${description}: ${command} exited ${result.status === null ? 'without a status' : result.status}${detail}`,
    )
  }
  return result.stdout ?? ''
}

const nonEmptyLines = (text: string): string[] => text.split('\n').filter(line => line.length > 0)

/** Every `getfacl` line of `target`, access and default, as the runner reads them. Throws when `getfacl` fails. */
export function aclLines(target: string, recursive: boolean, run?: InspectionRunner): string[] {
  const args = ['-p', '-c', ...(recursive ? ['-R'] : []), target]
  return nonEmptyLines(inspectOutput('getfacl', args, `reading the ACL of ${target}`, run))
}

/** `getfacl` output for the given arguments (paths and flags), whole. Throws when `getfacl` fails. */
export function aclText(args: readonly string[], run?: InspectionRunner): string {
  const targets = args.filter(arg => !arg.startsWith('-')).join(' ')
  return inspectOutput('getfacl', args, `reading the ACL of ${targets}`, run)
}

/** Regular files under `root` modified after `marker`, minus names starting with `ignoredPrefix` and anything under an `install` directory (bun's own cache). */
export function changedFilesSince(
  root: string,
  marker: string,
  ignoredPrefix: string,
  run?: InspectionRunner,
): string[] {
  const args = [
    root,
    '-type',
    'f',
    '-newer',
    marker,
    '-not',
    '-name',
    `${ignoredPrefix}-*`,
    '-not',
    '-path',
    '*/install/*',
  ]
  return nonEmptyLines(inspectOutput('find', args, `scanning ${root} for changed files`, run))
}

/** The paths `find` prints for `args` (a complete argument list). Throws when `find` fails, even with partial output. */
export function findPaths(args: readonly string[], description: string, run?: InspectionRunner): string[] {
  return nonEmptyLines(inspectOutput('find', args, description, run))
}

/** What `pgrep` prints for `args`. Exit 1 means "no match" and is a real answer; any other status is a failure. */
export function pgrepOutput(args: readonly string[], run?: InspectionRunner): string {
  return inspectOutput('pgrep', args, `looking for processes (${args.join(' ')})`, run, [0, 1]).trim()
}

/** The mount namespaces on the machine as root sees them. A failed `lsns` is not an empty machine. */
export function mountNamespaceIds(run?: InspectionRunner): string[] {
  const text = inspectOutput('sudo', ['-n', 'lsns', '-t', 'mnt', '-n', '-o', 'NS'], 'listing mount namespaces', run)
  return nonEmptyLines(
    text
      .split('\n')
      .map(line => line.trim())
      .join('\n'),
  ).toSorted()
}

/** One process's mount-namespace membership, as the scan read it. */
export interface NamespaceMember {
  readonly id: string
  readonly uid: number
  readonly comm: string
  /** The first line of `/proc/<pid>/cgroup`. */
  readonly cgroup: string
  /** The NUL-separated command line, with the separators turned into spaces. */
  readonly cmdline: string
}

/** What decides whether a namespace that appeared during a test belongs to the launch under test. */
export interface LaunchScope {
  /** The sandbox account's uid, captured while the account existed; null when it is not known. */
  readonly sandboxUid: number | null
  /**
   * Patterns (the `pgrep -f` / extended-regex syntax the suites already use, so a plain name is its own pattern) that a
   * member's command line matches when the member belongs to the launch. Empty patterns are dropped: they match everything.
   */
  readonly markers: readonly string[]
  /** The test process's own cgroup line. Defaults to the first line of `/proc/self/cgroup`. */
  readonly cgroup?: string
}

export interface LaunchNamespaces {
  /** Namespaces that are new and have a member that belongs to the launch. The assertion is that this is empty. */
  readonly kept: readonly string[]
  /** One member of each kept namespace, for the failure message. */
  readonly keptMembers: readonly NamespaceMember[]
  /** One member of each new namespace that is not the launch's (host services such as `systemd-timedated`). */
  readonly ignored: readonly NamespaceMember[]
}

/**
 * Everything is read in one root shell pass over `/proc`, so the answer is one consistent moment rather than one `lsns` plus
 * a lookup per namespace. A process that exits mid-scan is skipped (`|| continue`); a scan that fails as a whole is not. The
 * real uid comes from `status`, since `/proc/<pid>` is owned by root for a process that is not dumpable.
 */
const NAMESPACE_MEMBER_SCAN = String.raw`for p in /proc/[0-9]*; do
  ns=$(readlink "$p/ns/mnt" 2>/dev/null) || continue
  uid=$(awk '/^Uid:/ {print $2}' "$p/status" 2>/dev/null) || continue
  cg=$(head -n 1 "$p/cgroup" 2>/dev/null) || continue
  comm=$(tr '\0\n\t' '   ' 2>/dev/null <"$p/comm") || continue
  cmd=$(tr '\0\n\t' '   ' 2>/dev/null <"$p/cmdline") || continue
  printf '%s\t%s\t%s\t%s\t%s\n' "$ns" "$uid" "$comm" "$cg" "$cmd"
done`

function parseNamespaceMembers(text: string): NamespaceMember[] {
  return nonEmptyLines(text).map(line => {
    const [ns, uid, comm, cgroup, ...rest] = line.split('\t')
    const id = /^mnt:\[(\d+)\]$/.exec(ns ?? '')?.[1]
    if (id === undefined || !/^\d+$/.test(uid ?? '') || comm === undefined || cgroup === undefined) {
      throw new Error(`scanning mount namespace members: unreadable line ${JSON.stringify(line.slice(0, 200))}`)
    }
    // `tr` turned the trailing newline of `comm` and `cmdline` into a space.
    return {id, uid: Number(uid), comm: comm.trim(), cgroup, cmdline: rest.join('\t').trim()}
  })
}

function ownCgroupLine(): string {
  return fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n')[0] ?? ''
}

/** A short, single-line description of members, for an assertion message. */
export function describeNamespaceMembers(members: readonly NamespaceMember[]): string {
  return members.length === 0
    ? 'none'
    : members
        .map(m => `${m.id} (uid ${m.uid}, ${m.comm}, cgroup ${m.cgroup}, cmd ${m.cmdline.trim().slice(0, 80)})`)
        .join('; ')
}

/**
 * The mount namespaces that appeared since `before` and belong to the launch. A hosted runner creates namespaces of its own
 * during a job (`snapd` makes D-Bus activate `systemd-timedated`, which lives in a private namespace for about 30 s), so
 * "no new namespace id" is not the property; "no new namespace with a member of ours" is. A member is ours when it runs as
 * the sandbox uid, sits in the test process's own cgroup, or has a command line that names the launch. The rest are
 * returned as `ignored`, with their owner, so a failure can say what was set aside. Throws when the scan fails.
 */
export function newLaunchNamespaces(
  before: readonly string[],
  scope: LaunchScope,
  run?: InspectionRunner,
): LaunchNamespaces {
  // The root cgroup (`0::/`) would make every process look like ours, so it never counts as a match.
  const own = scope.cgroup ?? ownCgroupLine()
  const ownCgroup = /::\/?$/.test(own) ? null : own
  const patterns = scope.markers.filter(marker => marker.length > 0).map(marker => new RegExp(marker))
  const members = parseNamespaceMembers(
    inspectOutput('sudo', ['-n', 'sh', '-c', NAMESPACE_MEMBER_SCAN], 'scanning mount namespace members', run),
  )
  const ours = (member: NamespaceMember): boolean =>
    (scope.sandboxUid !== null && member.uid === scope.sandboxUid) ||
    (ownCgroup !== null && member.cgroup === ownCgroup) ||
    patterns.some(pattern => pattern.test(member.cmdline))

  const kept: string[] = []
  const keptMembers: NamespaceMember[] = []
  const ignored: NamespaceMember[] = []
  const decided = new Set<string>()
  const fresh = members.filter(member => !before.includes(member.id))
  for (const member of fresh) {
    if (decided.has(member.id)) continue
    const mine = fresh.find(candidate => candidate.id === member.id && ours(candidate))
    decided.add(member.id)
    if (mine === undefined) {
      ignored.push(member)
    } else {
      kept.push(member.id)
      keptMembers.push(mine)
    }
  }
  return {kept: kept.toSorted(), keptMembers, ignored}
}

/** The first line of what the runner's own shell command prints. Throws when the command fails. */
export function runnerFirstLine(command: string, run?: InspectionRunner): string {
  return inspectOutput('sh', ['-c', command], `running ${command}`, run).split('\n')[0]?.trim() ?? ''
}

/**
 * What the server was told about the run, read from its own environment (the tool shell's parent): the launcher variable holds
 * the lifecycle trace's ids and the session, each once. The credential's absence from the same variable is the canary search's
 * `environ` group, which reads this environment too. `environFile` is the server's `/proc/<pid>/environ`; a test names a file.
 */
export function launcherLinkProbe(
  ids: {readonly traceId: string; readonly rootSpanId: string; readonly invocationId: string} | null,
  session: string | undefined,
  environFile = '/proc/$PPID/environ',
): Probe {
  const count = (needle: string): string => `$(printf %s "$doc" | grep -cF -- ${q(needle)})`
  return {
    id: 'launcher_link',
    category: 'works',
    // `String.raw`: the `\0` and `\n` are the characters `tr` is given, not a NUL and a newline inside the command text.
    cmd:
      `${String.raw`doc=$(tr '\0' '\n' < ${environFile} 2>/dev/null | grep '^OPENCODE_FROBOT_TRACING='); `}[ -n "$doc" ] || { R launcher_link FAILED "the launcher variable could not be read"; exit 0; }; ` +
      `t=${count(ids?.traceId ?? 'absent')}; s=${count(ids?.rootSpanId ?? 'absent')}; ` +
      `n=${count(session ?? 'absent')}; i=${count(ids?.invocationId ?? 'absent')}; ` +
      `[ "$t" = 1 ] && [ "$s" = 1 ] && [ "$n" = 1 ] && [ "$i" = 1 ] && st=WORKS || st=FAILED; ` +
      `R launcher_link $st "trace=$t span=$s session=$n invocation=$i"`,
  }
}
