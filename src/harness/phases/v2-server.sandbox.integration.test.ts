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
 * Four suites run one after another (the sandbox account name is fixed, so two never overlap):
 *   1. the boundary: blocked and works rows, identity, quiescence, take-back;
 *   2. a provisioned `gh` config and an admitted repo skill;
 *   3. the persistence round trip (restore, isolated run, checkpoint and save, restore, isolated run);
 *   4. hostile git state written through the model's shell, then runner-side git after take-back.
 *
 *   FRO_BOT_SANDBOX_INTEGRATION=1 FRO_BOT_OPENCODE_V2_BIN=/path/to/opencode bun run test src/harness/phases/v2-server.sandbox
 */
import type {SandboxToolPaths} from '../../services/setup/sandbox-preflight.js'
import type {Logger} from '../../shared/logger.js'
import type {SandboxLifecycle, SandboxReleaseResult} from './sandbox-lifecycle.js'
import type {Probe, Row, ScriptedProvider} from './v2-server.sandbox.harness.js'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {getSessionDbBasenames} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {resolveBrokeredPushCommitMessage} from '../../features/delegated/commit-message.js'
import {reconstructChanges} from '../../features/delegated/reconstruct-changes.js'
import {
  buildCacheKeyComponents,
  buildPrimaryCacheKey,
  buildSaveCacheKey,
  restoreCache,
  saveCache,
  type CacheAdapter,
  type CacheKeyComponents,
} from '../../services/cache/index.js'
import {buildCachePathsV2} from '../../services/cache/paths.js'
import {createExecAdapter} from '../../services/setup/adapters.js'
import {admitRepoSkills, createRepoSkillsStagingRoot} from '../../services/setup/repo-skills.js'
import {createSandboxPreflightDeps, runSandboxPreflight} from '../../services/setup/sandbox-preflight.js'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {getGitHubRunAttempt, getInvocationIdentity} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'
import {createSandboxLifecycle} from './sandbox-lifecycle.js'
import {
  describeReconstruction,
  failuresFor,
  parseRows,
  PRELUDE,
  q,
  readProbe,
  readSessionIds,
  safeEnvPath,
  safeEnvToken,
  startScriptedProvider,
  startScriptedSession,
} from './v2-server.sandbox.harness.js'

const BINARY = process.env.FRO_BOT_OPENCODE_V2_BIN
const gated =
  process.env.FRO_BOT_SANDBOX_INTEGRATION === '1' &&
  process.platform === 'linux' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
  BINARY !== undefined &&
  BINARY.length > 0

const TOKEN_MARK = safeEnvToken(process.env.PROBE_DUMMY_TOKEN, 'dummy-probe-token')
const runnerHome = os.userInfo().homedir
const runnerTemp = safeEnvPath(process.env.RUNNER_TEMP, path.join(runnerHome, 'work', '_temp'))

// --- Helpers shared by the four suites ---------------------------------------------------------------------------------

/** The runner's own environment, minus the throwaway XDG paths the test harness sets, so paths resolve as the Action's do. */
function hostedEnv(workspace: string, xdgRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: runnerHome,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: workspace,
  }
  for (const name of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) delete env[name]
  if (xdgRoot !== undefined) {
    env.XDG_DATA_HOME = path.join(xdgRoot, 'data')
    env.XDG_CONFIG_HOME = path.join(xdgRoot, 'config')
    env.XDG_CACHE_HOME = path.join(xdgRoot, 'cache')
    env.XDG_STATE_HOME = path.join(xdgRoot, 'state')
  }
  return env
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'})
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** A one-commit checkout owned by the runner. Returns the commit, which stands in for the trusted head SHA. */
function initWorkspace(workspace: string): string {
  fs.mkdirSync(workspace, {recursive: true})
  git(workspace, 'init', '-q', '-b', 'main')
  git(workspace, 'config', 'user.name', 'Runner Setup')
  git(workspace, 'config', 'user.email', 'setup@example.invalid')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n')
  git(workspace, 'add', '.')
  git(workspace, 'commit', '-qm', 'init')
  // The identity setup configures globally for the runner; the sandbox must receive the same one.
  spawnSync('git', ['config', '--global', 'user.name', 'Fro Bot'])
  spawnSync('git', ['config', '--global', 'user.email', 'fro-bot@example.invalid'])
  return git(workspace, 'rev-parse', 'HEAD').trim()
}

/** Runs each control probe as the runner. A blocked row is only evidence when its control row is OPEN. */
function runControls(steps: readonly Probe[], cwd: string, env: NodeJS.ProcessEnv): Map<string, Row[]> {
  return new Map(
    steps
      .filter(step => step.control === true)
      .map(step => {
        const result = spawnSync('bash', ['-c', PRELUDE + step.cmd], {encoding: 'utf8', cwd, env})
        return [step.id, parseRows(result.stdout + result.stderr).get(step.id) ?? []] as const
      }),
  )
}

function uncontrolledRows(controls: ReadonlyMap<string, readonly Row[]>): string[] {
  const bad: string[] = []
  for (const [id, controlRows] of controls) {
    if (controlRows.length === 0 || controlRows.some(row => row.status !== 'OPEN')) {
      bad.push(`${id}: ${JSON.stringify(controlRows)}`)
    }
  }
  return bad
}

interface IsolatedRunOptions {
  readonly tools: SandboxToolPaths
  readonly env: NodeJS.ProcessEnv
  readonly workspace: string
  readonly responseDir: string
  readonly keyFile: string
  readonly steps: readonly Probe[]
  readonly logger: Logger
  readonly ghConfigDir?: string
  readonly repoSkills?: {readonly stagingRoot: string; readonly admittedDir: string | null}
  /** Called with the lifecycle as soon as it exists, so a suite's `afterAll` can release it if the run throws. */
  readonly onLifecycle?: (lifecycle: SandboxLifecycle) => void
}

interface IsolatedRunResult {
  readonly rows: ReadonlyMap<string, readonly Row[]>
  readonly released: SandboxReleaseResult
}

/** One whole isolated run: handoff, launch as the sandbox, one scripted turn, graceful stop, verify, take back. */
async function runIsolated(options: IsolatedRunOptions): Promise<IsolatedRunResult> {
  const provider: ScriptedProvider = await startScriptedProvider(() => options.steps)
  const lifecycle = createSandboxLifecycle({
    tools: options.tools,
    env: options.env,
    runnerHome,
    workspacePath: options.workspace,
    responseDir: options.responseDir,
    logger: options.logger,
  })
  options.onLifecycle?.(lifecycle)
  try {
    const prepared = await lifecycle.prepare({
      keyFilePaths: [options.keyFile],
      ghConfigDir: options.ghConfigDir ?? null,
      repoSkills: options.repoSkills ?? null,
    })
    if (!prepared.success) throw new Error(prepared.error)
    const handle = await startScriptedSession({
      binary: BINARY ?? '',
      workspace: options.workspace,
      env: options.env,
      sandbox: prepared.data,
      keyFile: options.keyFile,
      provider,
      logger: options.logger,
    })
    const rows = parseRows(provider.state.results.join('\n'))
    await handle.shutdown()
    const released = await lifecycle.release()
    return {rows, released}
  } finally {
    await lifecycle.release()
    await provider.close()
  }
}

function writeKeyFile(keyDir: string): string {
  fs.mkdirSync(keyDir, {recursive: true})
  const keyFile = path.join(keyDir, 'fake.key')
  fs.writeFileSync(keyFile, 'sk-fake-canary', {mode: 0o600})
  return keyFile
}

async function preflightTools(logger: Logger): Promise<SandboxToolPaths> {
  // This suite runs from the checkout, which the action-location gate refuses for a real run. The gate has its own unit
  // tests; here the install is declared to be a published location so the rest of the preflight is exercised for real.
  const preflight = await runSandboxPreflight({
    ...createSandboxPreflightDeps(createExecAdapter(), logger),
    actionPaths: ['/opt/fro-bot-published-action/dist', '/opt/fro-bot-published-action'],
    invokedAs: '/opt/fro-bot-published-action/dist/main.js',
  })
  if (!preflight.ok) throw new Error(preflight.message)
  return preflight.tools
}

// --- 1. The boundary ---------------------------------------------------------------------------------------------------

describe.skipIf(!gated)('isolate-agent against the real stock binary on a hosted runner', () => {
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
  const env = hostedEnv(workspace)

  let provider: ScriptedProvider | undefined
  let providerPort = 0
  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let rows = new Map<string, Row[]>()
  let controls = new Map<string, Row[]>()
  let identityLine = ''
  let straysAfterRelease = ''

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
      cmd: readProbe('github_env', safeEnvPath(env.GITHUB_ENV, '/nonexistent')),
    },
    {
      id: 'github_output',
      category: 'blocked',
      control: true,
      cmd: readProbe('github_output', safeEnvPath(env.GITHUB_OUTPUT, '/nonexistent')),
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
        `ln -s ${q(sentinel)} m-link && ln README.md m-hardlink && ` +
        // Mode-000 file and directory: take-back must leave the owner rwX so the runner can read them again.
        `echo z > m-000 && chmod 000 m-000 && mkdir m-000d && echo y > m-000d/f && chmod 000 m-000d && ` +
        `R create_takeback_fixtures INFO ok`,
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
    const tools = await preflightTools(logger)

    // --- Fixtures the runner owns -----------------------------------------------------------------------------
    for (const dir of [responseDir, secretDir]) fs.mkdirSync(dir, {recursive: true})
    fs.chmodSync(secretDir, 0o700)
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'top secret')
    fs.writeFileSync(sentinel, 'sentinel-content', {mode: 0o600})
    const keyFile = writeKeyFile(keyDir)
    for (const file of Object.values(canaries)) {
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, 'canary', {mode: 0o644})
    }
    initWorkspace(workspace)
    // ACLs that existed before the run: a named access entry on a file and a dir, and a named default entry on the dir.
    // Take-back removes only this run's entries, so these must survive it.
    fs.writeFileSync(path.join(workspace, 'pre-acl'), 'pre-existing ACL\n')
    fs.mkdirSync(path.join(workspace, 'pre-acl-dir'))
    for (const args of [
      ['-m', 'u:nobody:r-x', path.join(workspace, 'pre-acl')],
      ['-m', 'u:nobody:r-x', path.join(workspace, 'pre-acl-dir')],
      ['-d', '-m', 'u:nobody:r-x', path.join(workspace, 'pre-acl-dir')],
    ]) {
      const result = spawnSync('setfacl', args, {encoding: 'utf8'})
      if (result.status !== 0) throw new Error(`setfacl ${args.join(' ')}: ${result.stderr}`)
    }

    // The provider starts first: a probe command embeds its port, and the steps are read lazily.
    provider = await startScriptedProvider(probes)
    providerPort = provider.port

    // --- Positive controls: the same probes as the runner must be OPEN --------------------------------------------
    controls = runControls(probes(), workspace, process.env)

    // --- Hand over, launch, drive one turn --------------------------------------------------------------------------
    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
    })
    const prepared = await lifecycle.prepare({keyFilePaths: [keyFile], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)
    const handle = await startScriptedSession({
      binary: BINARY ?? '',
      workspace,
      env,
      sandbox: prepared.data,
      keyFile,
      provider,
      logger,
    })
    rows = parseRows(provider.state.results.join('\n'))
    identityLine = rows.get('identity')?.[0]?.evidence ?? ''

    // --- Stop, verify, take back ------------------------------------------------------------------------------
    await handle.shutdown()
    released = await lifecycle.release()
    straysAfterRelease = spawnSync('pgrep', ['-f', 'sleep 777'], {encoding: 'utf8'}).stdout.trim()
  }, 600_000)

  afterAll(async () => {
    // A failed run must not leave the account or processes behind on a shared developer runner.
    await lifecycle?.release()
    await provider?.close()
    fs.rmSync(scratch, {recursive: true, force: true})
    for (const file of Object.values(canaries)) fs.rmSync(file, {force: true})
    fs.rmSync(path.dirname(canaries.config), {recursive: true, force: true})
    fs.rmSync(path.dirname(canaries.cache), {recursive: true, force: true})
  }, 120_000)

  it('has a positive control for every blocked row: the runner can do what the sandbox cannot', () => {
    // #given the controls ran as the runner before the sandbox started
    // #then each blocked probe with a control was OPEN for the runner (a BLOCKED sandbox result is only evidence then)
    expect(uncontrolledRows(controls)).toEqual([])
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
    expect(failuresFor(rows, id, 'BLOCKED')).toEqual([])
  })

  it.each(['checkout_rw_and_git', 'tools', 'provider_request', 'sandbox_dirs_writable', 'key_file_readable'])(
    'keeps %s working for the model',
    id => {
      // #given the same real tool shell
      // #then the capability the model needs still works
      expect(failuresFor(rows, id, 'WORKS')).toEqual([])
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

  it('makes mode-000 files and directories the model created readable by the runner again', () => {
    // #given the model created a mode-000 file and a mode-000 directory holding a file
    expect(released?.restore).toBe('restored')
    // #then the same take-back pass gave the owner rwX, so the runner reads them (it could not before)
    expect(fs.readFileSync(path.join(workspace, 'm-000'), 'utf8').trim()).toBe('z')
    expect(fs.readFileSync(path.join(workspace, 'm-000d', 'f'), 'utf8').trim()).toBe('y')
  })

  it("removes only this run's ACL entries: a pre-existing named ACL survives and no default entry of this run remains", () => {
    // #given ACLs that existed before the run, and the handoff's own access and default entries
    const read = (target: string): string => spawnSync('getfacl', ['-p', target], {encoding: 'utf8'}).stdout
    // #then the pre-existing named access entries and the pre-existing default entry are intact
    expect(read(path.join(workspace, 'pre-acl'))).toContain('user:nobody:r-x')
    expect(read(path.join(workspace, 'pre-acl-dir'))).toContain('user:nobody:r-x')
    expect(read(path.join(workspace, 'pre-acl-dir'))).toContain('default:user:nobody:r-x')
    // #and nothing of this run is left: no entry for the (deleted, so numeric) sandbox uid, none for the runner
    const tree = spawnSync('getfacl', ['-R', '-p', workspace, responseDir], {encoding: 'utf8'}).stdout
    expect(tree).not.toMatch(/^(default:)?user:\d+:/m)
    expect(tree).not.toMatch(new RegExp(`^(default:)?user:${os.userInfo().username}:`, 'm'))
  })

  it('leaves the files the model created non-executable: take-back must not widen the ACL mask', () => {
    // #given regular files the model created without ever setting an execute bit
    const files = ['model-wrote.txt', 'm-0600', path.join('m-0700', 'inner', 'f')]
    // #when their modes are read after take-back
    const modes = Object.fromEntries(
      files.map(file => [file, (fs.lstatSync(path.join(workspace, file)).mode & 0o777).toString(8).padStart(3, '0')]),
    )
    // #then none has an execute bit in any class. A removed named entry used to make setfacl recalculate the mask as the
    // union of the stored entries (wider than the mask the file was created with), so the group class gained x, and
    // reconstruction then refused the file as executable
    const executable = Object.entries(modes)
      .filter(([, mode]) => /[1357]/.test(mode))
      .map(([file, mode]) => `${file}: ${mode}`)
    expect(executable).toEqual([])
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

// --- 2. A provisioned gh config and an admitted repo skill --------------------------------------------------------------

describe.skipIf(!gated)('isolate-agent with a provisioned gh config and an admitted repo skill', () => {
  const logger = createLogger({phase: 'sandbox-integration-provision'})
  const scratch = path.join(runnerTemp, `sandbox-it-prov-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  // The shape the Action provisions in provision mode: a `gh-config-*` directory directly under RUNNER_TEMP.
  const ghConfigDir = path.join(runnerTemp, `gh-config-it-${process.pid}`)
  const ghHost = 'gh.example.test'
  // A syntactically plausible dummy. It is never a real token and no network call is made with it.
  const ghDummyToken = 'gho_dummyDummyDummyDummyDummyDummy000000'
  // The runner's own gh config. Only created when absent, and only then removed.
  const runnerGhHosts = path.join(runnerHome, '.config', 'gh', 'hosts.yml')
  let createdRunnerGhHosts = false
  const skillMarker = `SKILL-MARKER-${process.pid}`
  let stagingRoot = ''
  let admittedDir = ''
  let lifecycle: SandboxLifecycle | undefined
  let rows: ReadonlyMap<string, readonly Row[]> = new Map()
  let controls = new Map<string, Row[]>()
  let released: SandboxReleaseResult | undefined

  const probes = (): Probe[] => [
    {
      id: 'gh_config_dir_env',
      category: 'works',
      cmd: `[ "$GH_CONFIG_DIR" = ${q(ghConfigDir)} ] && R gh_config_dir_env WORKS "$GH_CONFIG_DIR" || R gh_config_dir_env FAILED "[$GH_CONFIG_DIR]"`,
    },
    {
      // `gh auth token` reads the token from the configured hosts.yml without any network call.
      id: 'gh_auth_token',
      category: 'works',
      cmd:
        `t=$(gh auth token --hostname ${ghHost} 2>&1); ` +
        `if [ "$t" = ${q(ghDummyToken)} ]; then R gh_auth_token WORKS "provisioned token readable by design"; ` +
        `else R gh_auth_token FAILED "$(printf %s "$t" | ev)"; fi`,
    },
    {
      id: 'gh_runner_hosts',
      category: 'blocked',
      control: true,
      cmd: readProbe('gh_runner_hosts', runnerGhHosts),
    },
    {
      id: 'skill_read',
      category: 'works',
      cmd:
        `f=${q(path.join(admittedDir, 'demo-skill', 'SKILL.md'))}; ` +
        `if grep -q ${q(skillMarker)} "$f" 2>/dev/null; then R skill_read WORKS "admitted skill readable"; else R skill_read FAILED "$(cat "$f" 2>&1 | ev)"; fi`,
    },
    {
      id: 'skill_dir_read_only',
      category: 'blocked',
      control: true,
      cmd:
        `t=${q(path.join(admittedDir, 'demo-skill'))}/.w-$$; ` +
        `if ( : > "$t" ) 2>/dev/null; then rm -f "$t"; R skill_dir_read_only OPEN "writable"; else R skill_dir_read_only BLOCKED "not writable"; fi`,
    },
    {
      id: 'staging_root_listing',
      category: 'blocked',
      control: true,
      cmd:
        `o=$(ls -A ${q(stagingRoot)} 2>&1); rc=$?; ` +
        `if [ $rc -eq 0 ]; then R staging_root_listing OPEN "listable"; else R staging_root_listing BLOCKED "rc=$rc $(printf %s "$o" | ev)"; fi`,
    },
    {
      id: 'staging_root_other_file',
      category: 'blocked',
      control: true,
      cmd: readProbe('staging_root_other_file', path.join(stagingRoot, 'runner-only-note.txt')),
    },
  ]

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    for (const dir of [responseDir, workspace]) fs.mkdirSync(dir, {recursive: true})
    initWorkspace(workspace)
    const keyFile = writeKeyFile(keyDir)

    // The provisioned gh config: a runner-owned 0700 directory with a dummy hosts entry.
    fs.mkdirSync(ghConfigDir, {mode: 0o700})
    fs.writeFileSync(
      path.join(ghConfigDir, 'hosts.yml'),
      `${ghHost}:\n    oauth_token: ${ghDummyToken}\n    user: dummy-user\n    git_protocol: https\n`,
      {mode: 0o600},
    )
    // Created exclusively (`wx`): no separate existence check, so nothing can slip in between the check and the write.
    fs.mkdirSync(path.dirname(runnerGhHosts), {recursive: true})
    try {
      fs.writeFileSync(runnerGhHosts, 'github.com:\n    oauth_token: runner-dummy\n    user: runner\n', {
        mode: 0o644,
        flag: 'wx',
      })
      createdRunnerGhHosts = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    // The admitted repo skill goes through the Action's real admission, into a real staging root.
    const staging = createRepoSkillsStagingRoot(runnerTemp)
    if (!staging.success) throw new Error(staging.error)
    stagingRoot = staging.data
    const sourceDir = path.join(stagingRoot, 'source-tree')
    fs.mkdirSync(path.join(sourceDir, 'demo-skill'), {recursive: true})
    fs.writeFileSync(
      path.join(sourceDir, 'demo-skill', 'SKILL.md'),
      `---\nname: demo-skill\ndescription: A demo skill for the sandbox suite\n---\n${skillMarker}\n`,
    )
    fs.writeFileSync(path.join(stagingRoot, 'runner-only-note.txt'), 'runner only', {mode: 0o600})
    const bundled = path.join(scratch, 'bundled-skills')
    fs.mkdirSync(path.join(bundled, 'bundled-one'), {recursive: true})
    fs.writeFileSync(
      path.join(bundled, 'bundled-one', 'SKILL.md'),
      '---\nname: bundled-one\ndescription: A stand-in for a bundled skill\n---\nbundled\n',
    )
    const admission = await admitRepoSkills({
      sourceDir,
      stagingRoot,
      bundledSkillsDirectories: [bundled],
      symlinkedSkillIds: [],
      logger,
    })
    if (!admission.success) throw new Error(admission.error)
    if (admission.data.directory === null) throw new Error('the demo skill was not admitted')
    admittedDir = admission.data.directory

    const env = hostedEnv(workspace)
    controls = runControls(probes(), workspace, env)
    const result = await runIsolated({
      tools,
      env,
      workspace,
      responseDir,
      keyFile,
      steps: probes(),
      logger,
      ghConfigDir,
      repoSkills: {stagingRoot, admittedDir},
      onLifecycle: value => {
        lifecycle = value
      },
    })
    rows = result.rows
    released = result.released
  }, 600_000)

  afterAll(async () => {
    await lifecycle?.release()
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(ghConfigDir, {recursive: true, force: true})
    if (stagingRoot !== '') fs.rmSync(stagingRoot, {recursive: true, force: true})
    if (createdRunnerGhHosts) fs.rmSync(runnerGhHosts, {force: true})
  }, 120_000)

  it('has a positive control for every blocked row of this suite', () => {
    // #given the controls ran as the runner before the sandbox started
    // #then the runner could read the gh config, write the skill dir, list the staging root and read the other file
    expect(uncontrolledRows(controls)).toEqual([])
  })

  it('gives the model the provisioned gh config: GH_CONFIG_DIR is set and `gh auth token` returns the dummy token', () => {
    // #given the config dir was handed over and named in the server environment
    // #then the model's gh reads it
    expect(failuresFor(rows, 'gh_config_dir_env', 'WORKS')).toEqual([])
    expect(failuresFor(rows, 'gh_auth_token', 'WORKS')).toEqual([])
  })

  it("keeps the runner's own gh config out of reach", () => {
    // #given the runner has its own ~/.config/gh/hosts.yml
    // #then the model cannot read it (the control proved the runner can)
    expect(failuresFor(rows, 'gh_runner_hosts', 'BLOCKED')).toEqual([])
  })

  it('lets the model read an admitted repo skill but not write to it, and sees nothing else of the staging root', () => {
    // #given the staging root is traverse-only and only the admitted skills tree is readable
    // #then the skill reads, the skills dir is read-only, the staging root cannot be listed and its other file is unreadable
    expect(failuresFor(rows, 'skill_read', 'WORKS')).toEqual([])
    expect(failuresFor(rows, 'skill_dir_read_only', 'BLOCKED')).toEqual([])
    expect(failuresFor(rows, 'staging_root_listing', 'BLOCKED')).toEqual([])
    expect(failuresFor(rows, 'staging_root_other_file', 'BLOCKED')).toEqual([])
  })

  it('takes everything back and leaves the admitted skill and the gh config as the runner had them', () => {
    // #given the release finished
    expect(released?.stop).toBe('stopped')
    expect(released?.restore).toBe('restored')
    const runnerUid = os.userInfo().uid
    // #then the skill is intact and runner-owned, and the gh hosts file is unchanged and runner-owned
    const skill = path.join(admittedDir, 'demo-skill', 'SKILL.md')
    expect(fs.readFileSync(skill, 'utf8')).toContain(skillMarker)
    expect(fs.statSync(skill).uid).toBe(runnerUid)
    const hosts = path.join(ghConfigDir, 'hosts.yml')
    expect(fs.readFileSync(hosts, 'utf8')).toContain(ghDummyToken)
    expect(fs.statSync(hosts).uid).toBe(runnerUid)
    const acl = spawnSync('getfacl', ['-R', '-p', ghConfigDir, stagingRoot], {encoding: 'utf8'}).stdout
    expect(acl).not.toMatch(/^user:\d+:/m)
  })
})

// --- 3. The persistence round trip --------------------------------------------------------------------------------------

interface StoredCacheEntry {
  readonly key: string
  readonly paths: readonly string[]
  readonly dir: string
}

/** A cache backend on a local directory. Records every call so the suite can compare restore paths with save paths. */
function createLocalDirCacheAdapter(root: string): {
  readonly adapter: CacheAdapter
  readonly entries: StoredCacheEntry[]
  readonly restoreCalls: {readonly paths: readonly string[]; readonly primaryKey: string}[]
} {
  fs.mkdirSync(root, {recursive: true})
  const entries: StoredCacheEntry[] = []
  const restoreCalls: {paths: readonly string[]; primaryKey: string}[] = []
  // @actions/cache keys an entry's restorability on a hash of the path list: the same list means the same version.
  const versionOf = (paths: readonly string[]): string => createHash('sha256').update(paths.join('|')).digest('hex')
  const adapter: CacheAdapter = {
    saveCache: async (paths, key) => {
      const dir = path.join(root, `${entries.length}-${versionOf(paths).slice(0, 12)}`)
      fs.mkdirSync(dir, {recursive: true})
      for (const [index, source] of paths.entries()) {
        if (fs.existsSync(source)) {
          fs.cpSync(source, path.join(dir, String(index)), {recursive: true, verbatimSymlinks: true})
        }
      }
      entries.push({key, paths: [...paths], dir})
      return entries.length
    },
    restoreCache: async (paths, primaryKey, restoreKeys) => {
      restoreCalls.push({paths: [...paths], primaryKey})
      const wanted = [primaryKey, ...restoreKeys]
      const hit = entries
        .toReversed()
        .find(entry => versionOf(entry.paths) === versionOf(paths) && wanted.some(key => entry.key.startsWith(key)))
      if (hit === undefined) return undefined
      for (const [index, target] of paths.entries()) {
        const source = path.join(hit.dir, String(index))
        if (!fs.existsSync(source)) continue
        fs.mkdirSync(path.dirname(target), {recursive: true})
        fs.cpSync(source, target, {recursive: true, verbatimSymlinks: true})
      }
      return hit.key
    },
  }
  return {adapter, entries, restoreCalls}
}

function fileSizeOrZero(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function integrityCheck(dbPath: string): string {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('PRAGMA integrity_check').get() as {integrity_check?: unknown} | undefined
    return String(row?.integrity_check)
  } finally {
    db.close()
  }
}

describe.skipIf(!gated)('isolate-agent session persistence round trip', () => {
  const logger = createLogger({phase: 'sandbox-integration-persistence'})
  const scratch = path.join(runnerTemp, `sandbox-it-persist-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const xdgRoot = path.join(scratch, 'xdg')
  const dataDir = path.join(xdgRoot, 'data', 'opencode')
  const storagePath = path.join(dataDir, 'storage')
  const authPath = path.join(dataDir, 'auth.json')
  const projectIdPath = path.join(workspace, '.git', 'opencode')
  const dbName = getSessionDbBasenames('v2').main
  const dbPath = path.join(dataDir, dbName)
  const walPath = path.join(dataDir, getSessionDbBasenames('v2').wal)
  const components: CacheKeyComponents = {...buildCacheKeyComponents(), repo: 'sandbox-it/persist', ref: 'main'}
  const runId = 4242
  let lifecycle: SandboxLifecycle | undefined

  const facts = {
    coldRestoreHit: true,
    run1: undefined as IsolatedRunResult | undefined,
    run2: undefined as IsolatedRunResult | undefined,
    sessionsAfterRun1: [] as string[],
    walBytesBeforeSave: -1,
    saveOutcome: undefined as Awaited<ReturnType<typeof saveCache>> | undefined,
    walBytesAfterSave: -1,
    integrityAfterSave: '',
    saved: undefined as StoredCacheEntry | undefined,
    restoreHit: undefined as Awaited<ReturnType<typeof restoreCache>> | undefined,
    restoreCallPaths: [] as (readonly string[])[],
    versionFile: '',
    walBytesAfterRestore: -1,
    integrityAfterRestore: '',
    sessionsAfterRestore: [] as string[],
    sessionsAfterRun2: [] as string[],
    integrityAfterRun2: '',
  }

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    for (const dir of [responseDir]) fs.mkdirSync(dir, {recursive: true})
    initWorkspace(workspace)
    const keyFile = writeKeyFile(keyDir)
    const env = hostedEnv(workspace, xdgRoot)
    const backend = createLocalDirCacheAdapter(path.join(scratch, 'cache-backend'))
    const cacheOptions = {components, logger, storagePath, authPath, projectIdPath, cacheAdapter: backend.adapter}

    // --- Run 1: a cold restore, then an isolated run that writes a session and a storage file ------------------------------
    const cold = await restoreCache(cacheOptions)
    facts.coldRestoreHit = cold.hit
    facts.run1 = await runIsolated({
      tools,
      env,
      workspace,
      responseDir,
      keyFile,
      logger,
      onLifecycle: value => {
        lifecycle = value
      },
      steps: [
        {
          id: 'persist_write_storage',
          category: 'works',
          cmd:
            `echo storage-from-the-sandbox > "$XDG_DATA_HOME/opencode/storage/sandbox-note.txt" && ` +
            `R persist_write_storage WORKS "wrote storage" || R persist_write_storage FAILED "write failed"`,
        },
      ],
    })
    facts.sessionsAfterRun1 = readSessionIds(dbPath)

    // --- Checkpoint and save through the real save path ----------------------------------------------------------------------
    facts.walBytesBeforeSave = fileSizeOrZero(walPath)
    facts.saveOutcome = await saveCache({...cacheOptions, runId})
    facts.walBytesAfterSave = fileSizeOrZero(walPath)
    facts.integrityAfterSave = integrityCheck(dbPath)
    facts.saved = backend.entries.at(-1)

    // --- Run 2: wipe local state, restore, and run isolated again on the restored database ---------------------------------
    fs.rmSync(dataDir, {recursive: true, force: true})
    facts.restoreHit = await restoreCache(cacheOptions)
    facts.restoreCallPaths = backend.restoreCalls.map(call => call.paths)
    facts.versionFile = fs.readFileSync(path.join(storagePath, '.version'), 'utf8').trim()
    facts.walBytesAfterRestore = fileSizeOrZero(walPath)
    facts.integrityAfterRestore = integrityCheck(dbPath)
    facts.sessionsAfterRestore = readSessionIds(dbPath)
    facts.run2 = await runIsolated({
      tools,
      env,
      workspace,
      responseDir,
      keyFile,
      logger,
      onLifecycle: value => {
        lifecycle = value
      },
      steps: [
        {
          id: 'persist_read_restored',
          category: 'works',
          cmd:
            `d="$XDG_DATA_HOME/opencode"; ` +
            `[ "$(cat "$d/storage/sandbox-note.txt" 2>/dev/null)" = storage-from-the-sandbox ] && [ -r "$d/${dbName}" ] && [ -w "$d/${dbName}" ] && ` +
            `R persist_read_restored WORKS "restored storage and database usable by the sandbox" || R persist_read_restored FAILED "unusable"`,
        },
      ],
    })
    facts.sessionsAfterRun2 = readSessionIds(dbPath)
    facts.integrityAfterRun2 = integrityCheck(dbPath)
  }, 900_000)

  afterAll(async () => {
    await lifecycle?.release()
    fs.rmSync(scratch, {recursive: true, force: true})
  }, 120_000)

  it('starts cold, then the first isolated run writes to storage and the lifecycle stops and restores cleanly', () => {
    // #given an empty cache backend
    expect(facts.coldRestoreHit).toBe(false)
    // #then run 1 worked in its sandbox, stopped, restored, and left a session in the database
    expect(failuresFor(facts.run1?.rows ?? new Map(), 'persist_write_storage', 'WORKS')).toEqual([])
    expect(facts.run1?.released.stop).toBe('stopped')
    expect(facts.run1?.released.restore).toBe('restored')
    expect(facts.sessionsAfterRun1.length).toBeGreaterThan(0)
  })

  it('saves through the real save path: persisted, the expected key and paths, a clean WAL and a sound database', () => {
    // #given the sandbox-written state after take-back
    // #then the real saveCache persisted it under the save key, with exactly the path list a restore will ask for
    expect(facts.saveOutcome).toMatchObject({cachePersisted: true, outcome: 'persisted'})
    expect(facts.saved?.key).toBe(buildSaveCacheKey(components, runId, getGitHubRunAttempt(), getInvocationIdentity()))
    expect(facts.saved?.key.startsWith(buildPrimaryCacheKey(components))).toBe(true)
    expect(facts.saved?.paths).toEqual(buildCachePathsV2(storagePath, projectIdPath))
    // #and the checkpoint left no write-ahead log behind and the database is sound
    expect(facts.walBytesAfterSave).toBe(0)
    expect(facts.integrityAfterSave).toBe('ok')
  })

  it('restores in the second run: a hit on the same key, with identical paths (so the same cache version)', () => {
    // #given local state was wiped and the same options restored
    // #then it is a clean cache hit on the saved key
    expect(facts.restoreHit).toMatchObject({hit: true, corrupted: false, source: 'cache', key: facts.saved?.key})
    // #and some restore request used exactly the path list the save used
    expect(facts.restoreCallPaths).toContainEqual(facts.saved?.paths)
    // #and the storage version marker is the current one
    expect(facts.versionFile).toBe(String(STORAGE_VERSION))
  })

  it('restores a clean, sound database holding the first run session', () => {
    // #given the restored files
    // #then there is no WAL, the database passes integrity_check and it still holds run 1's sessions
    expect(facts.walBytesAfterRestore).toBe(0)
    expect(facts.integrityAfterRestore).toBe('ok')
    expect(facts.sessionsAfterRestore).toEqual(facts.sessionsAfterRun1)
  })

  it('runs isolated again on the restored state: the sandbox uses it and the run adds a session', () => {
    // #given the second isolated run started on the restored files
    // #then the sandbox could read the storage note and read and write the database
    expect(failuresFor(facts.run2?.rows ?? new Map(), 'persist_read_restored', 'WORKS')).toEqual([])
    expect(facts.run2?.released.stop).toBe('stopped')
    expect(facts.run2?.released.restore).toBe('restored')
    // #and the database kept every earlier session, gained one, and is still sound
    expect(facts.sessionsAfterRun2).toEqual(expect.arrayContaining(facts.sessionsAfterRun1))
    expect(facts.sessionsAfterRun2.length).toBeGreaterThan(facts.sessionsAfterRun1.length)
    expect(facts.integrityAfterRun2).toBe('ok')
  })
})

// --- 4. Hostile git state written through the model's shell -------------------------------------------------------------

describe.skipIf(!gated)('isolate-agent hostile git state through a real model shell', () => {
  const logger = createLogger({phase: 'sandbox-integration-git'})
  const scratch = path.join(runnerTemp, `sandbox-it-git-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  // The payload scripts live in the response dir (handed to the sandbox, outside the checkout). They write their markers
  // into a directory only the runner can write, so a marker proves a RUNNER-side git ran the payload.
  const payloadDir = path.join(responseDir, 'hostile')
  const markerDir = path.join(scratch, 'markers')
  const payloads = ['fsmon', 'textconv', 'clean', 'hook'] as const
  const markerOf = (name: string): string => path.join(markerDir, `ran-${name}`)
  const hostileConfig =
    `[core]\n\tfsmonitor = ${path.join(payloadDir, 'fsmon.sh')}\n` +
    `[diff "x"]\n\ttextconv = ${path.join(payloadDir, 'textconv.sh')}\n` +
    `[filter "x"]\n\tclean = ${path.join(payloadDir, 'clean.sh')}\n`
  const hookBody = `#!/bin/sh\nexec ${path.join(payloadDir, 'hook.sh')}\n`
  const commitSubject = 'fix: sandbox commit'
  let trustedHead = ''
  let lifecycle: SandboxLifecycle | undefined
  let result: IsolatedRunResult | undefined
  let markersFromControl: string[] = []
  const after = {
    configAfterTakeBack: '',
    hookExistsAfterTakeBack: true,
    markersAfterTrustedGit: [] as string[],
    reconstruct: undefined as Awaited<ReturnType<typeof reconstructChanges>> | undefined,
    commitMessage: '',
  }

  const probes = (): Probe[] => [
    {
      // Commit first, with a clean config, so the model never runs git under the hostile config it writes next.
      id: 'git_model_commit',
      category: 'works',
      cmd:
        `${String.raw`cd ${q(workspace)} && printf '*.dat diff=x filter=x\n' > .gitattributes && echo v1 > data.dat && `}git add .gitattributes data.dat && git commit -qm ${q(commitSubject)} 2>&1 && ` +
        `R git_model_commit WORKS "$(git log -1 --format=%s)" || R git_model_commit FAILED "$(git status 2>&1 | ev)"`,
    },
    {
      id: 'git_hostile_payloads',
      category: 'info',
      cmd: `mkdir -p ${q(payloadDir)} && for n in ${payloads.join(' ')}; do ${String.raw`printf '#!/bin/sh\necho ran >> %s/ran-%s\ncat\n' ${q(markerDir)} "$n" > ${q(payloadDir)}/"$n".sh && chmod +x ${q(payloadDir)}/"$n".sh; done && `}R git_hostile_payloads INFO ok`,
    },
    {
      // Replace .git/config by rename (fsmonitor, textconv, a clean filter) and plant a post-index-change hook.
      id: 'git_hostile_config',
      category: 'info',
      cmd:
        `cd ${q(workspace)} && cat .git/config > .git/config.new && printf %b ${q(hostileConfig.replaceAll('\n', String.raw`\n`).replaceAll('\t', String.raw`\t`))} >> .git/config.new && ` +
        `mv -f .git/config.new .git/config && printf %b ${q(hookBody.replaceAll('\n', String.raw`\n`))} > .git/hooks/post-index-change && ` +
        `chmod +x .git/hooks/post-index-change && R git_hostile_config INFO ok`,
    },
    {
      // Dirty tracked and untracked files without invoking git, and age a tracked file so the index is stale. The aged file
      // is one the model owns: `touch -d` needs ownership (an ACL grants only touch-to-now), and the runner-owned README.md
      // refused it, which ended the && chain before the row was printed.
      id: 'git_dirty_worktree',
      category: 'info',
      cmd:
        `cd ${q(workspace)} && echo 'v2 edited by the model' > data.dat && echo untracked > untracked-by-model.txt && ` +
        `touch -d 2001-01-01 data.dat && R git_dirty_worktree INFO ok`,
    },
  ]

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    for (const dir of [responseDir, markerDir]) fs.mkdirSync(dir, {recursive: true})
    trustedHead = initWorkspace(workspace)
    const keyFile = writeKeyFile(keyDir)
    const env = hostedEnv(workspace)

    result = await runIsolated({
      tools,
      env,
      workspace,
      responseDir,
      keyFile,
      logger,
      steps: probes(),
      onLifecycle: value => {
        lifecycle = value
      },
    })

    // --- Positive control: the same hostile state, plain git as the runner, in a copy -----------------------------------
    // The take-back already undid the real checkout's config and hook, so rebuild exactly what the model wrote in a copy
    // (the payload scripts are runner-owned and executable now) and run plain git there. Each payload must fire.
    after.configAfterTakeBack = fs.readFileSync(path.join(workspace, '.git', 'config'), 'utf8')
    after.hookExistsAfterTakeBack = fs.existsSync(path.join(workspace, '.git', 'hooks', 'post-index-change'))
    const control = path.join(scratch, 'control-ws')
    spawnSync('cp', ['-a', workspace, control])
    fs.appendFileSync(path.join(control, '.git', 'config'), hostileConfig)
    fs.writeFileSync(path.join(control, '.git', 'hooks', 'post-index-change'), hookBody, {mode: 0o755})
    spawnSync('touch', ['-d', '2001-01-01', path.join(control, 'data.dat')])
    spawnSync('git', ['diff', 'HEAD'], {cwd: control, encoding: 'utf8'})
    spawnSync('git', ['status', '--short'], {cwd: control, encoding: 'utf8'})
    markersFromControl = payloads.filter(name => fs.existsSync(markerOf(name)))
    for (const name of payloads) fs.rmSync(markerOf(name), {force: true})

    // --- The Action's runner-side git, against the real post-take-back checkout ---------------------------------------
    const adapter = createExecAdapter()
    after.reconstruct = await reconstructChanges(adapter, trustedHead, workspace, logger)
    after.commitMessage = await resolveBrokeredPushCommitMessage(adapter, trustedHead, workspace, logger, 'fallback')
    after.markersAfterTrustedGit = payloads.filter(name => fs.existsSync(markerOf(name)))
  }, 900_000)

  afterAll(async () => {
    await lifecycle?.release()
    fs.rmSync(scratch, {recursive: true, force: true})
  }, 120_000)

  it('ran the whole script in the model shell: it committed, wrote the payloads and the hostile state', () => {
    // #given the scripted model used its real tool shell
    // #then the commit went through (the identity and checkout access work) and the setup steps ran
    expect(failuresFor(result?.rows ?? new Map(), 'git_model_commit', 'WORKS')).toEqual([])
    expect(failuresFor(result?.rows ?? new Map(), 'git_hostile_payloads', 'INFO')).toEqual([])
    expect(failuresFor(result?.rows ?? new Map(), 'git_hostile_config', 'INFO')).toEqual([])
    expect(failuresFor(result?.rows ?? new Map(), 'git_dirty_worktree', 'INFO')).toEqual([])
    expect(result?.released.restore).toBe('restored')
  })

  it('positive control: plain git as the runner runs every payload against the hostile state', () => {
    // #given the hostile config, hook and attributes the model wrote, rebuilt in a copy
    // #then fsmonitor, textconv, the clean filter and the hook each fired, so a missing marker below means something
    expect(markersFromControl).toEqual([...payloads])
  })

  it('take-back removed the hostile config and the hook from the real checkout', () => {
    // #given the model replaced .git/config by rename and planted a hook
    // #then the restored config has none of the payload and the hook is gone
    expect(after.configAfterTakeBack).not.toContain('fsmonitor')
    expect(after.configAfterTakeBack).not.toContain('textconv')
    expect(after.configAfterTakeBack).not.toContain('clean')
    expect(after.hookExistsAfterTakeBack).toBe(false)
  })

  it('reconstruction and the commit-message lookup run no payload and still return the model work', () => {
    // #given the raw rows the model script printed, in case a step went missing
    const scriptRows: Record<string, string[]> = {}
    for (const [id, rows] of result?.rows ?? new Map<string, readonly Row[]>()) {
      scriptRows[id] = rows.map(row => `${row.status} ${row.evidence}`)
    }
    expect(scriptRows).toHaveProperty('git_dirty_worktree')
    // #given runner-side git ran after take-back, through the trusted wrapper
    // #then no payload ran as the runner
    expect(after.markersAfterTrustedGit).toEqual([])
    // #and the model's net changes against the trusted head are all there (none from inside .git)
    // (the description carries the refusal reason, so a failure here names it instead of printing `false`)
    expect(describeReconstruction(after.reconstruct)).toBe('ok')
    const changes =
      after.reconstruct?.success === true && after.reconstruct.data.kind === 'changes'
        ? after.reconstruct.data.changes
        : []
    const changed = changes.map(change => change.path)
    expect(changed).toEqual(expect.arrayContaining(['.gitattributes', 'data.dat', 'untracked-by-model.txt']))
    expect(changed.filter(file => file.startsWith('.git/'))).toEqual([])
    // #and the lookup returns the subject of the commit the model made in its shell
    expect(after.commitMessage).toBe(commitSubject)
  })
})

// A model that cannot change `.git/config` (take-back restores it) can still redirect git's config: it copies `.git`
// into the checkout, puts a clean filter in THAT copy's config, and points `.git/commondir` at it. Restoring the real
// config restores nothing git reads, so take-back must refuse the redirect (unsafe) and the caller must run no git.
describe.skipIf(!gated)('isolate-agent .git/commondir redirect through a real model shell', () => {
  const logger = createLogger({phase: 'sandbox-integration-commondir'})
  const scratch = path.join(runnerTemp, `sandbox-it-commondir-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const markerDir = path.join(scratch, 'markers')
  const payload = path.join(responseDir, 'clean.sh')
  const marker = path.join(markerDir, 'ran-clean')
  let trustedHead = ''
  let lifecycle: SandboxLifecycle | undefined
  let result: IsolatedRunResult | undefined
  let controlFired = false

  const probes = (): Probe[] => [
    {
      id: 'commondir_payload',
      category: 'info',
      cmd:
        `${String.raw`printf '#!/bin/sh\necho ran >> %s\ncat\n' ${q(marker)} > ${q(payload)} && chmod +x ${q(payload)} && `}` +
        `R commondir_payload INFO ok`,
    },
    {
      id: 'commondir_redirect',
      category: 'info',
      cmd:
        `cd ${q(workspace)} && cp -R .git evil-common && ` +
        `${String.raw`printf '[filter "x"]\n\tclean = %s\n' ${q(payload)} >> evil-common/config && printf '* filter=x\n' > .gitattributes && `}${String.raw`printf '../evil-common\n' > .git/commondir && echo 'edited by the model' > README.md && R commondir_redirect INFO ok`}`,
    },
  ]

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    for (const dir of [responseDir, markerDir]) fs.mkdirSync(dir, {recursive: true})
    trustedHead = initWorkspace(workspace)
    const keyFile = writeKeyFile(keyDir)

    result = await runIsolated({
      tools,
      env: hostedEnv(workspace),
      workspace,
      responseDir,
      keyFile,
      logger,
      steps: probes(),
      onLifecycle: value => {
        lifecycle = value
      },
    })

    // Positive control: plain git as the runner, against what the model left, runs the filter.
    spawnSync('git', ['diff', '--raw', trustedHead], {cwd: workspace, encoding: 'utf8'})
    controlFired = fs.existsSync(marker)
    fs.rmSync(marker, {force: true})
  }, 900_000)

  afterAll(async () => {
    await lifecycle?.release()
    // The refused take-back leaves sandbox-owned files behind, which the runner cannot delete; the job's VM is discarded.
    try {
      fs.rmSync(scratch, {recursive: true, force: true})
    } catch {
      // expected for the unsafe case this suite creates
    }
  }, 120_000)

  it('ran the redirect in the model shell', () => {
    // #given the scripted model used its real tool shell
    // #then both setup steps ran
    expect(failuresFor(result?.rows ?? new Map(), 'commondir_payload', 'INFO')).toEqual([])
    expect(failuresFor(result?.rows ?? new Map(), 'commondir_redirect', 'INFO')).toEqual([])
  })

  it('positive control: plain git as the runner runs the clean filter through the redirect', () => {
    // #given the checkout exactly as the model left it
    // #then the payload fired, so the refusal below is not a fixture that never worked
    expect(controlFired).toBe(true)
  })

  it('take-back refuses the redirect as unsafe, naming commondir, so no runner-side git runs', () => {
    // #given the model planted .git/commondir
    // #then the release is unsafe with the reason, and the run declines to reconstruct or publish on that basis
    expect(result?.released.restore).toBe('unsafe')
    expect(result?.released.reason ?? '').toContain('commondir')
    expect(fs.existsSync(path.join(workspace, '.git', 'commondir'))).toBe(true)
  })
})
