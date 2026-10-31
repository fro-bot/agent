/**
 * Where the installed Systematic plugin keeps its bundled skills, on disk, per OpenCode generation.
 *
 * A skill reads its own `references/` and runs its own `scripts/` from `<package>/skills/<name>/`, which is outside the
 * checkout. The `external_directory` deny the Action and the workspace install shadows the allow OpenCode adds for that
 * directory itself (last matching rule wins), so each surface re-allows exactly this directory. These helpers find it.
 *
 * - V1: `<cache>/opencode/packages/<spec>/node_modules/<name>/skills` (`core/src/npm.ts`, `directory(pkg)`).
 * - V2: `<cache>/opencode/npm/<spec>/<generation>/node_modules/<name>/skills` (`util/src/npm.ts`). The generation is a
 *   millisecond timestamp the installer picks, so it is read from disk: the newest numbered one is what the server loads.
 *
 * Both skill tools report `dirname(SKILL.md)` as the skill's base directory, built from the path the loader found the
 * file at, so a symlinked cache can surface the real path instead of the one named here. When the two differ both are
 * returned, each as a spelling the caller grants and pairs with an edit deny.
 *
 * Only a spelling that ends in `/@fro.bot/systematic/skills` is returned. A skills directory, or a parent of it, that
 * links to `/` or any other shallow path would otherwise resolve to a real path whose grant (`/*`) covers the whole
 * filesystem. Such a spelling is dropped with a warning, which never prints the path.
 *
 * The version lands in a path, so only a plain version or tag is accepted. An unsafe value, a relative cache home and a
 * directory that is not on disk all resolve to nothing, never to a wider path.
 */

import type {Logger} from '../shared/logger.js'
import {readdir, realpath} from 'node:fs/promises'
import path from 'node:path'
import {SYSTEMATIC_PACKAGE} from '../shared/constants.js'

/** A version or dist-tag as it appears in a plugin spec, with nothing that could widen a path or a wildcard. */
const SAFE_SPEC_VERSION = /^[0-9A-Z][\w.+-]*$/i

const GENERATION_PATTERN = /^\d+$/

function isSafeInput(cacheHome: string, version: string): boolean {
  return path.isAbsolute(cacheHome) && SAFE_SPEC_VERSION.test(version) && !version.includes('..')
}

/** Every granted spelling names the package's own `skills` directory, however deep the cache sits. The edit deny keys on it. */
const SKILLS_TAIL = `/${SYSTEMATIC_PACKAGE}/skills`

/** The candidate and, when it differs, its real path. Empty when the candidate is not on disk. */
async function existingSpellings(candidate: string, logger: Logger): Promise<readonly string[]> {
  let spellings: readonly string[]
  try {
    const real = await realpath(candidate)
    spellings = real === candidate ? [candidate] : [candidate, real]
  } catch {
    return []
  }
  const accepted = spellings.filter(isSystematicSkillsDir)
  if (accepted.length < spellings.length) {
    logger.warning(
      'Ignoring a bundled Systematic skills path that resolves outside the package layout; skills there will ask',
    )
  }
  return accepted
}

/** The installed V1 skills directory of `@fro.bot/systematic@<version>`, as the paths it may be reported under. */
export async function resolveSystematicSkillsDirsV1(
  cacheHome: string,
  version: string,
  logger: Logger,
): Promise<readonly string[]> {
  if (!isSafeInput(cacheHome, version)) return []
  return existingSpellings(
    path.join(
      cacheHome,
      'opencode',
      'packages',
      `${SYSTEMATIC_PACKAGE}@${version}`,
      'node_modules',
      SYSTEMATIC_PACKAGE,
      'skills',
    ),
    logger,
  )
}

/** The installed V2 skills directory of `@fro.bot/systematic@<version>`, as the paths it may be reported under. */
export async function resolveSystematicSkillsDirsV2(
  cacheHome: string,
  version: string,
  logger: Logger,
): Promise<readonly string[]> {
  if (!isSafeInput(cacheHome, version)) return []
  const specDir = path.join(cacheHome, 'opencode', 'npm', `${SYSTEMATIC_PACKAGE}@${version}`)
  let entries: string[]
  try {
    entries = await readdir(specDir)
  } catch {
    return []
  }
  const newest = entries
    .filter(entry => GENERATION_PATTERN.test(entry))
    .toSorted((a, b) => Number(a) - Number(b))
    .at(-1)
  if (newest === undefined) return []
  return existingSpellings(path.join(specDir, newest, 'node_modules', SYSTEMATIC_PACKAGE, 'skills'), logger)
}

/** Whether `directory` is a spelling of the package's own `skills` directory (see `SKILLS_TAIL`). */
export function isSystematicSkillsDir(directory: string): boolean {
  return directory.endsWith(SKILLS_TAIL)
}

/**
 * The V1 `edit` resource pattern that denies writes to every granted skills directory, from any worktree.
 *
 * V1's `edit`, `write` and `apply_patch` ask `permission: "edit"` with `path.relative(instance.worktree, file)`
 * (`tool/edit.ts`, `write.ts`, `apply_patch.ts`), so an absolute `<dir>/*` pattern never matches. What the relative
 * path keeps of the directory depends on how much of it the worktree shares: from `/home/runner/work/repo` the cache
 * `/home/runner/.cache/opencode/...` is `../../.cache/opencode/...`, with no `home/runner` in it, so a pattern built
 * from the whole directory misses the common case. The one thing every spelling has is its tail, and
 * `existingSpellings` guarantees it. `*` compiles to `.*` and matches `/` and `..` too, so `*` + the tail matches the
 * relative path from any worktree, and the absolute spelling as well. Nothing else ends in `/@fro.bot/systematic/skills`
 * (not the package, not `skills-evil`, not the checkout), so one pattern pairs with every grant.
 */
export const SKILLS_EDIT_DENY_PATTERN_V1 = `*${SKILLS_TAIL}/*`
