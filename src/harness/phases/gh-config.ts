import type {Logger} from '../../shared/logger.js'
import process from 'node:process'
import * as core from '@actions/core'
import {removeGhConfigDir} from '../../services/setup/gh-config-dir.js'
import {STATE_KEYS} from '../config/state-keys.js'

/**
 * The `gh` config directory this run's setup created (provision mode), or null. `configureGhAuth` points
 * `process.env.GH_CONFIG_DIR` at it only after a successful login, so a value equal to what the environment held when the
 * run started belongs to an earlier step and is not ours to remove. Recorded in the action state so the post hook can
 * remove it if the main step is killed before its own cleanup.
 */
export function trackRunGhConfigDir(ambient: string | undefined): string | null {
  const current = process.env.GH_CONFIG_DIR
  if (current === undefined || current.length === 0 || current === ambient) return null
  core.saveState(STATE_KEYS.GH_CONFIG_DIR, current)
  return current
}

export interface ReleaseRunGhConfigOptions {
  /** From `trackRunGhConfigDir`. */
  readonly dir: string | null
  /**
   * False once an isolated run's sandbox was not confirmed stopped and restored. The directory is handed to the sandbox
   * user, so until take-back restores it the sandbox may still own or hold it; it is then left exactly as it is, like every
   * other sandbox-writable path.
   */
  readonly sandboxTrusted: boolean
  readonly logger: Logger
}

/**
 * Ends the run's `gh` credential: drops the Action process's own `GH_TOKEN` and `GH_CONFIG_DIR`, and removes the config
 * directory, whose `hosts.yml` holds the token a later step in the caller's job could otherwise read (#2156).
 *
 * Called from the run's `finally`, after `runCleanup`. Everything that uses the credential is over by then: the server and
 * the sandbox (which hold the directory through `GH_CONFIG_DIR`) are stopped and restored, and finalize, review
 * reconciliation and cleanup have run. What follows uses the Action's own Octokit client, never `gh` or this directory. Never
 * throws; a failure is a warning.
 */
export async function releaseRunGhConfig(options: ReleaseRunGhConfigOptions): Promise<void> {
  delete process.env.GH_TOKEN
  delete process.env.GH_CONFIG_DIR
  if (options.dir === null) return
  if (!options.sandboxTrusted) {
    options.logger.warning(
      'Leaving the gh config directory in place: the isolate-agent sandbox was not confirmed stopped and restored',
    )
    return
  }
  const outcome = await removeGhConfigDir(options.dir, process.env, options.logger)
  // Cleared only once it is gone, so a failed or refused removal is still the post hook's to retry.
  if (outcome === 'removed' || outcome === 'absent') core.saveState(STATE_KEYS.GH_CONFIG_DIR, '')
}
