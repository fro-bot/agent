#!/usr/bin/env bun
/**
 * build-platform.ts — per-platform native build of the integrated OpenCode.
 *
 * Given the frozen integration commit (from the provenance manifest) and a
 * target platform, checks out the FULL upstream repo at that commit, runs upstream's
 * real build (packages/opencode/script/build.ts — the embedded-app + native-dep build)
 * with the release-identity env, and emits the native binary for that platform.
 *
 * Build-environment contract:
 *   - Bun version is pinned to match upstream's packageManager (bun@1.3.13).
 *   - The full upstream repo is checked out at the frozen integration commit.
 *   - Native-dep install + embedded-app build happen under the UPSTREAM repo root.
 *   - Build runs with:
 *       OPENCODE_CHANNEL=latest
 *       OPENCODE_VERSION=<baseVersion>+harness.<integrationCommit[0..7]>
 *     The version string embeds the integration commit short SHA so the binary
 *     self-reports it. The upstream build bakes OPENCODE_VERSION into the binary
 *     via the `define: { OPENCODE_VERSION: ... }` field in build.ts.
 *   - Built binary --version is verified == OPENCODE_VERSION before emitting.
 *   - provenance.json is written to packages/harness/ for the workflow assemble step.
 *
 * Integration commit embedding mechanism:
 *   OpenCode's build.ts reads OPENCODE_VERSION from the environment (via the
 *   @opencode-ai/script package's Script.version getter) and bakes it into the
 *   binary as a compile-time define. We set OPENCODE_VERSION to
 *   "<baseVersion>+harness.<shortSha>" so the binary's --version output includes
 *   the integration commit. verify-binary.ts then probes `binary info` (which calls
 *   formatProvenance) for the structured "integration commit: <sha>" line.
 *
 *   NOTE: The binary's --version output will be "<baseVersion>+harness.<shortSha>"
 *   rather than the bare "<baseVersion>". The verify step uses the full version string.
 *
 * Usage:
 *   bun run packages/harness/scripts/build-platform.ts \
 *     --integration-commit <sha> \
 *     --base-version <version> \
 *     --platform <linux|darwin> \
 *     --arch <x64|arm64> \
 *     --repo-url <https://github.com/anomalyco/opencode.git> \
 *     --work-dir <path> \
 *     --out-dir <path>
 *
 * The script exits non-zero on any failure (version mismatch, build error, etc.).
 * It does NOT run a real build when --help is passed.
 */

import {execFileSync, spawnSync} from 'node:child_process'
import {cpSync, mkdirSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {buildHarnessVersion} from '../src/version.js'

// ---------------------------------------------------------------------------
// Build-environment contract constants
// ---------------------------------------------------------------------------

/** Pinned Bun version — matches upstream anomalyco/opencode packageManager field. */
const REQUIRED_BUN_VERSION = '1.3.13'

/** The release channel used for the build identity env. */
const OPENCODE_CHANNEL = 'latest'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface BuildArgs {
  readonly integrationCommit: string
  readonly baseVersion: string
  readonly platform: string
  readonly arch: string
  readonly repoUrl: string
  readonly workDir: string
  readonly outDir: string
}

function parseArgs(argv: string[]): BuildArgs | null {
  const args = argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    printHelp()
    process.exit(0)
  }

  function flag(name: string): string | null {
    const idx = args.indexOf(name)
    if (idx === -1) return null
    const val = args[idx + 1]
    return val !== undefined && !val.startsWith('--') ? val : null
  }

  const integrationCommit = flag('--integration-commit')
  const baseVersion = flag('--base-version')
  const platform = flag('--platform')
  const arch = flag('--arch')
  const repoUrl = flag('--repo-url') ?? 'https://github.com/anomalyco/opencode.git'
  const workDir = flag('--work-dir') ?? path.join(process.cwd(), '.harness-build-work')
  const outDir = flag('--out-dir') ?? path.join(process.cwd(), '.harness-build-out')

  if (integrationCommit === null || baseVersion === null || platform === null || arch === null) {
    console.error('[build-platform] Missing required arguments.')
    console.error('  Required: --integration-commit, --base-version, --platform, --arch')
    printHelp()
    return null
  }

  return {integrationCommit, baseVersion, platform, arch, repoUrl, workDir, outDir}
}

function printHelp(): void {
  console.log(String.raw`
build-platform.ts — per-platform native build of the integrated OpenCode

Usage:
  bun run packages/harness/scripts/build-platform.ts \
    --integration-commit <sha>          Frozen integration commit SHA (from provenance manifest)
    --base-version <version>            Base release version (e.g. 1.15.13)
    --platform <linux|darwin>           Target OS (linux or darwin; no windows)
    --arch <x64|arm64>                  Target CPU arch
    [--repo-url <url>]                  Upstream repo URL (default: anomalyco/opencode)
    [--work-dir <path>]                 Working directory for the clone (default: .harness-build-work)
    [--out-dir <path>]                  Output directory for the native binary (default: .harness-build-out)
    [--help]                            Print this help

Build-environment contract:
  - Bun ${REQUIRED_BUN_VERSION} required (matches upstream packageManager).
  - Full upstream repo checked out at the frozen integration commit.
  - Build: OPENCODE_CHANNEL=${OPENCODE_CHANNEL} OPENCODE_VERSION=<base>+harness.<shortSha> bun run build -- --single
  - Built binary --version verified == OPENCODE_VERSION before emitting.
  - provenance.json written to packages/harness/ for the workflow assemble step.
  - Exits non-zero on any failure.
`)
}

// ---------------------------------------------------------------------------
// Bun version enforcement
// ---------------------------------------------------------------------------

function enforceBunVersion(): void {
  let actual: string
  try {
    const result = execFileSync('bun', ['--version'], {encoding: 'utf8', timeout: 10_000})
    actual = result.trim()
  } catch {
    console.error(`[build-platform] bun not found on PATH. Install bun@${REQUIRED_BUN_VERSION}`)
    process.exit(1)
  }

  if (actual !== REQUIRED_BUN_VERSION) {
    console.error(
      `[build-platform] Bun version mismatch: got ${actual}, required ${REQUIRED_BUN_VERSION}. ` +
        `Install the pinned version: curl -fsSL https://bun.sh/install | bash -s "bun-v${REQUIRED_BUN_VERSION}"`,
    )
    process.exit(1)
  }

  console.log(`[build-platform] Bun version ok: ${actual}`)
}

// ---------------------------------------------------------------------------
// Git operations
// ---------------------------------------------------------------------------

function gitExec(args: string[], cwd?: string): void {
  const result = spawnSync('git', args, {
    cwd,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`)
  }
}

function cloneAndCheckout(repoUrl: string, workDir: string, commit: string): void {
  const workDirExists = spawnSync('test', ['-d', workDir]).status === 0
  if (workDirExists) {
    console.log(`[build-platform] Work dir exists, fetching and resetting to ${commit}`)
    gitExec(['fetch', 'origin'], workDir)
    gitExec(['checkout', '--detach', commit], workDir)
    gitExec(['clean', '-fdx'], workDir)
  } else {
    console.log(`[build-platform] Cloning ${repoUrl} into ${workDir}`)
    gitExec(['clone', repoUrl, workDir])
    gitExec(['checkout', '--detach', commit], workDir)
  }
}

// ---------------------------------------------------------------------------
// Build invocation
// ---------------------------------------------------------------------------

function runUpstreamBuild(workDir: string, baseVersion: string, integrationCommit: string): void {
  const opencodeDir = path.join(workDir, 'packages', 'opencode')
  const opencodeVersion = buildHarnessVersion(baseVersion, integrationCommit)
  console.log(`[build-platform] Running upstream build in ${opencodeDir}`)
  console.log(`[build-platform] Env: OPENCODE_CHANNEL=${OPENCODE_CHANNEL} OPENCODE_VERSION=${opencodeVersion}`)

  // Install native deps first (mirrors upstream build.ts skipInstall=false path).
  // The upstream build.ts does this internally, but we invoke it via `bun run build -- --single`
  // which triggers the full build.ts including the bun install steps.
  const result = spawnSync('bun', ['run', 'build', '--', '--single'], {
    cwd: opencodeDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENCODE_CHANNEL,
      OPENCODE_VERSION: opencodeVersion,
    },
    timeout: 30 * 60 * 1000, // 30-minute hard timeout
  })

  if (result.status !== 0) {
    throw new Error(`Upstream build failed with exit code ${result.status ?? 'unknown'}`)
  }
}

// ---------------------------------------------------------------------------
// Binary resolution and version verification
// ---------------------------------------------------------------------------

function resolveBuiltBinaryPath(workDir: string, platform: string, arch: string): string {
  // Upstream build.ts emits to: packages/opencode/dist/opencode-<os>-<arch>/bin/opencode
  const name = `opencode-${platform}-${arch}`
  const binary = 'opencode'
  return path.join(workDir, 'packages', 'opencode', 'dist', name, 'bin', binary)
}

function verifyBuiltBinary(binaryPath: string, expectedVersion: string): void {
  console.log(`[build-platform] Verifying binary: ${binaryPath} --version`)

  const binaryExists = spawnSync('test', ['-f', binaryPath]).status === 0
  if (!binaryExists) {
    throw new Error(`Built binary not found at: ${binaryPath}`)
  }

  let actual: string
  try {
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    actual = output.trim()
  } catch (error) {
    throw new Error(`Binary --version failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (actual !== expectedVersion) {
    throw new Error(`Version mismatch: got '${actual}', expected '${expectedVersion}'`)
  }

  console.log(`[build-platform] Version ok: ${actual}`)
}

// ---------------------------------------------------------------------------
// Output emission
// ---------------------------------------------------------------------------

function emitBinary(binaryPath: string, outDir: string, platform: string, arch: string): string {
  mkdirSync(outDir, {recursive: true})
  const destName = `opencode-${platform}-${arch}`
  const destBinDir = path.join(outDir, destName, 'bin')
  mkdirSync(destBinDir, {recursive: true})
  const destPath = path.join(destBinDir, 'opencode')

  cpSync(binaryPath, destPath)

  // Ensure the binary is executable.
  const chmodResult = spawnSync('chmod', ['+x', destPath], {stdio: 'inherit'})
  if (chmodResult.status !== 0) {
    throw new Error(`chmod +x failed for ${destPath}`)
  }

  console.log(`[build-platform] Binary emitted: ${destPath}`)
  return destPath
}

// ---------------------------------------------------------------------------
// Provenance manifest emission
// ---------------------------------------------------------------------------

/**
 * Writes provenance.json to packages/harness/ so the workflow assemble step
 * can read it. This is the canonical provenance record for the build.
 *
 * The manifest records the integration commit, base version, and build SHA
 * so the runtime getProvenance() function can serve it to `harness info`.
 */
function emitProvenanceManifest(
  harnessPackageDir: string,
  baseVersion: string,
  integrationCommit: string,
  buildSha: string,
): void {
  const manifest = {
    baseVersion,
    integrationRefs: [], // populated by the integration engine; preserved here as empty for build-only runs
    integrationCommit,
    buildSha,
  }
  const manifestPath = path.join(harnessPackageDir, 'provenance.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[build-platform] provenance.json written: ${manifestPath}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  if (args === null) {
    process.exit(1)
  }

  const {integrationCommit, baseVersion, platform, arch, repoUrl, workDir, outDir} = args

  // Derive the harness package directory (two levels up from this script).
  const harnessPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  console.log(`[build-platform] Starting build`)
  console.log(`  integration commit: ${integrationCommit}`)
  console.log(`  base version:       ${baseVersion}`)
  console.log(`  platform:           ${platform}/${arch}`)
  console.log(`  repo:               ${repoUrl}`)
  console.log(`  work dir:           ${workDir}`)
  console.log(`  out dir:            ${outDir}`)

  // 1. Enforce Bun version (build-environment contract).
  enforceBunVersion()

  // 2. Clone/checkout the full upstream repo at the frozen integration commit.
  try {
    cloneAndCheckout(repoUrl, workDir, integrationCommit)
  } catch (error) {
    console.error(`[build-platform] Clone/checkout failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 3. Run upstream's real build (embedded-app + native-dep build).
  //    OPENCODE_VERSION embeds the integration commit short SHA for binary self-reporting.
  try {
    runUpstreamBuild(workDir, baseVersion, integrationCommit)
  } catch (error) {
    console.error(`[build-platform] Build failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 4. Verify the built binary --version == OPENCODE_VERSION (build-environment contract).
  const binaryPath = resolveBuiltBinaryPath(workDir, platform, arch)
  const expectedVersion = buildHarnessVersion(baseVersion, integrationCommit)
  try {
    verifyBuiltBinary(binaryPath, expectedVersion)
  } catch (error) {
    console.error(`[build-platform] Verification failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 5. Emit the binary to the output directory.
  try {
    emitBinary(binaryPath, outDir, platform, arch)
  } catch (error) {
    console.error(`[build-platform] Emit failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 6. Write provenance.json for the workflow assemble step.
  const buildSha = process.env.GITHUB_SHA ?? 'dev'
  try {
    emitProvenanceManifest(harnessPackageDir, baseVersion, integrationCommit, buildSha)
  } catch (error) {
    console.error(`[build-platform] Provenance emit failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  console.log(`[build-platform] Done. Binary ready at: ${outDir}/opencode-${platform}-${arch}/bin/opencode`)
}

await main()
