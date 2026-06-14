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
 *   - Bun version is pinned to match upstream's packageManager (see HARNESS_BUN_VERSION).
 *   - The full upstream repo is checked out at the frozen integration commit.
 *   - Native-dep install + embedded-app build happen under the UPSTREAM repo root.
 *   - Build runs with:
 *       OPENCODE_CHANNEL=latest
 *       OPENCODE_VERSION=<baseVersion>+harness.<integrationCommit[0..7]>
 *     The version string embeds the integration commit short SHA so the binary
 *     self-reports it. The upstream build bakes OPENCODE_VERSION into the binary
 *     via the `define: { OPENCODE_VERSION: ... }` field in build.ts.
 *   - Built binary --version is verified == OPENCODE_VERSION before emitting (glibc targets only;
 *     musl targets skip execution — cannot run musl binary on glibc runner — and rely on
 *     assertMuslBinary() file-based linkage check instead).
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
import {cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {HARNESS_BUN_VERSION as REQUIRED_BUN_VERSION} from '../src/bun-version.js'
import {buildHarnessVersion} from '../src/version.js'

// ---------------------------------------------------------------------------
// Type guard utilities
// ---------------------------------------------------------------------------

/**
 * Type-safe error code check — no `as` assertion.
 * After `typeof e === 'object' && e !== null && 'code' in e`, TypeScript narrows
 * `e` to `object & Record<'code', unknown>`, making `e.code` accessible.
 */
function hasErrorCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === code
}

// ---------------------------------------------------------------------------
// Build-environment contract constants
// ---------------------------------------------------------------------------

/** The release channel used for the build identity env. */
const OPENCODE_CHANNEL = 'latest'

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export interface BuildArgs {
  readonly integrationCommit: string
  readonly baseVersion: string
  readonly platform: string
  readonly arch: string
  readonly repoUrl: string
  readonly workDir: string
  readonly outDir: string
  readonly sourceTree: string | null
  /** musl ABI variant — when set to 'musl', selects the musl target in build.ts */
  readonly abi: 'musl' | null
  /** When true, selects the baseline (avx2=false) target variant */
  readonly baseline: boolean
}

export function parseArgs(argv: string[]): BuildArgs | null {
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

  // FIX 4: Track --source-tree PRESENCE separately from value.
  // If --source-tree is present but has no value (or next token is another flag),
  // fail-closed rather than silently falling back to clone.
  const sourceTreePresent = args.includes('--source-tree')
  const sourceTreeValue = flag('--source-tree')
  if (sourceTreePresent && sourceTreeValue === null) {
    console.error('[build-platform] --source-tree requires a value')
    return null
  }
  const sourceTree = sourceTreeValue

  // --abi: optional, only 'musl' is accepted (additive; glibc is the default when absent).
  // Presence-without-value check: if --abi is in args but flag() returned null, the value is missing.
  const abiPresent = args.includes('--abi')
  const abiRaw = flag('--abi')
  if (abiPresent && (abiRaw === null || abiRaw === '')) {
    console.error('[build-platform] --abi requires a value: --abi musl')
    console.error('Run with --help for usage.')
    return null
  }
  if (abiRaw !== null && abiRaw !== 'musl') {
    console.error(`[build-platform] --abi '${abiRaw}' is not supported. Only 'musl' is accepted.`)
    return null
  }
  const abi = abiRaw === 'musl' ? 'musl' : null

  // --baseline: optional boolean flag (presence = true).
  const baseline = args.includes('--baseline')

  if (integrationCommit === null || baseVersion === null || platform === null || arch === null) {
    console.error('[build-platform] Missing required arguments.')
    console.error('  Required: --integration-commit, --base-version, --platform, --arch')
    printHelp()
    return null
  }

  // Cross-validation: --baseline and --abi musl are linux-only; --baseline is x64-only.
  if ((baseline || abi !== null) && platform !== 'linux') {
    console.error(
      `[build-platform] --baseline and --abi musl are only supported for --platform linux (got: ${platform}).`,
    )
    return null
  }
  if (baseline && arch !== 'x64') {
    console.error(`[build-platform] --baseline is only supported for --arch x64 (got: ${arch}).`)
    return null
  }

  return {integrationCommit, baseVersion, platform, arch, repoUrl, workDir, outDir, sourceTree, abi, baseline}
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
    [--abi musl]                        ABI variant (only 'musl' accepted; omit for glibc default)
    [--baseline]                        Select the baseline (avx2=false) target variant
    [--repo-url <url>]                  Upstream repo URL (default: anomalyco/opencode)
    [--work-dir <path>]                 Working directory for the clone (default: .harness-build-work)
    [--out-dir <path>]                  Output directory for the native binary (default: .harness-build-out)
    [--source-tree <path>]              Pre-extracted merged source tree (bypasses clone; fail-closed if missing/empty)
    [--help]                            Print this help

Build-environment contract:
  - Bun ${REQUIRED_BUN_VERSION} required (matches upstream packageManager).
  - Full upstream repo checked out at the frozen integration commit.
  - Build: OPENCODE_CHANNEL=${OPENCODE_CHANNEL} OPENCODE_VERSION=<base>+harness.<shortSha> bun run build -- --single
  - Built binary --version verified == OPENCODE_VERSION before emitting.
  - provenance.json written to packages/harness/ for the workflow assemble step.
  - Exits non-zero on any failure.

Musl/baseline variants:
  - --abi musl --baseline: selects linux-x64-baseline-musl (avx2=false, musl)
  - --abi musl (no --baseline): selects linux-arm64-musl (arm64, musl)
  - No flags: selects the default glibc target for the current platform/arch (unchanged behavior).
  - The build.ts singleFlag filter is patched in-place in the source tree to honor
    OPENCODE_TARGET_ABI / OPENCODE_TARGET_BASELINE env vars before invoking build.ts.
`)
}

// ---------------------------------------------------------------------------
// Bun version enforcement
// ---------------------------------------------------------------------------

export function enforceBunVersion(): void {
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

export function cloneAndCheckout(repoUrl: string, workDir: string, commit: string): void {
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
// Target-name helpers
// ---------------------------------------------------------------------------

/**
 * Computes the dist dir suffix that upstream build.ts appends for musl/baseline variants.
 *
 * Upstream build.ts `name` computation (lines 146-155):
 *   [pkg.name, os, arch, avx2===false ? 'baseline' : undefined, abi ?? undefined].filter(Boolean).join('-')
 *
 * So for our targets:
 *   linux/x64 + baseline + musl → opencode-linux-x64-baseline-musl
 *   linux/arm64 + musl (no baseline) → opencode-linux-arm64-musl
 *   linux/x64 (glibc, no baseline) → opencode-linux-x64  (unchanged)
 *
 * Returns the suffix string to append after `opencode-<os>-<arch>`, e.g. '-baseline-musl'.
 * Returns '' for the default glibc target.
 */
export function resolveTargetDirSuffix(abi: 'musl' | null, baseline: boolean): string {
  const parts: string[] = []
  if (baseline) parts.push('baseline')
  if (abi !== null) parts.push(abi)
  return parts.length > 0 ? `-${parts.join('-')}` : ''
}

/**
 * Patches the upstream build.ts singleFlag filter in-place to honor
 * OPENCODE_TARGET_ABI and OPENCODE_TARGET_BASELINE env vars for explicit target selection.
 *
 * The patch replaces the ENTIRE baseline+abi+return-true block (lines 122-133 in upstream
 * build.ts) with a single coherent block that:
 *   - When OPENCODE_TARGET_ABI is set: selects ONLY the target matching {abi, baseline},
 *     rejecting the default glibc target (no abi) AND wrong baseline variants.
 *   - When OPENCODE_TARGET_ABI is NOT set: preserves original behavior exactly.
 *
 * This fixes two bugs in the prior patch:
 *   1. The baseline gate (avx2===false → return baselineFlag) was hit BEFORE the abi gate,
 *      so a baseline-musl target was rejected at line 124 before reaching the patched abi block.
 *   2. The default glibc target (no abi, no avx2) was not suppressed when an explicit musl
 *      target was requested, causing the glibc linux-x64 binary to build instead.
 *
 * The patch hook string is: `OPENCODE_TARGET_ABI` — used by the patch-landed guard to assert
 * the patch landed before building.
 *
 * @param buildTsPath - Absolute path to the integration-tree build.ts to patch.
 */
// ---------------------------------------------------------------------------
// Patch constants — exported for test deduplication
// ---------------------------------------------------------------------------

/**
 * The exact baseline+abi+return-true block from upstream build.ts (lines 122-133).
 * Verified against anomalyco/opencode v1.17.3's singleFlag filter block.
 * Must be re-diffed if clonedeps is bumped to a new upstream version.
 *
 * @see .slim/clonedeps/repos/anomalyco__opencode/packages/opencode/script/build.ts
 */
export const TARGET_ORIGINAL = `      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true`

/**
 * The replacement block: when OPENCODE_TARGET_ABI is set, drives the ENTIRE selection from the
 * explicit target spec — honoring both the baseline gate (avx2===false) and the abi gate,
 * AND suppressing the default glibc target (no abi) so only the requested {abi, baseline}
 * target survives. When OPENCODE_TARGET_ABI is NOT set, original behavior is preserved.
 * OPENCODE_TARGET_ABI
 */
export const TARGET_REPLACEMENT = `      // When building for the current platform, prefer a single native binary by default.
      // Baseline binaries require additional Bun artifacts and can be flaky to download.
      // OPENCODE_TARGET_ABI: when set, the harness selects the explicit {abi, baseline} target.
      // This hook is injected by the harness build-platform.ts for musl/baseline targets.
      const _harnessTargetAbi = process.env["OPENCODE_TARGET_ABI"]
      const _harnessTargetBaseline = process.env["OPENCODE_TARGET_BASELINE"] === "true"
      if (_harnessTargetAbi !== undefined) {
        // Explicit target mode: select ONLY the target matching {abi, baseline}.
        // Reject the default glibc target (no abi) — it would otherwise build instead of musl.
        if (item.abi !== _harnessTargetAbi) {
          return false
        }
        // Honor the baseline flag: avx2===false means baseline; must match OPENCODE_TARGET_BASELINE.
        if ((item.avx2 === false) !== _harnessTargetBaseline) {
          return false
        }
        return true
      }

      // Original behavior (no explicit target): prefer a single native binary by default.
      if (item.avx2 === false) {
        return baselineFlag
      }

      // also skip abi-specific builds for the same reason
      if (item.abi !== undefined) {
        return false
      }

      return true`

export function patchBuildTs(buildTsPath: string): void {
  console.log(`[build-platform] Patching build.ts for explicit target selection: ${buildTsPath}`)

  const original = readFileSync(buildTsPath, 'utf8')

  if (!original.includes(TARGET_ORIGINAL)) {
    throw new Error(
      `[build-platform] build.ts patch target not found — upstream build.ts shape may have changed. ` +
        `Expected to find the singleFlag baseline+abi+return-true block. Refusing to build with an unpatched build.ts.`,
    )
  }

  const patched = original.replace(TARGET_ORIGINAL, TARGET_REPLACEMENT)
  writeFileSync(buildTsPath, patched, 'utf8')
  console.log(`[build-platform] build.ts patched successfully.`)
}
/**
 * Guard: asserts the patch hook landed in the patched build.ts.
 * Throws if the hook string is absent — meaning the patch silently failed.
 */
export function assertPatchLanded(buildTsPath: string): void {
  const content = readFileSync(buildTsPath, 'utf8')
  // The hook comment is the canonical marker — present iff the patch succeeded.
  const HOOK_MARKER = 'OPENCODE_TARGET_ABI'
  if (!content.includes(HOOK_MARKER)) {
    throw new Error(
      `[build-platform] Guard: patch hook '${HOOK_MARKER}' not found in ${buildTsPath} after patching. ` +
        `The patch did not land. Refusing to build.`,
    )
  }
  console.log(`[build-platform] Guard: patch hook confirmed in build.ts.`)
}

/**
 * Guard: asserts the emitted binary is actually a musl binary (not glibc).
 * Uses `file` to inspect the binary's ELF interpreter / linkage.
 *
 * Positive assertions (all must pass):
 *   - Output contains 'ELF' (not a text file, wrong format, or corrupt binary).
 *   - Output contains the expected architecture string:
 *       x64   → 'x86-64'
 *       arm64 → 'aarch64'
 *   - Output contains 'statically linked' OR 'musl' (Bun musl builds are statically linked).
 *
 * Negative assertion (must NOT be present):
 *   - glibc dynamic linker patterns (ld-linux-*.so) → throws if found.
 *
 * Throws on any assertion failure.
 */
export function assertMuslBinary(binaryPath: string, arch: 'x64' | 'arm64'): void {
  console.log(`[build-platform] Asserting musl linkage for ${binaryPath} (arch: ${arch})`)

  let fileOutput: string
  try {
    fileOutput = execFileSync('file', [binaryPath], {encoding: 'utf8', timeout: 10_000}).trim()
  } catch (error) {
    throw new Error(
      `[build-platform] 'file' command failed on ${binaryPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  console.log(`[build-platform] file output: ${fileOutput}`)

  // Positive assertion 1: must be an ELF binary.
  if (!fileOutput.includes('ELF')) {
    throw new Error(
      `[build-platform] Binary at ${binaryPath} is not an ELF binary (file output: '${fileOutput}'). ` +
        `Expected an ELF executable for a musl target.`,
    )
  }

  // Positive assertion 2: must match the expected architecture.
  const archString = arch === 'x64' ? 'x86-64' : 'aarch64'
  if (!fileOutput.includes(archString)) {
    throw new Error(
      `[build-platform] Binary at ${binaryPath} does not match expected architecture '${archString}' ` +
        `(arch: ${arch}, file output: '${fileOutput}'). Architecture mismatch.`,
    )
  }

  // Negative assertion: glibc binaries reference the glibc dynamic linker (ld-linux-*.so).
  // Check this before the "statically linked or musl" positive check so glibc binaries
  // get a clear, specific error message rather than the generic "not musl-linked" message.
  const glibcPatterns = [/ld-linux-x86-64\.so/, /ld-linux-aarch64\.so/, /ld-linux\.so/, /interpreter \/lib.*ld-linux/]
  for (const pattern of glibcPatterns) {
    if (pattern.test(fileOutput)) {
      throw new Error(
        `[build-platform] Binary at ${binaryPath} appears to be glibc-linked (file output: '${fileOutput}'). ` +
          `A musl target was requested but the binary is not musl. ` +
          `This means the build.ts patch did not correctly select the musl target.`,
      )
    }
  }

  // Positive assertion 3: must be statically linked, static-pie linked, or reference musl.
  // Bun musl compile targets produce statically linked binaries. Some `file` versions report
  // static-PIE musl binaries as "static-pie linked" rather than "statically linked".
  if (
    !fileOutput.includes('statically linked') &&
    !fileOutput.includes('static-pie linked') &&
    !fileOutput.includes('musl')
  ) {
    throw new Error(
      `[build-platform] Binary at ${binaryPath} is neither statically linked nor musl-linked ` +
        `(file output: '${fileOutput}'). A musl target was requested but the binary does not show musl linkage.`,
    )
  }

  console.log(
    `[build-platform] Musl linkage verified (ELF, ${archString}, statically linked / musl, no glibc interpreter).`,
  )
}

// ---------------------------------------------------------------------------
// Build invocation
// ---------------------------------------------------------------------------

export function runUpstreamBuild(
  workDir: string,
  baseVersion: string,
  integrationCommit: string,
  abi: 'musl' | null,
  baseline: boolean,
): void {
  const opencodeVersion = buildHarnessVersion(baseVersion, integrationCommit)
  console.log(`[build-platform] Running upstream build in ${workDir}`)
  console.log(`[build-platform] Env: OPENCODE_CHANNEL=${OPENCODE_CHANNEL} OPENCODE_VERSION=${opencodeVersion}`)

  // Root workspace install — mirrors upstream's setup-bun action which runs `bun install`
  // at the repo root before invoking build.ts. Hoisted linker is used ONLY on Windows
  // (matching upstream's setup-bun action); Linux/macOS use a plain install.
  // This wires workspace symlinks (e.g. @opencode-ai/script) into node_modules so
  // packages/opencode/script/build.ts can resolve them at module load time.
  // The --single build below compiles just this platform's binary.
  console.log(`[build-platform] Installing workspace dependencies (bun install) in ${workDir}`)
  // The win32 branch is intentionally inert for this repo's linux/darwin-only matrix;
  // it exists to faithfully mirror upstream's setup-bun action behavior on Windows.
  const installArgs = process.platform === 'win32' ? ['install', '--linker', 'hoisted'] : ['install']
  const installResult = spawnSync('bun', installArgs, {
    cwd: workDir,
    stdio: 'inherit',
    env: {...process.env},
    timeout: 20 * 60 * 1000, // 20-minute hard timeout
  })

  if (installResult.status !== 0) {
    throw new Error(`Workspace install failed with exit code ${installResult.status ?? 'unknown'}`)
  }

  // For musl/baseline targets, patch the upstream build.ts singleFlag filter to honor
  // OPENCODE_TARGET_ABI / OPENCODE_TARGET_BASELINE env vars.
  // Build-time mutation of the checked-out source tree only — no credentials/push/OIDC.
  // The patch is applied in-place to the source tree before invoking build.ts.
  const buildTsPath = path.join(workDir, 'packages', 'opencode', 'script', 'build.ts')
  const buildEnv: Record<string, string> = {
    ...process.env,
    OPENCODE_CHANNEL,
    OPENCODE_VERSION: opencodeVersion,
  }

  if (abi !== null || baseline) {
    // Apply the ephemeral patch to the integration-tree build.ts.
    patchBuildTs(buildTsPath)
    // Guard: assert the patch hook landed before building.
    assertPatchLanded(buildTsPath)

    // Set env vars that the patched singleFlag filter reads to select the target.
    if (abi !== null) {
      buildEnv.OPENCODE_TARGET_ABI = abi
    }
    if (baseline) {
      buildEnv.OPENCODE_TARGET_BASELINE = 'true'
    }
    console.log(`[build-platform] Musl/baseline target selected: abi=${abi ?? 'none'} baseline=${String(baseline)}`)
  }

  const result = spawnSync('bun', ['./packages/opencode/script/build.ts', '--single'], {
    cwd: workDir, // NOTE: workDir (repo root) — build.ts does its own process.chdir to packages/opencode
    stdio: 'inherit',
    env: buildEnv,
    timeout: 30 * 60 * 1000, // 30-minute hard timeout
  })

  if (result.status !== 0) {
    throw new Error(`Upstream build failed with exit code ${result.status ?? 'unknown'}`)
  }
}

// ---------------------------------------------------------------------------
// Binary resolution and version verification
// ---------------------------------------------------------------------------

function resolveBuiltBinaryPath(
  workDir: string,
  platform: string,
  arch: string,
  abi: 'musl' | null,
  baseline: boolean,
): string {
  // Upstream build.ts emits to: packages/opencode/dist/opencode-<os>-<arch>[suffix]/bin/opencode
  // The suffix matches the `name` computation in build.ts (lines 146-155):
  //   [pkg.name, os, arch, avx2===false ? 'baseline' : undefined, abi ?? undefined].filter(Boolean).join('-')
  const suffix = resolveTargetDirSuffix(abi, baseline)
  const name = `opencode-${platform}-${arch}${suffix}`
  const binary = 'opencode'
  return path.join(workDir, 'packages', 'opencode', 'dist', name, 'bin', binary)
}

export function verifyBuiltBinary(binaryPath: string, expectedVersion: string, abi: 'musl' | null): void {
  console.log(`[build-platform] Verifying binary: ${binaryPath} --version`)

  const binaryExists = spawnSync('test', ['-f', binaryPath]).status === 0
  if (!binaryExists) {
    throw new Error(`Built binary not found at: ${binaryPath}`)
  }

  if (abi === 'musl') {
    // musl binaries cannot execute on a glibc runner (posix_spawn ENOENT — no compatible loader).
    // Upstream build.ts guards its own smoke test the same way (build.ts:201-202):
    //   if (item.os === process.platform && item.arch === process.arch && !item.abi)
    // Skip --version execution for musl targets; correctness is proven by:
    //   (a) binary exists (checked above), and
    //   (b) assertMuslBinary() (file-based libc check) which runs immediately after this call.
    // The version string is baked at compile time via OPENCODE_VERSION define — we trust the build.
    console.log(
      `[build-platform] Skipping --version execution for musl target (cannot run musl binary on glibc runner). ` +
        `Existence confirmed; musl linkage will be verified by assertMuslBinary().`,
    )
    return
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

function emitBinary(
  binaryPath: string,
  outDir: string,
  platform: string,
  arch: string,
  abi: 'musl' | null,
  baseline: boolean,
): string {
  mkdirSync(outDir, {recursive: true})
  // The emitted out-dir name matches the upstream dist dir name so the release workflow
  // and workspace Dockerfile can find the asset by its canonical name.
  const suffix = resolveTargetDirSuffix(abi, baseline)
  const destName = `opencode-${platform}-${arch}${suffix}`
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

export async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  if (args === null) {
    process.exit(1)
  }

  const {integrationCommit, baseVersion, platform, arch, repoUrl, workDir, outDir, sourceTree, abi, baseline} = args

  // Derive the harness package directory (two levels up from this script).
  const harnessPackageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

  console.log(`[build-platform] Starting build`)
  console.log(`  integration commit: ${integrationCommit}`)
  console.log(`  base version:       ${baseVersion}`)
  console.log(`  platform:           ${platform}/${arch}`)
  console.log(`  abi:                ${abi ?? 'glibc (default)'}`)
  console.log(`  baseline:           ${String(baseline)}`)
  if (sourceTree === null) {
    console.log(`  repo:               ${repoUrl}`)
    console.log(`  work dir:           ${workDir}`)
  } else {
    console.log(`  source tree:        ${sourceTree} (artifact-extract mode; clone bypassed)`)
  }
  console.log(`  out dir:            ${outDir}`)

  // 1. Enforce Bun version (build-environment contract).
  enforceBunVersion()

  // 2. Resolve the source directory: either a pre-extracted merged source tree
  //    (--source-tree mode, used by the CI artifact-handoff path) or a fresh
  //    clone/checkout of the upstream repo (standalone/local path).
  let buildSourceDir: string
  if (sourceTree === null) {
    // Standalone/local mode: clone or reuse the upstream repo at the frozen commit.
    try {
      cloneAndCheckout(repoUrl, workDir, integrationCommit)
    } catch (error) {
      console.error(`[build-platform] Clone/checkout failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    buildSourceDir = workDir
  } else {
    // Artifact-extract mode: fail CLOSED if the supplied dir is missing or empty.
    // Never silently fall back to cloning — a missing/empty source tree means the
    // artifact handoff failed and we must not build from an unknown source.
    let entries: string[]
    try {
      const stat = statSync(sourceTree)
      if (!stat.isDirectory()) {
        console.error(`[build-platform] --source-tree '${sourceTree}' exists but is not a directory.`)
        process.exit(1)
      }
      entries = readdirSync(sourceTree)
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        console.error(`[build-platform] --source-tree '${sourceTree}' does not exist. Refusing to fall back to clone.`)
      } else {
        console.error(
          `[build-platform] --source-tree '${sourceTree}' could not be read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      process.exit(1)
    }
    if (entries.length === 0) {
      console.error(`[build-platform] --source-tree '${sourceTree}' is empty. Refusing to fall back to clone.`)
      process.exit(1)
    }
    console.log(`[build-platform] Using pre-extracted source tree: ${sourceTree} (${entries.length} entries)`)
    buildSourceDir = sourceTree
  }

  // 3. Run upstream's real build (embedded-app + native-dep build).
  //    OPENCODE_VERSION embeds the integration commit short SHA for binary self-reporting.
  //    Version derivation is pure-from-arg (buildHarnessVersion uses --integration-commit
  //    directly; no git rev-parse is invoked — works with no .git present).
  //    For musl/baseline targets, runUpstreamBuild patches build.ts in-place and sets
  //    OPENCODE_TARGET_ABI / OPENCODE_TARGET_BASELINE env vars before invoking build.ts.
  try {
    runUpstreamBuild(buildSourceDir, baseVersion, integrationCommit, abi, baseline)
  } catch (error) {
    console.error(`[build-platform] Build failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 4. Verify the built binary --version == OPENCODE_VERSION (build-environment contract).
  const binaryPath = resolveBuiltBinaryPath(buildSourceDir, platform, arch, abi, baseline)
  const expectedVersion = buildHarnessVersion(baseVersion, integrationCommit)
  try {
    verifyBuiltBinary(binaryPath, expectedVersion, abi)
  } catch (error) {
    console.error(`[build-platform] Verification failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  // 4a. Musl linkage guard: for musl targets, assert the emitted binary is actually musl (not glibc).
  //     This runs in the real publish path (not only dry-run) because the LLM-merge
  //     integration commit differs per run, making a green dry-run non-authoritative.
  if (abi === 'musl') {
    const typedArch = arch === 'x64' || arch === 'arm64' ? arch : null
    if (typedArch === null) {
      console.error(`[build-platform] Musl linkage guard: unsupported arch '${arch}' for musl assertion.`)
      process.exit(1)
    }
    try {
      assertMuslBinary(binaryPath, typedArch)
    } catch (error) {
      console.error(
        `[build-platform] Musl linkage guard failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  }

  // 5. Emit the binary to the output directory.
  const suffix = resolveTargetDirSuffix(abi, baseline)
  try {
    emitBinary(binaryPath, outDir, platform, arch, abi, baseline)
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

  console.log(`[build-platform] Done. Binary ready at: ${outDir}/opencode-${platform}-${arch}${suffix}/bin/opencode`)
}

// Only run when executed directly (not when imported by tests or other modules).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
