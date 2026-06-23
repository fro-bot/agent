/**
 * bin-shims.test.ts — structural and behavioural tests for the committed bin/ shims.
 *
 * Verifies:
 *   1. bin/harness.mjs and bin/postinstall.mjs exist as committed files.
 *   2. bin/harness.mjs exits non-zero with a clear error when dist/cli.mjs is absent.
 *   3. bin/postinstall.mjs exits 0 (non-fatal) when dist/postinstall.mjs is absent.
 *   4. bin/harness.mjs imports and runs dist/cli.mjs when present.
 *   5. bin/postinstall.mjs imports dist/postinstall.mjs when present.
 *
 * Tests run the REAL committed shim files (not inlined copies) so regressions in
 * path resolution, messages, or exit codes are caught.
 */

import {spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {afterAll, beforeAll, describe, expect, it} from 'vitest'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const binHarness = join(pkgRoot, 'bin', 'harness.mjs')
const binPostinstall = join(pkgRoot, 'bin', 'postinstall.mjs')

// #region structural

describe('bin shim files exist', () => {
  it('bin/harness.mjs is a committed file', () => {
    // #given / #when / #then
    expect(existsSync(binHarness)).toBe(true)
  })

  it('bin/postinstall.mjs is a committed file', () => {
    // #given / #when / #then
    expect(existsSync(binPostinstall)).toBe(true)
  })
})

// #endregion

// #region graceful-degrade (dist absent)
// Copies the REAL shim into a temp dir with no sibling dist/ so ../dist/cli.mjs is absent.

describe('bin/harness.mjs: graceful degrade when dist is absent', () => {
  let tempDir: string
  let tempBinHarness: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fro-bot-harness-'))
    const tempBin = join(tempDir, 'bin')
    mkdirSync(tempBin, {recursive: true})
    tempBinHarness = join(tempBin, 'harness.mjs')
    // #given — copy the REAL committed shim; no temp/dist/ created so ../dist/cli.mjs is absent
    copyFileSync(binHarness, tempBinHarness)
  })

  afterAll(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('exits non-zero and prints "not built" error when dist/cli.mjs is missing', () => {
    // #when
    const result = spawnSync(process.execPath, [tempBinHarness], {encoding: 'utf8'})

    // #then
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('@fro.bot/harness is not built')
    expect(result.stderr).toContain('pnpm --filter @fro.bot/harness build')
  })
})

describe('bin/postinstall.mjs: graceful degrade when dist is absent', () => {
  let tempDir: string
  let tempBinPostinstall: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fro-bot-harness-'))
    const tempBin = join(tempDir, 'bin')
    mkdirSync(tempBin, {recursive: true})
    tempBinPostinstall = join(tempBin, 'postinstall.mjs')
    // #given — copy the REAL committed shim; no temp/dist/ created so ../dist/postinstall.mjs is absent
    copyFileSync(binPostinstall, tempBinPostinstall)
  })

  afterAll(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('exits 0 and prints skip message when dist/postinstall.mjs is missing', () => {
    // #when
    const result = spawnSync(process.execPath, [tempBinPostinstall], {encoding: 'utf8'})

    // #then
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('[harness] dist not built yet; skipping postinstall')
  })
})

// #endregion

// #region present-branch (dist present)
// Copies the REAL shim into a temp dir WITH a synthetic dist/ containing a marker module.

describe('bin/harness.mjs: runs dist/cli.mjs when present', () => {
  let tempDir: string
  let tempBinHarness: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fro-bot-harness-'))
    const tempBin = join(tempDir, 'bin')
    const tempDist = join(tempDir, 'dist')
    mkdirSync(tempBin, {recursive: true})
    mkdirSync(tempDist, {recursive: true})
    tempBinHarness = join(tempBin, 'harness.mjs')
    // #given — copy the REAL committed shim and create a marker dist/cli.mjs
    copyFileSync(binHarness, tempBinHarness)
    writeFileSync(join(tempDist, 'cli.mjs'), "process.stdout.write('CLI_RAN\\n')\n")
  })

  afterAll(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('exits 0 and runs dist/cli.mjs when present', () => {
    // #when
    const result = spawnSync(process.execPath, [tempBinHarness], {encoding: 'utf8'})

    // #then
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('CLI_RAN')
  })
})

describe('bin/postinstall.mjs: runs dist/postinstall.mjs when present', () => {
  let tempDir: string
  let tempBinPostinstall: string

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'fro-bot-harness-'))
    const tempBin = join(tempDir, 'bin')
    const tempDist = join(tempDir, 'dist')
    mkdirSync(tempBin, {recursive: true})
    mkdirSync(tempDist, {recursive: true})
    tempBinPostinstall = join(tempBin, 'postinstall.mjs')
    // #given — copy the REAL committed shim and create a marker dist/postinstall.mjs
    copyFileSync(binPostinstall, tempBinPostinstall)
    writeFileSync(join(tempDist, 'postinstall.mjs'), "process.stdout.write('POSTINSTALL_RAN\\n')\n")
  })

  afterAll(() => {
    rmSync(tempDir, {recursive: true, force: true})
  })

  it('exits 0 and runs dist/postinstall.mjs when present', () => {
    // #when
    const result = spawnSync(process.execPath, [tempBinPostinstall], {encoding: 'utf8'})

    // #then
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('POSTINSTALL_RAN')
  })
})

// #endregion
