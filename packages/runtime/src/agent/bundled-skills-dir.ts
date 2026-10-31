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
 * returned.
 *
 * The version lands in a path and, on V1, in a wildcard pattern, so only a plain version or tag is accepted. An unsafe
 * value, a relative cache home and a directory that is not on disk all resolve to nothing, never to a wider path.
 */

import {readdir, realpath} from 'node:fs/promises'
import path from 'node:path'

import {SYSTEMATIC_PACKAGE} from '../shared/constants.js'

/** A version or dist-tag as it appears in a plugin spec, with nothing that could widen a path or a wildcard. */
const SAFE_SPEC_VERSION = /^[0-9A-Z][\w.+-]*$/i

const GENERATION_PATTERN = /^\d+$/

function isSafeInput(cacheHome: string, version: string): boolean {
  return path.isAbsolute(cacheHome) && SAFE_SPEC_VERSION.test(version) && !version.includes('..')
}

/** The candidate and, when it differs, its real path. Empty when the candidate is not on disk. */
async function existingSpellings(candidate: string): Promise<readonly string[]> {
  try {
    const real = await realpath(candidate)
    return real === candidate ? [candidate] : [candidate, real]
  } catch {
    return []
  }
}

/** The installed V1 skills directory of `@fro.bot/systematic@<version>`, as the paths it may be reported under. */
export async function resolveSystematicSkillsDirsV1(cacheHome: string, version: string): Promise<readonly string[]> {
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
  )
}

/** The installed V2 skills directory of `@fro.bot/systematic@<version>`, as the paths it may be reported under. */
export async function resolveSystematicSkillsDirsV2(cacheHome: string, version: string): Promise<readonly string[]> {
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
  return existingSpellings(path.join(specDir, newest, 'node_modules', SYSTEMATIC_PACKAGE, 'skills'))
}

/**
 * The `edit` resource pattern that denies writes to the V1 skills directory.
 *
 * V1's `edit`, `write` and `apply_patch` ask `permission: "edit"` with `path.relative(instance.worktree, file)`
 * (`tool/edit.ts`, `write.ts`, `apply_patch.ts`), so an absolute `<dir>/*` pattern never matches: from a checkout it is
 * `../../../.cache/opencode/...`, and the number of `..` depends on where the worktree is. `*` compiles to `.*` and
 * matches `/` and `..` too, so a pattern anchored on the version-specific tail matches the path whatever the worktree is
 * (and the absolute spelling as well). The tail names this one package version, so nothing else is caught.
 */
export function systematicSkillsEditDenyPatternV1(version: string): string | undefined {
  if (!SAFE_SPEC_VERSION.test(version) || version.includes('..')) return undefined
  return `*/opencode/packages/${SYSTEMATIC_PACKAGE}@${version}/node_modules/${SYSTEMATIC_PACKAGE}/skills/*`
}
