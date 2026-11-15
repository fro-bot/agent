/**
 * The agent's `PATH` under `isolate-agent`: the runner's own, so tools that earlier steps put there (`setup-node`,
 * `setup-uv`, `setup-python` and the like, which install under the hosted tool cache) run for the agent as they do for the
 * job.
 *
 * Absolute entries that are existing directories, in the runner's order, each once at its first position; then the system
 * directories that are not already there. Nothing is filtered by writability: the read-only view makes every shared
 * directory read-only for the agent, and an entry only the agent could write could only shadow the agent's own tools. An
 * entry under the runner home stays on the list; it resolves nothing until that path is granted.
 */

/** Where the sandbox's own system tools live, in lookup order. Always last, never before a runner entry. */
export const SANDBOX_SYSTEM_DIRECTORIES: readonly string[] = ['/usr/local/bin', '/usr/bin', '/bin']

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/

/** `/opt/a/` and `/opt/a` are one directory. The root itself stays `/`. */
function withoutTrailingSlashes(entry: string): string {
  const trimmed = entry.replace(/\/+$/, '')
  return trimmed.length === 0 ? '/' : trimmed
}

export function buildSandboxPath(
  runnerPath: string | undefined,
  isExistingDirectory: (directory: string) => boolean,
): string {
  const entries: string[] = []
  const seen = new Set<string>()
  const add = (entry: string): void => {
    if (seen.has(entry)) return
    seen.add(entry)
    entries.push(entry)
  }

  for (const raw of (runnerPath ?? '').split(':')) {
    if (!raw.startsWith('/') || CONTROL_CHARACTERS.test(raw)) continue
    const entry = withoutTrailingSlashes(raw)
    if (seen.has(entry)) continue
    let exists = false
    try {
      exists = isExistingDirectory(entry)
    } catch {
      // An entry that cannot be checked is not one the agent can use.
    }
    if (exists) add(entry)
  }
  for (const directory of SANDBOX_SYSTEM_DIRECTORIES) add(directory)
  return entries.join(':')
}
