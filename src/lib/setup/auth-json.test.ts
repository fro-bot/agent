import type {AuthConfig, Logger} from './types.js'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createMockLogger} from '../test-helpers.js'
import {parseAuthJsonInput, populateAuthJson, verifyAuthJson} from './auth-json.js'

describe('parseAuthJsonInput', () => {
  // #given valid JSON input
  it('parses valid API auth config', () => {
    // #when
    const input = '{"anthropic": {"type": "api", "key": "sk-ant-123"}}'
    const result = parseAuthJsonInput(input)

    // #then
    expect('anthropic' in result).toBe(true)
    const anthropic = result.anthropic as {type: string; key: string}
    expect(anthropic.type).toBe('api')
    expect(anthropic.key).toBe('sk-ant-123')
  })

  it('parses valid OAuth auth config', () => {
    // #given
    const input = JSON.stringify({
      openai: {
        type: 'oauth',
        refresh: 'refresh-token',
        access: 'access-token',
        expires: 1234567890,
      },
    })

    // #when
    const result = parseAuthJsonInput(input)

    // #then
    expect('openai' in result).toBe(true)
    const openai = result.openai as {type: string}
    expect(openai.type).toBe('oauth')
  })

  it('parses multiple providers', () => {
    // #given
    const input = JSON.stringify({
      anthropic: {type: 'api', key: 'sk-ant-123'},
      openai: {type: 'api', key: 'sk-openai-456'},
    })

    // #when
    const result = parseAuthJsonInput(input)

    // #then
    expect(Object.keys(result)).toHaveLength(2)
    expect(result.anthropic).toBeDefined()
    expect(result.openai).toBeDefined()
  })

  // #given invalid input
  it('throws on invalid JSON syntax', () => {
    // #when / #then
    expect(() => parseAuthJsonInput('not valid json')).toThrow('Invalid auth-json format')
  })

  it('throws on non-object JSON (array)', () => {
    // #when / #then
    expect(() => parseAuthJsonInput('["anthropic"]')).toThrow('auth-json must be a JSON object')
  })

  it('throws on non-object JSON (string)', () => {
    // #when / #then
    expect(() => parseAuthJsonInput('"just a string"')).toThrow('auth-json must be a JSON object')
  })

  it('throws on null', () => {
    // #when / #then
    expect(() => parseAuthJsonInput('null')).toThrow('auth-json must be a JSON object')
  })

  it('allows empty object', () => {
    // #when
    const result = parseAuthJsonInput('{}')

    // #then
    expect(Object.keys(result)).toHaveLength(0)
  })
})

describe('populateAuthJson', () => {
  let tempDir: string
  let logger: Logger

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-json-test-'))
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('writes auth.json to specified path', async () => {
    // #given
    const authConfig: AuthConfig = {
      anthropic: {type: 'api', key: 'sk-ant-test'},
    }

    // #when
    const authPath = await populateAuthJson(authConfig, tempDir, logger)

    // #then
    expect(authPath).toBe(path.join(tempDir, 'auth.json'))
    const content = await fs.readFile(authPath, 'utf8')
    const parsed = JSON.parse(content) as Record<string, {type: string}>
    expect(parsed.anthropic?.type).toBe('api')
  })

  it('creates parent directories if they do not exist', async () => {
    // #given
    const nestedDir = path.join(tempDir, 'nested', 'opencode')
    const authConfig: AuthConfig = {
      openai: {type: 'api', key: 'sk-test'},
    }

    // #when
    const authPath = await populateAuthJson(authConfig, nestedDir, logger)

    // #then
    expect(authPath).toBe(path.join(nestedDir, 'auth.json'))
    const stat = await fs.stat(authPath)
    expect(stat.isFile()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('sets restrictive file permissions (0600)', async () => {
    // #given
    const authConfig: AuthConfig = {
      anthropic: {type: 'api', key: 'secret-key'},
    }

    // #when
    const authPath = await populateAuthJson(authConfig, tempDir, logger)

    // #then
    const stat = await fs.stat(authPath)
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('writes pretty-printed JSON', async () => {
    // #given
    const authConfig: AuthConfig = {
      anthropic: {type: 'api', key: 'sk-ant-test'},
    }

    // #when
    await populateAuthJson(authConfig, tempDir, logger)

    // #then
    const content = await fs.readFile(path.join(tempDir, 'auth.json'), 'utf8')
    expect(content).toContain('\n') // Pretty printed has newlines
    expect(content).toContain('  ') // Pretty printed has indentation
  })

  it('overwrites existing auth.json', async () => {
    // #given - existing file
    const authPath = path.join(tempDir, 'auth.json')
    await fs.writeFile(authPath, '{"old": "data"}')

    const authConfig: AuthConfig = {
      anthropic: {type: 'api', key: 'new-key'},
    }

    // #when
    await populateAuthJson(authConfig, tempDir, logger)

    // #then
    const content = await fs.readFile(authPath, 'utf8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    expect('anthropic' in parsed).toBe(true)
    expect('old' in parsed).toBe(false)
  })
})

describe('verifyAuthJson', () => {
  let tempDir: string
  let logger: Logger

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-auth-test-'))
    logger = createMockLogger()
  })

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true})
  })

  it('returns true when auth.json exists and is readable', async () => {
    // #given auth.json file exists
    const authPath = path.join(tempDir, 'auth.json')
    await fs.writeFile(authPath, '{"anthropic": {"type": "api", "key": "test"}}')

    // #when verifying
    const result = await verifyAuthJson(authPath, logger)

    // #then returns true
    expect(result).toBe(true)
  })

  it('returns false when auth.json does not exist', async () => {
    // #given non-existent path
    const authPath = path.join(tempDir, 'nonexistent', 'auth.json')

    // #when verifying
    const result = await verifyAuthJson(authPath, logger)

    // #then returns false
    expect(result).toBe(false)
  })

  it('returns true for empty auth.json file', async () => {
    // #given empty but existing file
    const authPath = path.join(tempDir, 'auth.json')
    await fs.writeFile(authPath, '{}')

    // #when verifying
    const result = await verifyAuthJson(authPath, logger)

    // #then returns true (file exists and is readable)
    expect(result).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('returns false when auth.json is not readable', async () => {
    // #given file with no read permissions
    const authPath = path.join(tempDir, 'auth.json')
    await fs.writeFile(authPath, '{"test": "data"}')
    await fs.chmod(authPath, 0o000)

    // #when verifying
    const result = await verifyAuthJson(authPath, logger)

    // #then returns false
    expect(result).toBe(false)

    // cleanup: restore permissions for deletion
    await fs.chmod(authPath, 0o600)
  })
})
