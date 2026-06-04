import {describe, expect, it} from 'vitest'
import {binaryPathInPackage, getHostPlatformInfo, getPlatformInfo} from './platform.js'

// ---------------------------------------------------------------------------
// getPlatformInfo — supported matrix
// ---------------------------------------------------------------------------

describe('getPlatformInfo', () => {
  it('linux/x64 → @fro.bot/harness-linux-x64', () => {
    // #given / #when
    const result = getPlatformInfo('linux', 'x64')

    // #then
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.info.os).toBe('linux')
    expect(result.info.arch).toBe('x64')
    expect(result.info.packageName).toBe('@fro.bot/harness-linux-x64')
    expect(result.info.binaryName).toBe('opencode')
  })

  it('linux/arm64 → @fro.bot/harness-linux-arm64', () => {
    // #given / #when
    const result = getPlatformInfo('linux', 'arm64')

    // #then
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.info.packageName).toBe('@fro.bot/harness-linux-arm64')
    expect(result.info.binaryName).toBe('opencode')
  })

  it('darwin/x64 → @fro.bot/harness-darwin-x64', () => {
    // #given / #when
    const result = getPlatformInfo('darwin', 'x64')

    // #then
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.info.packageName).toBe('@fro.bot/harness-darwin-x64')
    expect(result.info.binaryName).toBe('opencode')
  })

  it('darwin/arm64 → @fro.bot/harness-darwin-arm64', () => {
    // #given / #when
    const result = getPlatformInfo('darwin', 'arm64')

    // #then
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.info.packageName).toBe('@fro.bot/harness-darwin-arm64')
    expect(result.info.binaryName).toBe('opencode')
  })

  // ---------------------------------------------------------------------------
  // Unsupported platforms — return {ok: false} (no throw)
  // ---------------------------------------------------------------------------

  it('win32/x64 → {ok: false} with error message', () => {
    // #given / #when
    const result = getPlatformInfo('win32', 'x64')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected not ok')
    expect(result.error).toContain('win32')
    expect(result.error).toContain('x64')
  })

  it('win32/arm64 → {ok: false}', () => {
    // #given / #when / #then
    expect(getPlatformInfo('win32', 'arm64').ok).toBe(false)
  })

  it('linux/ia32 → {ok: false}', () => {
    // #given / #when / #then
    expect(getPlatformInfo('linux', 'ia32').ok).toBe(false)
  })

  it('freebsd/x64 → {ok: false}', () => {
    // #given / #when / #then
    expect(getPlatformInfo('freebsd', 'x64').ok).toBe(false)
  })

  it('unsupported platform error message includes os and arch', () => {
    // #given / #when
    const result = getPlatformInfo('win32', 'x64')

    // #then
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected not ok')
    expect(result.error).toContain('win32')
    expect(result.error).toContain('x64')
  })
})

// ---------------------------------------------------------------------------
// getHostPlatformInfo — smoke test (host must be in the supported matrix in CI)
// ---------------------------------------------------------------------------

const isHostSupported =
  (process.platform === 'linux' || process.platform === 'darwin') &&
  (process.arch === 'x64' || process.arch === 'arm64')

describe('getHostPlatformInfo', () => {
  // Skip on unsupported platforms (e.g. windows dev machine) — no conditional expects.
  it.skipIf(!isHostSupported)('returns a valid PlatformInfo for the current host (linux or darwin)', () => {
    // #given / #when
    const result = getHostPlatformInfo()

    // #then
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.info.os).toBe(process.platform)
    expect(result.info.arch).toBe(process.arch)
    expect(result.info.packageName).toMatch(/^@fro\.bot\/harness-(linux|darwin)-(x64|arm64)$/)
    expect(result.info.binaryName).toBe('opencode')
  })

  it.skipIf(isHostSupported)('returns {ok: false} on unsupported host platform', () => {
    // #given / #when
    const result = getHostPlatformInfo()

    // #then
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// binaryPathInPackage
// ---------------------------------------------------------------------------

describe('binaryPathInPackage', () => {
  it('constructs the expected binary path', () => {
    // #given
    const result = getPlatformInfo('linux', 'x64')
    if (!result.ok) throw new Error('expected ok')

    // #when
    const binaryPath = binaryPathInPackage('/home/runner/.npm/@fro.bot/harness-linux-x64', result.info)

    // #then
    expect(binaryPath).toBe('/home/runner/.npm/@fro.bot/harness-linux-x64/bin/opencode')
  })

  it('darwin/arm64 binary path', () => {
    // #given
    const result = getPlatformInfo('darwin', 'arm64')
    if (!result.ok) throw new Error('expected ok')

    // #when
    const binaryPath = binaryPathInPackage('/usr/local/lib/node_modules/@fro.bot/harness-darwin-arm64', result.info)

    // #then
    expect(binaryPath).toBe('/usr/local/lib/node_modules/@fro.bot/harness-darwin-arm64/bin/opencode')
  })
})
