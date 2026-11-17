import type {Logger} from '../shared/logger.js'
import type {SetupAdapter, SetupInputs} from './setup-adapter.js'
import type {EnsureOpenCodeResult} from './types.js'
import process from 'node:process'

export interface EnsureOpenCodeOptions {
  readonly logger: Logger
  readonly opencodeVersion: string
  readonly githubToken: string
  readonly authJson: string
  readonly systematicVersion: string
  readonly opencodeConfig: string | null
  readonly systematicConfig: string | null
  readonly credential: SetupInputs['credential']
}

/**
 * Provision OpenCode and this invocation's environment. Setup ALWAYS runs: it carries per-invocation work that no
 * binary already on the runner can stand in for (gh CLI auth, git identity, the Systematic config, the provider keys),
 * so a binary that reports the pinned version -- on a self-hosted runner, or left on PATH by an earlier step in the
 * same job -- is never a reason to skip it. Setup stays cheap on a warm runner: it restores the binary from the tools
 * cache, digest-checked, rather than downloading it again.
 */
export async function ensureOpenCodeAvailable(
  options: EnsureOpenCodeOptions,
  setupAdapter: SetupAdapter,
): Promise<EnsureOpenCodeResult> {
  const {logger, opencodeVersion} = options
  const setupInputs: SetupInputs = {
    opencodeVersion,
    authJson: options.authJson,
    appId: null,
    privateKey: null,
    opencodeConfig: options.opencodeConfig,
    systematicConfig: options.systematicConfig,
    systematicVersion: options.systematicVersion,
    credential: options.credential,
  }
  const setupResult = await setupAdapter.runSetup(setupInputs, options.githubToken)
  if (setupResult == null) {
    throw new Error('Auto-setup failed: runSetup returned null')
  }

  // These take different halves of the same install on purpose. `addToPath` wants the directory;
  // OPENCODE_PATH is read back as an executable — by @fro.bot/harness's `resolveBinary()` and by every child
  // that inherits it (filterAgentEnv allows the OPENCODE_ prefix through). Assigning the directory here made
  // them exec it.
  setupAdapter.addToPath(setupResult.opencodePath)
  const replacedPath = process.env.OPENCODE_PATH
  if (replacedPath != null && replacedPath !== '' && replacedPath !== setupResult.opencodeBinaryPath) {
    // The Action runs the binary setup verified, not whatever the operator pointed OPENCODE_PATH at.
    logger.warning('OPENCODE_PATH points at a different binary; the Action uses the one setup installed', {
      replacedPath,
      usedPath: setupResult.opencodeBinaryPath,
    })
  }
  process.env.OPENCODE_PATH = setupResult.opencodeBinaryPath
  // Log both halves: the whole failure mode here is "which of these two strings got exported",
  // so a recurrence should be diagnosable from the run log alone.
  logger.info('OpenCode setup completed', {
    version: setupResult.opencodeVersion,
    path: setupResult.opencodePath,
    binaryPath: setupResult.opencodeBinaryPath,
  })
  return {path: setupResult.opencodeBinaryPath, version: setupResult.opencodeVersion}
}
