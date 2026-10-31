/**
 * Real-binary check of the Action's OpenCode V2 start: credentials as `{file:}` references, plugin install, held-claim
 * clear, the three gates and the V1 import wait, end to end on a restored database.
 *
 * Runs only when `FRO_BOT_OPENCODE_V2_BIN` names the stock OpenCode binary pinned in
 * `packages/runtime/src/shared/opencode-v2-pin.json`. Fetch the archive, compare its sha256 with that file BEFORE running
 * anything from it, and delete the binary afterwards:
 *
 *   v=$(node -p "require('./packages/runtime/src/shared/opencode-v2-pin.json').version")
 *   curl -fsSL -o oc.zip "https://github.com/anomalyco/opencode/releases/download/v$v/opencode-darwin-arm64.zip"
 *   shasum -a 256 oc.zip   # must equal assets["opencode-darwin-arm64.zip"] in opencode-v2-pin.json
 *   unzip -o oc.zip && FRO_BOT_OPENCODE_V2_BIN=$PWD/opencode bun run test src/harness/phases/v2-server.integration
 *
 * The plugin install uses the npm registry (`@fro.bot/systematic` and `@fro.bot/opencode-plugin` at their pins), so the
 * test needs network access. The model is a local OpenAI-compatible stub: nothing leaves the machine except that install.
 */

import type {AddressInfo} from 'node:net'
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {StartActionOpenCodeV2Options} from './v2-server.js'
import {execFileSync} from 'node:child_process'
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {clearHeldClaims} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest'
import pin from '../../../packages/runtime/src/shared/opencode-v2-pin.json'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {installPluginsV2, resolvePluginSpecsV2} from '../../services/setup/plugin-install-v2.js'
import {createMockLogger, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {waitForV1Import} from './v1-import-wait.js'
import {startActionOpenCodeV2} from './v2-server.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const hasBinary = BINARY !== undefined && BINARY !== '' && existsSync(BINARY)

/** A synthetic V1 database: the schema and rows a real OpenCode 1.19.4 wrote for two small sessions (no real content). */
const V1_SEED_SQL = readFileSync(fileURLToPath(new URL('./fixtures/v1-seed.sql', import.meta.url)), 'utf8')

const CANARY = 'sk-fake-CANARY-integration-9f3a7c'
const MODEL = 'fake/fixture-model'

interface Sandbox {
  readonly root: string
  readonly repo: string
  readonly runnerTemp: string
  readonly dataDir: string
  readonly dbPath: string
  readonly authPath: string
  readonly cacheHome: string
  readonly env: NodeJS.ProcessEnv
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v2-server-it-'))
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
    runnerTemp,
    dataDir,
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

interface Provider {
  readonly baseURL: string
  readonly requests: () => readonly {readonly authorization: string | undefined}[]
  readonly stop: () => Promise<void>
}

/** An OpenAI-compatible stub that records each chat request's Authorization header and then holds the turn open. */
async function startProvider(): Promise<Provider> {
  const seen: {authorization: string | undefined}[] = []
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({object: 'list', data: [{id: 'fixture-model', object: 'model'}]}))
      return
    }
    seen.push({authorization: req.headers.authorization})
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
    res.write(
      `data: ${JSON.stringify({id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null}]})}\n\n`,
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => seen,
    stop: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** The operator's `opencode-config` input: the stub provider and the model. The key comes from `auth-json`, not here. */
function operatorConfig(baseURL: string): string {
  return JSON.stringify({
    share: 'disabled',
    // The model comes from the config here; the V2 prompt shape for a per-prompt model is the execution loop's (U12a).
    model: MODEL,
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

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate()
}

function query<T>(dbPath: string, sql: string): T[] {
  const db = new DatabaseSync(dbPath, {readOnly: true})
  try {
    return db.prepare(sql).all() as T[]
  } finally {
    db.close()
  }
}

/** Every regular file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(full) : [full]
  })
}

/** A restored cache: the V1 seed, plus what a killed V2 run left behind (a held claim and a background-job row). */
async function restoreV1DatabaseWithHeldClaim(box: Sandbox): Promise<void> {
  const v1 = new DatabaseSync(box.dbPath)
  v1.exec(V1_SEED_SQL)
  v1.close()

  // A V2 server alone creates V2 tables, so boot one on the V1 seed once: it applies its schema and imports the seed.
  const {startOpenCodeV2Server} = await import('@fro-bot/runtime')
  const booted = await startOpenCodeV2Server(
    {binaryPath: BINARY as string, directory: box.repo, expectedPluginIds: [], env: box.env},
    createMockLogger(),
  )
  const handle = unwrapOk(booted)
  const imported = await waitForV1Import({fetch: handle.fetch, logger: createMockLogger()})
  unwrapOk(imported)
  const shutdown = await handle.shutdown()
  expect(shutdown.exit.outcome).toBe('graceful')

  // Un-import: the V1 history stays in the file with the import marker rewound, and a session a killed run held is
  // planted beside it. That is the mid-conversion state of a restored cache with both generations' tables.
  const db = new DatabaseSync(box.dbPath)
  try {
    db.exec(`
      CREATE TEMP TABLE planted AS SELECT * FROM session_v2 LIMIT 1;
      UPDATE planted SET id = 'ses_planted_claim', time_suspended = ${Date.now()}, resume_attempts = 2;
      DELETE FROM session_v2;
      INSERT INTO session_v2 SELECT * FROM planted;
      UPDATE kv SET value = '{"phase":"sessions"}' WHERE key = 'migration.v1-v2';
      INSERT INTO kv (key, value, time_created, time_updated)
        VALUES ('job.background/ntf_it', '{"status":"running"}', ${Date.now()}, ${Date.now()});
    `)
  } finally {
    db.close()
  }
  expect(
    query<{c: number}>(box.dbPath, 'SELECT COUNT(*) AS c FROM session_v2 WHERE time_suspended IS NOT NULL')[0]?.c,
  ).toBe(1)
}

/** How long after a failed start the spawned process may still be running. A graceful stop is under a second. */
const PROCESS_EXIT_BOUND_MS = 10_000

/** True while a process with this pid exists (signal 0 checks existence and permission without sending anything). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sandboxes: Sandbox[] = []
const handles: OpenCodeV2ServerHandle[] = []
const providers: Provider[] = []

describe.skipIf(!hasBinary)('startActionOpenCodeV2 against the real stock binary', () => {
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

  it('starts on a restored V1 database with a held claim: claims cleared, import completed, gates passed with a {file:} key, no credential at rest', async () => {
    // #given a restored cache, a stale auth.json from an older run, and the plugins installed the way setup installs them
    const box = createSandbox()
    sandboxes.push(box)
    const provider = await startProvider()
    providers.push(provider)
    await restoreV1DatabaseWithHeldClaim(box)
    writeFileSync(box.authPath, JSON.stringify({fake: {type: 'api', key: 'STALE-RESTORED-KEY'}}))

    const specs = unwrapOk(resolvePluginSpecsV2('latest')).specs
    const installed = await installPluginsV2({
      logger: createMockLogger(),
      execAdapter: createExecAdapter(),
      opencodeBinaryPath: BINARY as string,
      specs,
      cacheHome: box.cacheHome,
      env: box.env,
    })
    expect(installed).toEqual({success: true, data: undefined})

    // #and the facts at the instant the server is spawned, read from the database it is about to open
    const atSpawn = {claims: -1, jobs: -1, authJsonPresent: true}
    const statuses: string[] = []
    const logger = createMockLogger()
    const options: StartActionOpenCodeV2Options = {
      binaryPath: BINARY as string,
      workspacePath: box.repo,
      authJson: JSON.stringify({fake: {type: 'api', key: CANARY}}),
      opencodeConfig: operatorConfig(provider.baseURL),
      systematicVersion: 'latest',
      model: MODEL,
      dbPath: box.dbPath,
      authPath: box.authPath,
      env: box.env,
      runId: 1,
      runAttempt: 1,
      logger,
      deps: {
        startServer: async (spawnOptions, spawnLogger) => {
          atSpawn.claims = query<{c: number}>(
            box.dbPath,
            'SELECT COUNT(*) AS c FROM session_v2 WHERE time_suspended IS NOT NULL',
          )[0]?.c as number
          atSpawn.jobs = query<{c: number}>(
            box.dbPath,
            "SELECT COUNT(*) AS c FROM kv WHERE key LIKE 'job.background/%'",
          )[0]?.c as number
          atSpawn.authJsonPresent = existsSync(box.authPath)
          const {startOpenCodeV2Server} = await import('@fro-bot/runtime')
          return startOpenCodeV2Server({...spawnOptions, timeouts: {agentReadyTimeoutMs: 90_000}}, spawnLogger)
        },
        clearClaims: clearHeldClaims,
        waitForImport: async waitOptions =>
          waitForV1Import({
            ...waitOptions,
            fetch: async (pathname, init) => {
              const response = await waitOptions.fetch(pathname, init)
              const body = (await response
                .clone()
                .json()
                .catch(() => ({}))) as {status?: string}
              if (body.status !== undefined) statuses.push(body.status)
              return response
            },
          }),
      },
    }

    // #when
    const started = await startActionOpenCodeV2(options)

    // #then the start succeeded: both plugins active, the permission gate and the credential gate passed, the import done
    const handle = unwrapOk(started)
    handles.push(handle)
    expect(statuses.at(-1)).toBe('completed')
    // #and nothing was held when the server opened the database, and no auth.json was there for m39 to import
    expect(atSpawn).toEqual({claims: 0, jobs: 0, authJsonPresent: false})
    // #and no claim resumed on its own: the stub model saw no request
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(provider.requests()).toEqual([])
    expect(
      query<{c: number}>(box.dbPath, 'SELECT COUNT(*) AS c FROM session_v2 WHERE time_suspended IS NOT NULL')[0]?.c,
    ).toBe(0)
    // #and the V1 history was imported by the wait that ran before any prompt
    expect(query<{c: number}>(box.dbPath, 'SELECT COUNT(*) AS c FROM session_v2')[0]?.c).toBeGreaterThanOrEqual(2)

    // #and the server really resolves the {file:} reference: the stub receives the key from the file as the bearer token
    const created = (await (
      await handle.fetch('/api/session', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({location: {directory: box.repo}}),
      })
    ).json()) as {data: {id: string}}
    const sessionId = created.data.id
    handle.registerOwnedSession(sessionId)
    const prompt = await handle.fetch(`/api/session/${sessionId}/prompt`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'go'}),
    })
    expect(prompt.status).toBeLessThan(300)
    expect(await waitFor(() => provider.requests().length > 0, 30_000)).toBe(true)
    expect(provider.requests()[0]?.authorization).toBe(`Bearer ${CANARY}`)

    // #when the run ends the way the Action ends it: owned sessions interrupted, then the server stopped
    const shutdown = await handle.shutdown({ownedSessionIds: [sessionId]})
    expect(shutdown.exit).toMatchObject({outcome: 'graceful', code: 0})

    // #then the database that would be saved holds no credential, and the key is nowhere under the data directory
    const tables = query<{name: string}>(box.dbPath, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
      row => row.name,
    )
    expect(tables).toContain('credential')
    expect(query<{c: number}>(box.dbPath, 'SELECT COUNT(*) AS c FROM credential')[0]?.c).toBe(0)
    expect(existsSync(box.authPath)).toBe(false)
    for (const file of filesUnder(box.dataDir)) {
      expect(readFileSync(file).includes(CANARY), `${path.relative(box.root, file)} must not hold the key`).toBe(false)
    }
    // #and the key lives only in its own 0600 file under RUNNER_TEMP, outside the data directory and the cache home
    const keyDirs = readdirSync(box.runnerTemp)
    expect(keyDirs).toHaveLength(1)
    const keyFile = path.join(box.runnerTemp, keyDirs[0] as string, 'fake.key')
    const keyFd = openSync(keyFile, 'r')
    try {
      expect(fstatSync(keyFd).mode & 0o777).toBe(0o600)
      expect(readFileSync(keyFd, 'utf8')).toBe(CANARY)
    } finally {
      closeSync(keyFd)
    }
    // #and nothing the Action logged carries it
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(CANARY)
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain(keyFile)
  }, 240_000)

  it('fails closed when the model provider has no key, and leaves no server running', async () => {
    // #given a fresh database and an auth-json with no entry for the model's provider
    const box = createSandbox()
    sandboxes.push(box)
    const provider = await startProvider()
    providers.push(provider)
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

    // #when the start fails at the credential gate; the real server handle is captured as the spawn returns it
    let spawned: OpenCodeV2ServerHandle | undefined
    const started = await startActionOpenCodeV2({
      binaryPath: BINARY as string,
      workspacePath: box.repo,
      authJson: '{}',
      opencodeConfig: operatorConfig(provider.baseURL),
      systematicVersion: 'latest',
      model: MODEL,
      dbPath: box.dbPath,
      authPath: box.authPath,
      env: box.env,
      runId: 2,
      runAttempt: 1,
      logger: createMockLogger(),
      deps: {
        startServer: async (spawnOptions, spawnLogger) => {
          const {startOpenCodeV2Server} = await import('@fro-bot/runtime')
          const result = await startOpenCodeV2Server(
            {...spawnOptions, timeouts: {agentReadyTimeoutMs: 90_000}},
            spawnLogger,
          )
          if (result.success) spawned = result.data
          return result
        },
      },
    })

    // #then the credential gate refuses, naming the provider
    const error = unwrapErr(started)
    expect(error.stage).toBe('credential-gate')
    expect(error.message).toContain('fake')

    // #and the process the start spawned is gone by the time it returns: observed on the real handle, before any
    // fallback cleanup (the suite's afterAll shutdown) gets a chance to be the thing that stops it
    expect(spawned).toBeDefined()
    const server = spawned as OpenCodeV2ServerHandle
    try {
      const exit = await Promise.race([
        server.exited,
        new Promise<'still-running'>(resolve => setTimeout(() => resolve('still-running'), PROCESS_EXIT_BOUND_MS)),
      ])
      expect(exit, `pid ${server.pid} still running ${PROCESS_EXIT_BOUND_MS} ms after the failed start`).not.toBe(
        'still-running',
      )
      expect(isProcessAlive(server.pid), `pid ${server.pid} is still alive`).toBe(false)
    } finally {
      // Only now does the fallback apply; on a failed assertion above it stops the leak the assertion found.
      handles.push(server)
    }
  }, 240_000)
})
