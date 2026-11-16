import type {Logger} from '../../shared/logger.js'
import process from 'node:process'
import * as core from '@actions/core'
import {removeGhConfigDir} from '../../services/setup/gh-config-dir.js'
import {STATE_KEYS} from '../config/state-keys.js'

// The `gh` config directory this run's setup created, or null. One source of truth: the end-of-run cleanup removes exactly
// this, and the action state below is the same value for the post hook. Setup records it the moment `mkdtemp` returns
// (before `gh auth login` writes the token into it), so nothing is inferred from `GH_CONFIG_DIR`, which an earlier step may
// have set to a directory that is not ours.
let recordedDir: string | null = null

/**
 * Records (or, with `null`, forgets) the run's `gh` config directory in this process and in the action state. The state is
 * what lets the post hook remove the directory if the main step is killed before its own cleanup.
 */
export function recordRunGhConfigDir(dir: string | null): void {
  recordedDir = dir
  core.saveState(STATE_KEYS.GH_CONFIG_DIR, dir ?? '')
}

export interface ReleaseRunGhConfigOptions {
  /**
   * False once an isolated run's sandbox was not confirmed stopped and restored. The directory is handed to the sandbox
   * user, so until take-back restores it the sandbox may still own or hold it; it is then left exactly as it is, like every
   * other sandbox-writable path.
   */
  readonly sandboxTrusted: boolean
  readonly logger: Logger
}

/**
 * Ends the run's `gh` credential: drops the Action process's own `GH_TOKEN` and `GH_CONFIG_DIR`, and removes the recorded
 * config directory, whose `hosts.yml` holds the token a later step in the caller's job could otherwise read (#2156).
 *
 * Called from the run's `finally`, after `runCleanup`. Everything that uses the credential is over by then: the server and
 * the sandbox (which hold the directory through `GH_CONFIG_DIR`) are stopped and restored, and finalize, review
 * reconciliation and cleanup have run. What follows uses the Action's own Octokit client, never `gh` or this directory. Never
 * throws; a failure is a warning.
 */
export async function releaseRunGhConfig(options: ReleaseRunGhConfigOptions): Promise<void> {
  delete process.env.GH_TOKEN
  delete process.env.GH_CONFIG_DIR
  const dir = recordedDir
  if (dir === null) return
  if (!options.sandboxTrusted) {
    options.logger.warning(
      'Leaving the gh config directory in place: the isolate-agent sandbox was not confirmed stopped and restored',
    )
    return
  }
  const outcome = await removeGhConfigDir(dir, process.env, options.logger)
  // Forgotten only once it is gone, so a failed or refused removal is still the post hook's to retry.
  if (outcome === 'removed' || outcome === 'absent') recordRunGhConfigDir(null)
}
