/**
 * Tests for config.ts — readReadyTimeoutMs parser.
 *
 * Covers: absent/empty → default 60000 (fail-soft),
 *         valid positive integer → parsed value,
 *         invalid (non-numeric, zero, negative) → throws (fail-fast).
 */

import {describe, expect, it} from 'vitest'
import {readReadyTimeoutMs} from './config.js'

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
