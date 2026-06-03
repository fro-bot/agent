import {execFileSync} from 'node:child_process'
import process from 'node:process'

/**
 * Result of binary resolution.
 *
 * resolved  — true when a usable binary was found.
 * path      — the resolved binary path or command name.
 * isBuilt   — true when the binary is a real harness-built artifact (Unit 3).
 *             false in the dev scaffold (falls back to opencode on PATH).
 */
export interface ResolvedBinary {
  readonly resolved: boolean
  readonly path: string
  readonly isBuilt: boolean
}

/**
 * Resolves the patched OpenCode binary for the current host.
 *
 * Resolution order (Unit 3 will prepend the optionalDependencies host-binary step):
 *   1. OPENCODE_PATH env override (explicit override, always honoured).
 *   2. Dev/scaffold fallback: `opencode` on PATH.
 *
 * Unit 3 wires step 0: select the host-platform binary from the installed
 * @fro.bot/harness-<platform>-<arch> optionalDependency package, verify its
 * integrity, and return it as isBuilt:true.
 */
export function resolveBinary(): ResolvedBinary {
  // Explicit override — always wins.
  const override = process.env.OPENCODE_PATH
  if (override !== undefined && override.length > 0) {
    return {resolved: true, path: override, isBuilt: false}
  }

  // Dev scaffold: fall back to `opencode` on PATH.
  // Unit 3 inserts the optionalDependencies host-binary resolution here.
  return {resolved: true, path: 'opencode', isBuilt: false}
}

/**
 * Checks whether the resolved binary is present and runnable by invoking it
 * with `--version`. Returns the version string on success, or null on failure.
 */
export function probeBinary(binaryPath: string): string | null {
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return output.trim()
  } catch {
    return null
  }
}
