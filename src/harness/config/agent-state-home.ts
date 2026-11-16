import type {Result} from '@bfra.me/es/result'
import {lstatSync} from 'node:fs'
import path from 'node:path'
import {err, ok} from '../../shared/types.js'

/**
 * Resolves the `agent-state-home` input: an absolute directory inside the checkout that becomes the isolated agent's
 * `XDG_STATE_HOME` (handed to the sandbox user for the run, taken back after it).
 *
 * The checkout is the one tree the sandbox user can already rewrite, so a directory inside it adds no reach. What must not
 * happen is the path leaving it: the directory is chowned to the sandbox user, and a link on the way would turn that into a
 * chown of whatever the link points at. Every component below the checkout that already exists is therefore checked with
 * `lstat`: a symlink anywhere (the final component or a parent) is refused, as is a non-directory. A component that does not
 * exist yet is fine; the handoff creates it, after checking the chain again.
 *
 * Pure of side effects: nothing is created here, and nothing is followed.
 */
export function resolveAgentStateHome(raw: string, workspace: string | undefined): Result<string, Error> {
  const requested = raw.trim()
  const refuse = (problem: string): Result<string, Error> => err(new Error(`Invalid agent-state-home: ${problem}`))

  if (!path.isAbsolute(requested)) return refuse(`"${requested}" must be an absolute path`)
  if (workspace === undefined || workspace.trim().length === 0) {
    return refuse('GITHUB_WORKSPACE is not set, so there is no checkout to keep it inside')
  }

  const root = path.resolve(workspace)
  // Normalized lexically before the containment check, and the normalized form is what is returned, so a `..` hidden behind a
  // link can never be read two ways.
  const target = path.resolve(requested)
  const relative = path.relative(root, target)
  if (relative === '') return refuse('it must be a directory inside the checkout, not the checkout itself')
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return refuse(`"${target}" is not inside the checkout (${root}); it must be a directory inside the checkout`)
  }

  const segments = relative.split(path.sep)
  // The take-back restores `.git` metadata from a snapshot, so a state directory there would be overwritten.
  if (segments.includes('.git')) return refuse('it may not be inside a .git directory')

  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    let stats
    try {
      stats = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      return refuse(`${current} cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`)
    }
    if (stats.isSymbolicLink())
      return refuse(`${current} is a symlink; it must be a real directory inside the checkout`)
    if (!stats.isDirectory()) return refuse(`${current} exists and is not a directory`)
  }
  return ok(target)
}
