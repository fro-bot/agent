import type {Server} from 'node:http'
/**
 * Real-runner proof of `isolate-agent` (fro-bot/agent#2135, Phase 3).
 *
 * Gated: it needs a GitHub-hosted Linux runner with passwordless sudo, setpriv, setfacl and the pinned stock OpenCode V2
 * binary, so it skips everywhere else (including a developer Mac). The `Sandbox integration` job in ci.yaml sets the
 * gate and runs it. Locally it is only syntax- and type-checked.
 *
 * A fake OpenAI-compatible provider scripts the model: every probe is one `bash` tool call, run in the real server's real
 * tool shell as the sandbox user. Each "blocked" probe has a positive control: the same command run as the runner must
 * succeed (be OPEN), otherwise a BLOCKED result proves nothing.
 *
 *   FRO_BOT_SANDBOX_INTEGRATION=1 FRO_BOT_OPENCODE_V2_BIN=/path/to/opencode bun run test src/harness/phases/v2-server.sandbox
 */
import type {OpenCodeV2ServerHandle} from '@fro-bot/runtime'
import type {SandboxLifecycle, SandboxReleaseResult} from './sandbox-lifecycle.js'
import {Buffer} from 'node:buffer'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {startOpenCodeV2Server} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {createSandboxPreflightDeps, runSandboxPreflight} from '../../services/setup/sandbox-preflight.js'
import {createLogger} from '../../shared/logger.js'
import {createSandboxLifecycle} from './sandbox-lifecycle.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const gated =
  process.env.FRO_BOT_SANDBOX_INTEGRATION === '1' &&
  process.platform === 'linux' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
  BINARY !== undefined &&
  BINARY.length > 0

const TOKEN_MARK = process.env.PROBE_DUMMY_TOKEN ?? 'dummy-probe-token'
const PRELUDE = String.raw`R(){ echo "RESULT $1 $2 $3"; }; ev(){ head -c 240 | tr '\n\r\t' '   '; }; `
const q = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`

interface Probe {
  readonly id: string
  readonly category: 'blocked' | 'works' | 'info'
  readonly cmd: string
  /** Run the same command as the runner and require OPEN. */
  readonly control?: boolean
}

interface Row {
  readonly status: string
  readonly evidence: string
}

function parseRows(text: string): Map<string, Row[]> {
  const rows = new Map<string, Row[]>()
  for (const match of text.matchAll(/RESULT ([a-z0-9_]+) (BLOCKED|OPEN|WORKS|FAILED|INFO) ([^\n"]*)/g)) {
    const [, id, status, evidence] = match
    if (id === undefined || status === undefined) continue
    rows.set(id, [...(rows.get(id) ?? []), {status, evidence: (evidence ?? '').trim()}])
  }
  return rows
}

/** `BLOCKED` when the command could not read `file`; `OPEN` when it could. Read-only so a control cannot corrupt state. */
const readProbe = (id: string, file: string): string =>
  `f=${q(file)}; o=$( { cat "$f" >/dev/null; } 2>&1 ); rc=$?; ` +
  `if [ $rc -ne 0 ]; then R ${id} BLOCKED "rc=$rc [$(printf %s "$o" | ev)]"; else R ${id} OPEN "readable"; fi`

describe.skipIf(!gated)('isolate-agent against the real stock binary on a hosted runner', () => {
  const runnerHome = os.userInfo().homedir
  const runnerTemp = process.env.RUNNER_TEMP ?? path.join(runnerHome, 'work', '_temp')
  const logger = createLogger({phase: 'sandbox-integration'})
  const scratch = path.join(runnerTemp, `sandbox-it-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const secretDir = path.join(scratch, 'secret-0700')
  const sentinel = path.join(scratch, 'sentinel.txt')
  const canaries = {
    home: path.join(runnerHome, 'sandbox-it-canary-home.txt'),
    config: path.join(runnerHome, '.config', 'sandbox-it-canary', 'c.txt'),
    cache: path.join(runnerHome, '.cache', 'sandbox-it-canary', 'c.txt'),
    docker: path.join(runnerHome, '.docker', 'config.json'),
  }
  // The runner's own environment, minus the throwaway XDG paths the test harness sets, so the lifecycle resolves the
  // paths the Action would.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: runnerHome,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: workspace,
  }
  for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete env[name]

  let provider: Server | undefined
  let providerPort = 0
  let handle: OpenCodeV2ServerHandle | undefined
  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let rows = new Map<string, Row[]>()
  let controls = new Map<string, Row[]>()
  let identityLine = ''
  let straysAfterRelease = ''

  /** Rows of probe `id` that are missing or not `expected`; empty means the probe came out as expected. */
  const failuresFor = (id: string, expected: string): string[] => {
    const found = rows.get(id)
    if (found === undefined || found.length === 0) return [`${id}: no result`]
    return found.filter(row => row.status !== expected).map(row => `${id}: ${row.status} ${row.evidence}`)
  }

  const probes = (): Probe[] => [
    {
      id: 'identity',
      category: 'info',
      cmd: String.raw`R identity INFO "uid=$(id -u) gid=$(id -g) groups=[$(id -G)] $(grep -E '^(NoNewPrivs|CapInh|CapPrm|CapEff|CapBnd|CapAmb):' /proc/self/status | tr -s '\t\n' '  ')"`,
    },
    {
      id: 'proc_environ_parent',
      category: 'blocked',
      control: true,
      cmd: `${String.raw`if tr '\0' '\n' < /proc/${process.pid}/environ 2>/dev/null | grep -q ${q(TOKEN_MARK)}; then R proc_environ_parent OPEN "token visible"; `}else R proc_environ_parent BLOCKED "environ unreadable or token absent"; fi`,
    },
    {
      id: 'proc_ancestors',
      category: 'blocked',
      control: true,
      cmd:
        `pid=$PPID; leak=""; while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do ${String.raw`if tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -q ${q(TOKEN_MARK)}; then leak="$leak $pid"; fi; `}pid=$(awk '/^PPid:/{print $2}' /proc/$pid/status 2>/dev/null); done; ` +
        `if [ -z "$leak" ]; then R proc_ancestors BLOCKED "no ancestor environ shows the token"; else R proc_ancestors OPEN "token in:$leak"; fi`,
    },
    {
      id: 'github_env',
      category: 'blocked',
      control: true,
      cmd: readProbe('github_env', env.GITHUB_ENV ?? '/nonexistent'),
    },
    {
      id: 'github_output',
      category: 'blocked',
      control: true,
      cmd: readProbe('github_output', env.GITHUB_OUTPUT ?? '/nonexistent'),
    },
    {
      id: 'runner_temp_0700',
      category: 'blocked',
      control: true,
      cmd: readProbe('runner_temp_0700', `${secretDir}/secret.txt`),
    },
    {id: 'canary_home', category: 'blocked', control: true, cmd: readProbe('canary_home', canaries.home)},
    {id: 'canary_config', category: 'blocked', control: true, cmd: readProbe('canary_config', canaries.config)},
    {id: 'canary_cache', category: 'blocked', control: true, cmd: readProbe('canary_cache', canaries.cache)},
    {id: 'docker_config', category: 'blocked', control: true, cmd: readProbe('docker_config', canaries.docker)},
    {
      id: 'sudo',
      category: 'blocked',
      control: true,
      cmd: `out=$(sudo -n true 2>&1); rc=$?; if [ $rc -eq 0 ]; then R sudo OPEN "rc=0"; else R sudo BLOCKED "rc=$rc $(printf %s "$out" | ev)"; fi`,
    },
    {
      id: 'docker_socket',
      category: 'blocked',
      control: true,
      cmd:
        `out=$(curl -sS --max-time 5 --unix-socket /var/run/docker.sock http://localhost/_ping 2>&1); rc=$?; ` +
        `if [ $rc -eq 0 ] && [ "$out" = OK ]; then R docker_socket OPEN "ping ok"; else R docker_socket BLOCKED "rc=$rc $(printf %s "$out" | ev)"; fi`,
    },
    {
      id: 'checkout_rw_and_git',
      category: 'works',
      cmd:
        `cd ${q(workspace)} && echo model > model-wrote.txt && echo '// edit' >> README.md && git add model-wrote.txt && ` +
        `git commit -qm 'model commit' 2>&1 && R checkout_rw_and_git WORKS "$(git log -1 --format='%an <%ae>')" || R checkout_rw_and_git FAILED "$(git status 2>&1 | ev)"`,
    },
    {
      id: 'tools',
      category: 'works',
      cmd: `n=$(node -v 2>&1) && g=$(git --version 2>&1) && r=$(rg --version 2>&1 | head -1) && R tools WORKS "$n $g $r" || R tools FAILED "node/git/rg missing"`,
    },
    {
      id: 'provider_request',
      category: 'works',
      cmd: `c=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' http://127.0.0.1:${providerPort}/v1/models 2>&1); [ "$c" = 200 ] && R provider_request WORKS "$c" || R provider_request FAILED "[$c]"`,
    },
    {
      id: 'sandbox_dirs_writable',
      category: 'works',
      cmd:
        `ok=1; for d in "$HOME" "$XDG_DATA_HOME/opencode" "$XDG_CONFIG_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$XDG_STATE_HOME/opencode" ${q(responseDir)}; do ` +
        `t="$d/.w-$$"; if ( : > "$t" ) 2>/dev/null; then rm -f "$t"; else ok=0; echo "nowrite:$d"; fi; done; ` +
        `[ $ok = 1 ] && R sandbox_dirs_writable WORKS "home, four xdg dirs, response dir" || R sandbox_dirs_writable FAILED "see nowrite"`,
    },
    {
      id: 'key_file_readable',
      category: 'works',
      cmd: `[ "$(cat ${q(path.join(keyDir, 'fake.key'))} 2>/dev/null)" = sk-fake-canary ] && R key_file_readable WORKS "provider key readable by design" || R key_file_readable FAILED "unreadable"`,
    },
    {
      // Take-back inputs: a 0600 file, a 0700 dir, a symlink to a runner-owned sentinel, a hardlink to a file the model can write.
      id: 'create_takeback_fixtures',
      category: 'info',
      cmd:
        `cd ${q(workspace)} && umask 077 && echo secret > m-0600 && mkdir -p m-0700/inner && echo x > m-0700/inner/f && ` +
        `ln -s ${q(sentinel)} m-link && ln README.md m-hardlink && R create_takeback_fixtures INFO ok`,
    },
    {
      // Hostile git state the runner-side restore must undo (asserted after release).
      id: 'git_hostile_state',
      category: 'info',
      cmd:
        String.raw`cd ${q(workspace)} && rm -f .git/config && printf '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /tmp/sandbox-it-fsmon\n' > .git/config && ` +
        String.raw`printf '#!/bin/sh\ntouch /tmp/sandbox-it-hook\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit && R git_hostile_state INFO ok`,
    },
    {
      id: 'spawn_strays',
      category: 'info',
      cmd:
        `(setsid sleep 7771 >/dev/null 2>&1 &); (nohup sleep 7773 >/dev/null 2>&1 &); (trap '' TERM HUP; exec sleep 7774 >/dev/null 2>&1 &); ` +
        `sleep 0.3; R spawn_strays INFO "$(pgrep -d, -f 'sleep 777')"`,
    },
  ]

  beforeAll(async () => {
    const preflight = await runSandboxPreflight({...createSandboxPreflightDeps(createExecAdapter(), logger)})
    if (!preflight.ok) throw new Error(preflight.message)

    // --- Fixtures the runner owns -----------------------------------------------------------------------------
    for (const dir of [workspace, responseDir, keyDir, secretDir]) fs.mkdirSync(dir, {recursive: true})
    fs.chmodSync(secretDir, 0o700)
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret')
    fs.writeFileSync(sentinel, 'sentinel-content', {mode: 0o600})
    fs.writeFileSync(path.join(keyDir, 'fake.key'), 'sk-fake-canary', {mode: 0o600})
    for (const file of Object.values(canaries)) {
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, 'canary', {mode: 0o644})
    }
    const git = (...args: string[]): void => {
      const result = spawnSync('git', args, {cwd: workspace, encoding: 'utf8'})
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Runner Setup')
    git('config', 'user.email', 'setup@example.invalid')
    fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n')
    git('add', '.')
    git('commit', '-qm', 'init')
    // The identity setup configures globally for the runner; the sandbox must receive the same one.
    spawnSync('git', ['config', '--global', 'user.name', 'Fro Bot'])
    spawnSync('git', ['config', '--global', 'user.email', 'fro-bot@example.invalid'])

    // --- Positive controls: the same probes as the runner must be OPEN --------------------------------------------
    // Provider port is needed by a probe command, so the provider starts first.
    const steps = probes()
    const state = {results: [] as string[], done: false}
    provider = http.createServer((req, res) => {
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
        const step = steps[index]
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
    await new Promise<void>(resolve => provider?.listen(0, '127.0.0.1', resolve))
    const address = provider.address()
    providerPort = typeof address === 'object' && address !== null ? address.port : 0
    // Probe commands embed the provider port, so rebuild them now that it is known.
    steps.splice(0, steps.length, ...probes())

    controls = new Map(
      steps
        .filter(step => step.control === true)
        .map(step => {
          const result = spawnSync('bash', ['-c', PRELUDE + step.cmd], {
            encoding: 'utf8',
            cwd: workspace,
            env: process.env,
          })
          return [step.id, parseRows(result.stdout + result.stderr).get(step.id) ?? []] as const
        }),
    )

    // --- Hand over, launch, drive one turn --------------------------------------------------------------------------
    lifecycle = createSandboxLifecycle({
      tools: preflight.tools,
      env,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
    })
    const prepared = await lifecycle.prepare({
      keyFilePaths: [path.join(keyDir, 'fake.key')],
      ghConfigDir: null,
      repoSkills: null,
    })
    if (!prepared.success) throw new Error(prepared.error)

    const started = await startOpenCodeV2Server(
      {
        binaryPath: BINARY ?? '',
        directory: workspace,
        expectedPluginIds: [],
        env,
        sandbox: prepared.data,
        config: {
          share: 'disabled',
          model: 'fake/fixture-model',
          plugins: [],
          provider: {
            fake: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Fake',
              options: {
                baseURL: `http://127.0.0.1:${providerPort}/v1`,
                apiKey: `{file:${path.join(keyDir, 'fake.key')}}`,
              },
              models: {'fixture-model': {name: 'Fixture', tool_call: true, limit: {context: 100_000, output: 8000}}},
            },
          },
          // This suite tests the OS boundary, not OpenCode's permission layer.
          permission: {bash: 'allow', edit: 'allow', external_directory: 'allow', question: 'deny'},
        },
        timeouts: {agentReadyTimeoutMs: 90_000},
      },
      logger,
    )
    if (!started.success) throw new Error(`server start failed: ${started.error.message}`)
    handle = started.data

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
    const deadline = Date.now() + 240_000
    while (!state.done && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500))
    rows = parseRows(state.results.join('\n'))
    identityLine = rows.get('identity')?.[0]?.evidence ?? ''

    // --- Stop, verify, take back ------------------------------------------------------------------------------
    await handle.shutdown()
    released = await lifecycle.release()
    straysAfterRelease = spawnSync('pgrep', ['-f', 'sleep 777'], {encoding: 'utf8'}).stdout.trim()
  }, 600_000)

  afterAll(async () => {
    // A failed run must not leave the account or processes behind on a shared developer runner.
    await lifecycle?.release()
    await new Promise<void>(resolve => (provider === undefined ? resolve() : provider.close(() => resolve())))
    fs.rmSync(scratch, {recursive: true, force: true})
    for (const file of Object.values(canaries)) fs.rmSync(file, {force: true})
    fs.rmSync(path.dirname(canaries.config), {recursive: true, force: true})
    fs.rmSync(path.dirname(canaries.cache), {recursive: true, force: true})
  }, 120_000)

  it('has a positive control for every blocked row: the runner can do what the sandbox cannot', () => {
    // #given the controls ran as the runner before the sandbox started
    // #then each blocked probe with a control was OPEN for the runner (a BLOCKED sandbox result is only evidence then)
    const uncontrolled: string[] = []
    for (const [id, controlRows] of controls) {
      if (controlRows.length === 0 || controlRows.some(row => row.status !== 'OPEN')) {
        uncontrolled.push(`${id}: ${JSON.stringify(controlRows)}`)
      }
    }
    expect(uncontrolled).toEqual([])
  })

  it.each([
    'proc_environ_parent',
    'proc_ancestors',
    'github_env',
    'github_output',
    'runner_temp_0700',
    'canary_home',
    'canary_config',
    'canary_cache',
    'docker_config',
    'sudo',
    'docker_socket',
  ])('blocks %s from the model shell', id => {
    // #given the scripted model ran the probe in its real tool shell
    // #then it was BLOCKED
    expect(failuresFor(id, 'BLOCKED')).toEqual([])
  })

  it.each(['checkout_rw_and_git', 'tools', 'provider_request', 'sandbox_dirs_writable', 'key_file_readable'])(
    'keeps %s working for the model',
    id => {
      // #given the same real tool shell
      // #then the capability the model needs still works
      expect(failuresFor(id, 'WORKS')).toEqual([])
    },
  )

  it('runs the server and tool shell as the sandbox uid, with no extra groups, no_new_privs and no capabilities', () => {
    // #given the identity row
    // #then the shell is not the runner, has exactly one group, NoNewPrivs 1 and an empty capability set
    const runnerUid = String(os.userInfo().uid)
    expect(identityLine).toMatch(/uid=\d+/)
    expect(identityLine).not.toContain(`uid=${runnerUid} `)
    expect(identityLine).toMatch(/groups=\[\d+\]/)
    expect(identityLine).toContain('NoNewPrivs: 1')
    expect(identityLine).toMatch(/CapEff: 0000000000000000/)
    expect(identityLine).toMatch(/CapBnd: 0000000000000000/)
  })

  it('leaves no sandbox process behind: setsid, nohup and TERM-ignoring children are all gone', () => {
    // #given strays were started in the model shell
    expect(rows.get('spawn_strays')?.[0]?.evidence ?? '').toMatch(/\d/)
    // #then after stop nothing of them survives, and the lifecycle confirmed it
    expect(released?.stop).toBe('stopped')
    expect(straysAfterRelease).toBe('')
  })

  it("takes everything back: runner-owned and readable, links untouched, hardlinked inode still the runner's", () => {
    // #given the model created a 0600 file, a 0700 dir, a link to a runner sentinel and a hardlink to a runner-owned file
    expect(released?.restore).toBe('restored')
    const runnerUid = os.userInfo().uid
    const owned = (target: string): number => fs.lstatSync(target).uid
    // #then everything the model made is the runner's and readable
    expect(owned(path.join(workspace, 'm-0600'))).toBe(runnerUid)
    expect(fs.readFileSync(path.join(workspace, 'm-0600'), 'utf8').trim()).toBe('secret')
    expect(owned(path.join(workspace, 'm-0700'))).toBe(runnerUid)
    expect(fs.readFileSync(path.join(workspace, 'm-0700', 'inner', 'f'), 'utf8').trim()).toBe('x')
    // #and nothing under the roots still belongs to the sandbox
    const leftover = spawnSync('find', [workspace, responseDir, '-xdev', '!', '-user', String(runnerUid)], {
      encoding: 'utf8',
    })
    expect(leftover.stdout.trim()).toBe('')
    // #and the symlink is still a symlink, and the sentinel it pointed at was never touched
    expect(fs.lstatSync(path.join(workspace, 'm-link')).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('sentinel-content')
    expect(fs.statSync(sentinel).uid).toBe(runnerUid)
    expect(fs.statSync(sentinel).mode & 0o777).toBe(0o600)
    // #and the hardlinked runner file kept its owner
    expect(owned(path.join(workspace, 'README.md'))).toBe(runnerUid)
  })

  it('restores trusted git metadata over what the model wrote', () => {
    // #given the model replaced .git/config with an fsmonitor payload and planted a pre-commit hook
    // #then take-back put the pre-model versions back
    const config = fs.readFileSync(path.join(workspace, '.git', 'config'), 'utf8')
    expect(config).not.toContain('sandbox-it-fsmon')
    expect(fs.existsSync(path.join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false)
    // #and runner-side git runs no payload against the restored checkout
    spawnSync('git', ['status'], {cwd: workspace})
    expect(fs.existsSync('/tmp/sandbox-it-fsmon')).toBe(false)
    expect(fs.existsSync('/tmp/sandbox-it-hook')).toBe(false)
  })

  it('removes the sandbox account and every ACL entry it was granted', () => {
    // #given the release finished
    const passwd = fs.readFileSync('/etc/passwd', 'utf8')
    // #then the account is gone and no ACL names it on the paths we touched
    expect(passwd).not.toContain('fro-bot-sandbox')
    const acl = spawnSync('getfacl', ['-R', '-p', workspace], {encoding: 'utf8'}).stdout
    expect(acl).not.toContain('user:fro-bot-sandbox')
    expect(acl).not.toMatch(/^user:\d+:/m)
  })
})
