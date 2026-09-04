import type {ExecAdapter, Logger} from './types.js'
import process from 'node:process'
import {filterAgentEnv} from '@fro-bot/runtime'
import {toErrorMessage} from '../../shared/errors.js'

// Sized against the failure this install exists to prevent, not against a healthy
// install. When the npm registry is degraded, the server-side install this replaces
// was measured at 181-370s before returning. A budget below that tail would time out
// on precisely the slow-but-valid runs that matter, warn, continue, and then let the
// server perform the same install unbounded -- paying the timeout AND the original
// stall. 420s clears the observed tail with margin; exceeding it means something is
// broken badly enough that falling back to the server's own install is the right call.
// A healthy install finishes in seconds, so this ceiling is not a latency cost in the
// common case -- and unlike the stall it replaces, the time is logged and attributable.
const DEFAULT_INSTALL_TIMEOUT_MS = 420_000

export interface SystematicPluginInstallOptions {
  readonly logger: Logger
  readonly execAdapter: ExecAdapter
  readonly opencodePath: string
  readonly systematicVersion: string
  readonly timeoutMs?: number
}

export interface SystematicPluginInstallResult {
  readonly status: 'installed' | 'failed' | 'timed-out'
  readonly duration: number
}

const emptyConfig = JSON.stringify({plugin: []})

export async function installSystematicPlugin(
  options: SystematicPluginInstallOptions,
): Promise<SystematicPluginInstallResult> {
  const {logger, execAdapter, opencodePath, systematicVersion} = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const startTime = Date.now()

  logger.info('Installing Systematic plugin', {systematicVersion, timeoutMs})

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const args = ['--pure', 'plugin', `@fro.bot/systematic@${systematicVersion}`, '--global']
    // Scrubbed, not inherited. This subprocess runs `npm install`, which executes
    // lifecycle scripts from a package fetched off the network -- the same untrusted-child
    // boundary that made issue #1147 wrap `createOpencode` in `withScrubbedEnv`. An
    // unscrubbed spread would hand `GITHUB_TOKEN`, `*_API_KEY`, `*_SECRET`, `AWS_*`, and
    // every `INPUT_*` to that script. `filterAgentEnv` is a deny-by-default allowlist and
    // already passes what an install needs: PATH, HOME, TMPDIR, the proxy and CA vars, and
    // `XDG_*` (which is how the package lands in the cache directory the server reads).
    const execOptions = {
      env: {
        ...filterAgentEnv(process.env),
        OPENCODE_CONFIG_CONTENT: emptyConfig,
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      ignoreReturnCode: true,
      silent: true,
    } as const
    const execWithTimeout = execAdapter.execWithTimeout
    const result =
      execWithTimeout === undefined
        ? await Promise.race<number | 'timed-out'>([
            execAdapter.exec(opencodePath, args, execOptions),
            new Promise<'timed-out'>(resolve => {
              timeoutId = setTimeout(() => resolve('timed-out'), timeoutMs)
            }),
          ])
        : await execWithTimeout(opencodePath, args, timeoutMs, execOptions)

    const duration = Date.now() - startTime
    if (result === 'timed-out') {
      logger.warning('Systematic plugin install timed out', {systematicVersion, timeoutMs, duration})
      return {status: 'timed-out', duration}
    }

    if (result === 0) {
      logger.info('Systematic plugin install complete', {systematicVersion, duration})
      return {status: 'installed', duration}
    }

    logger.warning('Systematic plugin install failed', {systematicVersion, exitCode: result, duration})
    return {status: 'failed', duration}
  } catch (error) {
    const duration = Date.now() - startTime
    logger.warning('Systematic plugin install failed', {
      systematicVersion,
      error: toErrorMessage(error),
      duration,
    })
    return {status: 'failed', duration}
  } finally {
    if (timeoutId != null) {
      clearTimeout(timeoutId)
    }
  }
}
