import type {Logger} from '../../shared/logger.js'
import {lstat, realpath, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, dirname, isAbsolute} from 'node:path'
import process from 'node:process'

/** `configureGhAuth` creates the run's `gh` config as `<base>/gh-config-<random>`; removal only ever touches that shape. */
export const GH_CONFIG_DIR_PREFIX = 'gh-config-'

/** Where the run's `gh` config directory is created and, at the end of the run, removed from. */
export function ghConfigBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const runnerTemp = env.RUNNER_TEMP
  return runnerTemp != null && runnerTemp.length > 0 ? runnerTemp : tmpdir()
}

/**
 * `removed`: gone now. `absent`: nothing was there. `refused`: not a directory this run's setup could have made (a symlink,
 * a wrong name or parent, not ours), left untouched. `failed`: the removal threw; left as it was.
 */
export type RemoveGhConfigDirOutcome = 'removed' | 'absent' | 'refused' | 'failed'

/**
 * Removes the run's `gh` config directory (it holds `hosts.yml`, i.e. the token). Never throws: a refusal or a failure is a
 * warning, since the runner's own temp cleanup is the backstop.
 *
 * Refuses anything that is not a real directory (never a symlink, so a planted link cannot redirect the removal) named
 * `gh-config-*` directly under the directory setup created it in and owned by this user, so an ambient `GH_CONFIG_DIR` from
 * an earlier step or a bad value cannot delete something else. `rm` does not follow symlinks inside the tree either.
 */
export async function removeGhConfigDir(
  dir: string,
  env: NodeJS.ProcessEnv,
  logger: Logger,
  remove: (target: string) => Promise<void> = async target => rm(target, {recursive: true, force: true}),
): Promise<RemoveGhConfigDirOutcome> {
  const refuse = (): RemoveGhConfigDirOutcome => {
    logger.warning("Refusing to remove a gh config directory that is not this run's own")
    return 'refused'
  }
  if (!isAbsolute(dir)) return refuse()
  const name = basename(dir)
  if (!name.startsWith(GH_CONFIG_DIR_PREFIX) || name.length === GH_CONFIG_DIR_PREFIX.length) return refuse()

  let parentIsBase: boolean
  try {
    parentIsBase = (await realpath(dirname(dir))) === (await realpath(ghConfigBaseDir(env)))
  } catch {
    // The parent or the base is not there, so the path cannot be the one setup made.
    return refuse()
  }
  if (!parentIsBase) return refuse()

  try {
    const stat = await lstat(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) return refuse()
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid !== uid) return refuse()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    logger.warning('Could not inspect the gh config directory', {
      error: (error as NodeJS.ErrnoException).code ?? 'unknown',
    })
    return 'failed'
  }

  try {
    await remove(dir)
    return 'removed'
  } catch (error) {
    logger.warning('Could not remove the gh config directory', {
      error: (error as NodeJS.ErrnoException).code ?? 'unknown',
    })
    return 'failed'
  }
}
