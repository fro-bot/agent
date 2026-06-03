/**
 * Resolves the patched OpenCode binary for the current host.
 *
 * Resolution order:
 *   0. OPENCODE_PATH env override (explicit override, always honoured).
 *   1. Host-platform optionalDependencies binary (the real harness-built artifact).
 *      Looks up the @fro.bot/harness-<os>-<arch> package installed alongside this
 *      package and integrity-verifies the binary before returning it.
 *   2. Dev/PATH fallback: `opencode` on PATH (dev scaffold, isBuilt: false).
 *
 * The integrity check in step 1 is a basic executable-probe (--version succeeds).
 * A full cryptographic integrity check (npm provenance) is enforced by the
 * postinstall resolver at install time; this runtime check is a belt-and-suspenders
 * guard against a corrupted or missing binary.
 */

import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
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

// The harness package root is two levels up from this compiled file (dist/resolve-binary.js → ../..)
// At runtime (compiled), __dirname is packages/harness/dist.
// At test time (ts-node/vitest), __dirname is packages/harness/src.
// We resolve the package root by walking up to find package.json.
function findPackageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // Walk up until we find a directory containing package.json for @fro.bot/harness.
  // In practice: dist/ → packages/harness/ (one level up) or src/ → packages/harness/ (one level up).
  const candidate = path.resolve(here, '..')
  return candidate
}

/**
 * Attempts to resolve the host-platform binary from the installed
 * @fro.bot/harness-<os>-<arch> optionalDependencies package.
 *
 * Returns the binary path if found and executable, or null otherwise.
 */
function resolveOptionalDepBinary(): string | null {
  let info
  try {
    info = getHostPlatformInfo()
  } catch {
    // Unsupported platform or other error — fall through to dev scaffold.
    return null
  }

  // The per-platform package is installed as a sibling of @fro.bot/harness in node_modules.
  // Path: <packageRoot>/node_modules/@fro.bot/harness-<os>-<arch>/bin/opencode
  const packageRoot = findPackageRoot()
  const platformPkgRoot = path.join(packageRoot, 'node_modules', info.packageName)
  const binaryPath = binaryPathInPackage(platformPkgRoot, info)

  if (!existsSync(binaryPath)) {
    return null
  }

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
 * Resolves the patched OpenCode binary for the current host.
 *
 * Resolution order:
 *   0. OPENCODE_PATH env override.
 *   1. Host-platform optionalDependencies binary (isBuilt: true).
 *   2. Dev/PATH fallback: `opencode` on PATH (isBuilt: false).
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

  // 2. Dev scaffold: fall back to `opencode` on PATH.
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
