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
 * Fourteen suites run one after another (the sandbox account name is fixed, so two never overlap):
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
 *      unless it confirmed the orphaned root process gone;
 *  10. the agent's PATH is the runner's: `node` and `uv` from the tool cache (put on PATH by `setup-node` and `setup-uv`)
 *      run in the agent's shell and report what they report to the runner, and the Action's own OpenCode directory is last,
 *      so `opencode` resolves there;
 *  11. `bun` and `pnpm` run for the agent from their install roots under the runner home, installs work, nothing else in the
 *      home becomes readable, the roots stay read-only, and take-back leaves no ACL entry for the agent's uid;
 *  12. `agent-state-home` inside the checkout, with the runner's own state elsewhere: the agent's state lands in the checkout,
 *      runner-owned, its `opencode` entry is a link that is removed afterwards, and a clone under the checkout is trusted;
 *  13. the same, in connect's layout: the runner's `XDG_STATE_HOME` is the state home, so its real `opencode` directory is
 *      nested inside the handed-over state home, and the take-back still ends `restored` with the session database readable.
 *  14. run tracing, once the Action's pinned plugin is 0.2.0 or later (it is installed from the registry, as setup installs it):
 *      a loopback HTTPS collector stand-in and a unique canary in `trace-headers`. Isolated, the spans arrive with the canary
 *      header and the sandbox user's search of process environments and command lines, the runner's temp and step files, the
 *      checkout and the agent's home finds none; not isolated, the same search finds it (the control); no exported span holds
 *      it; no relay process is left and the sandbox restores; with tracing off no relay runs and nothing is sent.
 *
 * Every suite runs through the read-only view, as the Action does: the launch has no other form.
 *
 *   FRO_BOT_SANDBOX_INTEGRATION=1 FRO_BOT_OPENCODE_V2_BIN=/path/to/opencode bun run test src/harness/phases/v2-server.sandbox
 */
import type {SandboxToolPaths} from '../../services/setup/sandbox-preflight.js'
import type {Logger} from '../../shared/logger.js'
import type {SandboxLifecycle, SandboxLifecycleDeps, SandboxReleaseResult, SignalHost} from './sandbox-lifecycle.js'
import type {LaunchNamespaces, Probe, Row, ScriptedProvider, ScriptedTracing} from './v2-server.sandbox.harness.js'
import {Buffer} from 'node:buffer'
import {spawn, spawnSync} from 'node:child_process'
import {createHash, randomBytes} from 'node:crypto'
import * as fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {DatabaseSync} from 'node:sqlite'
import {fileURLToPath} from 'node:url'
import {
  admitLaunch,
  buildSandboxLaunch,
  buildTracingLauncherValue,
  createSandboxAccount,
  FRO_BOT_PLUGIN_ID,
  FRO_BOT_PLUGIN_PACKAGE,
  FRO_BOT_PLUGIN_VERSION,
  getSessionDbBasenames,
} from '@fro-bot/runtime'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {
  decodeSpans,
  sleep,
  waitUntil,
} from '../../../packages/opencode-plugin/src/tracing/tracing.integration.fixture.js'
import {
  startTlsUpstream,
  type RecordedRequest,
  type TlsUpstream,
} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
import {startOtlpSink, type OtlpSink} from '../../../packages/runtime/src/tracing/otlp-sink.testing.js'
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
import {installPluginsV2} from '../../services/setup/plugin-install-v2.js'
import {admitRepoSkills, createRepoSkillsStagingRoot} from '../../services/setup/repo-skills.js'
import {createSandboxPreflightDeps, runSandboxPreflight} from '../../services/setup/sandbox-preflight.js'
import {createViewProbe} from '../../services/setup/sandbox-view-probe.js'
import {
  buildActionTracingHost,
  buildTraceSessionId,
  buildTracingRunIdentity,
  buildTracingRunLink,
  relayRequestFromInputs,
} from '../../services/setup/tracing.js'
import {STORAGE_VERSION} from '../../shared/constants.js'
import {getGitHubRunAttempt, getInvocationIdentity} from '../../shared/env.js'
import {createLifecycleTracer, createRegistryScrubber} from '../../shared/lifecycle-tracer.js'
import {createLogger} from '../../shared/logger.js'
import {createSecretRegistry} from '../../shared/secret-registry.js'
import {unwrapOk} from '../../shared/test-helpers.js'
import {parseTraceInputs} from '../config/trace-inputs.js'
import {startKeyProxyProcess, type KeyProxyProcess} from './key-proxy-process.js'
import {snapshotLogDirectory} from './log-snapshot.js'
import {createSandboxLifecycle} from './sandbox-lifecycle.js'
import {startTraceRelayProcess, type TraceRelayProcess, type TraceRelayStopResult} from './trace-relay-process.js'
import {
  canaryForms,
  canaryShapedValue,
  exportedSpans,
  plantScanControls,
  scanCommand,
  toolSpanHoldsArgument,
  type ScanSpec,
} from './v2-server.sandbox.canary.js'
import {
  fallbackHosts,
  startRecordingHttpSink,
  tracingFallbackDocument,
  type RecordingHttpSink,
} from './v2-server.sandbox.fallback.js'
import {
  aclLines,
  aclText,
  changedFilesSince,
  controlCoversMatrix,
  copyBundleWithImports,
  describeNamespaceMembers,
  describeReconstruction,
  failuresFor,
  findPaths,
  launcherLinkProbe,
  matrixDirectories,
  matrixSentinels,
  mountNamespaceIds,
  newLaunchNamespaces,
  parseRows,
  pgrepOutput,
  PRELUDE,
  q,
  readProbe,
  readSessionIds,
  runnerFirstLine,
  safeEnvPath,
  safeEnvToken,
  startPlainScriptedSession,
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

/**
 * The Node that runs the view builder, as the Action's own Node does in production. Under Bun the test process is not Node,
 * so the first `node` on PATH stands in.
 */
const builderNode =
  process.versions.bun === undefined
    ? process.execPath
    : spawnSync('sh', ['-c', 'command -v node'], {encoding: 'utf8'}).stdout.trim() || process.execPath

/** What a lifecycle needs to build the view: the Node that runs the builder, and the builder of the stand-in install. */
const viewLauncher = {nodePath: builderNode, builderPath: path.join(fakeActionRoot, 'dist', 'sandbox-view.js')}

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
  /** The directory of the Action's own OpenCode binary, which the agent's `PATH` gets last. */
  readonly opencodeDirectory?: string
  readonly repoSkills?: {readonly stagingRoot: string; readonly admittedDir: string | null}
  /** The `agent-state-home` input, resolved: an absolute directory inside `workspace`. */
  readonly agentStateHome?: string
  /** Called with the lifecycle as soon as it exists, so a suite's `afterAll` can release it if the run throws. */
  readonly onLifecycle?: (lifecycle: SandboxLifecycle) => void
  /** Called with the launch the lifecycle prepared (the account's uid is the one the handoff named). */
  readonly onPrepared?: (launch: {
    readonly account: {readonly uid: number; readonly gid: number}
    readonly xdg: {readonly config: string}
  }) => Promise<void> | void
  /** A plugin for the server to load and what the launcher says about tracing. Absent: no plugin, tracing off. */
  readonly tracing?: ScriptedTracing
  /** Awaited after the scripted turn and before the server is stopped. */
  readonly beforeShutdown?: () => Promise<void>
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
    runnerPath: options.env.PATH,
    opencodeDirectory: options.opencodeDirectory ?? null,
    runnerHome,
    workspacePath: options.workspace,
    responseDir: options.responseDir,
    agentStateHome: options.agentStateHome ?? null,
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
    await options.onPrepared?.(prepared.data)
    const handle = await startScriptedSession({
      binary: BINARY ?? '',
      workspace: options.workspace,
      env: options.env,
      lifecycle,
      keyFile: options.keyFile,
      provider,
      logger: options.logger,
      ...(options.tracing === undefined ? {} : {tracing: options.tracing}),
    })
    const rows = parseRows(provider.state.results.join('\n'))
    await options.beforeShutdown?.()
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
  // The view builder is the real bundle with everything it imports: the preflight probe and every launch run it as root.
  copyBundleWithImports(realDist, path.join(fakeActionRoot, 'dist'), 'sandbox-view.js')
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
    env: {...base.env, GITHUB_ACTION_REPOSITORY: 'fro-bot-sandbox-it/agent', GITHUB_ACTION_REF: 'refs/v1'},
    bundleDir: path.join(fakeActionRoot, 'dist'),
    invokedAs: path.join(fakeActionRoot, 'dist', 'main.js'),
    // The real probe, pointed at the stand-in install's builder: the preflight is part of what this suite proves.
    probeView: createViewProbe({
      exec: createExecAdapter(),
      logger,
      env: process.env,
      bundleDir: path.join(fakeActionRoot, 'dist'),
      nodePath: builderNode,
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
      runnerPath: env.PATH,
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
    straysAfterRelease = pgrepOutput(['-f', 'sleep 777'])
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
    const leftover = findPaths(
      [workspace, responseDir, '-xdev', '!', '-user', String(runnerUid), '!', '-name', 'pre-acl-root'],
      'looking for files the sandbox still owns',
    )
    expect(leftover).toEqual([])
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
    const read = (target: string): string => aclText(['-p', target])
    // #then the pre-existing named access entries and the pre-existing default entry are intact
    expect(read(path.join(workspace, 'pre-acl'))).toContain('user:nobody:r-x')
    expect(read(path.join(workspace, 'pre-acl-dir'))).toContain('user:nobody:r-x')
    expect(read(path.join(workspace, 'pre-acl-dir'))).toContain('default:user:nobody:r-x')
    // #and nothing of this run is left: no entry for the (deleted, so numeric) sandbox uid, anywhere
    const tree = aclText(['-R', '-p', workspace, responseDir])
    expect(tree).not.toMatch(/^(default:)?user:\d+:/m)
    // #and the runner has no entry in the handed-over directory beyond the ones it had before (none)
    const me = os.userInfo().username
    const handed = aclText(['-R', '-p', responseDir])
    expect(handed).not.toMatch(new RegExp(`^(default:)?user:${me}:`, 'm'))
  })

  it('leaves the runner grants that existed before the run alone, and gives model-created checkout files none of their own', () => {
    // #given a runner entry on a root-owned file and a runner default entry on a runner-owned directory, both from before
    const me = os.userInfo().username
    const read = (target: string): string => aclText(['-p', target])
    // #then both survived take-back exactly (the mask-preserving removal touched neither)
    expect(read(path.join(workspace, 'pre-acl-root'))).toContain(`user:${me}:r--`)
    expect(read(path.join(workspace, 'pre-acl-runner-default'))).toContain(`default:user:${me}:r-x`)
    // #and the only checkout paths that name the runner are those two: nothing this run created inherited an entry
    const tree = aclText(['-R', '-p', workspace])
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
    const acl = aclText(['-R', '-p', workspace])
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
    const acl = aclText(['-R', '-p', ghConfigDir, stagingRoot])
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
          // An unset root is skipped: an empty operand would make some grep builds scan the current directory. The `opencode`
          // entries of the agent's XDG roots are links, which `grep -r` follows only when named, so each is named too.
          `set --; for d in "$HOME" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_DATA_HOME/opencode" "$XDG_CONFIG_HOME/opencode" "$XDG_CACHE_HOME/opencode" "$XDG_STATE_HOME/opencode" ${q(responseDir)} ${q(workspace)}; do [ -n "$d" ] && set -- "$@" "$d"; done; files=$(leaks "$@"); ` +
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
      runnerPath: env.PATH,
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
  return mountNamespaceIds()
}

/**
 * Of the namespaces that appeared since `before`, those that belong to the launch. A hosted runner makes namespaces of its
 * own during a job (`snapd` has D-Bus activate `systemd-timedated`, which lives about 30 s in a private one), and no delay
 * outlasts that, so "no new id" is not the property: "no new namespace with a member of ours" is.
 */
function launchNamespacesSince(
  before: readonly string[],
  sandboxUid: number | null,
  markers: readonly string[],
): LaunchNamespaces {
  return newLaunchNamespaces(before, {sandboxUid, markers})
}

/** Fails when the launch left a namespace; the diff names its members and the host namespaces that were set aside. */
function expectNoLaunchNamespaces(result: LaunchNamespaces | undefined): void {
  // #given a check that ran (an unset result is "not checked", never "clean")
  expect(result).toBeDefined()
  const ignored = describeNamespaceMembers(result?.ignored ?? [])
  // #then no namespace of the launch is left; `ignored` is in both objects so a failure shows what was set aside
  expect({
    kept: result?.kept ?? ['not checked'],
    owners: describeNamespaceMembers(result?.keptMembers ?? []),
    ignored,
  }).toEqual({kept: [], owners: 'none', ignored})
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
  return pgrepOutput(['-d,', '-f', pattern])
}

describe.skipIf(!gated)('isolate-agent read-only view: the write boundary on a hosted runner', () => {
  const logger = createLogger({phase: 'sandbox-integration-view'})
  const scratch = path.join(runnerTemp, `sandbox-it-view-${process.pid}`)
  // Its own XDG roots: the commondir suite above ends `unsafe` and leaves the default ones owned by the sandbox uid.
  const xdgRoot = path.join(runnerTemp, `sandbox-it-view-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  // The shape the Action provisions in provision mode: a `gh-config-*` directory directly under RUNNER_TEMP.
  const ghConfigDir = path.join(runnerTemp, `gh-config-view-${process.pid}`)
  const env = hostedEnv(workspace, xdgRoot)
  const privateMarkers = ['/tmp', '/var/tmp', '/dev/shm'].map(dir => `${dir}/${VIEW_IT_PREFIX}-priv-${VIEW_TAG}`)
  const escapeDir = matrixDirs.includes('/usr/local/bin') ? '/usr/local/bin' : (matrixDirs[0] ?? '/usr/local/bin')
  const hardlinkSource = `${escapeDir}/${VIEW_IT_PREFIX}-hl-${VIEW_TAG}`

  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let sandboxUid: number | null = null
  let rows = new Map<string, readonly Row[]>()
  let controls = new Map<string, Row[]>()
  const facts = {
    mountsBefore: [] as string[],
    mountsAfter: [] as string[],
    launchNamespaces: undefined as LaunchNamespaces | undefined,
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
      onPrepared: launch => {
        sandboxUid = launch.account.uid
      },
    })
    rows = new Map(result.rows)
    released = result.released

    facts.mountsAfter = hostMountSet()
    facts.launchNamespaces = launchNamespacesSince(namespacesBefore, sandboxUid, [path.basename(scratch)])
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
    fs.rmSync(xdgRoot, {recursive: true, force: true})
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
    expectNoLaunchNamespaces(facts.launchNamespaces)
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
  // Its own XDG roots: the commondir suite above ends `unsafe` and leaves the default ones owned by the sandbox uid.
  const xdgRoot = path.join(runnerTemp, `sandbox-it-kill-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace, xdgRoot)
  const marker = `/tmp/${VIEW_IT_PREFIX}-kill-${VIEW_TAG}`
  const strayPattern = 'sleep 778[12]'

  let provider: ScriptedProvider | undefined
  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let strays = 'not checked'
  let markerLeft = true
  let launchNamespaces: LaunchNamespaces | undefined
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
      runnerPath: env.PATH,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
      viewLauncher,
    })
    const prepared = await lifecycle.prepare({keyFilePaths: [keyFile], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)
    const sandboxUid = prepared.data.account.uid
    await startScriptedSession({binary: BINARY ?? '', workspace, env, lifecycle, keyFile, provider, logger})

    // No graceful shutdown: the lifecycle is torn down with the server and its strays still running.
    released = await lifecycle.release()
    strays = strayProcesses(strayPattern)
    markerLeft = fs.existsSync(marker)
    launchNamespaces = launchNamespacesSince(namespacesBefore, sandboxUid, [strayPattern, path.basename(scratch)])
    mountsEqual = hostMountSet().join('\n') === mountsBefore.join('\n')
  }, 600_000)

  afterAll(async () => {
    await lifecycle?.release()
    await provider?.close()
    spawnSync('sudo', ['-n', 'pkill', '-KILL', '-f', strayPattern])
    fs.rmSync(marker, {force: true})
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(xdgRoot, {recursive: true, force: true})
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
    expectNoLaunchNamespaces(launchNamespaces)
    expect(mountsEqual).toBe(true)
  })
})

describe.skipIf(!gated)('isolate-agent read-only view: a second isolated run in the same job', () => {
  const logger = createLogger({phase: 'sandbox-integration-second'})
  const scratch = path.join(runnerTemp, `sandbox-it-second-${process.pid}`)
  // Its own XDG roots: the commondir suite above ends `unsafe` and leaves the default ones owned by the sandbox uid.
  const xdgRoot = path.join(runnerTemp, `sandbox-it-second-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace, xdgRoot)
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
    fs.rmSync(xdgRoot, {recursive: true, force: true})
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

/**
 * `agent-state-home` inside the checkout, in the two layouts a runner can have:
 *  - `link`: the runner's `XDG_STATE_HOME` is elsewhere, so the lifecycle links `<state home>/opencode` to the runner's own
 *    `<state>/opencode`, and removes the link after take-back;
 *  - `connect`: the runner's `XDG_STATE_HOME` *is* the state home, exactly as `connect.yaml` sets it, so `<state home>/opencode`
 *    is the runner's real, handed-over directory, nested inside the handed-over state home.
 */
function stateHomeSuite(layout: 'connect' | 'link'): void {
  const connect = layout === 'connect'
  describe.skipIf(!gated)(
    `isolate-agent agent-state-home (${layout} layout): a state directory and a clone inside the checkout`,
    () => {
      const logger = createLogger({phase: `sandbox-integration-state-home-${layout}`})
      const scratch = path.join(runnerTemp, `sandbox-it-state-home-${layout}-${process.pid}`)
      const xdgRoot = path.join(runnerTemp, `sandbox-it-state-home-${layout}-xdg-${process.pid}`)
      const workspace = path.join(scratch, 'ws')
      const stateHome = path.join(workspace, 'connect', 'state')
      const nested = path.join(workspace, 'connect', 'checkouts', 'nested')
      const responseDir = path.join(scratch, 'response')
      const keyDir = path.join(scratch, 'keys')
      // The connect layout: the runner's XDG_STATE_HOME is the state home itself (`connect.yaml` exports it to `$GITHUB_ENV`).
      const env = {...hostedEnv(workspace, xdgRoot), ...(connect ? {XDG_STATE_HOME: stateHome} : {})}
      const written = path.join(stateHome, 'systematic', 'connect', 'run.json')
      // In the link layout the note goes through the link into the runner's own state directory, and the link is gone
      // after take-back; in the connect layout `opencode` is that directory.
      const note = connect
        ? path.join(stateHome, 'opencode', 'agent-note')
        : path.join(xdgRoot, 'state', 'opencode', 'agent-note')
      const dbPath = path.join(xdgRoot, 'data', 'opencode', getSessionDbBasenames('v2').main)
      const uid = process.getuid?.()

      let result: IsolatedRunResult | undefined

      const steps = (): Probe[] => [
        {
          // What the connect helper does: its run record lives under `$XDG_STATE_HOME`, which must be the directory the runner named
          // and must be the sandbox's to write (the helper refuses a state root another uid owns). `opencode` there must reach the
          // runner's session storage: a link in one layout, the real directory in the other.
          id: 'state_home_write',
          category: 'works',
          cmd:
            `if [ "$XDG_STATE_HOME" = ${q(stateHome)} ] && mkdir -p "$XDG_STATE_HOME/systematic/connect" ` +
            `&& echo recorded > "$XDG_STATE_HOME/systematic/connect/run.json" ` +
            `&& ${connect ? '[ -d "$XDG_STATE_HOME/opencode" ] && [ ! -L "$XDG_STATE_HOME/opencode" ]' : '[ -L "$XDG_STATE_HOME/opencode" ]'} ` +
            `&& echo noted > "$XDG_STATE_HOME/opencode/agent-note"; ` +
            'then R state_home_write WORKS "wrote under XDG_STATE_HOME and through its opencode entry"; ' +
            'else R state_home_write FAILED "XDG_STATE_HOME=$XDG_STATE_HOME"; fi',
        },
        {
          // A repository the runner cloned under the checkout is the runner's, not the sandbox uid's: git trusts it only through
          // the `<checkout>/*` entry.
          id: 'nested_git_status',
          category: 'works',
          cmd:
            `if out=$(git -C ${q(nested)} status --porcelain 2>&1); then R nested_git_status WORKS "status ok"; ` +
            'else R nested_git_status FAILED "$(printf %s "$out" | ev)"; fi',
        },
      ]

      beforeAll(async () => {
        const tools = await preflightTools(logger)
        fs.mkdirSync(responseDir, {recursive: true})
        const keyFile = writeKeyFile(keyDir)
        initWorkspace(workspace)
        // Cloned by the runner, as the connect workflow does, before the sandbox exists.
        fs.mkdirSync(path.dirname(nested), {recursive: true})
        git(workspace, 'clone', '-q', workspace, nested)
        // The runner pre-creates the state directory and drops files in it (the connect hand-off files).
        fs.mkdirSync(stateHome, {recursive: true})
        fs.writeFileSync(path.join(stateHome, 'runner-handoff.json'), '{}')
        result = await runIsolated({
          tools,
          env,
          workspace,
          responseDir,
          keyFile,
          steps: steps(),
          logger,
          agentStateHome: stateHome,
        })
      }, 600_000)

      afterAll(() => {
        fs.rmSync(scratch, {recursive: true, force: true})
        fs.rmSync(xdgRoot, {recursive: true, force: true})
      }, 120_000)

      const everyEntry = (target: string): string[] =>
        fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink()
          ? [target, ...fs.readdirSync(target).flatMap(entry => everyEntry(path.join(target, entry)))]
          : [target]

      it('takes everything back: the teardown ends restored', () => {
        // #given the run, taken back after the server stopped
        // #then the stop was confirmed and the take-back found nothing foreign (it refused the nested layout once)
        expect(result?.released).toMatchObject({stop: 'stopped', restore: 'restored'})
      })

      it('gives the agent the named state home: it writes there and the file is in the checkout, runner-owned', () => {
        // #given the agent wrote a file under its XDG_STATE_HOME, and through its `opencode` entry
        // #then the probe saw the variable and the entry, and the runner finds both files owned by itself
        expect(failuresFor(result?.rows ?? new Map(), 'state_home_write', 'WORKS')).toEqual([])
        expect(fs.readFileSync(written, 'utf8')).toBe('recorded\n')
        expect(fs.lstatSync(written).uid).toBe(uid)
        expect(fs.readFileSync(note, 'utf8')).toBe('noted\n')
        expect(fs.lstatSync(note).uid).toBe(uid)
      })

      it('leaves nothing under the state home owned by anyone but the runner', () => {
        // #given the whole tree, the runner's pre-created file and the server's own state included
        const foreign = everyEntry(stateHome).filter(entry => fs.lstatSync(entry).uid !== uid)

        // #then none of it stayed the sandbox's
        expect(foreign).toEqual([])
        expect(fs.readFileSync(path.join(stateHome, 'runner-handoff.json'), 'utf8')).toBe('{}')
      })

      it.skipIf(!connect)('keeps the real opencode directory as it was: no link was made over it', () => {
        // #given the connect layout after take-back
        // #then `opencode` is still the runner's real directory
        expect(fs.lstatSync(path.join(stateHome, 'opencode')).isDirectory()).toBe(true)
      })

      it.skipIf(connect)('removes the opencode link the lifecycle made in the state home', () => {
        // #given the link layout after take-back
        // #then our link is gone, and the note that went through it is in the runner's own state directory
        expect(fs.existsSync(path.join(stateHome, 'opencode'))).toBe(false)
        expect(fs.readFileSync(path.join(xdgRoot, 'state', 'opencode', 'agent-note'), 'utf8')).toBe('noted\n')
      })

      it('leaves the OpenCode session database readable by the runner, with the run in it', () => {
        // #given the session storage the server wrote through the data directory
        // #then the runner can open it, it is sound, and the scripted session is in it
        expect(integrityCheck(dbPath)).toBe('ok')
        expect(readSessionIds(dbPath).length).toBeGreaterThan(0)
      })

      it('runs git in a repository the runner cloned under the checkout', () => {
        // #given the probe ran `git -C <checkout>/connect/checkouts/nested status` as the sandbox uid
        // #then it was trusted
        expect(failuresFor(result?.rows ?? new Map(), 'nested_git_status', 'WORKS')).toEqual([])
      })
    },
  )
}

stateHomeSuite('link')
stateHomeSuite('connect')

describe.skipIf(!gated)('isolate-agent read-only view: a launcher killed while the chain waits at its gate', () => {
  const logger = createLogger({phase: 'sandbox-integration-gate'})
  const scratch = path.join(runnerTemp, `sandbox-it-gate-${process.pid}`)
  // Its own XDG roots: the commondir suite above ends `unsafe` and leaves the default ones owned by the sandbox uid.
  const xdgRoot = path.join(runnerTemp, `sandbox-it-gate-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace, xdgRoot)
  const marker = path.join(workspace, `${VIEW_IT_PREFIX}-gate-ran-${VIEW_TAG}`)
  const strayPattern = 'sleep 7791'

  let lifecycle: SandboxLifecycle | undefined
  let released: SandboxReleaseResult | undefined
  let gateDir = ''
  let gateReported = false
  let processesAtGate = 'not checked'
  let processesAfter = 'not checked'
  let markerAfterWait = true
  let sandboxUid: number | null = null
  let launchNamespaces: LaunchNamespaces | undefined
  let gateNamespace = 'not read'
  let namespacesAtGate: LaunchNamespaces | undefined

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)
    const namespacesBefore = mountNamespaces()
    const markers = (): string[] => [path.basename(gateDir), strayPattern, path.basename(scratch)]

    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerPath: env.PATH,
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
    sandboxUid = prepared.data.account.uid

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
      // Positive control for the scan the teardown check relies on: the orphan is still at the gate, so its namespace
      // must be found as the launch's.
      gateNamespace = /\d+/.exec(fs.readFileSync(path.join(gateDir, 'ns'), 'utf8'))?.[0] ?? 'unreadable'
      namespacesAtGate = launchNamespacesSince(namespacesBefore, sandboxUid, markers())
      return {value: 'killed at the gate', unconfirmed: false}
    })

    released = await lifecycle.release()
    // A chain that had passed the gate would have written the marker within milliseconds.
    await new Promise(resolve => setTimeout(resolve, 3000))
    markerAfterWait = fs.existsSync(marker)
    processesAfter = strayProcesses(`${path.basename(gateDir)}|${strayPattern}`)
    launchNamespaces = launchNamespacesSince(namespacesBefore, sandboxUid, markers())
  }, 300_000)

  afterAll(async () => {
    await lifecycle?.release()
    spawnSync('sudo', ['-n', 'pkill', '-KILL', '-f', strayPattern])
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(xdgRoot, {recursive: true, force: true})
  }, 120_000)

  it('held the chain at the gate: it reported its namespace and nothing past the gate ran', () => {
    // #given a launch whose go-ahead was never given
    // #then the gate had written its id, was still running, and the stand-in server never started
    expect(gateReported).toBe(true)
    expect(processesAtGate).not.toBe('')
    expect(markerAfterWait).toBe(false)
  })

  it('found the orphan’s namespace as the launch’s while it waited, so the teardown check can fail', () => {
    // #given the scan ran with the orphan still at the gate
    // #then the namespace the gate reported is among the kept ones
    expect(namespacesAtGate?.kept).toContain(gateNamespace)
  })

  it('is restored only because the orphaned root process was confirmed gone', () => {
    // #given the launcher was killed and its child orphaned
    // #then the release confirmed the stop, and no process of the launch is left
    expect(released).toMatchObject({stop: 'stopped', restore: 'restored'})
    expect(processesAfter).toBe('')
    expectNoLaunchNamespaces(launchNamespaces)
  })
})

// --- 10. The agent's PATH ----------------------------------------------------------------------------------------------

/** Where `name` resolves for the runner, or null. The runner's PATH is what the agent's is built from. */
function runnerTool(name: string): string | null {
  const found = spawnSync('sh', ['-c', `command -v ${name}`], {encoding: 'utf8'})
  const resolved = found.stdout.trim()
  return found.status === 0 && resolved.startsWith('/') ? resolved : null
}

/** The first line of what the runner's own `command` prints: what the agent's shell must report too. */
function runnerReports(command: string): string {
  return runnerFirstLine(command)
}

const pathTools = gated ? {node: runnerTool('node'), uv: runnerTool('uv')} : {node: null, uv: null}
/** The tools the CI job provisions (`setup-node`, `setup-uv`) that are not on the runner's PATH. Empty off a runner. */
const missingPathTools = Object.entries(pathTools)
  .filter(([, found]) => found === null)
  .map(([name]) => name)

describe.skipIf(!gated)("isolate-agent PATH mirrors the runner's", () => {
  const logger = createLogger({phase: 'sandbox-integration-path'})
  const scratch = path.join(runnerTemp, `sandbox-it-path-${process.pid}`)
  // Its own XDG roots: the commondir suite above ends `unsafe` and leaves the default ones owned by the sandbox uid.
  const xdgRoot = path.join(runnerTemp, `sandbox-it-path-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace, xdgRoot)
  // What setup resolved: the suite's pinned binary, in a directory no runner PATH entry names.
  const opencodeDirectory = path.dirname(BINARY ?? '')

  let result: IsolatedRunResult | undefined
  const expected = {
    nodePath: pathTools.node ?? '',
    nodeVersion: gated ? runnerReports('node -v') : '',
    uvPath: pathTools.uv ?? '',
    uvVersion: gated ? runnerReports('uv --version') : '',
  }

  const steps: Probe[] = [
    {
      id: 'path_node',
      category: 'works',
      cmd: 'v=$(node -v 2>&1 | head -1); p=$(command -v node); [ -n "$v" ] && R path_node WORKS "$v $p" || R path_node FAILED "node did not run"',
    },
    {
      id: 'path_uv',
      category: 'works',
      cmd: 'v=$(uv --version 2>&1 | head -1); p=$(command -v uv); [ -n "$p" ] && R path_uv WORKS "$v $p" || R path_uv FAILED "uv not found"',
    },
    {
      // The system tools still resolve through the appended system directories.
      id: 'path_system',
      category: 'works',
      cmd: 'p=$(command -v git); case "$p" in /*) R path_system WORKS "$p";; *) R path_system FAILED "git not found";; esac',
    },
    {
      // Nothing on the runner's PATH provides `opencode`, so it resolves only through the Action's directory, appended last.
      id: 'path_opencode',
      category: 'works',
      // The exit status must be zero: an executable that resolves but fails to start is not a working `opencode`.
      cmd: String.raw`if ! p=$(command -v opencode); then R path_opencode FAILED "not on PATH"; elif v=$(opencode --version 2>&1); then R path_opencode WORKS "$p $(printf "%s\n" "$v" | sed -n 1p)"; else R path_opencode FAILED "opencode --version failed"; fi`,
    },
    {
      id: 'path_value',
      category: 'info',
      cmd: 'R path_value INFO "$PATH"',
    },
  ]

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)
    result = await runIsolated({tools, env, workspace, responseDir, keyFile, steps, logger, opencodeDirectory})
  }, 600_000)

  afterAll(() => {
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(xdgRoot, {recursive: true, force: true})
  }, 120_000)

  it('starts from a runner that has the tools this suite checks', () => {
    // #given the gated run is on, so the job is expected to have run `setup-node` and `setup-uv`
    // #then a missing tool is a failure of the job's setup, not a reason to skip the checks below
    expect(missingPathTools).toEqual([])
  })

  it('runs the runner’s node, the version and the file the runner reports', () => {
    // #given the agent's shell ran `node -v` and `command -v node`
    // #then both match what the runner resolves and reports
    expect(failuresFor(result?.rows ?? new Map(), 'path_node', 'WORKS')).toEqual([])
    expect(result?.rows.get('path_node')?.[0]?.evidence).toBe(`${expected.nodeVersion} ${expected.nodePath}`)
  })

  it('runs the runner’s uv, the version and the file the runner reports', () => {
    // #given the agent's shell ran `uv --version` and `command -v uv`
    // #then both match what the runner resolves and reports
    expect(failuresFor(result?.rows ?? new Map(), 'path_uv', 'WORKS')).toEqual([])
    expect(result?.rows.get('path_uv')?.[0]?.evidence).toBe(`${expected.uvVersion} ${expected.uvPath}`)
  })

  it('finds the Action’s own opencode, last on the PATH, and it runs', () => {
    // #given `command -v opencode` and `opencode --version` in the agent's shell, with the runner's PATH holding no opencode
    const evidence = result?.rows.get('path_opencode')?.[0]?.evidence ?? ''
    const agentPath = (result?.rows.get('path_value')?.[0]?.evidence ?? '').split(':')

    // #then both succeed, it resolves into the Action's directory, and that directory is the final PATH entry
    expect(failuresFor(result?.rows ?? new Map(), 'path_opencode', 'WORKS')).toEqual([])
    expect(evidence.startsWith(`${opencodeDirectory}/opencode `)).toBe(true)
    expect(evidence.slice(`${opencodeDirectory}/opencode `.length)).toMatch(/\bv?\d+\.\d+\.\d+/)
    expect(agentPath.at(-1)).toBe(opencodeDirectory)
  })

  it('still resolves the system tools', () => {
    // #given `git` looked up in the agent's shell
    // #then it is found
    expect(failuresFor(result?.rows ?? new Map(), 'path_system', 'WORKS')).toEqual([])
  })

  it('has the runner’s tool directories in order, then the system directories', () => {
    // #given the agent's PATH, as its shell reports it
    const agentPath = (result?.rows.get('path_value')?.[0]?.evidence ?? '').split(':')

    // #then the directory of the runner's node comes before the directory of its uv or after, as on the runner, and every
    // system directory is present
    const runnerEntries = (process.env.PATH ?? '').split(':')
    const nodeDir = path.dirname(expected.nodePath)
    const uvDir = path.dirname(expected.uvPath)
    expect(agentPath).toContain(nodeDir)
    expect(agentPath).toContain(uvDir)
    expect(Math.sign(agentPath.indexOf(nodeDir) - agentPath.indexOf(uvDir))).toBe(
      Math.sign(runnerEntries.indexOf(nodeDir) - runnerEntries.indexOf(uvDir)),
    )
    for (const directory of ['/usr/local/bin', '/usr/bin', '/bin']) expect(agentPath).toContain(directory)
  })

  it('restored the run', () => {
    // #given the release of the run
    // #then it was stopped and taken back
    expect(result?.released).toMatchObject({stop: 'stopped', restore: 'restored'})
  })
})

// --- 11. bun and pnpm --------------------------------------------------------------------------------------------------

const toolRoots = {bun: path.join(runnerHome, '.bun'), pnpm: path.join(runnerHome, 'setup-pnpm')}
const toolFacts = gated
  ? {
      bun: runnerTool('bun'),
      pnpm: runnerTool('pnpm'),
      bunVersion: runnerReports('cd /tmp && bun --version'),
      // Not from the checkout: its package.json names bun as the package manager, which pnpm complains about.
      pnpmVersion: runnerReports('cd /tmp && pnpm --version'),
    }
  : {bun: null, pnpm: null, bunVersion: '', pnpmVersion: ''}

/** Why this runner cannot run the suite. The CI job provisions both tools, so a gated run that lacks one must fail. */
function toolProblems(): string[] {
  const problems: string[] = []
  for (const name of ['bun', 'pnpm'] as const) {
    const found = toolFacts[name]
    if (found === null) problems.push(`${name} is not on the runner's PATH`)
    else if (!found.startsWith(`${toolRoots[name]}/`))
      problems.push(`${name} resolves to ${found}, not under ${toolRoots[name]}`)
  }
  return problems
}

describe.skipIf(!gated)('isolate-agent runs bun and pnpm from their install roots', () => {
  const logger = createLogger({phase: 'sandbox-integration-tools'})
  const tag = String(process.pid)
  const scratch = path.join(runnerTemp, `sandbox-it-tools-${process.pid}`)
  // Its own XDG roots: the commondir suite above ends `unsafe` and leaves the default ones owned by the sandbox uid.
  const xdgRoot = path.join(runnerTemp, `sandbox-it-tools-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const keyDir = path.join(scratch, 'keys')
  const env = hostedEnv(workspace, xdgRoot)
  // The directories the two binaries sit in (what `command -v` resolves to on the runner's PATH).
  const binaryDirs = {bun: path.dirname(toolFacts.bun ?? ''), pnpm: path.dirname(toolFacts.pnpm ?? '')}
  const canary = path.join(runnerHome, `.fro-bot-it-canary-${tag}`)
  const canaryDir = path.join(runnerHome, `.fro-bot-it-canary-dir-${tag}`)
  // A link INSIDE a granted root that names a runner-private file: the grant must not follow it.
  const link = path.join(toolRoots.bun, `fro-bot-it-link-${tag}`)
  const marker = path.join(scratch, 'marker')
  const aclBefore = new Map<string, string[]>()
  const sharedAclTargets = (): string[] => [runnerHome, path.dirname(runnerTemp), runnerTemp, path.dirname(workspace)]

  let result: IsolatedRunResult | undefined
  let sandboxUid = -1
  let controls = new Map<string, Row[]>()
  const facts = {
    changedInRoots: [] as string[],
    aclAfter: [] as string[],
    aclChanged: [] as string[],
    leftovers: [] as string[],
    otherToolInRunnerXdg: [] as string[],
  }

  const fixtureDir = (name: string): string => path.join(workspace, 'fixtures', name)
  const installProbe = (id: string, directory: string, command: string, expectDirectory: string): Probe => ({
    id,
    category: 'works',
    cmd:
      `cd ${q(directory)} && o=$(${command} 2>&1); rc=$?; ` +
      `if [ $rc -eq 0 ] && [ -d ${q(`${directory}/node_modules/${expectDirectory}`)} ]; then R ${id} WORKS "installed"; ` +
      `else R ${id} FAILED "rc=$rc [$(printf %s "$o" | tail -c 300 | ev)]"; fi`,
  })

  const steps = (): Probe[] => [
    {
      id: 'tool_bun',
      category: 'works',
      cmd: 'cd /tmp && v=$(bun --version 2>&1 | head -1); p=$(command -v bun); [ -n "$p" ] && R tool_bun WORKS "$v $p" || R tool_bun FAILED "bun not found"',
    },
    {
      id: 'tool_pnpm',
      category: 'works',
      cmd: 'cd /tmp && v=$(pnpm --version 2>&1 | head -1); p=$(command -v pnpm); [ -n "$p" ] && R tool_pnpm WORKS "$v $p" || R tool_pnpm FAILED "pnpm not found"',
    },
    // Installs of a local package, offline, and of one tiny registry package (left-pad@1.3.0, the one the earlier hosted
    // measurements installed): both tools must succeed with the account's own home and the checkout as their only writes.
    installProbe('tool_bun_install', fixtureDir('bun-local'), 'bun install', 'local-pkg'),
    installProbe('tool_bun_install_registry', fixtureDir('bun-registry'), 'bun install', 'left-pad'),
    installProbe('tool_pnpm_install', fixtureDir('pnpm-local'), 'pnpm install --no-frozen-lockfile', 'local-pkg'),
    installProbe(
      'tool_pnpm_install_registry',
      fixtureDir('pnpm-registry'),
      'pnpm install --no-frozen-lockfile',
      'left-pad',
    ),
    {
      // uv from the tool cache: a project venv in the checkout, one tiny registry package, and an import through it.
      id: 'tool_uv_install',
      category: 'works',
      cmd:
        `cd ${q(fixtureDir('uv-project'))} && o=$( { uv venv .venv && uv pip install --python .venv/bin/python six && ` +
        `.venv/bin/python -c 'import six'; } 2>&1); rc=$?; ` +
        `if [ $rc -eq 0 ]; then R tool_uv_install WORKS "installed"; ` +
        `else R tool_uv_install FAILED "rc=$rc [$(printf %s "$o" | tail -c 300 | ev)]"; fi`,
    },
    {
      // The agent's runtime directory is its own: tools that keep sockets there (agent-browser) can create them.
      id: 'runtime_dir_own',
      category: 'works',
      cmd:
        `case "$XDG_RUNTIME_DIR" in "$HOME"/*) ;; *) R runtime_dir_own FAILED "not under the home: $XDG_RUNTIME_DIR"; exit 0;; esac; ` +
        `mkdir -p "$XDG_RUNTIME_DIR/fro-bot-it" && R runtime_dir_own WORKS "$XDG_RUNTIME_DIR" || R runtime_dir_own FAILED "cannot write $XDG_RUNTIME_DIR"`,
    },
    {
      // A missing command is "not found", not "permission denied": the agent's PATH holds no directory it can't enter
      // (the runner image puts `~/.cargo/bin` and `~/.dotnet/tools` on the runner's).
      id: 'path_missing_command',
      category: 'works',
      cmd:
        `code=$(node -e "require('child_process').spawn('fro-bot-no-such-command').on('error', e => console.log(e.code))") && ` +
        `[ "$code" = ENOENT ] && R path_missing_command WORKS "$code" || R path_missing_command FAILED "spawn reported $code"`,
    },
    {
      // Git trusts the runner-owned checkout even with the global and system config files turned off, as test suites do.
      id: 'git_safe_directory_env',
      category: 'works',
      cmd:
        `out=$(GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null HOME=$(mktemp -d) git -C ${q(workspace)} rev-parse --is-inside-work-tree 2>&1) && ` +
        `R git_safe_directory_env WORKS "$out" || R git_safe_directory_env FAILED "$out"`,
    },
    {
      // Any tool that follows XDG: its cache and data land in the agent's own XDG roots, in its home.
      id: 'tool_xdg_other',
      category: 'works',
      cmd:
        `mkdir -p "$XDG_CACHE_HOME/othertool" "$XDG_DATA_HOME/othertool" && echo x > "$XDG_CACHE_HOME/othertool/x" && ` +
        `echo x > "$XDG_DATA_HOME/othertool/x" && a=$(readlink -f "$XDG_CACHE_HOME/othertool/x") && ` +
        `b=$(readlink -f "$XDG_DATA_HOME/othertool/x") && case "$a$b" in *"$HOME"/*"$HOME"/*) R tool_xdg_other WORKS "$a $b";; ` +
        `*) R tool_xdg_other FAILED "outside the home: $a $b";; esac || R tool_xdg_other FAILED "write failed"`,
    },
    {
      // Where each tool put its cache: all belong in the agent's own home, and none in the checkout.
      id: 'tool_cache_places',
      category: 'info',
      cmd:
        `places=""; for d in "$HOME/.local/share/pnpm/store" "$HOME/.bun/install/cache" "$HOME/.cache/uv" ` +
        `${q(fixtureDir('bun-registry'))}/node_modules/.cache ${q(fixtureDir('pnpm-registry'))}/.pnpm-store; ` +
        `do [ -e "$d" ] && places="$places $d"; done; R tool_cache_places INFO "$places"`,
    },
    // The roots stay read-only (create, append, rename, unlink next to the tool), and so does the binary itself.
    ...(['bun', 'pnpm'] as const).map(name =>
      writeMatrixProbe(`tool_ro_${name}`, toolRoots[name], tag, os.userInfo().uid),
    ),
    // The directories that hold the binaries too: create, append, rename and unlink next to `bun` and `pnpm` themselves.
    ...(['bun', 'pnpm'] as const).map(name =>
      writeMatrixProbe(`tool_ro_${name}_bin`, binaryDirs[name], tag, os.userInfo().uid),
    ),
    {
      // pnpm's file, not bun's: the runner's own control cannot open the running bun (this suite runs under it) for writing.
      id: 'tool_binary_write',
      category: 'blocked',
      control: true,
      cmd:
        `b=$(command -v pnpm); if ( : >> "$b" ) 2>/dev/null; then R tool_binary_write OPEN "opened the binary for writing"; ` +
        `else R tool_binary_write BLOCKED "refused"; fi`,
    },
    // What the grant must not reach: a file and a directory beside the roots, and what a link inside a root names.
    {id: 'tool_canary_file', category: 'blocked', control: true, cmd: readProbe('tool_canary_file', canary)},
    {
      id: 'tool_canary_dir',
      category: 'blocked',
      control: true,
      cmd: readProbe('tool_canary_dir', path.join(canaryDir, 'secret')),
    },
    {id: 'tool_canary_link', category: 'blocked', control: true, cmd: readProbe('tool_canary_link', link)},
    {
      id: 'tool_home_listing',
      category: 'blocked',
      control: true,
      // The home's own listing: the sandbox may traverse it, but not list it.
      cmd: `if ls ${q(runnerHome)} >/dev/null 2>&1; then R tool_home_listing OPEN "listed"; else R tool_home_listing BLOCKED "refused"; fi`,
    },
  ]

  beforeAll(async () => {
    const problems = toolProblems()
    if (problems.length > 0)
      throw new Error(`The tools suite needs bun and pnpm set up before it runs: ${problems.join('; ')}`)
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(keyDir)
    initWorkspace(workspace)

    // Fixture projects in the checkout: two offline ones with a local package, two with one registry package.
    for (const [name, withRegistry] of [
      ['bun-local', false],
      ['bun-registry', true],
      ['pnpm-local', false],
      ['pnpm-registry', true],
    ] as const) {
      const dir = fixtureDir(name)
      fs.mkdirSync(path.join(dir, 'local-pkg'), {recursive: true})
      fs.writeFileSync(
        path.join(dir, 'local-pkg', 'package.json'),
        '{"name":"local-pkg","version":"1.0.0","main":"index.js"}\n',
      )
      fs.writeFileSync(path.join(dir, 'local-pkg', 'index.js'), 'module.exports = 1\n')
      const dependencies: Record<string, string> = {'local-pkg': 'file:./local-pkg'}
      if (withRegistry) dependencies['left-pad'] = '1.3.0'
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', dependencies}))
    }
    fs.mkdirSync(fixtureDir('uv-project'), {recursive: true})
    // The checkout is committed state: the fixtures are untracked files in it, which the handoff does not mind.

    // Canaries beside the roots (readable by anyone if nothing denied them), a link inside a root, and sentinels in the roots.
    fs.writeFileSync(canary, 'canary', {mode: 0o644})
    fs.mkdirSync(canaryDir, {mode: 0o755})
    fs.writeFileSync(path.join(canaryDir, 'secret'), 'canary', {mode: 0o644})
    fs.symlinkSync(canary, link)
    for (const root of [toolRoots.bun, toolRoots.pnpm, binaryDirs.bun, binaryDirs.pnpm]) {
      for (const file of matrixSentinels(root, tag)) {
        fs.writeFileSync(file, 'sentinel')
        fs.chmodSync(file, 0o666)
      }
    }

    controls = runControls(steps(), workspace, process.env)
    // What is on the shared directories before this suite's run. An earlier suite in the same job may have left entries for
    // the account's uid (the commondir suite ends unsafe on purpose and keeps its grants), so the run is judged by what it
    // changes, not by what the directories already held.
    for (const target of sharedAclTargets()) aclBefore.set(target, aclLines(target, false))
    fs.writeFileSync(marker, 'm')
    // The marker is older than everything the run does, newer than everything this setup did.
    await new Promise(resolve => setTimeout(resolve, 1100))

    result = await runIsolated({
      tools,
      env,
      workspace,
      responseDir,
      keyFile,
      steps: steps(),
      logger,
      onPrepared: launch => {
        sandboxUid = launch.account.uid
      },
    })

    // What the runner finds afterwards: anything new or changed in the roots, and any entry left for the agent's uid.
    for (const root of [toolRoots.bun, toolRoots.pnpm]) {
      facts.changedInRoots.push(...changedFilesSince(root, marker, VIEW_IT_PREFIX))
    }
    // Nothing a tool wrote to its XDG directories reached the runner's own XDG roots.
    facts.otherToolInRunnerXdg.push(...findPaths([xdgRoot, '-name', 'othertool'], 'the runner XDG roots'))
    // Paths this suite alone touches must carry no entry for the account at all.
    const uidEntry = new RegExp(`^(default:)?user:(${sandboxUid}|fro-bot-sandbox):`)
    for (const target of [toolRoots.bun, toolRoots.pnpm]) {
      facts.aclAfter.push(
        ...aclLines(target, true)
          .filter(line => uidEntry.test(line))
          .map(line => `${target}: ${line}`),
      )
    }
    for (const target of [canary, canaryDir]) {
      facts.aclAfter.push(
        ...aclLines(target, false)
          .filter(line => uidEntry.test(line))
          .map(line => `${target}: ${line}`),
      )
    }
    // Shared directories must hold what they held before the run.
    for (const [target, before] of aclBefore) {
      const after = aclLines(target, false)
      facts.aclChanged.push(
        ...after.filter(line => !before.includes(line)).map(line => `${target}: gained ${line}`),
        ...before.filter(line => !after.includes(line)).map(line => `${target}: lost ${line}`),
      )
    }
    for (const root of [toolRoots.bun, toolRoots.pnpm, binaryDirs.bun, binaryDirs.pnpm]) {
      for (const file of matrixSentinels(root, tag).filter(
        entry => entry.endsWith('-sbx') || entry.endsWith('-sbx-unlink'),
      )) {
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '<missing>'
        if (content !== 'sentinel') facts.leftovers.push(`${file}: ${content}`)
      }
    }
  }, 900_000)

  afterAll(() => {
    for (const root of [toolRoots.bun, toolRoots.pnpm, binaryDirs.bun, binaryDirs.pnpm]) {
      for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        if (name.startsWith(`${VIEW_IT_PREFIX}-`)) fs.rmSync(path.join(root, name), {recursive: true, force: true})
      }
    }
    fs.rmSync(canary, {force: true})
    fs.rmSync(canaryDir, {recursive: true, force: true})
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(xdgRoot, {recursive: true, force: true})
  }, 120_000)

  it('has a runner-side control for every blocked row', () => {
    // #given the same commands run as the runner
    // #then each managed to do what the sandbox is shown not to (a blocked row without a working control proves nothing)
    expect(uncontrolledRows(controls)).toEqual([])
    expect(controlCoversMatrix(controls.get('tool_ro_bun'))).toBe(true)
    expect(controlCoversMatrix(controls.get('tool_ro_pnpm'))).toBe(true)
    expect(controlCoversMatrix(controls.get('tool_ro_bun_bin'))).toBe(true)
    expect(controlCoversMatrix(controls.get('tool_ro_pnpm_bin'))).toBe(true)
  })

  it('runs the runner’s bun, with the version and the file the runner reports', () => {
    // #given `bun --version` and `command -v bun` in the agent's shell
    // #then both match what the runner resolves and reports
    expect(failuresFor(result?.rows ?? new Map(), 'tool_bun', 'WORKS')).toEqual([])
    expect(result?.rows.get('tool_bun')?.[0]?.evidence).toBe(`${toolFacts.bunVersion} ${toolFacts.bun}`)
  })

  it('runs the runner’s pnpm, with the version and the file the runner reports', () => {
    // #given the same for pnpm
    // #then
    expect(failuresFor(result?.rows ?? new Map(), 'tool_pnpm', 'WORKS')).toEqual([])
    expect(result?.rows.get('tool_pnpm')?.[0]?.evidence).toBe(`${toolFacts.pnpmVersion} ${toolFacts.pnpm}`)
  })

  it.each([
    'tool_bun_install',
    'tool_bun_install_registry',
    'tool_pnpm_install',
    'tool_pnpm_install_registry',
    'tool_uv_install',
  ])('installs: %s succeeds in the checkout as the agent', id => {
    // #given an install of a tiny project in the checkout
    // #then it succeeded and put its package in node_modules
    expect(failuresFor(result?.rows ?? new Map(), id, 'WORKS')).toEqual([])
  })

  it('keeps the install roots read-only: create, append, rename and unlink are refused, and so is opening the binary', () => {
    // #given the write matrix on each root and an append-open of the bun binary
    // #then nothing worked
    for (const id of ['tool_ro_bun', 'tool_ro_pnpm', 'tool_ro_bun_bin', 'tool_ro_pnpm_bin', 'tool_binary_write']) {
      expect(failuresFor(result?.rows ?? new Map(), id, 'BLOCKED')).toEqual([])
    }
    // #and the sentinels the runner placed in the roots are untouched
    expect(facts.leftovers).toEqual([])
    // #and nothing in either root is new or changed after the run began
    expect(facts.changedInRoots).toEqual([])
  })

  it('leaves every other entry of the home unreadable: the canary file, the canary directory, a link inside a root, the listing', () => {
    // #given the home was made traversable for the roots
    // #then what lies beside the roots is still refused, and so is what a link inside a root names
    for (const id of ['tool_canary_file', 'tool_canary_dir', 'tool_canary_link', 'tool_home_listing']) {
      expect(failuresFor(result?.rows ?? new Map(), id, 'BLOCKED')).toEqual([])
    }
  })

  it('left no ACL entry for the agent’s uid on the roots or canaries, and the shared directories as it found them', () => {
    // #given the runner reads the ACLs after take-back
    // #then the uid was captured, nothing remains on what this suite owns, and the home, the work directory and RUNNER_TEMP
    // hold exactly the entries they held before the run
    expect(sandboxUid).toBeGreaterThan(0)
    expect(facts.aclAfter).toEqual([])
    expect(facts.aclChanged).toEqual([])
    expect(result?.released).toMatchObject({stop: 'stopped', restore: 'restored'})
  })

  it('gives the agent a runtime directory of its own that it can write', () => {
    // #given the agent created a directory under $XDG_RUNTIME_DIR
    // #then it is under the account's home and the write succeeded
    expect(failuresFor(result?.rows ?? new Map(), 'runtime_dir_own', 'WORKS')).toEqual([])
  })

  it('reports a missing command as not found and lets git use the runner’s checkout with its config files off', () => {
    // #given the agent spawned a command that doesn't exist and ran git with no global or system config
    // #then the spawn failed with ENOENT, not EACCES, and git still trusted the checkout
    expect(failuresFor(result?.rows ?? new Map(), 'path_missing_command', 'WORKS')).toEqual([])
    expect(failuresFor(result?.rows ?? new Map(), 'git_safe_directory_env', 'WORKS')).toEqual([])
  })

  it('gives any tool that follows XDG the agent’s own XDG roots, not the runner’s', () => {
    // #given a tool wrote to $XDG_CACHE_HOME and $XDG_DATA_HOME as the agent
    // #then both writes resolved into the account's home, and the runner's XDG roots hold nothing of it
    expect(failuresFor(result?.rows ?? new Map(), 'tool_xdg_other', 'WORKS')).toEqual([])
    expect(facts.otherToolInRunnerXdg).toEqual([])
  })

  it('keeps the tools’ caches in the agent’s own home and out of the checkout', () => {
    // #given where the registry installs left their caches
    const places = result?.rows.get('tool_cache_places')?.[0]?.evidence ?? ''

    // #then pnpm's store and bun's and uv's caches are under the account's home, and nothing is in the checkout (it could be
    // committed)
    expect(places).toMatch(/\/\.local\/share\/pnpm\/store/)
    expect(places).toMatch(/\/\.bun\/install\/cache/)
    expect(places).toMatch(/\/\.cache\/uv/)
    expect(places).not.toContain('/fixtures/')
  })
})

// --- 14. Run tracing ---------------------------------------------------------------------------------------------------

/** The first plugin version that traces. */
const TRACING_PLUGIN_MIN_VERSION = [0, 2, 0] as const

function pinTraces(version: string): boolean {
  const parts = version.split('.').map(Number)
  for (const [index, least] of TRACING_PLUGIN_MIN_VERSION.entries()) {
    const part = parts[index] ?? 0
    if (part !== least) return part > least
  }
  return true
}

// These rows load the plugin the Action pins, installed from the registry as setup installs it. The suite has no local-build
// path (the real-binary tracing test in tracing.integration.test.ts has one, outside the sandbox), so the rows run once the
// pin names a version with tracing.
const tracingGated = gated && pinTraces(FRO_BOT_PLUGIN_VERSION)

/**
 * Unique per process, so any copy of it anywhere is this run's. The sandbox is never given it: the search it runs gets the
 * canary's SHA-256 and length (see `v2-server.sandbox.canary.ts`), and its detector controls are other values of the same shape.
 */
const TRACE_CANARY = canaryShapedValue('sk-trace-canary-', randomBytes(18).toString('hex'))
const TRACE_HEADERS = `Authorization: Bearer ${TRACE_CANARY}`
/**
 * A command-only marker: the scripted tool command starts with it as a no-op (`: marker`), so it is in the tool call's
 * arguments and in no output the command prints. It is what ties an exported tool span to this call.
 */
const TOOL_ARGUMENT_MARKER = `toolarg-marker-${randomBytes(8).toString('hex')}`
const SCAN_CONTROLS = {
  liveControl: canaryShapedValue('sk-trace-live-', randomBytes(18).toString('hex')),
  xdgTextControl: canaryShapedValue('sk-trace-xdgt-', randomBytes(18).toString('hex')),
  xdgBinaryControl: canaryShapedValue('sk-trace-xdgb-', randomBytes(18).toString('hex')),
  longControl: canaryShapedValue('sk-trace-long-', randomBytes(18).toString('hex')),
  boundaryControl: canaryShapedValue('sk-trace-edge-', randomBytes(18).toString('hex')),
} as const

/** Counts processes whose command line names the relay's bundle, after showing the search a process that does. */
function noRelayProcessProbe(): Probe {
  const count = String.raw`count(){ n=0; for f in /proc/[0-9]*/cmdline; do { tr '\0' ' ' < "$f"; } 2>/dev/null | grep -qF -- "$M" && n=$((n+1)); done; echo $n; }; `
  return {
    id: 'no_relay_process',
    category: 'blocked',
    cmd:
      `M=${q('trace-rel')}${q('ay.js')}; ${count}` +
      `bash -c 'exec -a "$0" sleep 30' "$M" & p=$!; sleep 1; ok=0; [ "$(count)" -ge 1 ] && ok=1; ` +
      `kill $p 2>/dev/null; wait $p 2>/dev/null; ` +
      `[ $ok = 1 ] || { R no_relay_process FAILED "the search did not see a process that names the relay"; exit 0; }; ` +
      `n=$(count); [ "$n" = 0 ] && R no_relay_process BLOCKED "no relay process" || R no_relay_process OPEN "relay_processes=$n"`,
  }
}

/**
 * What the server was told, read from its own environment (the tool shell's parent): the launcher variable is exactly the
 * Action's "off" document, there is exactly one such variable, no `OTEL_*` variable is set, and nothing names the address of the
 * collector stand-in. Together with a relay that never ran, "no request arrived" then means tracing was off, not that spans
 * went somewhere else.
 */
function tracingOffEnvProbe(expectedLauncherLine: string, collectorAddress: string): Probe {
  return {
    id: 'tracing_off_env',
    category: 'blocked',
    cmd:
      `${String.raw`exp=${q(expectedLauncherLine)}; env=$(tr '\0' '\n' < /proc/$PPID/environ 2>/dev/null); `}[ -n "$env" ] || { R tracing_off_env FAILED "the server environment could not be read"; exit 0; }; ` +
      `l=$(printf %s "$env" | grep -cxF -- "$exp"); v=$(printf %s "$env" | grep -c '^OPENCODE_FROBOT_TRACING='); ` +
      `o=$(printf %s "$env" | grep -c '^OTEL_'); e=$(printf %s "$env" | grep -cF -- ${q(collectorAddress)}); ` +
      `[ "$l" = 1 ] && [ "$v" = 1 ] && [ "$o" = 0 ] && [ "$e" = 0 ] && s=BLOCKED || s=OPEN; ` +
      `R tracing_off_env $s "launcher_off=$l launcher_vars=$v otel=$o endpoint=$e"`,
  }
}

/**
 * That the fallback is really in place, as the plugin would find it: at `$XDG_CONFIG_HOME/fro-bot/opencode-plugin/tracing.json`,
 * a regular file the sandbox user owns, mode 0600, naming the sink. Without this a silent sink could mean a file that was
 * never there.
 */
function tracingFallbackPlantedProbe(sinkAddress: string, machine: string): Probe {
  return {
    id: 'tracing_fallback_planted',
    category: 'works',
    cmd:
      `f="$XDG_CONFIG_HOME/fro-bot/opencode-plugin/tracing.json"; ` +
      `[ -f "$f" ] || { R tracing_fallback_planted FAILED "no file at the plugin's path"; exit 0; }; ` +
      `m=$(stat -c %a "$f"); own=0; [ -O "$f" ] && own=1; s=$(grep -cF -- ${q(sinkAddress)} "$f"); h=$(grep -cF -- ${q(machine)} "$f"); ` +
      `[ "$m" = 600 ] && [ $own = 1 ] && [ "$s" = 1 ] && [ "$h" = 1 ] && st=WORKS || st=FAILED; ` +
      `R tracing_fallback_planted $st "mode=$m owned=$own sink=$s machine=$h"`,
  }
}

/** Installs `content` at `dest` for the sandbox user, mode 0600, with the directories above it (below `base`) owned by it. */
function plantForAccount(account: {uid: number; gid: number}, base: string, dest: string, content: string): void {
  const owner = ['-o', String(account.uid), '-g', String(account.gid)]
  const sudo = (args: string[]): void => {
    const result = spawnSync('sudo', ['-n', 'install', ...args], {encoding: 'utf8'})
    if (result.status !== 0) throw new Error(`install ${args.at(-1)}: ${result.stderr}`)
  }
  let dir = base
  for (const part of path.relative(base, path.dirname(dest)).split(path.sep)) {
    dir = path.join(dir, part)
    sudo(['-d', '-m', '0700', ...owner, dir])
  }
  const source = path.join(os.tmpdir(), `fallback-${process.pid}-${randomBytes(4).toString('hex')}`)
  fs.writeFileSync(source, content, {mode: 0o600})
  try {
    sudo(['-m', '0600', ...owner, source, dest])
  } finally {
    fs.rmSync(source, {force: true})
  }
}

/** The names of the spans a stand-in collector received. A body that is not OTLP JSON adds none. */
function exportedSpanNames(requests: readonly RecordedRequest[]): string[] {
  return exportedSpans(requests.map(request => request.body)).map(span => span.name)
}

/** The turn root spans (`invoke_agent` with no parent) in the collector's requests, with their string attributes and links. */
function turnRootSpans(requests: readonly RecordedRequest[]): {
  readonly attributes: Record<string, string>
  readonly links: readonly {readonly traceId: string; readonly spanId: string}[]
}[] {
  const roots: {attributes: Record<string, string>; links: {traceId: string; spanId: string}[]}[] = []
  for (const request of requests) {
    let parsed: unknown
    try {
      parsed = JSON.parse(request.body.toString('utf8'))
    } catch {
      continue
    }
    const resources = (parsed as {resourceSpans?: {scopeSpans?: {spans?: Record<string, unknown>[]}[]}[]} | null)
      ?.resourceSpans
    for (const resource of resources ?? []) {
      for (const scope of resource.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) {
          const parent = span.parentSpanId
          if (typeof span.name !== 'string' || !span.name.startsWith('invoke_agent')) continue
          if (typeof parent === 'string' && parent !== '') continue
          const attributes: Record<string, string> = {}
          for (const item of (span.attributes ?? []) as {key?: unknown; value?: {stringValue?: unknown}}[]) {
            if (typeof item.key === 'string' && typeof item.value?.stringValue === 'string') {
              attributes[item.key] = item.value.stringValue
            }
          }
          const links = ((span.links ?? []) as {traceId?: unknown; spanId?: unknown}[])
            .filter(link => typeof link.traceId === 'string' && typeof link.spanId === 'string')
            .map(link => ({traceId: link.traceId as string, spanId: link.spanId as string}))
          roots.push({attributes, links})
        }
      }
    }
  }
  return roots
}

const hasRootSpan = (requests: readonly RecordedRequest[]): boolean =>
  exportedSpanNames(requests).some(name => name.startsWith('invoke_agent'))

interface TracedTurn {
  readonly rows: ReadonlyMap<string, readonly Row[]>
  /** Everything the collector stand-in received. */
  readonly requests: readonly RecordedRequest[]
  /** Set for an isolated run. */
  readonly released: SandboxReleaseResult | undefined
  /** Null when no relay was started. */
  readonly relayStop: TraceRelayStopResult | null
  /** What `pgrep` finds of the relay's bundle after the run. */
  readonly relayLeft: string
  /** What the plain-`http` fallback sink received. Empty for a run with no fallback planted. */
  readonly sinkRequests: readonly string[]
}

describe.skipIf(!tracingGated)('run tracing through the relay: isolated, not isolated, and off', () => {
  const logger = createLogger({phase: 'sandbox-integration-tracing'})
  const scratch = path.join(runnerTemp, `sandbox-it-tracing-${process.pid}`)
  const responseDir = path.join(scratch, 'response')
  // Its own XDG roots, shared by the runs: the plugin is installed once into the cache the server reads.
  const xdgRoot = path.join(scratch, 'xdg')
  const relayBundle = path.join(realDist, 'trace-relay.js')
  const pluginSpec = `${FRO_BOT_PLUGIN_PACKAGE}@${FRO_BOT_PLUGIN_VERSION}`
  const cleanups: (() => Promise<void> | void)[] = []
  // The lifecycle trace of these runs, never exported here: its ids and session are what the Action hands the launcher (so the
  // server's environment holds them) and keeps in Action state (so a file in the step's directory holds them).
  const lifecycleRegistry = createSecretRegistry(() => undefined)
  const lifecycleTracer = createLifecycleTracer({
    inputs: {enabled: true, url: 'http://127.0.0.1:9/v1/traces', headers: []},
    logger,
    registry: lifecycleRegistry,
    env: {},
  })
  const lifecycleSession = buildTraceSessionId('owner', 'repo', 'issue-42', createRegistryScrubber(lifecycleRegistry))
  const runLink = buildTracingRunLink(lifecycleTracer.ids, lifecycleSession)
  /** The Action's identity record and session, as `core.saveState` writes them: one `name=value` line each. */
  const stateText = `lifecycleTrace=${JSON.stringify(lifecycleTracer.ids)}\nlifecycleSession=${lifecycleSession ?? ''}\n`
  const scanSpecFor = (workspace: string): ScanSpec => ({
    canary: TRACE_CANARY,
    ...SCAN_CONTROLS,
    // 1 MiB chunks, so the planted boundary control needs a 2 MiB file. Over 128 MiB a file is counted as skipped: the runner
    // temp holds the OpenCode binary (about 225 MiB), which the sandbox is not meant to read and which would only spend time.
    chunkBytes: 1024 * 1024,
    maxFileBytes: 128 * 1024 * 1024,
    runnerTemp,
    checkout: [workspace, responseDir],
    // Opened by exact path as well as walked for: a directory can refuse listing and still allow access to a known child.
    knownPaths: [path.join(scratch, 'step', 'file_commands.txt'), path.join(scratch, 'step', 'lifecycle_state.txt')],
  })
  let isolated: TracedTurn | undefined
  let plain: TracedTurn | undefined
  let off: TracedTurn | undefined

  /** The collector stand-in: an HTTPS server on loopback that records every request and accepts it. */
  async function startCollector(): Promise<TlsUpstream> {
    const collector = await startTlsUpstream((_request, res) => {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end('{}')
    })
    cleanups.push(async () => collector.close())
    return collector
  }

  /**
   * What a real step's process holds: the action's inputs sit in its environment, readable by the runner's own user. This
   * stand-in carries them, so the not-isolated row has a place where the search must find the canary.
   */
  async function startStepStandIn(): Promise<void> {
    const child = spawn(builderNode, ['-e', 'setInterval(() => {}, 1000)'], {
      env: {PATH: process.env.PATH ?? '', 'INPUT_TRACE-HEADERS': TRACE_HEADERS},
      stdio: 'ignore',
    })
    cleanups.push(async () => {
      child.kill('SIGKILL')
      await new Promise<void>(resolve => (child.exitCode === null ? child.once('exit', () => resolve()) : resolve()))
    })
  }

  async function startRelay(collector: TlsUpstream, name: string): Promise<TraceRelayProcess> {
    // The inputs, through the real parser, as a workflow's two inputs would reach it.
    const parsed = parseTraceInputs(
      {endpoint: `${collector.origin}/v1/traces`, headers: TRACE_HEADERS},
      {warning: () => undefined, notice: () => undefined, info: () => undefined, mask: () => undefined},
    )
    const request = relayRequestFromInputs(parsed)
    if (request === null) throw new Error('the trace inputs were not accepted')
    const caFile = path.join(scratch, `collector-ca-${name}.pem`)
    fs.writeFileSync(caFile, collector.ca)
    // `env` gives the relay's own empty environment the stand-in's CA and nothing else; the credential still reaches it only
    // on its stdin.
    const started = await startTraceRelayProcess({
      config: request,
      logger,
      launcher: {command: '/usr/bin/env', args: [`NODE_EXTRA_CA_CERTS=${caFile}`, builderNode, relayBundle]},
      timeouts: {readyMs: 15_000, exitGraceMs: 4_000, killConfirmMs: 2_000},
    })
    const relay = unwrapOk(started)
    // Registered as soon as the relay is up, so a failure later in the run still stops it.
    cleanups.push(async () => {
      await relay.stop()
    })
    return relay
  }

  async function runTurn(options: {
    readonly name: string
    readonly isolation: 'on' | 'off'
    readonly tracing: 'on' | 'off'
    readonly tools: SandboxToolPaths
  }): Promise<TracedTurn> {
    const {name, tools} = options
    const workspace = path.join(scratch, `ws-${name}`)
    initWorkspace(workspace)
    const collector = await startCollector()
    // A usable fallback a wrongly-on plugin would export through, for the off run only: see the row for what it proves.
    const sink: RecordingHttpSink | null =
      options.tracing === 'off' && options.isolation === 'on' ? await startRecordingHttpSink() : null
    if (sink !== null) cleanups.push(async () => sink.close())
    const machine = fallbackHosts(os.hostname())[0] ?? ''
    const relay = options.tracing === 'on' ? await startRelay(collector, name) : null
    const identity = unwrapOk(
      buildTracingRunIdentity({
        repository: 'owner/repo',
        runId: '4242',
        attempt: 1,
        job: 'sandbox-it',
        trigger: 'workflow_dispatch',
      }),
    )
    const tracing: ScriptedTracing = {
      specs: [pluginSpec],
      expectedPluginIds: [FRO_BOT_PLUGIN_ID],
      host: buildActionTracingHost(relay?.port ?? null, identity, runLink),
    }
    const scanSpec = scanSpecFor(workspace)
    const offHost = buildActionTracingHost(null, identity)
    const steps: Probe[] =
      options.tracing === 'on'
        ? [
            launcherLinkProbe(lifecycleTracer.ids, lifecycleSession),
            {id: 'canary_scan', category: 'blocked', cmd: `: ${TOOL_ARGUMENT_MARKER}\n${scanCommand(scanSpec)}`},
          ]
        : [
            noRelayProcessProbe(),
            ...(sink === null ? [] : [tracingFallbackPlantedProbe(sink.address, machine)]),
            tracingOffEnvProbe(
              `OPENCODE_FROBOT_TRACING=${buildTracingLauncherValue(offHost)}`,
              new URL(collector.origin).host,
            ),
          ]
    // A turn is over when its root span is at the collector; stopping the server before that would race the last flush.
    const beforeShutdown = async (): Promise<void> => {
      if (options.tracing === 'off') return
      await waitUntil(
        'the turn’s root span at the collector stand-in',
        () => hasRootSpan(collector.requests),
        90_000,
        () =>
          `received ${collector.requests.length} requests; spans: ${exportedSpanNames(collector.requests).join(', ')}`,
      )
    }
    const keyFile = writeKeyFile(path.join(scratch, `key-${name}`))

    let rows: ReadonlyMap<string, readonly Row[]>
    let released: SandboxReleaseResult | undefined
    if (options.isolation === 'on') {
      const result = await runIsolated({
        tools,
        env: hostedEnv(workspace, xdgRoot),
        workspace,
        responseDir,
        keyFile,
        steps,
        logger,
        tracing,
        beforeShutdown,
        // After the account exists and before the server starts: the file must be there when the plugin loads.
        ...(sink === null
          ? {}
          : {
              onPrepared: launch => {
                const dest = path.join(launch.xdg.config, 'fro-bot', 'opencode-plugin', 'tracing.json')
                plantForAccount(
                  launch.account,
                  launch.xdg.config,
                  dest,
                  tracingFallbackDocument({endpoint: `${sink.origin}/v1/traces`, hosts: fallbackHosts(os.hostname())}),
                )
              },
            }),
      })
      rows = result.rows
      released = result.released
    } else {
      // The agent's home is a directory of its own, so the search of "the agent's home" does not walk the runner's.
      const home = path.join(scratch, 'home-plain')
      fs.mkdirSync(home, {recursive: true})
      const provider = await startScriptedProvider(() => steps)
      cleanups.push(async () => provider.close())
      const handle = await startPlainScriptedSession({
        binary: BINARY ?? '',
        workspace,
        env: {...hostedEnv(workspace, xdgRoot), HOME: home},
        keyFile,
        provider,
        logger,
        tracing,
      })
      cleanups.push(async () => {
        await handle.shutdown()
      })
      rows = parseRows(provider.state.results.join('\n'))
      await beforeShutdown()
      await handle.shutdown()
    }
    // The relay goes after the server and the sandbox, as the Action stops it.
    const relayStop = relay === null ? null : await relay.stop()
    return {
      rows,
      requests: [...collector.requests],
      released,
      relayStop,
      relayLeft: pgrepOutput(['-f', relayBundle]),
      sinkRequests: [...(sink?.requests ?? [])],
    }
  }

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    cleanups.push(() => fs.rmSync(scratch, {recursive: true, force: true}))
    // Where a runner's step files would hold the action's inputs: a private file, readable by the runner's user and by no one else.
    const stepDir = path.join(scratch, 'step')
    fs.mkdirSync(stepDir, {recursive: true, mode: 0o700})
    fs.writeFileSync(path.join(stepDir, 'file_commands.txt'), `INPUT_TRACE-HEADERS=${TRACE_HEADERS}\n`, {mode: 0o600})
    // The Action's state for the run, in the same private directory: the identity record and session, never an input.
    fs.writeFileSync(path.join(stepDir, 'lifecycle_state.txt'), stateText, {mode: 0o600})
    await startStepStandIn()
    // The runner's detector controls, in the directories the sandbox reaches OpenCode's storage through links to.
    plantScanControls(xdgRoot, scanSpecFor(path.join(scratch, 'ws-isolated')))

    // The pinned plugin, installed as setup installs it, into the cache the server reads (the lifecycle hands the agent a link
    // to it).
    const installed = await installPluginsV2({
      logger,
      execAdapter: createExecAdapter(),
      opencodeBinaryPath: BINARY ?? '',
      specs: [pluginSpec],
      cacheHome: path.join(xdgRoot, 'cache'),
      env: hostedEnv(path.join(scratch, 'ws-install'), xdgRoot),
    })
    if (!installed.success) throw new Error(`plugin install failed: ${installed.error.message}`)

    // One after another: the sandbox account's name is fixed. The not-isolated run is last, so it can leave nothing in a place a
    // sandbox run reads.
    isolated = await runTurn({name: 'isolated', isolation: 'on', tracing: 'on', tools})
    off = await runTurn({name: 'off', isolation: 'on', tracing: 'off', tools})
    plain = await runTurn({name: 'plain', isolation: 'off', tracing: 'on', tools})
  }, 1_200_000)

  afterAll(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  }, 120_000)

  /** The `key=value` counts of the canary search's result line. */
  const scanCounts = (turn: TracedTurn | undefined): Map<string, string> =>
    new Map(
      (turn?.rows.get('canary_scan')?.[0]?.evidence ?? '')
        .split(' ')
        .filter(part => part.includes('='))
        .map(part => part.split('=') as [string, string]),
    )

  const credentialSeen = (turn: TracedTurn | undefined): boolean[] =>
    (turn?.requests ?? []).map(request => request.headers.authorization === `Bearer ${TRACE_CANARY}`)

  it('isolated: the spans reach the collector with the canary credential, and the sandbox user finds it nowhere', () => {
    // #given a traced turn in the sandbox, with the credential held by the relay alone
    // #then the root span arrived, and every request carried the canary
    expect(hasRootSpan(isolated?.requests ?? [])).toBe(true)
    expect(credentialSeen(isolated).length).toBeGreaterThan(0)
    expect(credentialSeen(isolated).every(Boolean)).toBe(true)

    // #then the sandbox user's search (by fingerprint: it was never given the canary) of process environments and command lines,
    // the runner's temp and step files, the checkout, the agent's home and OpenCode's storage behind the links found no copy
    expect(failuresFor(isolated?.rows ?? new Map(), 'canary_scan', 'BLOCKED')).toEqual([])
    const counts = scanCounts(isolated)
    for (const group of ['environ', 'cmdline', 'temp', 'checkout', 'home', 'xdg', 'known']) {
      expect(counts.get(`canary.${group}`)).toBe('0')
    }
    // #and the step file and the Action's state file, opened by their exact paths, were refused (not absent, which would be a
    // skip) and not read
    expect(counts.get('denied.known')).toBe('2')
    expect(counts.get('read.known')).toBe('0')
    expect(counts.get('skip.known')).toBe('0')

    // #and the search is shown to look where it counts: its own controls were found in a file, a process environment and a
    // command line, the runner's controls in a text file and in a binary file behind the links, and it read files there and in
    // the checkout
    expect(Number(counts.get('read.xdg'))).toBeGreaterThanOrEqual(2)
    expect(Number(counts.get('read.checkout'))).toBeGreaterThanOrEqual(1)
  })

  it('not isolated: the same turn is traced, and the same search finds the canary', () => {
    // #given the same turn with the agent running as the runner's user
    // #then it is traced the same way
    expect(hasRootSpan(plain?.requests ?? [])).toBe(true)
    expect(credentialSeen(plain).every(Boolean)).toBe(true)

    // #then the search finds the canary where the runner's user can read it (the step's environment and the step file): the
    // negative control that shows the isolated row's empty result means something. The relay's own command line holds none, and
    // neither the checkout nor the agent's home does. The exposure warning that goes with this is run.ts's, covered in
    // run-tracing.test.ts: this suite drives the server, not the Action.
    expect(failuresFor(plain?.rows ?? new Map(), 'canary_scan', 'OPEN')).toEqual([])
    const counts = scanCounts(plain)
    expect(Number(counts.get('canary.environ'))).toBeGreaterThanOrEqual(1)
    expect(Number(counts.get('canary.temp'))).toBeGreaterThanOrEqual(1)
    // #and the step file and the state file, opened by their exact paths, were read, and only the step file held the canary
    expect(counts.get('read.known')).toBe('2')
    expect(counts.get('canary.known')).toBe('1')
    for (const group of ['cmdline', 'checkout', 'home', 'xdg']) expect(counts.get(`canary.${group}`)).toBe('0')
  })

  it('tells the server the run’s root span, session and invocation id, and the credential is in none of it', () => {
    // #given the launcher document the Action builds for these runs
    const document = buildTracingLauncherValue(
      buildActionTracingHost(
        43_210,
        unwrapOk(
          buildTracingRunIdentity({
            repository: 'owner/repo',
            runId: '4242',
            attempt: 1,
            job: 'sandbox-it',
            trigger: 'workflow_dispatch',
          }),
        ),
        runLink,
      ),
    )

    // #then it carries the link, and no form of the credential or the collector
    expect(JSON.parse(document)).toMatchObject({
      rootSpan: {traceId: lifecycleTracer.ids?.traceId, spanId: lifecycleTracer.ids?.rootSpanId},
      sessionId: 'owner/repo:issue-42',
      invocationId: lifecycleTracer.ids?.invocationId,
    })
    expect(canaryForms(Buffer.from(document), TRACE_CANARY)).toEqual([])
    expect(document).not.toContain('Authorization')

    // #and the isolated agent and the plain one each read that same link from the server's own environment
    for (const turn of [isolated, plain])
      expect(failuresFor(turn?.rows ?? new Map(), 'launcher_link', 'WORKS')).toEqual([])
  })

  it('keeps the credential out of the Action’s state, and the agent user cannot open the state file', () => {
    // #given the state the Action saves for the run
    // #then it holds the ids and the session and no form of the credential, the headers or the collector
    expect(stateText).toContain(lifecycleTracer.ids?.traceId)
    expect(canaryForms(Buffer.from(stateText), TRACE_CANARY)).toEqual([])
    expect(stateText).not.toContain('Authorization')

    // #and the isolated agent was refused when it opened the state file by its path (the scan's `denied.known` counts the
    // step file and this one); the runner's own user read it, and found no canary there
    expect(scanCounts(isolated).get('denied.known')).toBe('2')
    expect(scanCounts(plain).get('read.known')).toBe('2')
    expect(scanCounts(plain).get('canary.known')).toBe('1')
  })

  it('links each turn root to the lifecycle root span, in the lifecycle trace’s session', () => {
    for (const turn of [isolated, plain]) {
      // #given the traced turn's root span as the collector received it
      const roots = turnRootSpans(turn?.requests ?? [])

      // #then one root, linking to the lifecycle root, with the session and invocation id the launcher carried
      expect(roots).toHaveLength(1)
      expect(roots[0]?.links).toEqual([
        {traceId: lifecycleTracer.ids?.traceId, spanId: lifecycleTracer.ids?.rootSpanId},
      ])
      expect(roots[0]?.attributes['langfuse.session.id']).toBe('owner/repo:issue-42')
      expect(roots[0]?.attributes['fro_bot.invocation.id']).toBe(lifecycleTracer.ids?.invocationId)
    }
  })

  it('exports no span that holds the canary, in any form a span could carry it', () => {
    // #given the checker is shown able to see the credential header it will be asked about
    expect(canaryForms(Buffer.from(JSON.stringify({header: TRACE_HEADERS})), TRACE_CANARY)).toContain('contiguous')

    for (const turn of [isolated, plain]) {
      const requests = turn?.requests ?? []

      // #given spans that really carry content: the tool span for this call arrived with the command-only marker in its own
      // `gen_ai.tool.call.arguments` attribute (the marker is in no tool output, so the result span alone cannot supply it), so
      // an absent canary is absence from content that was there to hold it
      expect(toolSpanHoldsArgument(exportedSpans(requests.map(request => request.body)), TOOL_ARGUMENT_MARKER)).toBe(
        true,
      )

      // #then no request body holds the canary as written (raw or in any parsed string), as \uXXXX escapes, as both halves, as
      // base64 or base64url at any of the three alignments, or as hex
      for (const request of requests) expect(canaryForms(request.body, TRACE_CANARY)).toEqual([])
    }
  })

  it('leaves no relay process after any run, and the sandbox restores cleanly', () => {
    // #then each traced run stopped its relay and none is left, and each isolated run was taken back
    for (const turn of [isolated, plain]) {
      expect(['stopped', 'already-exited']).toContain(turn?.relayStop?.outcome)
      expect(turn?.relayLeft).toBe('')
    }
    for (const turn of [isolated, off]) {
      expect(turn?.released?.restore).toBe('restored')
      expect(turn?.released?.stop).not.toBe('never-started')
    }
  })

  it('with tracing off on the same runner: the server was told off, no relay runs, and nothing is sent', () => {
    // #given the turn with the plugin installed and the launcher saying off. Zero requests proves tracing was off only if the
    // server was told so and nothing pointed its export elsewhere; the traced rows are the control, since the same plugin,
    // server and runner export when the launcher says on. So the agent reads the server's own environment: the launcher line
    // is exactly the "off" document, the only one, no OTEL_* variable is set and the stand-in's address appears nowhere in it.
    expect(failuresFor(off?.rows ?? new Map(), 'tracing_off_env', 'BLOCKED')).toEqual([])

    // #and a usable fallback was in place and nothing used it: a valid user-scope settings file (the sandbox user's own, mode
    // 0600, naming this machine, pointing at a plain-http loopback sink) that the plugin would accept if no launcher variable
    // were set (the unit control in v2-server.sandbox.fallback.test.ts shows exactly that, against the plugin's own resolver).
    // The Action's server also carries the headless markers, which would refuse the file on their own; so this row shows the
    // published plugin, given the "off" launcher, sends nothing even with a fallback present and a sink to receive it.
    expect(failuresFor(off?.rows ?? new Map(), 'tracing_fallback_planted', 'WORKS')).toEqual([])
    expect(off?.sinkRequests).toEqual([])
    expect(off?.rows.get('tracing_off_env')?.[0]?.evidence).toBe('launcher_off=1 launcher_vars=1 otel=0 endpoint=0')

    // #then no relay process runs (after a control showed the search could see one), the stand-in heard nothing, and no relay
    // was started or left
    expect(failuresFor(off?.rows ?? new Map(), 'no_relay_process', 'BLOCKED')).toEqual([])
    expect(off?.requests).toEqual([])
    expect(off?.relayStop).toBeNull()
    expect(off?.relayLeft).toBe('')
  })
})

// --- 15. A cancelled run -----------------------------------------------------------------------------------------------

/** The runner cancels a step with SIGINT and, if it is still running 7.5 seconds later, sends SIGTERM. */
const RUNNER_SIGTERM_DELAY_MS = 7_500

/** A stand-in for `process` for the sandbox's handler: it listens on it and re-raises on it, and the test says when a signal arrives. */
function fakeSignalHost(): SignalHost & {
  readonly deliver: (signal: 'SIGINT' | 'SIGTERM') => void
  readonly killed: {readonly signal: 'SIGINT' | 'SIGTERM'; readonly at: number; readonly spansAtReceiver: number}[]
  /** Set by the test: how many spans the receiver holds, read at the moment of the re-raise. */
  spansAtReceiver: () => number
} {
  const handlers = new Map<'SIGINT' | 'SIGTERM', (() => void)[]>()
  const killed: {signal: 'SIGINT' | 'SIGTERM'; at: number; spansAtReceiver: number}[] = []
  const host = {
    pid: 4242,
    killed,
    spansAtReceiver: () => 0,
    on: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      handlers.set(signal, [...(handlers.get(signal) ?? []), listener])
    },
    off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      handlers.set(
        signal,
        (handlers.get(signal) ?? []).filter(item => item !== listener),
      )
    },
    kill: (_pid: number, signal: 'SIGINT' | 'SIGTERM') => {
      killed.push({signal, at: Date.now(), spansAtReceiver: host.spansAtReceiver()})
    },
    deliver: (signal: 'SIGINT' | 'SIGTERM') => {
      for (const listener of handlers.get(signal) ?? []) listener()
    },
  }
  return host
}

interface CancelledOutcome {
  readonly spans: ReturnType<typeof decodeSpans>
  /** The first re-raise on the host, with when it happened and how many spans the receiver held at that moment. */
  readonly reRaised: readonly {
    readonly signal: 'SIGINT' | 'SIGTERM'
    readonly at: number
    readonly spansAtReceiver: number
  }[]
  /** When the sandbox's state last became `restored` or `unsafe`: the teardown settling. */
  readonly teardownSettledAt: number | undefined
  readonly sigintAt: number
}

const spanByName = (outcome: CancelledOutcome | undefined, name: string) =>
  outcome?.spans.find(span => span.name === name)

describe.skipIf(!gated)('a cancelled isolated run delivers its reached spans inside its teardown window', () => {
  const logger = createLogger({phase: 'sandbox-integration-cancel'})
  const scratch = path.join(runnerTemp, `sandbox-it-cancel-${process.pid}`)
  const xdgRoot = path.join(runnerTemp, `sandbox-it-cancel-xdg-${process.pid}`)
  const workspace = path.join(scratch, 'ws')
  const responseDir = path.join(scratch, 'response')
  const env = hostedEnv(workspace, xdgRoot)
  const strayPattern = 'sleep 779[34]'
  const cleanups: (() => Promise<void> | void)[] = []
  const states: {readonly state: string; readonly at: number}[] = []

  let provider: ScriptedProvider | undefined
  let lifecycle: SandboxLifecycle | undefined
  let outcome: CancelledOutcome | undefined
  let strays = 'not checked'
  let sigtermAfterReRaise = 0

  beforeAll(async () => {
    const tools = await preflightTools(logger)
    fs.mkdirSync(responseDir, {recursive: true})
    const keyFile = writeKeyFile(path.join(scratch, 'keys'))
    initWorkspace(workspace)
    // A tool that leaves a process that leaves its session and one that ignores SIGTERM: what the teardown must still end.
    provider = await startScriptedProvider(() => [
      {
        id: 'cancel_setup',
        category: 'info',
        cmd:
          `(setsid sleep 7793 >/dev/null 2>&1 &); (trap '' TERM HUP; exec sleep 7794 >/dev/null 2>&1 &); ` +
          `sleep 0.3; R cancel_setup INFO "$(pgrep -d, -f 'sleep 779')"`,
      },
    ])
    const sink: OtlpSink = await startOtlpSink()
    cleanups.push(sink.stop)
    const tracer = createLifecycleTracer({
      inputs: {enabled: true, url: sink.url, headers: []},
      logger,
      registry: createSecretRegistry(() => undefined),
      env: {},
      identity: {
        repository: 'owner/repo',
        runId: '4242',
        attempt: '1',
        job: 'sandbox-it',
        trigger: 'workflow_dispatch',
      },
    })
    // The phases the run had reached: bootstrap is done, execution is where the cancel finds it.
    tracer.startSpan('bootstrap').end({outcome: 'succeeded'})
    tracer.startSpan('execution')
    const host = fakeSignalHost()
    host.spansAtReceiver = () => decodeSpans(sink.accepted()).length
    lifecycle = createSandboxLifecycle({
      tools,
      env,
      runnerPath: env.PATH,
      runnerHome,
      workspacePath: workspace,
      responseDir,
      logger,
      viewLauncher,
      // The real handler of a real isolated run: its own, on a stand-in for `process`, so the re-raise does not end the test.
      signals: host,
      signalTrace: {
        onSignal: signal => tracer.cancel(signal === 'SIGINT' ? 'sigint' : 'sigterm'),
        flush: async options => tracer.flush(options),
      },
      recordState: state => states.push({state, at: Date.now()}),
    })
    const prepared = await lifecycle.prepare({keyFilePaths: [keyFile], ghConfigDir: null, repoSkills: null})
    if (!prepared.success) throw new Error(prepared.error)
    // The server is up and the agent has run its tool: the run is mid-execution when it is cancelled.
    await startScriptedSession({binary: BINARY ?? '', workspace, env, lifecycle, keyFile, provider, logger})

    // The runner's SIGINT, then (if the process were still running) its SIGTERM 7.5 s later.
    const sigintAt = Date.now()
    host.deliver('SIGINT')
    await waitUntil('the signal to be re-raised', () => host.killed.length > 0, 30_000)
    await sleep(Math.max(0, sigintAt + RUNNER_SIGTERM_DELAY_MS - Date.now()))
    host.deliver('SIGTERM')
    sigtermAfterReRaise = host.killed.length
    outcome = {
      spans: decodeSpans(sink.accepted()),
      reRaised: [...host.killed],
      teardownSettledAt: states.findLast(item => item.state === 'restored' || item.state === 'unsafe')?.at,
      sigintAt,
    }
    strays = strayProcesses(strayPattern)
  }, 600_000)

  afterAll(async () => {
    await lifecycle?.release()
    await provider?.close()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    spawnSync('sudo', ['-n', 'pkill', '-KILL', '-f', strayPattern])
    fs.rmSync(scratch, {recursive: true, force: true})
    fs.rmSync(xdgRoot, {recursive: true, force: true})
  }, 120_000)

  it('had delivered the spans it reached by the time the teardown settled and the signal was re-raised', () => {
    // #given a run cancelled mid-execution
    // #then at the moment of the re-raise the receiver already held the trace: the export ran beside the teardown
    expect(outcome?.reRaised[0]?.spansAtReceiver).toBeGreaterThan(0)
    expect(spanByName(outcome, 'bootstrap')).toMatchObject({attrs: {'fro_bot.outcome': 'succeeded'}})
    // #and the phase it was in and the root are cancelled, with the signal as the reason, and not errors
    for (const name of ['execution', 'action.main']) {
      expect(spanByName(outcome, name)?.attrs).toMatchObject({
        'fro_bot.outcome': 'cancelled',
        'fro_bot.reason': 'sigint',
      })
      expect(spanByName(outcome, name)?.status.code).not.toBe(2)
    }
  })

  it('re-raised the signal once, no later than the teardown settling, with nothing left of the launch', () => {
    // #then the sandbox ended restored, the signal came right after that (the export added no wait), once, and the SIGTERM the
    // runner would send 7.5 s later found no handler to run again
    expect(states.at(-1)?.state).toBe('restored')
    expect(outcome?.reRaised.map(item => item.signal)).toEqual(['SIGINT'])
    expect((outcome?.reRaised[0]?.at ?? 0) - (outcome?.teardownSettledAt ?? Number.POSITIVE_INFINITY)).toBeLessThan(
      1_000,
    )
    expect(sigtermAfterReRaise).toBe(1)
    expect(strays).toBe('')
  })
})

/**
 * A run WITHOUT `isolate-agent`: the real fixture process with real signals (it needs no sandbox, so it can also run off a hosted
 * runner when asked: `FRO_BOT_CANCEL_IT=1 bunx vitest run <this file> -t 'without isolation'`). Cancellation is what it always
 * was: the process has no handler of its own, the exec adapter reaps the command it is running and re-raises at once, and no
 * lifecycle trace is sent.
 */
const cancelPlainEnabled = gated || process.env.FRO_BOT_CANCEL_IT === '1'

describe.skipIf(!cancelPlainEnabled)('a cancelled run without isolation ends as it always did', () => {
  const dir = path.join(os.tmpdir(), `sandbox-it-cancel-plain-${process.pid}`)
  const cleanups: (() => Promise<void> | void)[] = []
  let exit:
    {readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly elapsedMs: number} | undefined
  let received = -1
  let commandAlive = true

  beforeAll(async () => {
    fs.mkdirSync(dir, {recursive: true})
    const sink: OtlpSink = await startOtlpSink()
    cleanups.push(sink.stop)
    const child = spawn('bun', [path.join(import.meta.dirname, '..', 'signal-cancel.fixture.ts')], {
      env: {
        ...process.env,
        SIGNAL_FIXTURE_LOG: path.join(dir, 'log.txt'),
        SIGNAL_FIXTURE_TEMP: dir,
        SIGNAL_FIXTURE_COLLECTOR: sink.url,
        SIGNAL_FIXTURE_MODE: 'plain',
        SIGNAL_FIXTURE_SCENARIO: 'child',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => {
      child.once('exit', (code, signal) => resolve({code, signal}))
    })
    await new Promise<void>(resolve => {
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').includes('READY')) resolve()
      })
    })
    await sleep(500)
    // The runner's SIGINT. A process that kept itself alive for an export would still be running when its SIGTERM came.
    const sigintAt = Date.now()
    child.kill('SIGINT')
    const outcome = await exited
    exit = {...outcome, elapsedMs: Date.now() - sigintAt}
    received = sink.received()
    const pid = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8').trim())
    try {
      process.kill(pid, 0)
    } catch {
      commandAlive = false
    }
  }, 120_000)

  afterAll(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    fs.rmSync(dir, {recursive: true, force: true})
  }, 60_000)

  it('ended by the signal at once, with no export started and no lifecycle trace at the collector', () => {
    expect(exit?.signal).toBe('SIGINT')
    expect(exit?.elapsedMs).toBeLessThan(2_000)
    expect(received).toBe(0)
  })

  it('stopped the command the run was waiting on', () => {
    expect(commandAlive).toBe(false)
  })
})
