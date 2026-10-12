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

import {Buffer} from 'node:buffer'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
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
 * Locates an installed platform package root via Node module resolution
 * (createRequire), which correctly handles pnpm/npm hoisting — the package may
 * be installed outside the local node_modules tree. Returns null when absent.
 */
function locatePlatformPackageRoot(packageName: string): string | null {
  const require = createRequire(import.meta.url)
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`))
  } catch {
    // Platform package not installed (optional dependency absent).
    return null
  }
}

/** Where the host-platform binary would live, and which package is expected to provide it. */
interface PlatformBinaryLookup {
  /** The `@fro.bot/harness-<os>-<arch>` package name, or a placeholder when the host is unsupported. */
  readonly expectedPackage: string
  /** Absolute binary path inside the installed platform package; null when unsupported or not installed. */
  readonly binaryPath: string | null
}

/**
 * The one chain both resolvers use: host platform → installed package root → `bin/opencode` path, plus the package
 * name to cite in remediation. It only computes paths; callers decide how far to trust the file.
 */
function lookupPlatformBinary(
  locate: (packageName: string) => string | null = locatePlatformPackageRoot,
): PlatformBinaryLookup {
  const platformResult = getHostPlatformInfo()
  if (!platformResult.ok) {
    // Unsupported platform — no platform binary available.
    return {expectedPackage: '@fro.bot/harness-<os>-<arch>', binaryPath: null}
  }
  const info = platformResult.info
  const root = locate(info.packageName)
  return {
    expectedPackage: info.packageName,
    binaryPath: root === null ? null : binaryPathInPackage(root, info),
  }
}

/**
 * Attempts to resolve the host-platform binary from the installed
 * @fro.bot/harness-<os>-<arch> optionalDependencies package.
 *
 * Returns the binary path if found and runnable (`--version` probe), or null otherwise.
 */
function resolveOptionalDepBinary(locate: ((packageName: string) => string | null) | undefined): string | null {
  const {binaryPath} = lookupPlatformBinary(locate)
  if (binaryPath === null) {
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
 * Returns true when an explicit dev escape hatch is active.
 *
 * The escape hatch allows PATH fallback in local/dev/unbuilt environments.
 * It is NEVER active in published/production use (no env set by default).
 *
 * Escape hatches:
 *   - HARNESS_ALLOW_PATH_FALLBACK=1  — explicit opt-in for dev/CI without platform binary.
 *   - OPENCODE_PATH set              — explicit override already provided; PATH fallback is moot.
 */
function isDevEscapeHatchActive(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.HARNESS_ALLOW_PATH_FALLBACK === '1' || (env.OPENCODE_PATH !== undefined && env.OPENCODE_PATH.length > 0)
}

export interface ResolveBinaryOptions {
  /** Environment to read OPENCODE_PATH and HARNESS_ALLOW_PATH_FALLBACK from. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Test seam: locate the installed platform package root. Defaults to Node module resolution. */
  readonly locatePlatformPackage?: (packageName: string) => string | null
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
export function resolveBinary(options: ResolveBinaryOptions = {}): ResolvedBinary {
  const env = options.env ?? process.env

  // 0. Explicit override — always wins.
  const override = env.OPENCODE_PATH
  if (override !== undefined && override.length > 0) {
    return {resolved: true, path: override, isBuilt: false}
  }

  // 1. Host-platform optionalDependencies binary.
  const optionalBinary = resolveOptionalDepBinary(options.locatePlatformPackage)
  if (optionalBinary !== null) {
    return {resolved: true, path: optionalBinary, isBuilt: true}
  }

  // 2. No platform binary found.
  //    In dev/unbuilt environments with an explicit escape hatch, fall back to PATH.
  //    In production (no escape hatch), fail closed with an actionable error.
  if (isDevEscapeHatchActive(env)) {
    return {resolved: true, path: 'opencode', isBuilt: false}
  }

  // Determine which platform package was expected for the error message.
  const {expectedPackage: expectedPkg} = lookupPlatformBinary(options.locatePlatformPackage)

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

// #region no-probe resolution

/** Why no-probe resolution failed. */
export type ResolveFailureKind = 'not-found' | 'not-executable' | 'self-reference' | 'opaque-dispatcher'

/** Where a successfully resolved binary came from. */
export type ResolveSource = 'override' | 'platform-package' | 'path-walk'

/**
 * Typed outcome of {@link resolveBinaryNoProbe}. Failures carry remediation text
 * in `message`; callers print it and exit non-zero.
 */
export type ResolveNoProbeResult =
  | {
      readonly ok: true
      /** Absolute path to the binary. Never a bare command name. */
      readonly path: string
      readonly source: ResolveSource
      /** true only for the platform-package binary (a real harness artifact). */
      readonly isBuilt: boolean
    }
  | {
      readonly ok: false
      readonly kind: ResolveFailureKind
      readonly message: string
      /** The candidate that was rejected, when there was one. */
      readonly candidate?: string
    }

export interface ResolveNoProbeOptions {
  /**
   * Absolute paths of the caller's own entry points (the `opencode` shim and the
   * `harness` cli). A candidate whose realpath or (dev, ino) matches any of them
   * is rejected as a self-reference.
   */
  readonly entryPoints: readonly string[]
  /** Environment to read OPENCODE_PATH, HARNESS_ALLOW_PATH_FALLBACK and PATH from. Defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Test seam: locate the installed platform package root. Defaults to Node module resolution. */
  readonly locatePlatformPackage?: (packageName: string) => string | null
}

const REMEDIATION_HINT = 'set OPENCODE_PATH to the native harness opencode binary'

type CandidateState =
  | {readonly state: 'missing'}
  | {readonly state: 'not-file'}
  | {readonly state: 'ok'; readonly stat: fs.Stats; readonly real: string}

function inspectCandidate(candidate: string): CandidateState {
  let stat: fs.Stats
  try {
    stat = fs.statSync(candidate)
  } catch {
    return {state: 'missing'}
  }
  if (stat.isFile() === false) {
    return {state: 'not-file'}
  }
  try {
    return {state: 'ok', stat, real: fs.realpathSync(candidate)}
  } catch {
    return {state: 'missing'}
  }
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Native-binary check: the file starts with an ELF or Mach-O magic number
 * (thin or fat). `#!` scripts and every other format are "opaque" — mise shims
 * resolve to the mise executable or a wrapper script, and we cannot prove those
 * run the patched build, so they fail closed. Reads 4 bytes; never spawns.
 *
 * This is a FORMAT (magic-byte) check only. It rules out scripts and dispatchers;
 * it does not prove the file is the patched harness build (a stock native opencode
 * passes it too).
 */
function isNativeBinary(candidate: string): boolean {
  const header = Buffer.alloc(4)
  let fd: number | undefined
  try {
    fd = fs.openSync(candidate, 'r')
    if (fs.readSync(fd, header, 0, 4, 0) < 4) {
      return false
    }
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing useful to do; the header read already decided the outcome.
      }
    }
  }
  const magic = header.toString('hex')
  return (
    magic === '7f454c46' || // ELF
    magic === 'feedface' || // Mach-O 32-bit
    magic === 'feedfacf' || // Mach-O 64-bit
    magic === 'cefaedfe' || // Mach-O 32-bit, byte-swapped
    magic === 'cffaedfe' || // Mach-O 64-bit, byte-swapped
    magic === 'cafebabe' || // Mach-O fat
    magic === 'bebafeca' // Mach-O fat, byte-swapped
  )
}

/** Builds a predicate matching candidates that are one of the caller's own entry points. */
function buildSelfMatcher(entryPoints: readonly string[]): (candidate: {real: string; stat: fs.Stats}) => boolean {
  const reals = new Set<string>()
  const inodes = new Set<string>()
  for (const entry of entryPoints) {
    const absolute = path.resolve(entry)
    reals.add(absolute)
    try {
      reals.add(fs.realpathSync(absolute))
      const stat = fs.statSync(absolute)
      inodes.add(`${stat.dev}:${stat.ino}`)
    } catch {
      // Entry point not on disk (or unreadable): the lexical path above still guards.
    }
  }
  return ({real, stat}) => reals.has(real) || inodes.has(`${stat.dev}:${stat.ino}`)
}

function selfReferenceFailure(candidate: string, label: string): ResolveNoProbeResult {
  return {
    ok: false,
    kind: 'self-reference',
    candidate,
    message:
      `${label} ${candidate} points back at a harness entry point (opencode shim or harness cli); ` +
      `refusing to exec it to avoid infinite recursion.\n` +
      `  Remediation: ${REMEDIATION_HINT}.`,
  }
}

function opaqueFailure(candidate: string, label: string): ResolveNoProbeResult {
  return {
    ok: false,
    kind: 'opaque-dispatcher',
    candidate,
    message:
      `${label} ${candidate} is not a native binary (script or dispatcher such as a mise shim); ` +
      `it cannot be proven to be the patched build.\n` +
      `  Remediation: ${REMEDIATION_HINT}.`,
  }
}

function notExecutableFailure(candidate: string, label: string): ResolveNoProbeResult {
  return {
    ok: false,
    kind: 'not-executable',
    candidate,
    message:
      `${label} ${candidate} is not an executable file (permission denied or not a regular file).\n` +
      `  Remediation: fix the file mode (chmod +x) or reinstall the package.`,
  }
}

/**
 * Validates an explicit candidate (OPENCODE_PATH or a PATH-walk entry): present,
 * not a harness entry point, executable, and a native binary.
 */
function checkExplicitCandidate(
  candidate: string,
  label: string,
  isSelf: (candidate: {real: string; stat: fs.Stats}) => boolean,
): ResolveNoProbeResult {
  const state = inspectCandidate(candidate)
  if (state.state === 'missing') {
    return {
      ok: false,
      kind: 'not-found',
      candidate,
      message:
        `${label} ${candidate} does not exist.\n` +
        `  ${label} must be an absolute path to the native binary; a bare or relative value is resolved against the ` +
        `current directory, never looked up on PATH.\n` +
        `  Remediation: ${REMEDIATION_HINT}.`,
    }
  }
  if (state.state === 'not-file') {
    return notExecutableFailure(candidate, label)
  }
  if (isSelf(state)) {
    return selfReferenceFailure(candidate, label)
  }
  if (isExecutable(candidate) === false) {
    return notExecutableFailure(candidate, label)
  }
  if (isNativeBinary(candidate) === false) {
    return opaqueFailure(candidate, label)
  }
  return {ok: true, path: candidate, source: 'override', isBuilt: false}
}

function walkPath(
  pathEnv: string,
  isSelf: (candidate: {real: string; stat: fs.Stats}) => boolean,
): ResolveNoProbeResult | null {
  let skippedSelf: string | undefined
  for (const dir of pathEnv.split(path.delimiter)) {
    // Empty and relative PATH entries mean "current directory"; never resolve through them.
    if (dir.length === 0 || path.isAbsolute(dir) === false) {
      continue
    }
    const candidate = path.join(dir, 'opencode')
    const state = inspectCandidate(candidate)
    if (state.state !== 'ok' || isExecutable(candidate) === false) {
      continue
    }
    if (isSelf(state)) {
      skippedSelf ??= candidate
      continue
    }
    // First non-self candidate decides: shadowing past an opaque dispatcher would
    // pick a binary the user's shell would not.
    const checked = checkExplicitCandidate(candidate, 'opencode on PATH:', isSelf)
    return checked.ok ? {...checked, source: 'path-walk'} : checked
  }
  return skippedSelf === undefined ? null : selfReferenceFailure(skippedSelf, 'The only opencode on PATH:')
}

/**
 * Resolves the patched OpenCode binary WITHOUT spawning it (no `--version` probe).
 * Used by the `opencode` shim and the `harness` passthrough, where the SDK's start
 * deadline makes a per-invocation probe too expensive. `harness doctor` keeps
 * the probing {@link resolveBinary}.
 *
 * Order:
 *   0. OPENCODE_PATH — explicit override; must be a native binary and not a harness entry point.
 *   1. Platform package binary — must exist and be executable.
 *   2. PATH walk — ONLY under HARNESS_ALLOW_PATH_FALLBACK=1; same checks as the override.
 *
 * Never returns a bare command name, a harness entry point, or an opaque dispatcher.
 */
export function resolveBinaryNoProbe(options: ResolveNoProbeOptions): ResolveNoProbeResult {
  const env = options.env ?? process.env
  const isSelf = buildSelfMatcher(options.entryPoints)

  // 0. Explicit override.
  const override = env.OPENCODE_PATH
  if (override !== undefined && override.length > 0) {
    return checkExplicitCandidate(path.resolve(override), 'OPENCODE_PATH', isSelf)
  }

  // 1. Platform package. A present-but-unusable binary is a hard failure, not a reason to fall through.
  const {expectedPackage: expectedPkg, binaryPath} = lookupPlatformBinary(options.locatePlatformPackage)
  if (binaryPath !== null) {
    const state = inspectCandidate(binaryPath)
    if (state.state === 'ok') {
      if (isSelf(state)) {
        return selfReferenceFailure(binaryPath, 'Platform binary')
      }
      if (isExecutable(binaryPath) === false) {
        return notExecutableFailure(binaryPath, 'Platform binary')
      }
      return {ok: true, path: binaryPath, source: 'platform-package', isBuilt: true}
    }
    if (state.state === 'not-file') {
      return notExecutableFailure(binaryPath, 'Platform binary')
    }
  }

  // 2. Dev-only PATH walk.
  if (env.HARNESS_ALLOW_PATH_FALLBACK === '1') {
    const walked = walkPath(env.PATH ?? '', isSelf)
    if (walked !== null) {
      return walked
    }
  }

  return {
    ok: false,
    kind: 'not-found',
    message:
      `Platform binary not found. Expected package: ${expectedPkg}\n` +
      `  Remediation: ensure ${expectedPkg} is installed as an optionalDependency,\n` +
      `  or ${REMEDIATION_HINT},\n` +
      `  or set HARNESS_ALLOW_PATH_FALLBACK=1 to search PATH for a native opencode (dev only).`,
  }
}

// #endregion
