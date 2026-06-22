#!/usr/bin/env node

// Build orchestration wrapper for the action dist bundle.
//
// Order of operations:
//   1. PREFLIGHT: collect third-party license notices (fail-closed, before tsdown
//      mutates dist/). If this fails, exit non-zero immediately — the committed
//      dist/THIRD_PARTY_NOTICES.txt is left untouched.
//   2. BUNDLE: run the action tsdown build (tsc --noEmit + tsdown). Capture exit
//      status; do not short-circuit on failure.
//   3. ESCAPE (in finally): run the hidden-unicode escape over dist/ regardless
//      of whether the bundle succeeded, so partial dist from a failed bundle is
//      still escaped. Re-propagate the bundle's exit code.
//   4. On bundle success: write the precomputed notice to dist/THIRD_PARTY_NOTICES.txt
//      atomically (temp file + rename). On failure: leave the committed notice intact.
//
// Run via: node --experimental-strip-types scripts/build-action-dist.ts
//
// This file uses .ts imports because it runs directly under Node's
// --experimental-strip-types. The test file uses .js imports for Vitest.

import {execFile} from 'node:child_process'
import {existsSync} from 'node:fs'
import {rename, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {escapeDistHiddenUnicode} from './dist-hidden-unicode.ts'
import {collectThirdPartyNotices} from './third-party-notices.ts'

const execFileAsync = promisify(execFile)

// Repo root resolved from this script's location (scripts/ is one level below root).
// fileURLToPath decodes percent-encoding (e.g. spaces) so path.join works correctly.
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DIST_DIR = join(REPO_ROOT, 'dist')

interface StepResult {
  readonly exitCode: number
}

interface OrchestratorSteps {
  preflight: () => Promise<string>
  bundle: () => Promise<StepResult>
  escape: () => Promise<void>
  writeNotice: (content: string) => Promise<void>
}

/**
 * Pure orchestration function — injectable steps for testability.
 *
 * Returns the exit code the process should use:
 * - 0 on full success (preflight + bundle + escape + notice write all succeeded)
 * - non-zero on any failure, preserving the bundle's exit code when it fails
 */
export async function runBuildOrchestration(steps: OrchestratorSteps): Promise<number> {
  // Step 1: Preflight — collect notices before tsdown touches dist/
  let noticeContent: string
  try {
    noticeContent = await steps.preflight()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] preflight failed: ${message}\n`)
    if (error instanceof Error && error.cause instanceof Error) {
      process.stderr.write(`[build-action-dist] cause: ${error.cause.message}\n`)
    }
    return 1
  }

  // Step 2: Bundle — run tsdown build, capture exit status
  let bundleResult: StepResult
  try {
    bundleResult = await steps.bundle()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] bundle step threw unexpectedly: ${message}\n`)
    bundleResult = {exitCode: 1}
  }

  // Step 3: Escape — always run, even if bundle failed (finally semantics)
  try {
    await steps.escape()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] escape step failed: ${message}\n`)
    // If bundle also failed, preserve its exit code; otherwise surface escape failure
    if (bundleResult.exitCode === 0) {
      return 1
    }
  }

  // Step 4: On bundle success, write the notice atomically
  if (bundleResult.exitCode !== 0) {
    process.stderr.write(`[build-action-dist] bundle failed with exit code ${bundleResult.exitCode}\n`)
    return bundleResult.exitCode
  }

  try {
    await steps.writeNotice(noticeContent)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`[build-action-dist] failed to write THIRD_PARTY_NOTICES.txt: ${message}\n`)
    return 1
  }

  return 0
}

async function runBundle(): Promise<StepResult> {
  try {
    // Mirror apps/action/package.json build: tsc --noEmit then tsdown.
    // REPO_ROOT is resolved from this script's location, not from process.cwd().
    await execFileAsync('pnpm', ['exec', 'tsc', '--noEmit'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    await execFileAsync('pnpm', ['exec', 'tsdown', '-c', 'tsdown.config.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return {exitCode: 0}
  } catch (error) {
    const exitCode =
      error != null && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : 1
    const stderr =
      error != null && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : ''
    if (stderr === '') {
      process.stderr.write(
        `[build-action-dist] bundle spawn failed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    } else {
      process.stderr.write(stderr)
    }
    return {exitCode}
  }
}

async function runEscape(): Promise<void> {
  if (!existsSync(DIST_DIR)) {
    console.log('[build-action-dist] dist/ does not exist — bundle failed before emitting output, skipping escape')
    return
  }
  const results = await escapeDistHiddenUnicode(DIST_DIR)
  if (results.length === 0) {
    console.log('[build-action-dist] dist/ is clean — no hidden Unicode found')
    return
  }
  for (const {file, replacements} of results) {
    console.log(`[build-action-dist] scrubbed ${replacements} char(s) in ${file}`)
  }
  console.log(`[build-action-dist] escape done — ${results.length} file(s) modified`)
}

async function writeNoticeAtomic(content: string): Promise<void> {
  // Stage the temp file inside dist/ so the rename stays on the same filesystem
  // (a cross-device rename from the OS tmpdir fails with EXDEV on some CI mounts).
  const tmpFile = join(DIST_DIR, `.THIRD_PARTY_NOTICES_${Date.now()}.tmp`)
  try {
    await writeFile(tmpFile, content, 'utf8')
    await rename(tmpFile, join(DIST_DIR, 'THIRD_PARTY_NOTICES.txt'))
  } catch (error) {
    // Clean up the temp file so it doesn't leak into dist/ or pollute git status.
    await unlink(tmpFile).catch(() => undefined)
    throw error
  }
  console.log('[build-action-dist] wrote dist/THIRD_PARTY_NOTICES.txt')
}

async function main(): Promise<void> {
  const packageJsonPath = join(REPO_ROOT, 'package.json')
  const exitCode = await runBuildOrchestration({
    preflight: async () => collectThirdPartyNotices(packageJsonPath),
    bundle: runBundle,
    escape: runEscape,
    writeNotice: writeNoticeAtomic,
  })

  process.exitCode = exitCode
}

try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`[build-action-dist] fatal: ${message}\n`)
  process.exitCode = 1
}
