/**
 * Resolves the patched OpenCode binary for the current host.
 *
 * Resolution order (precedence, highest to lowest):
 *   0. OPENCODE_PATH env override — always honoured; marks isBuilt: false.
 *   1. Host-platform optionalDependencies binary (the real harness-built artifact).
 *      Resolved via Node module resolution (createRequire) so pnpm/npm hoisting
 *      is handled correctly — the platform package may be hoisted outside the
 *      local node_modules tree.
 *   2. PATH fallback (`opencode` on PATH) — ONLY when an explicit dev escape hatch
 *      is active: HARNESS_ALLOW_PATH_FALLBACK=1 or OPENCODE_PATH is set.
 *      In published/production use (no escape hatch), a missing platform binary
 *      is a hard error with an actionable message.
 *
 * The integrity check in step 1 is a basic executable-probe (--version succeeds).
 * A full cryptographic integrity check (npm provenance) is enforced by the
 * postinstall resolver at install time; this runtime check is a belt-and-suspenders
 * guard against a corrupted or missing binary.
 */

import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import path from 'node:path'
import process from 'node:process'
import {binaryPathInPackage, getHostPlatformInfo} from './platform.js'

/**
 * Result of binary resolution.
 *
 * resolved  — true when a usable binary was found.
 * path      — the resolved binary path or command name.
 * isBuilt   — true when the binary is a real harness-built artifact.
 *             false in the dev scaffold (falls back to opencode on PATH).
 */
export interface ResolvedBinary {
  readonly resolved: boolean
  readonly path: string
  readonly isBuilt: boolean
}

/**
 * Attempts to resolve the host-platform binary from the installed
 * @fro.bot/harness-<os>-<arch> optionalDependencies package.
 *
 * Uses Node module resolution (createRequire) to locate the package, which
 * correctly handles pnpm/npm hoisting — the platform package may be installed
 * outside the local node_modules tree.
 *
 * Returns the binary path if found and executable, or null otherwise.
 */
function resolveOptionalDepBinary(): string | null {
  const platformResult = getHostPlatformInfo()
  if (!platformResult.ok) {
    // Unsupported platform — no platform binary available.
    return null
  }

  const info = platformResult.info

  // Resolve the platform package via Node module resolution.
  // This handles pnpm/npm hoisting correctly — the package may not be in
  // a local node_modules directory.
  const require = createRequire(import.meta.url)
  let platformPkgRoot: string
  try {
    const pkgJsonPath = require.resolve(`${info.packageName}/package.json`)
    platformPkgRoot = path.dirname(pkgJsonPath)
  } catch {
    // Platform package not installed (optional dependency absent).
    return null
  }

  const binaryPath = binaryPathInPackage(platformPkgRoot, info)

  // Basic executable probe — confirm the binary runs before returning it.
  try {
    execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return binaryPath
  } catch {
    return null
  }
}

/**
 * Returns true when an explicit dev escape hatch is active.
 *
 * The escape hatch allows PATH fallback in local/dev/unbuilt environments.
 * It is NEVER active in published/production use (no env set by default).
 *
 * Escape hatches:
 *   - HARNESS_ALLOW_PATH_FALLBACK=1  — explicit opt-in for dev/CI without platform binary.
 *   - OPENCODE_PATH set              — explicit override already provided; PATH fallback is moot.
 */
function isDevEscapeHatchActive(): boolean {
  return (
    process.env.HARNESS_ALLOW_PATH_FALLBACK === '1' ||
    (process.env.OPENCODE_PATH !== undefined && process.env.OPENCODE_PATH.length > 0)
  )
}

/**
 * Resolves the patched OpenCode binary for the current host.
 *
 * Resolution order:
 *   0. OPENCODE_PATH env override.
 *   1. Host-platform optionalDependencies binary (isBuilt: true).
 *   2. PATH fallback — ONLY when HARNESS_ALLOW_PATH_FALLBACK=1 (dev escape hatch).
 *      In production (no escape hatch), missing platform binary → throws with remediation.
 *
 * @throws {Error} when no platform binary is found and no dev escape hatch is active.
 */
export function resolveBinary(): ResolvedBinary {
  // 0. Explicit override — always wins.
  const override = process.env.OPENCODE_PATH
  if (override !== undefined && override.length > 0) {
    return {resolved: true, path: override, isBuilt: false}
  }

  // 1. Host-platform optionalDependencies binary.
  const optionalBinary = resolveOptionalDepBinary()
  if (optionalBinary !== null) {
    return {resolved: true, path: optionalBinary, isBuilt: true}
  }

  // 2. No platform binary found.
  //    In dev/unbuilt environments with an explicit escape hatch, fall back to PATH.
  //    In production (no escape hatch), fail closed with an actionable error.
  if (isDevEscapeHatchActive()) {
    return {resolved: true, path: 'opencode', isBuilt: false}
  }

  // Determine which platform package was expected for the error message.
  const platformResult = getHostPlatformInfo()
  const expectedPkg = platformResult.ok ? platformResult.info.packageName : '@fro.bot/harness-<os>-<arch>'

  throw new Error(
    `[harness] Platform binary not found. Expected package: ${expectedPkg}\n` +
      `  Remediation: ensure ${expectedPkg} is installed as an optionalDependency,\n` +
      `  or set OPENCODE_PATH to an explicit binary path,\n` +
      `  or set HARNESS_ALLOW_PATH_FALLBACK=1 to use opencode on PATH (dev only).`,
  )
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
