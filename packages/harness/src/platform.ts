/**
 * Host platform/arch detection → optionalDependencies package name.
 *
 * Maps the current Node.js process.platform + process.arch to the
 * @fro.bot/harness-<os>-<arch> package name that ships the native binary.
 *
 * Mirrors OpenCode's per-platform packaging model (anomalyco/opencode script/publish.ts).
 * Windows is out of scope (matrix: linux x64/arm64 + darwin x64/arm64 only).
 */

import process from 'node:process'

/** Supported OS identifiers (Node.js process.platform values we handle). */
export type SupportedOs = 'linux' | 'darwin'

/** Supported CPU arch identifiers (Node.js process.arch values we handle). */
export type SupportedArch = 'x64' | 'arm64'

/** A resolved platform identity. */
export interface PlatformInfo {
  readonly os: SupportedOs
  readonly arch: SupportedArch
  /** The @fro.bot/harness-<os>-<arch> package name for this platform. */
  readonly packageName: string
  /** The binary filename inside the package (always 'opencode' on supported platforms). */
  readonly binaryName: string
}

/** Thrown when the host platform is not in the supported matrix. */
export class UnsupportedPlatformError extends Error {
  constructor(os: string, arch: string) {
    super(`Unsupported platform: ${os}/${arch}. @fro.bot/harness supports linux/darwin × x64/arm64 only (no windows).`)
    this.name = 'UnsupportedPlatformError'
  }
}

/**
 * Returns the platform info for the given os/arch pair.
 *
 * @param os   - Node.js process.platform value (e.g. 'linux', 'darwin', 'win32').
 * @param arch - Node.js process.arch value (e.g. 'x64', 'arm64').
 * @throws {UnsupportedPlatformError} when the platform is not in the supported matrix.
 */
export function getPlatformInfo(os: string, arch: string): PlatformInfo {
  if (os !== 'linux' && os !== 'darwin') {
    throw new UnsupportedPlatformError(os, arch)
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new UnsupportedPlatformError(os, arch)
  }

  const supportedOs: SupportedOs = os
  const supportedArch: SupportedArch = arch

  return {
    os: supportedOs,
    arch: supportedArch,
    packageName: `@fro.bot/harness-${supportedOs}-${supportedArch}`,
    binaryName: 'opencode',
  }
}

/**
 * Returns the platform info for the current host process.
 *
 * @throws {UnsupportedPlatformError} when the host platform is not in the supported matrix.
 */
export function getHostPlatformInfo(): PlatformInfo {
  return getPlatformInfo(process.platform, process.arch)
}

/**
 * Returns the expected binary path inside an installed optionalDependencies package.
 *
 * The per-platform packages ship the native binary at:
 *   <packageRoot>/bin/<binaryName>
 *
 * @param packageRoot - Absolute path to the installed platform package root.
 * @param info        - Platform info (from getPlatformInfo or getHostPlatformInfo).
 */
export function binaryPathInPackage(packageRoot: string, info: PlatformInfo): string {
  // Use path.join via dynamic import to avoid circular deps — inline the join.
  // Node path.join is synchronous and safe here.
  return `${packageRoot}/bin/${info.binaryName}`
}
