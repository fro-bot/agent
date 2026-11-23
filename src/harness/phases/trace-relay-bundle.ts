import path from 'node:path'
import {
  createInstallLocationDeps,
  isInstalledEntryScriptUsable,
  type InstallLocationDeps,
} from '../../services/setup/sandbox-preflight.js'

/**
 * The trace relay bundle is optional: only a run that asks for tracing needs `dist/trace-relay.js`, so the `isolate-agent`
 * preflight does not require it (a missing or replaced file must not change an isolated run with tracing off). This checks
 * it at the one point it matters, right before the relay would be spawned.
 *
 * Isolated run: the full published-install rules of the preflight, plus the relay file (`isInstalledEntryScriptUsable`): a
 * downloaded `fro-bot/agent@<ref>` install with no symlink on the way, whose relay bundle is a regular file. The agent
 * cannot write there, so a file that passes now is the file that runs.
 *
 * Run without isolation: the published-install rules cannot apply (a local `uses: ./` install sits in the checkout and is
 * legitimate), and nothing makes the install immutable to the agent anyway. What is checked is the file the supervisor
 * would spawn: `trace-relay.js` in the directory of the running bundle, which the supervisor reaches the same way
 * (`import.meta.url`, and Node's `process.argv[1]` directory for the preflight). It must be a regular file: not missing,
 * not a symlink, not a directory. That catches a broken or half-extracted install; it is not a tamper guarantee.
 *
 * Returns true to go ahead, false to start nothing. Never throws, and never says why: the caller logs a fixed line.
 */

/** The relay's bundle file, beside the running bundle's other entry files. */
export const TRACE_RELAY_BUNDLE_FILE = 'trace-relay.js'

export interface CheckTraceRelayBundleOptions {
  readonly isolated: boolean
  /** The real filesystem view of the running install by default. */
  readonly deps?: InstallLocationDeps
}

export async function checkTraceRelayBundle(options: CheckTraceRelayBundleOptions): Promise<boolean> {
  try {
    const deps = options.deps ?? createInstallLocationDeps()
    if (options.isolated) return await isInstalledEntryScriptUsable(deps, [`dist/${TRACE_RELAY_BUNDLE_FILE}`])
    if (deps.bundleDir === null) return false
    return (await deps.lstat(path.join(deps.bundleDir, TRACE_RELAY_BUNDLE_FILE))) === 'file'
  } catch {
    return false
  }
}
