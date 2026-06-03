import {describe, expect, it} from 'vitest'
import {binaryPathInPackage, getHostPlatformInfo, getPlatformInfo, UnsupportedPlatformError} from './platform.js'

// ---------------------------------------------------------------------------
// getPlatformInfo — supported matrix
// ---------------------------------------------------------------------------

describe('getPlatformInfo', () => {
  it('linux/x64 → @fro.bot/harness-linux-x64', () => {
    // #given / #when
    const info = getPlatformInfo('linux', 'x64')

    // #then
    expect(info.os).toBe('linux')
    expect(info.arch).toBe('x64')
    expect(info.packageName).toBe('@fro.bot/harness-linux-x64')
    expect(info.binaryName).toBe('opencode')
  })

  it('linux/arm64 → @fro.bot/harness-linux-arm64', () => {
    // #given / #when
    const info = getPlatformInfo('linux', 'arm64')

    // #then
    expect(info.packageName).toBe('@fro.bot/harness-linux-arm64')
    expect(info.binaryName).toBe('opencode')
  })

  it('darwin/x64 → @fro.bot/harness-darwin-x64', () => {
    // #given / #when
    const info = getPlatformInfo('darwin', 'x64')

    // #then
    expect(info.packageName).toBe('@fro.bot/harness-darwin-x64')
    expect(info.binaryName).toBe('opencode')
  })

  it('darwin/arm64 → @fro.bot/harness-darwin-arm64', () => {
    // #given / #when
    const info = getPlatformInfo('darwin', 'arm64')

    // #then
    expect(info.packageName).toBe('@fro.bot/harness-darwin-arm64')
    expect(info.binaryName).toBe('opencode')
  })

  // ---------------------------------------------------------------------------
  // Unsupported platforms
  // ---------------------------------------------------------------------------

  it('win32/x64 → UnsupportedPlatformError', () => {
    // #given / #when / #then
    expect(() => getPlatformInfo('win32', 'x64')).toThrow(UnsupportedPlatformError)
  })

  it('win32/arm64 → UnsupportedPlatformError', () => {
    // #given / #when / #then
    expect(() => getPlatformInfo('win32', 'arm64')).toThrow(UnsupportedPlatformError)
  })

  it('linux/ia32 → UnsupportedPlatformError', () => {
    // #given / #when / #then
    expect(() => getPlatformInfo('linux', 'ia32')).toThrow(UnsupportedPlatformError)
  })

  it('freebsd/x64 → UnsupportedPlatformError', () => {
    // #given / #when / #then
    expect(() => getPlatformInfo('freebsd', 'x64')).toThrow(UnsupportedPlatformError)
  })

  it('unsupportedPlatformError message includes os and arch', () => {
    // #given / #when / #then — use toThrow with a matcher to avoid conditional expects
    expect(() => getPlatformInfo('win32', 'x64')).toThrow('win32')
    expect(() => getPlatformInfo('win32', 'x64')).toThrow('x64')
    expect(() => getPlatformInfo('win32', 'x64')).toThrow(UnsupportedPlatformError)
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
    const info = getHostPlatformInfo()

    // #then
    expect(info.os).toBe(process.platform)
    expect(info.arch).toBe(process.arch)
    expect(info.packageName).toMatch(/^@fro\.bot\/harness-(linux|darwin)-(x64|arm64)$/)
    expect(info.binaryName).toBe('opencode')
  })
})

// ---------------------------------------------------------------------------
// binaryPathInPackage
// ---------------------------------------------------------------------------

describe('binaryPathInPackage', () => {
  it('constructs the expected binary path', () => {
    // #given
    const info = getPlatformInfo('linux', 'x64')

    // #when
    const result = binaryPathInPackage('/home/runner/.npm/@fro.bot/harness-linux-x64', info)

    // #then
    expect(result).toBe('/home/runner/.npm/@fro.bot/harness-linux-x64/bin/opencode')
  })

  it('darwin/arm64 binary path', () => {
    // #given
    const info = getPlatformInfo('darwin', 'arm64')

    // #when
    const result = binaryPathInPackage('/usr/local/lib/node_modules/@fro.bot/harness-darwin-arm64', info)

    // #then
    expect(result).toBe('/usr/local/lib/node_modules/@fro.bot/harness-darwin-arm64/bin/opencode')
  })
})
