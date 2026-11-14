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
 * Nine suites run one after another (the sandbox account name is fixed, so two never overlap):
 *   1. the boundary: blocked and works rows, identity, quiescence, take-back;
 *   2. a provisioned `gh` config and an admitted repo skill;
 *   3. the persistence round trip (restore, isolated run, checkpoint and save, restore, isolated run);
 *   4. hostile git state written through the model's shell, then runner-side git after take-back;
 *   5. the key proxy: the model reaches the provider only through it, and the real key is nowhere the sandbox can read;
 *   6. the read-only view: a write matrix over the shared directories (each row with a runner-side control), the places the
 *      model must still write, escape attempts, and what the runner finds afterwards (sentinels, private temp, mounts);
 *   7. a server torn down mid-run leaves no namespace member and no private mount;
 *   8. a second isolated run in the same job finds nothing of the first outside the places it may write;
 *   9. a launcher killed while the chain waits at its gate: nothing past the gate ran, and the teardown is not `restored`
 *      unless it confirmed the orphaned root process gone.
 *
 * Every suite runs through the read-only view, as the Action does: the launch has no other form.
 *
 *   FRO_BOT_SANDBOX_INTEGRATION=1 FRO_BOT_OPENCODE_V2_BIN=/path/to/opencode bun run test src/harness/phases/v2-server.sandbox
 */
import type {SandboxToolPaths} from '../../services/setup/sandbox-preflight.js'
import type {Logger} from '../../shared/logger.js'
import type {SandboxLifecycle, SandboxLifecycleDeps, SandboxReleaseResult} from './sandbox-lifecycle.js'
import type {Probe, Row, ScriptedProvider} from './v2-server.sandbox.harness.js'
import {spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {admitLaunch, buildSandboxLaunch, createSandboxAccount, getSessionDbBasenames} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {startTlsUpstream, type TlsUpstream} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
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
import {createViewProbe} from '../../services/setup/sandbox-view-probe.js'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {getGitHubRunAttempt, getInvocationIdentity} from '../../shared/env.js'
import {createLogger} from '../../shared/logger.js'
import {startKeyProxyProcess, type KeyProxyProcess} from './key-proxy-process.js'
import {snapshotLogDirectory} from './log-snapshot.js'
import {createSandboxLifecycle} from './sandbox-lifecycle.js'
import {
  controlCoversMatrix,
  describeReconstruction,
  failuresFor,
  matrixDirectories,
  matrixSentinels,
  parseRows,
  PRELUDE,
  q,
  readProbe,
  readSessionIds,
  safeEnvPath,
  safeEnvToken,
  startScriptedProvider,
  startScriptedSession,
  VIEW_IT_PREFIX,
  writeMatrixProbe,
  writeWorksProbe,
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

/** The stand-in published install the preflight is pointed at (see `createPublishedActionLayout`). */
const fakeActionRoot = path.join(path.dirname(runnerTemp), '_actions', 'fro-bot-sandbox-it', 'agent', 'refs', 'v1')

/** The committed bundle of the repository under test (`dist/`, kept fresh by the pre-push hook and CI). */
const realDist = fileURLToPath(new URL('../../../dist', import.meta.url))

/** What a lifecycle needs to build the view: the Node that runs the builder, and the builder of the stand-in install. */
const viewLauncher = {nodePath: process.execPath, builderPath: path.join(fakeActionRoot, 'dist', 'sandbox-view.js')}

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
  // The hosted image has git-lfs installed system-wide, so a real actions/checkout writes this format integer into the local
  // config. Set directly so the suite mirrors that checkout whether or not git-lfs is installed where it runs.
  git(workspace, 'config', '--local', 'lfs.repositoryformatversion', '0')
  // actions/checkout v7 does the same with sparse checkout: enable the worktree config, disable sparse checkout, unset the
  // extension. That leaves a real .git/config.worktree (core.sparseCheckout etc.) that git ignores but the audit reads.
  git(workspace, 'config', '--local', 'extensions.worktreeConfig', 'true')
  git(workspace, 'sparse-checkout', 'disable')
  git(workspace, 'config', '--local', '--unset-all', 'extensions.worktreeConfig')
  fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n')
  git(workspace, 'add', '.')
  // The identity is passed for this commit only: handoff trusts just the keys a hosted checkout writes, and a checkout's
  // repo config has no user section.
  git(workspace, '-c', 'user.name=Runner Setup', '-c', 'user.email=setup@example.invalid', 'commit', '-qm', 'init')
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
    viewLauncher,
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
      lifecycle,
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

/**
 * A real published-action layout in the runner's work directory: `<work>/_actions/<owner>/<repo>/<ref>/` with the manifest
 * and the entry scripts as regular files, every component a real directory. This is what the preflight's walk looks for,
 * so the gate runs for real instead of being told where the Action lives. The suite itself runs from the checkout, so the
 * layout is a stand-in the preflight is pointed at (`bundleDir`, `invokedAs`); the walk and the file checks are the real ones.
 */

function createPublishedActionLayout(): void {
  fs.mkdirSync(path.join(fakeActionRoot, 'dist'), {recursive: true})
  fs.writeFileSync(
    path.join(fakeActionRoot, 'action.yaml'),
    'name: sandbox-it\nruns:\n  using: node24\n  main: dist/main.js\n',
  )
  for (const script of ['main.js', 'post.js', 'key-proxy.js'])
    fs.writeFileSync(path.join(fakeActionRoot, 'dist', script), '// stand-in\n')
  // The view builder is the real bundle, with the chunk it imports: the preflight probe and every launch run it as root.
  for (const name of fs.readdirSync(realDist)) {
    if (name === 'sandbox-view.js' || (name.startsWith('sandbox-view-') && name.endsWith('.js'))) {
      fs.copyFileSync(path.join(realDist, name), path.join(fakeActionRoot, 'dist', name))
    }
  }
}

afterAll(() => {
  // The whole owner directory is ours; never touch the runner's real _actions entries.
  fs.rmSync(path.join(path.dirname(runnerTemp), '_actions', 'fro-bot-sandbox-it'), {recursive: true, force: true})
})

async function preflightTools(logger: Logger): Promise<SandboxToolPaths> {
  createPublishedActionLayout()
  const base = createSandboxPreflightDeps(createExecAdapter(), logger)
  const preflight = await runSandboxPreflight({
    ...base,
    env: {...base.env, GITHUB_ACTION_PATH: fakeActionRoot, GITHUB_ACTION_REPOSITORY: 'fro-bot-sandbox-it/agent'},
    bundleDir: path.join(fakeActionRoot, 'dist'),
    invokedAs: path.join(fakeActionRoot, 'dist', 'main.js'),
    // The real probe, pointed at the stand-in install's builder: the preflight is part of what this suite proves.
    probeView: createViewProbe({
      exec: createExecAdapter(),
      logger,
      env: process.env,
      bundleDir: path.join(fakeActionRoot, 'dist'),
    }),
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
  /** The entries in the account's home right after creation; `null` when it could not be listed. */
  let homeEntriesAfterCreation: string[] | null = null

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
    // Runner grants that existed before the run: a named entry on a ROOT-owned file (which take-back never chowns), and a
    // named DEFAULT entry on an existing runner-owned directory. Neither may be touched. The runner is the file owner on
    // the second, so its default entry is the thing a handoff that wrote `default:user:<runner>` would have overwritten.
    const me = os.userInfo().username
    fs.writeFileSync(path.join(workspace, 'pre-acl-root'), 'root owned, runner granted\n')
    fs.mkdirSync(path.join(workspace, 'pre-acl-runner-default'))
    for (const args of [
      ['chown', 'root', path.join(workspace, 'pre-acl-root')],
      ['setfacl', '-m', `u:${me}:r--`, path.join(workspace, 'pre-acl-root')],
    ]) {
      const result = spawnSync('sudo', ['-n', ...args], {encoding: 'utf8'})
      if (result.status !== 0) throw new Error(`sudo ${args.join(' ')}: ${result.stderr}`)
    }
    const defaultResult = spawnSync(
      'setfacl',
      ['-d', '-m', `u:${me}:r-x`, path.join(workspace, 'pre-acl-runner-default')],
      {
        encoding: 'utf8',
      },
    )
    if (defaultResult.status !== 0) throw new Error(`setfacl -d: ${defaultResult.stderr}`)

    // The provider starts first: a probe command embeds its port, and the steps are read lazily.
    provider = await startScriptedProvider(probes)
    providerPort = provider.port

    // --- Positive controls: the same probes as the runner must be OPEN --------------------------------------------
    controls = runControls(probes(), workspace, process.env)

    // --- Hand over, launch, drive one turn --------------------------------------------------------------------------
    // The real account creation, timed (so the CI log shows how long it takes) and followed by a listing of the new home.
    const createAccount: SandboxLifecycleDeps['createAccount'] = async (accountTools, accountDeps) => {
      const started = performance.now()
      const created = await createSandboxAccount(accountTools, accountDeps)
      logger.info('Sandbox account creation finished', {elapsedMs: Math.round(performance.now() - started)})
      if (created.success) {
        const listing = await accountDeps.run([tools.find, created.data.home, '-mindepth', '1', '-maxdepth', '1'])
        homeEntriesAfterCreation =
          listing.exitCode === 0 ? listing.stdout.split('\n').filter(line => line.length > 0) : null
      }
      return created
    }
    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
      deps: {createAccount},
      viewLauncher,
    })
    const prepared = await lifecycle.prepare({keyFilePaths: [keyFile], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)
    const handle = await startScriptedSession({
      binary: BINARY ?? '',
      workspace,
      env,
      lifecycle,
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

  it('creates the account with an empty home: /etc/skel is not copied into it', () => {
    // #given the account was just created through the real lifecycle
    // #then its home had no entries (`useradd --create-home` would have copied about 833 MB of /etc/skel into it)
    expect(homeEntriesAfterCreation).toEqual([])
  })

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
    // (the root-owned file the setup made on purpose is not the sandbox's)
    const leftover = spawnSync(
      'find',
      [workspace, responseDir, '-xdev', '!', '-user', String(runnerUid), '!', '-name', 'pre-acl-root'],
      {encoding: 'utf8'},
    )
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
    // #and nothing of this run is left: no entry for the (deleted, so numeric) sandbox uid, anywhere
    const tree = spawnSync('getfacl', ['-R', '-p', workspace, responseDir], {encoding: 'utf8'}).stdout
    expect(tree).not.toMatch(/^(default:)?user:\d+:/m)
    // #and the runner has no entry in the handed-over directory beyond the ones it had before (none)
    const me = os.userInfo().username
    const handed = spawnSync('getfacl', ['-R', '-p', responseDir], {encoding: 'utf8'}).stdout
    expect(handed).not.toMatch(new RegExp(`^(default:)?user:${me}:`, 'm'))
  })

  it('leaves the runner grants that existed before the run alone, and gives model-created checkout files none of their own', () => {
    // #given a runner entry on a root-owned file and a runner default entry on a runner-owned directory, both from before
    const me = os.userInfo().username
    const read = (target: string): string => spawnSync('getfacl', ['-p', target], {encoding: 'utf8'}).stdout
    // #then both survived take-back exactly (the mask-preserving removal touched neither)
    expect(read(path.join(workspace, 'pre-acl-root'))).toContain(`user:${me}:r--`)
    expect(read(path.join(workspace, 'pre-acl-runner-default'))).toContain(`default:user:${me}:r-x`)
    // #and the only checkout paths that name the runner are those two: nothing this run created inherited an entry
    const tree = spawnSync('getfacl', ['-R', '-p', workspace], {encoding: 'utf8'}).stdout
    const named = tree
      .split('\n\n')
      .filter(block => new RegExp(`^(default:)?user:${me}:`, 'm').test(block))
      .map(block => /# file: (.*)/.exec(block)?.[1] ?? '')
      .map(file => path.relative(workspace, file))
      .toSorted()
    expect(named).toEqual(['pre-acl-root', 'pre-acl-runner-default'])
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
      // The sandbox's global gitconfig names gh as the credential helper for the server host, so the model's `git push`
      // authenticates with the token it already holds. `git credential fill` runs the helper chain for real, offline.
      id: 'git_credential_helper',
      category: 'works',
      cmd: [
        String.raw`o=$(printf 'protocol=https\nhost=%s\n\n' ${q(ghHost)} | GIT_TERMINAL_PROMPT=0 git credential fill 2>&1);`,
        `h=$(git config --global --get-all ${q(`credential.https://${ghHost}.helper`)} 2>&1);`,
        String.raw`if printf '%s\n' "$o" | grep -qx ${q(`password=${ghDummyToken}`)} && printf '%s\n' "$h" | grep -q 'gh auth git-credential$';`,
        'then R git_credential_helper WORKS "git credential fill answered from the provisioned gh token";',
        `else R git_credential_helper FAILED "helper=[$(printf %s "$h" | ev)] fill=[$(printf %s "$o" | grep -v '^password=' | ev)]"; fi`,
      ].join(' '),
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

    // The helper is scoped to the server the Action runs against, which the dummy gh config also names.
    const env = {...hostedEnv(workspace), GITHUB_SERVER_URL: `https://${ghHost}`}
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

  it("lets the model's git authenticate through the provisioned gh token (credential helper in the sandbox gitconfig)", () => {
    // #given provision mode: a gh config for the server host and the helper written into the sandbox's global gitconfig
    // #then `git credential fill` as the sandbox returns the provisioned token, and the helper is the configured one
    expect(failuresFor(rows, 'git_credential_helper', 'WORKS')).toEqual([])
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
    logSourceFiles: [] as string[],
    logSnapshot: undefined as string | null | undefined,
    logSnapshotFiles: [] as string[],
    logSnapshotLaterWrite: '',
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
            `mkdir -p "$XDG_DATA_HOME/opencode/log" && echo log-from-the-sandbox > "$XDG_DATA_HOME/opencode/log/sandbox-note.log" && ` +
            `echo storage-from-the-sandbox > "$XDG_DATA_HOME/opencode/storage/sandbox-note.txt" && ` +
            `R persist_write_storage WORKS "wrote storage" || R persist_write_storage FAILED "write failed"`,
        },
      ],
    })
    facts.sessionsAfterRun1 = readSessionIds(dbPath)

    // --- The log snapshot, taken the way run.ts takes it: right after the confirmed take-back ------------------------------
    const logSource = path.join(dataDir, 'log')
    facts.logSourceFiles = fs.readdirSync(logSource).sort()
    facts.logSnapshot = await snapshotLogDirectory({
      source: logSource,
      tempRoot: scratch,
      runnerUid: process.getuid?.() ?? -1,
      logger,
    })
    // A later isolated step's sandbox writing to the shared directory after the snapshot must not reach it.
    fs.writeFileSync(path.join(logSource, 'later-step.log'), 'written after the snapshot')
    facts.logSnapshotFiles = facts.logSnapshot === null ? [] : fs.readdirSync(facts.logSnapshot).sort()
    facts.logSnapshotLaterWrite = fs.existsSync(path.join(facts.logSnapshot ?? scratch, 'later-step.log'))
      ? 'present'
      : 'absent'

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

  it('snapshots every log the sandbox wrote, as runner-owned copies, and a later write to the shared directory does not reach it', () => {
    // #given the log directory right after the take-back: nothing may be skipped as not runner-owned
    expect(facts.logSourceFiles).toContain('sandbox-note.log')
    // #then the snapshot holds exactly those files, and nothing written to the shared directory afterwards
    expect(facts.logSnapshot).not.toBeNull()
    expect(facts.logSnapshotFiles).toEqual(facts.logSourceFiles)
    expect(facts.logSnapshotLaterWrite).toBe('absent')
    expect(fs.readFileSync(path.join(facts.logSnapshot ?? '', 'sandbox-note.log'), 'utf8')).toBe(
      'log-from-the-sandbox\n',
    )
    expect(fs.statSync(path.join(facts.logSnapshot ?? '', 'sandbox-note.log')).uid).toBe(process.getuid?.())
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
// This suite ends `unsafe` by design, which leaves the default XDG storage owned by the sandbox uid. Any suite after it
// must use its own XDG roots (`hostedEnv(workspace, xdgRoot)`).
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

// --- 5. The key proxy --------------------------------------------------------------------------------------------------

/** Passes each request to the scripted provider's plain-HTTP port, so the real model turn runs behind the TLS upstream. */
function forwardToProvider(port: number): (request: TlsUpstream['requests'][number], res: http.ServerResponse) => void {
  return (request, res) => {
    const outbound = http.request(
      {
        host: '127.0.0.1',
        port,
        method: request.method,
        path: request.url,
        headers: {
          'content-type': String(request.headers['content-type'] ?? 'application/json'),
          'content-length': request.body.length,
        },
      },
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )
    outbound.on('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502).end()
    })
    outbound.end(request.body)
  }
}

function findBunOnPath(): string {
  const found = spawnSync('which', ['bun'], {encoding: 'utf8'})
  if (found.status !== 0 || found.stdout.trim().length === 0) throw new Error('bun is required on PATH for this suite')
  return found.stdout.trim()
}

const PROXY_SOURCE_ENTRY = path.join(process.cwd(), 'apps', 'action', 'src', 'key-proxy.ts')

// The provider key never reaches the sandbox: the proxy child (runner user, empty environment) holds it, the sandboxed
// server holds a placeholder that only works on the proxy's loopback port, and the model turn goes through the proxy.
describe.skipIf(!gated)('isolate-agent key proxy through a real model shell', () => {
  const logger = createLogger({phase: 'sandbox-integration-key-proxy'})
  const scratch = path.join(runnerTemp, `sandbox-it-key-proxy-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  // Its own XDG roots. The suite before this one (the `.git/commondir` redirect) ends `unsafe` on purpose: nothing is taken
  // back, so the default XDG storage under the runner's home stays owned by the sandbox uid and a later handoff on those
  // paths is refused. The account itself is deleted once the stop is confirmed, so only the files are left behind.
  const xdgRoot = path.join(scratch, 'xdg')
  const REAL_KEY = 'sk-real-proxy-canary-7f3a91'
  let provider: ScriptedProvider | undefined
  let upstream: TlsUpstream | undefined
  let lifecycle: SandboxLifecycle | undefined
  let proxy: KeyProxyProcess | undefined
  let rows = new Map<string, Row[]>()
  let released: SandboxReleaseResult | undefined
  let reachableAfterRelease = true

  const curlStatus = (
    id: string,
    header: string | null,
    route: string,
    wantStatus: string,
    passStatus: string,
  ): string =>
    `c=$(curl -sS -o /dev/null --max-time 10 -w '%{http_code}' ${header === null ? '' : `-H ${q(header)}`} ${q(`http://127.0.0.1:${proxy?.port}${route}`)} 2>&1); ` +
    `[ "$c" = ${wantStatus} ] && R ${id} ${passStatus} "$c" || R ${id} FAILED "[$c]"`

  const probes = (): Probe[] => {
    const bearer = `Authorization: Bearer ${proxy?.placeholder ?? ''}`
    return [
      {
        // The request reaches the upstream with the placeholder, as the server's own requests do.
        id: 'proxy_models_with_placeholder',
        category: 'works',
        cmd: curlStatus('proxy_models_with_placeholder', bearer, '/fake/models', '200', 'WORKS'),
      },
      {
        // The proxy does not authenticate its callers: a credential of the model's own choosing changes nothing.
        id: 'proxy_ignores_wrong_credential',
        category: 'works',
        cmd: curlStatus(
          'proxy_ignores_wrong_credential',
          'Authorization: Bearer not-the-placeholder',
          '/fake/models',
          '200',
          'WORKS',
        ),
      },
      {
        id: 'proxy_serves_without_credential',
        category: 'works',
        cmd: curlStatus('proxy_serves_without_credential', null, '/fake/models', '200', 'WORKS'),
      },
      {
        id: 'proxy_refuses_unlisted_route',
        category: 'blocked',
        cmd: curlStatus('proxy_refuses_unlisted_route', bearer, '/fake/files', '404', 'BLOCKED'),
      },
      {
        id: 'proxy_refuses_unknown_provider',
        category: 'blocked',
        cmd: curlStatus('proxy_refuses_unknown_provider', bearer, '/other/models', '404', 'BLOCKED'),
      },
      {
        // The key is assembled at run time from two halves, so the command text (which the server stores with the tool
        // call) never holds it. Two controls prove each detector can see a copy before either is trusted to find none:
        // one readable file under an ordinary name for the file scan, one piped line for the content check.
        id: 'real_key_absent',
        category: 'blocked',
        cmd:
          `KEY=${q(REAL_KEY.slice(0, 9))}${q(REAL_KEY.slice(9))}; ` +
          `leaks(){ grep -rIlF -- "$KEY" "$@" 2>/dev/null </dev/null | wc -l | tr -d ' '; }; ` +
          `ctl=$(mktemp -d) && printf %s "$KEY" > "$ctl/notes.txt" || { R real_key_absent FAILED "control setup"; exit 0; }; ` +
          `[ "$(leaks "$ctl")" = 1 ] || { rm -rf "$ctl"; R real_key_absent FAILED "file detector control"; exit 0; }; rm -rf "$ctl"; ` +
          `[ "$(printf %s "$KEY" | grep -caF -- "$KEY")" = 1 ] || { R real_key_absent FAILED "content detector control"; exit 0; }; ` +
          `procs=$( { ${String.raw`tr '\0' '\n'`} < /proc/$PPID/environ; ${String.raw`tr '\0' '\n'`} < /proc/self/environ; ` +
          `cat /proc/${proxy?.pid}/cmdline /proc/${proxy?.pid}/environ; } 2>/dev/null | grep -caF -- "$KEY" ); ` +
          // An unset root is skipped: an empty operand would make some grep builds scan the current directory.
          `set --; for d in "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" ${q(responseDir)} ${q(workspace)}; do [ -n "$d" ] && set -- "$@" "$d"; done; files=$(leaks "$@"); ` +
          `[ "$procs" = 0 ] && [ "$files" = 0 ] && R real_key_absent BLOCKED "no copy of the key in env, proxy argv or readable files" || R real_key_absent OPEN "process_copies=$procs files=$files"`,
      },
    ]
  }

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    initWorkspace(workspace)
    provider = await startScriptedProvider(() => probes())
    upstream = await startTlsUpstream(forwardToProvider(provider.port))
    const env = hostedEnv(workspace, xdgRoot)
    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
      viewLauncher,
    })
    const started = await lifecycle.startKeyProxy(async context => {
      const result = await startKeyProxyProcess({
        providers: [
          {providerId: 'fake', key: REAL_KEY, baseUrl: `${upstream?.origin ?? ''}/v1`, protocols: ['openai-chat']},
        ],
        logger,
        launcher: {command: findBunOnPath(), args: [PROXY_SOURCE_ENTRY]},
        testing: {upstreamCa: upstream?.ca ?? ''},
        signal: context.signal,
      })
      return result.success
        ? {proxy: result.data, unconfirmed: false}
        : {proxy: null, unconfirmed: result.error.cleanup === 'unconfirmed'}
    })
    if (!started.success || started.data === null) throw new Error('key proxy did not start')
    proxy = started.data

    const prepared = await lifecycle.prepare({keyFilePaths: [], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)
    const handle = await startScriptedSession({
      binary: BINARY ?? '',
      workspace,
      env,
      lifecycle,
      provider,
      proxy: {baseURL: proxy.baseUrl('fake'), apiKey: proxy.placeholder},
      logger,
    })
    rows = parseRows(provider.state.results.join('\n'))
    await handle.shutdown()
    released = await lifecycle.release()
    reachableAfterRelease = await new Promise<boolean>(resolve => {
      const socket = net.connect({host: '127.0.0.1', port: proxy?.port ?? 0})
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
  }, 900_000)

  afterAll(async () => {
    await lifecycle?.release()
    await provider?.close()
    await upstream?.close()
    try {
      fs.rmSync(scratch, {recursive: true, force: true})
    } catch {
      // the job's VM is discarded
    }
  }, 120_000)

  it('serves a request whatever credential it carries, and refuses an unlisted route and an unknown provider', () => {
    // #given the scripted model's own shell, as the sandbox user
    // #then a request with the placeholder, with another credential and with none all reach the upstream
    for (const id of [
      'proxy_models_with_placeholder',
      'proxy_ignores_wrong_credential',
      'proxy_serves_without_credential',
    ]) {
      expect(failuresFor(rows, id, 'WORKS')).toEqual([])
    }
    // #then the allowlist still holds
    for (const id of ['proxy_refuses_unlisted_route', 'proxy_refuses_unknown_provider']) {
      expect(failuresFor(rows, id, 'BLOCKED')).toEqual([])
    }
  })

  it('leaves no copy of the real key where the sandbox can read it', () => {
    expect(failuresFor(rows, 'real_key_absent', 'BLOCKED')).toEqual([])
  })

  it('sends the model turn through the proxy with the real key, and never the placeholder', () => {
    // #given everything the upstream received
    const seen = upstream?.requests ?? []

    // #then the model's chat completion arrived, every request carried the real key, and none carried the placeholder
    expect(seen.some(request => request.method === 'POST' && request.url === '/v1/chat/completions')).toBe(true)
    for (const request of seen) {
      expect(request.headers.authorization).toBe(`Bearer ${REAL_KEY}`)
      expect(JSON.stringify(request.headers)).not.toContain(proxy?.placeholder ?? 'unset')
    }
  })

  it('stops the proxy after the sandbox is stopped and restored, and closes its port', () => {
    expect(released?.proxy).toBe('stopped')
    expect(released?.restore).toBe('restored')
    expect(reachableAfterRelease).toBe(false)
  })
})

// --- 6. The read-only view ---------------------------------------------------------------------------------------------

const VIEW_TAG = String(process.pid)
const runnerUid = os.userInfo().uid
const toolCache = safeEnvPath(process.env.RUNNER_TOOL_CACHE, '/opt/hostedtoolcache')

/** The shared directories the runner can write, which the matrix covers. Empty off a hosted runner. */
function listMatrixDirectories(): readonly string[] {
  if (!gated) return []
  return matrixDirectories(
    {pathEnv: process.env.PATH, toolCache, extra: ['/opt', '/usr/share']},
    {
      isDirectory: target => {
        try {
          return fs.statSync(target).isDirectory()
        } catch {
          return false
        }
      },
      isWritable: target => {
        try {
          fs.accessSync(target, fs.constants.W_OK)
          return true
        } catch {
          return false
        }
      },
      subdirectories: target => {
        try {
          return fs.readdirSync(target)
        } catch {
          return []
        }
      },
    },
  )
}

const matrixDirs = listMatrixDirectories()
const matrixIds = matrixDirs.map((_directory, index) => `wm_${index}`)

/** The host's mounts as `<mount point> <options>`, sorted: what a namespace of another process cannot change. */
function hostMountSet(): string[] {
  return fs
    .readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => {
      const fields = line.split(' ')
      return `${fields[4] ?? ''} ${fields[5] ?? ''}`
    })
    .toSorted()
}

/** The mount namespaces on the machine, as root sees them: a namespace with no process in it is not listed. */
function mountNamespaces(): string[] {
  const listed = spawnSync('sudo', ['-n', 'lsns', '-t', 'mnt', '-n', '-o', 'NS'], {encoding: 'utf8'})
  return listed.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .toSorted()
}

/** Removes what a view probe may have left in the shared directories. The runner may remove any of it: they are mode 777. */
function sweepViewFiles(): void {
  for (const dir of [...matrixDirs, '/tmp', '/var/tmp', '/dev/shm']) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${VIEW_IT_PREFIX}-`) || name.startsWith(`.${VIEW_IT_PREFIX}-`)) {
          fs.rmSync(path.join(dir, name), {recursive: true, force: true})
        }
      }
    } catch {
      // A directory that cannot be listed has nothing of ours in it.
    }
  }
}

function strayProcesses(pattern: string): string {
  return spawnSync('pgrep', ['-d,', '-f', pattern], {encoding: 'utf8'}).stdout.trim()
}

describe.skipIf(!gated)('isolate-agent read-only view: the write boundary on a hosted runner', () => {
  const logger = createLogger({phase: 'sandbox-integration-view'})
  const scratch = path.join(runnerTemp, `sandbox-it-view-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  // The shape the Action provisions in provision mode: a `gh-config-*` directory directly under RUNNER_TEMP.
  const ghConfigDir = path.join(runnerTemp, `gh-config-view-${process.pid}`)
  const env = hostedEnv(workspace)
  const privateMarkers = ['/tmp', '/var/tmp', '/dev/shm'].map(dir => `${dir}/${VIEW_IT_PREFIX}-priv-${VIEW_TAG}`)
  const escapeDir = matrixDirs.includes('/usr/local/bin') ? '/usr/local/bin' : (matrixDirs[0] ?? '/usr/local/bin')
  const hardlinkSource = `${escapeDir}/${VIEW_IT_PREFIX}-hl-${VIEW_TAG}`

  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let rows = new Map<string, readonly Row[]>()
  let controls = new Map<string, Row[]>()
  const facts = {
    mountsBefore: [] as string[],
    mountsAfter: [] as string[],
    newNamespaces: [] as string[],
    changedSentinels: [] as string[],
    privateLeft: [] as string[],
  }

  const writesFrom = (id: string, expression: string): Probe => writeWorksProbe(id, expression)

  const probes = (): Probe[] => [
    // Blocked: create, append, rename and unlink in every shared directory the runner can write.
    ...matrixDirs.map((dir, index) => writeMatrixProbe(`wm_${index}`, dir, VIEW_TAG, runnerUid)),
    // Works: every place the model needs to write.
    writesFrom('ww_checkout', q(workspace)),
    writesFrom('ww_response', q(responseDir)),
    writesFrom('ww_gh_config', q(ghConfigDir)),
    writesFrom('ww_xdg_data', '"$XDG_DATA_HOME/opencode"'),
    writesFrom('ww_xdg_config', '"$XDG_CONFIG_HOME/opencode"'),
    writesFrom('ww_xdg_cache', '"$XDG_CACHE_HOME/opencode"'),
    writesFrom('ww_xdg_state', '"$XDG_STATE_HOME/opencode"'),
    writesFrom('ww_home', '"$HOME"'),
    writesFrom('ww_tmp', '/tmp'),
    writesFrom('ww_var_tmp', '/var/tmp'),
    writesFrom('ww_dev_shm', '/dev/shm'),
    {
      id: 'ww_devices',
      category: 'works',
      cmd: `echo x > /dev/null && [ "$(head -c 16 /dev/urandom | wc -c | tr -d ' ')" = 16 ] && R ww_devices WORKS "null and urandom" || R ww_devices FAILED "device"`,
    },
    {
      id: 'ww_pty',
      category: 'works',
      cmd: String.raw`python3 -c 'import os,pty; m,s=pty.openpty(); os.write(m,b"ok\n"); assert os.read(s,3)' 2>/dev/null && R ww_pty WORKS "pty allocated" || R ww_pty FAILED "no pty"`,
    },
    {
      id: 'ww_shared_memory',
      category: 'works',
      cmd: `python3 -c 'from multiprocessing import shared_memory as s; m=s.SharedMemory(create=True,size=8); m.close(); m.unlink()' 2>/dev/null && R ww_shared_memory WORKS "shm segment" || R ww_shared_memory FAILED "no shm"`,
    },
    {
      // Private temp: what the run leaves there must vanish with the namespace (asserted from the runner afterwards).
      id: 'priv_markers',
      category: 'info',
      cmd: `for f in ${privateMarkers.map(q).join(' ')}; do echo x > "$f"; done; R priv_markers INFO "wrote private temp markers"`,
    },
    // Escapes. A write through a checkout symlink into a sealed directory, a hardlink from a sealed file into the checkout, the
    // runner's root through /proc: each has a runner-side control. A remount and a user namespace have none: the runner's own
    // attempt fails for the same reason, so there is nothing a control could show.
    {
      id: 'esc_symlink',
      category: 'blocked',
      control: true,
      cmd:
        `l=${q(workspace)}/${VIEW_IT_PREFIX}-link; rm -f "$l"; ln -s ${q(escapeDir)} "$l" 2>/dev/null; ` +
        `if ( : > "$l/${VIEW_IT_PREFIX}-esc-$$" ) 2>/dev/null; then rm -f "$l/${VIEW_IT_PREFIX}-esc-$$"; R esc_symlink OPEN "wrote through the link"; ` +
        `else R esc_symlink BLOCKED "write through the link refused"; fi; rm -f "$l"`,
    },
    {
      id: 'esc_hardlink',
      category: 'blocked',
      control: true,
      cmd:
        `t=${q(workspace)}/${VIEW_IT_PREFIX}-hl-$$; ` +
        `if ln ${q(hardlinkSource)} "$t" 2>/dev/null; then rm -f "$t"; R esc_hardlink OPEN "linked a sealed file into the checkout"; ` +
        `else R esc_hardlink BLOCKED "hardlink refused"; fi`,
    },
    {
      id: 'esc_proc_root',
      category: 'blocked',
      control: true,
      cmd: `if ls /proc/${process.pid}/root/ >/dev/null 2>&1; then R esc_proc_root OPEN "readable"; else R esc_proc_root BLOCKED "refused"; fi`,
    },
    {
      id: 'esc_remount',
      category: 'blocked',
      cmd: `out=$(mount -o remount,rw ${q(escapeDir)} 2>&1); rc=$?; if [ $rc -eq 0 ]; then R esc_remount OPEN "remounted"; else R esc_remount BLOCKED "rc=$rc $(printf %s "$out" | ev)"; fi`,
    },
    {
      id: 'esc_userns',
      category: 'blocked',
      // Whether a user namespace can be created depends on the image's AppArmor policy, so the probe asks the question that
      // matters: from inside one, with every mapped capability, can a write to the sealed directory be made to work?
      cmd:
        `t=${q(escapeDir)}/${VIEW_IT_PREFIX}-userns-$$; ` +
        `unshare --user --map-root-user --mount sh -c 'mount -o remount,rw,bind "$1" "$1"; : > "$2"' sh ${q(escapeDir)} "$t" >/dev/null 2>&1; ` +
        `if [ -e "$t" ]; then rm -f "$t"; R esc_userns OPEN "wrote from a user namespace"; else R esc_userns BLOCKED "no write from a user namespace"; fi`,
    },
  ]

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    for (const dir of [responseDir, ghConfigDir]) fs.mkdirSync(dir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)

    // Disposable files in every matrix directory, mode 0666 so that only the mount can refuse the sandbox: one set for the
    // runner's control, one for the sandbox. A hardlink source in the directory the escape probes aim at.
    for (const dir of matrixDirs) {
      for (const file of matrixSentinels(dir, VIEW_TAG)) {
        fs.writeFileSync(file, 'sentinel')
        fs.chmodSync(file, 0o666)
      }
    }
    fs.writeFileSync(hardlinkSource, 'sentinel')
    fs.chmodSync(hardlinkSource, 0o666)

    controls = runControls(probes(), workspace, process.env)
    facts.mountsBefore = hostMountSet()
    const namespacesBefore = mountNamespaces()

    const result = await runIsolated({
      tools,
      env,
      workspace,
      responseDir,
      keyFile,
      steps: probes(),
      logger,
      ghConfigDir,
      onLifecycle: value => {
        lifecycle = value
      },
    })
    rows = new Map(result.rows)
    released = result.released

    facts.mountsAfter = hostMountSet()
    facts.newNamespaces = mountNamespaces().filter(namespace => !namespacesBefore.includes(namespace))
    for (const dir of matrixDirs) {
      const [, , sandboxAppend, sandboxUnlink] = matrixSentinels(dir, VIEW_TAG)
      for (const file of [sandboxAppend, sandboxUnlink]) {
        if (file === undefined) continue
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<missing>'
        if (content !== 'sentinel') facts.changedSentinels.push(`${file}: ${content}`)
      }
    }
    if (fs.readFileSync(hardlinkSource, 'utf8') !== 'sentinel') facts.changedSentinels.push(hardlinkSource)
    facts.privateLeft = privateMarkers.filter(marker => fs.existsSync(marker))
  }, 600_000)

  afterAll(async () => {
    await lifecycle?.release()
    sweepViewFiles()
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(ghConfigDir, {recursive: true, force: true})
  }, 120_000)

  it('covers at least the runner PATH directories, /opt, /usr/share and the tool cache, with a control for each row', () => {
    // #given the directories the runner can write
    // #then there are some, and each matrix row has a runner-side control that managed all four operations
    expect(matrixDirs.length).toBeGreaterThan(0)
    expect(uncontrolledRows(controls)).toEqual([])
    for (const id of matrixIds) expect(controlCoversMatrix(controls.get(id))).toBe(true)
  })

  it.each(matrixIds)('blocks create, append, rename and unlink in matrix directory %s', id => {
    // #given the scripted model ran the row in its real tool shell
    // #then no operation worked
    expect(failuresFor(rows, id, 'BLOCKED')).toEqual([])
  })

  it.each(['esc_symlink', 'esc_hardlink', 'esc_proc_root', 'esc_remount', 'esc_userns'])(
    'blocks the escape attempt %s',
    id => {
      // #given the same real tool shell
      // #then it was refused
      expect(failuresFor(rows, id, 'BLOCKED')).toEqual([])
    },
  )

  it.each([
    'ww_checkout',
    'ww_response',
    'ww_gh_config',
    'ww_xdg_data',
    'ww_xdg_config',
    'ww_xdg_cache',
    'ww_xdg_state',
    'ww_home',
    'ww_tmp',
    'ww_var_tmp',
    'ww_dev_shm',
    'ww_devices',
    'ww_pty',
    'ww_shared_memory',
  ])('keeps %s working for the model', id => {
    // #given the same real tool shell
    // #then every place the model needs still works
    expect(failuresFor(rows, id, 'WORKS')).toEqual([])
  })

  it('left every sentinel the runner placed unchanged', () => {
    // #given the sandbox's disposable files and the hardlink source, read back from the runner
    // #then none was appended to, renamed away or unlinked
    expect(facts.changedSentinels).toEqual([])
  })

  it('left no private temp file on the host', () => {
    // #given the markers the model wrote in /tmp, /var/tmp and /dev/shm
    // #then none exists on the host: they lived on the namespace's own tmpfs
    expect(rows.get('priv_markers')).toBeDefined()
    expect(facts.privateLeft).toEqual([])
  })

  it('left no mount namespace and no change to the host mount table', () => {
    // #given the runner's view before and after
    // #then no new namespace remains, and the host's mounts are the same
    expect(facts.newNamespaces).toEqual([])
    expect(facts.mountsAfter).toEqual(facts.mountsBefore)
  })

  it('confirmed the namespace and the uid before taking everything back', () => {
    // #given the release of the run
    // #then it was stopped and restored
    expect(released).toMatchObject({stop: 'stopped', restore: 'restored'})
  })
})

describe.skipIf(!gated)('isolate-agent read-only view: a server torn down while it runs', () => {
  const logger = createLogger({phase: 'sandbox-integration-kill'})
  const scratch = path.join(runnerTemp, `sandbox-it-kill-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace)
  const marker = `/tmp/${VIEW_IT_PREFIX}-kill-${VIEW_TAG}`
  const strayPattern = 'sleep 778[12]'

  let provider: ScriptedProvider | undefined
  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let strays = 'not checked'
  let markerLeft = true
  let newNamespaces: string[] = ['not checked']
  let mountsEqual = false

  const steps = (): Probe[] => [
    {
      // A tool that leaves a private temp file and processes that leave their session, ignore SIGTERM and detach.
      id: 'kill_setup',
      category: 'info',
      cmd:
        `echo x > ${q(marker)}; (setsid sleep 7781 >/dev/null 2>&1 &); (trap '' TERM HUP; exec sleep 7782 >/dev/null 2>&1 &); ` +
        `sleep 0.3; R kill_setup INFO "$(pgrep -d, -f 'sleep 778')"`,
    },
  ]

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)
    provider = await startScriptedProvider(steps)
    const mountsBefore = hostMountSet()
    const namespacesBefore = mountNamespaces()

    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
      viewLauncher,
    })
    const prepared = await lifecycle.prepare({keyFilePaths: [keyFile], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)
    await startScriptedSession({binary: BINARY ?? '', workspace, env, lifecycle, keyFile, provider, logger})

    // No graceful shutdown: the lifecycle is torn down with the server and its strays still running.
    released = await lifecycle.release()
    strays = strayProcesses(strayPattern)
    markerLeft = fs.existsSync(marker)
    newNamespaces = mountNamespaces().filter(namespace => !namespacesBefore.includes(namespace))
    mountsEqual = hostMountSet().join('\n') === mountsBefore.join('\n')
  }, 600_000)

  afterAll(async () => {
    await lifecycle?.release()
    await provider?.close()
    spawnSync('sudo', ['-n', 'pkill', '-KILL', '-f', strayPattern])
    fs.rmSync(marker, {force: true})
    fs.rmSync(scratch, {recursive: true, force: true})
  }, 120_000)

  it('kills every member of the namespace, stray processes included, and confirms it', () => {
    // #given the teardown ran while the server was up
    // #then it confirmed the stop, restored the handoff, and no process of the launch is left
    expect(released).toMatchObject({stop: 'stopped', restore: 'restored'})
    expect(strays).toBe('')
  })

  it('leaves no private mount, no private temp file and no namespace', () => {
    // #given the runner's view afterwards
    // #then the namespace and its mounts are gone with its last member
    expect(markerLeft).toBe(false)
    expect(newNamespaces).toEqual([])
    expect(mountsEqual).toBe(true)
  })
})

describe.skipIf(!gated)('isolate-agent read-only view: a second isolated run in the same job', () => {
  const logger = createLogger({phase: 'sandbox-integration-second'})
  const scratch = path.join(runnerTemp, `sandbox-it-second-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace)
  const markers = ['/tmp', '/var/tmp', '/dev/shm'].map(dir => `${dir}/${VIEW_IT_PREFIX}-run1-${VIEW_TAG}`)
  const homeMarker = `$HOME/${VIEW_IT_PREFIX}-run1-${VIEW_TAG}`

  let first: IsolatedRunResult | undefined
  let second: IsolatedRunResult | undefined

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)
    const run = async (steps: readonly Probe[]): Promise<IsolatedRunResult> =>
      runIsolated({tools, env, workspace, responseDir, keyFile, steps, logger})

    first = await run([
      {
        id: 'run1_markers',
        category: 'info',
        cmd: `for f in ${markers.map(q).join(' ')} "${homeMarker}"; do echo x > "$f"; done; R run1_markers INFO ok`,
      },
    ])
    second = await run([
      {
        id: 'run2_clean',
        category: 'works',
        cmd:
          `left=$(ls ${markers.map(q).join(' ')} "${homeMarker}" 2>/dev/null); ` +
          `files=$(ls /tmp /var/tmp /dev/shm "$HOME" 2>/dev/null | grep -c ${q(VIEW_IT_PREFIX)}); ` +
          `if [ -z "$left" ] && [ "$files" = 0 ]; then R run2_clean WORKS "nothing of the first run"; ` +
          `else R run2_clean FAILED "left=[$(printf %s "$left" | ev)] files=$files"; fi`,
      },
    ])
  }, 900_000)

  afterAll(() => {
    sweepViewFiles()
    fs.rmSync(scratch, {recursive: true, force: true})
  }, 120_000)

  it('restored the first run before the second began', () => {
    // #given both runs
    // #then each was stopped and restored
    expect(first?.released).toMatchObject({stop: 'stopped', restore: 'restored'})
    expect(second?.released).toMatchObject({stop: 'stopped', restore: 'restored'})
  })

  it('finds nothing of the first run in the private temp directories or the home', () => {
    // #given the second run's own probe
    // #then it saw no marker and no file of ours in the places the first run wrote
    expect(failuresFor(second?.rows ?? new Map(), 'run2_clean', 'WORKS')).toEqual([])
    expect(first?.rows.get('run1_markers')).toBeDefined()
  })
})

describe.skipIf(!gated)('isolate-agent read-only view: a launcher killed while the chain waits at its gate', () => {
  const logger = createLogger({phase: 'sandbox-integration-gate'})
  const scratch = path.join(runnerTemp, `sandbox-it-gate-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace)
  const marker = path.join(workspace, `${VIEW_IT_PREFIX}-gate-ran-${VIEW_TAG}`)
  const strayPattern = 'sleep 7791'

  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let gateDir = ''
  let gateReported = false
  let processesAtGate = 'not checked'
  let processesAfter = 'not checked'
  let markerAfterWait = true
  let newNamespaces: string[] = ['not checked']

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)
    const namespacesBefore = mountNamespaces()

    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
      viewLauncher,
      // The runner side never gives the go-ahead: this is a launch whose admission was cut off, as a cancellation would.
      deps: {admit: async (pid, dir, deps, options) => admitLaunch(pid, dir, deps, {...options, isClosed: () => true})},
    })
    const prepared = await lifecycle.prepare({keyFilePaths: [keyFile], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)

    await lifecycle.launch(async context => {
      gateDir = context.spec.view?.gate.dir ?? ''
      // A stand-in server: if the chain ever got past the gate it would leave the marker and a stray.
      const built = buildSandboxLaunch(
        context.spec,
        tools.sh,
        ['-c', `echo ran > ${q(marker)}; exec sleep 7791`],
        {},
        workspace,
      )
      const child = spawn(built.command, [...built.args], {
        detached: true,
        stdio: 'ignore',
        env: {PATH: process.env.PATH},
      })
      if (child.pid === undefined) throw new Error('the launcher did not start')
      context.noteSpawn(child.pid)
      // Wait until the gate has reported its namespace and is waiting for a go-ahead that will never come.
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !fs.existsSync(path.join(gateDir, 'ns'))) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      gateReported = fs.existsSync(path.join(gateDir, 'ns'))
      processesAtGate = strayProcesses(path.basename(gateDir))
      // What a group kill from the runner does: only `sudo` dies; its root child is orphaned at the gate.
      child.kill('SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 500))
      return {value: 'killed at the gate', unconfirmed: false}
    })

    released = await lifecycle.release()
    // A chain that had passed the gate would have written the marker within milliseconds.
    await new Promise(resolve => setTimeout(resolve, 3000))
    markerAfterWait = fs.existsSync(marker)
    processesAfter = strayProcesses(`${path.basename(gateDir)}|${strayPattern}`)
    newNamespaces = mountNamespaces().filter(namespace => !namespacesBefore.includes(namespace))
  }, 300_000)

  afterAll(async () => {
    await lifecycle?.release()
    spawnSync('sudo', ['-n', 'pkill', '-KILL', '-f', strayPattern])
    fs.rmSync(scratch, {recursive: true, force: true})
  }, 120_000)

  it('held the chain at the gate: it reported its namespace and nothing past the gate ran', () => {
    // #given a launch whose go-ahead was never given
    // #then the gate had written its id, was still running, and the stand-in server never started
    expect(gateReported).toBe(true)
    expect(processesAtGate).not.toBe('')
    expect(markerAfterWait).toBe(false)
  })

  it('is restored only because the orphaned root process was confirmed gone', () => {
    // #given the launcher was killed and its child orphaned
    // #then the release confirmed the stop, and no process of the launch is left
    expect(released).toMatchObject({stop: 'stopped', restore: 'restored'})
    expect(processesAfter).toBe('')
    expect(newNamespaces).toEqual([])
  })
})
