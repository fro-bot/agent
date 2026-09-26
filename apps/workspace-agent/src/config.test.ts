/**
 * Tests for config.ts — readReadyTimeoutMs parser.
 *
 * Covers: absent/empty → default 60000 (fail-soft),
 *         valid positive integer → parsed value,
 *         invalid (non-numeric, zero, negative) → throws (fail-fast).
 */

import {describe, expect, it} from 'vitest'
import {readReadyTimeoutMs, readUpdateNetworkConfig} from './config.js'

describe('readReadyTimeoutMs', () => {
  describe('absent / empty → fail-soft default', () => {
    it('returns 60000 when the variable is absent', () => {
      // #given
      const env: NodeJS.ProcessEnv = {}

      // #when
      const result = readReadyTimeoutMs(env)

      // #then
      expect(result).toBe(60_000)
    })

    it('returns 60000 when the variable is undefined', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: undefined}

      // #when
      const result = readReadyTimeoutMs(env)

      // #then
      expect(result).toBe(60_000)
    })

    it('returns 60000 when the variable is an empty string', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: ''}

      // #when
      const result = readReadyTimeoutMs(env)

      // #then
      expect(result).toBe(60_000)
    })
  })

  describe('valid positive integer → parsed value', () => {
    it('parses 90000 correctly', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '90000'}

      // #when
      const result = readReadyTimeoutMs(env)

      // #then
      expect(result).toBe(90_000)
    })

    it('parses the minimum valid value (1)', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '1'}

      // #when
      const result = readReadyTimeoutMs(env)

      // #then
      expect(result).toBe(1)
    })

    it('parses a large value (300000)', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '300000'}

      // #when
      const result = readReadyTimeoutMs(env)

      // #then
      expect(result).toBe(300_000)
    })
  })

  describe('invalid value → fail-fast throw', () => {
    it('throws on non-numeric string "abc"', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: 'abc'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('throws on zero', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '0'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('throws on negative value "-5"', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '-5'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('throws on negative value "-1"', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '-1'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('throws on float "1.5"', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '1.5'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('throws on whitespace-only value', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '   '}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('throws on "Infinity"', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: 'Infinity'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
    })

    it('error message names the variable and describes the constraint', () => {
      // #given
      const env: NodeJS.ProcessEnv = {WORKSPACE_OPENCODE_READY_TIMEOUT_MS: 'bad'}

      // #when / #then
      expect(() => readReadyTimeoutMs(env)).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS.*positive integer/i)
    })
  })
})

describe('readUpdateNetworkConfig (A1)', () => {
  it('returns an empty config when no proxy or CA-bundle env vars are set', () => {
    // #given
    const env: NodeJS.ProcessEnv = {}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result).toEqual({})
  })

  it('reads proxy.https from HTTPS_PROXY', () => {
    // #given
    const env: NodeJS.ProcessEnv = {HTTPS_PROXY: 'http://mitmproxy:8080'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result).toEqual({proxy: {https: 'http://mitmproxy:8080'}})
  })

  it('falls back to lowercase https_proxy when HTTPS_PROXY is absent', () => {
    // #given
    const env: NodeJS.ProcessEnv = {https_proxy: 'http://mitmproxy:8080'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result).toEqual({proxy: {https: 'http://mitmproxy:8080'}})
  })

  it('prefers uppercase HTTPS_PROXY over lowercase https_proxy when both are set', () => {
    // #given
    const env: NodeJS.ProcessEnv = {HTTPS_PROXY: 'http://upper:8080', https_proxy: 'http://lower:8080'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result.proxy?.https).toBe('http://upper:8080')
  })

  it('includes noProxy from NO_PROXY only alongside an https value', () => {
    // #given
    const env: NodeJS.ProcessEnv = {HTTPS_PROXY: 'http://mitmproxy:8080', NO_PROXY: '10.0.0.0/8'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result).toEqual({proxy: {https: 'http://mitmproxy:8080', noProxy: '10.0.0.0/8'}})
  })

  it('falls back to lowercase no_proxy when NO_PROXY is absent', () => {
    // #given
    const env: NodeJS.ProcessEnv = {HTTPS_PROXY: 'http://mitmproxy:8080', no_proxy: '10.0.0.0/8'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result.proxy?.noProxy).toBe('10.0.0.0/8')
  })

  it('ignores NO_PROXY entirely when no https proxy is configured (never produces a bare noProxy)', () => {
    // #given
    const env: NodeJS.ProcessEnv = {NO_PROXY: '10.0.0.0/8'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result.proxy).toBeUndefined()
  })

  it('treats an empty-string HTTPS_PROXY as absent, not as an empty proxy URL', () => {
    // #given
    const env: NodeJS.ProcessEnv = {HTTPS_PROXY: ''}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result.proxy).toBeUndefined()
  })

  it('reads caBundlePath from GIT_SSL_CAINFO', () => {
    // #given
    const env: NodeJS.ProcessEnv = {GIT_SSL_CAINFO: '/etc/ssl/certs/mitmproxy-ca.pem'}

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result).toEqual({caBundlePath: '/etc/ssl/certs/mitmproxy-ca.pem'})
  })

  it('reads both caBundlePath and proxy together, independently', () => {
    // #given
    const env: NodeJS.ProcessEnv = {
      GIT_SSL_CAINFO: '/etc/ssl/certs/mitmproxy-ca.pem',
      HTTPS_PROXY: 'http://mitmproxy:8080',
    }

    // #when
    const result = readUpdateNetworkConfig(env)

    // #then
    expect(result).toEqual({
      caBundlePath: '/etc/ssl/certs/mitmproxy-ca.pem',
      proxy: {https: 'http://mitmproxy:8080'},
    })
  })

  it('defaults to process.env when no env argument is given', () => {
    // #given — no env passed at all; must not throw and must reflect whatever the real process.env holds
    // #when / #then
    expect(() => readUpdateNetworkConfig()).not.toThrow()
  })
})
