import type {GatewayConfig} from './config.js'

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {loadGatewayConfig, readOptionalSecret, readSecret} from './config.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  // #given save and isolate process.env
  savedEnv = {...process.env}
  // Clear all relevant env vars so tests start clean
  for (const key of [
    'DISCORD_TOKEN',
    'DISCORD_TOKEN_FILE',
    'DISCORD_APPLICATION_ID',
    'DISCORD_APPLICATION_ID_FILE',
    'DISCORD_GUILD_ID',
    'DISCORD_GUILD_ID_FILE',
    'S3_BUCKET',
    'S3_BUCKET_FILE',
    'S3_REGION',
    'S3_REGION_FILE',
    'S3_ENDPOINT',
    'S3_PREFIX',
    'S3_SSE',
    'GATEWAY_IDENTITY',
    'LOG_LEVEL',
    'TOKEN',
    'TOKEN_FILE',
    'MISSING',
    'MISSING_FILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_ACCESS_KEY_ID_FILE',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY_FILE',
    'AWS_SESSION_TOKEN',
    'AWS_SESSION_TOKEN_FILE',
  ]) {
    delete process.env[key]
  }
  tmpDir = mkdtempSync(join(tmpdir(), 'gateway-config-test-'))
})

afterEach(() => {
  // Restore original env
  process.env = savedEnv
  // Clean up temp dir
  rmSync(tmpDir, {recursive: true, force: true})
})

// ---------------------------------------------------------------------------
// readSecret
// ---------------------------------------------------------------------------

describe('readSecret', () => {
  it('reads from TOKEN_FILE when that file exists', () => {
    // #given a temp file with a secret value
    const secretFile = join(tmpDir, 'token.txt')
    writeFileSync(secretFile, 'file-secret-value')
    process.env.TOKEN_FILE = secretFile

    // #when
    const result = readSecret('TOKEN')

    // #then
    expect(result).toBe('file-secret-value')
  })

  it('falls back to process.env.TOKEN when TOKEN_FILE is unset', () => {
    // #given only the env var is set
    process.env.TOKEN = 'env-secret-value'

    // #when
    const result = readSecret('TOKEN')

    // #then
    expect(result).toBe('env-secret-value')
  })

  it('trims trailing newlines and whitespace from file contents', () => {
    // #given a file with trailing whitespace
    const secretFile = join(tmpDir, 'token-ws.txt')
    writeFileSync(secretFile, 'trimmed-value\n  \n')
    process.env.TOKEN_FILE = secretFile

    // #when
    const result = readSecret('TOKEN')

    // #then
    expect(result).toBe('trimmed-value')
  })

  it('throws with a clear message when neither variant is set', () => {
    // #given nothing is set for TOKEN

    // #when / #then
    expect(() => readSecret('TOKEN')).toThrow(
      'Missing required secret: TOKEN (set TOKEN env var or TOKEN_FILE pointing to a file)',
    )
  })

  it('prefers file content over env var when both are set', () => {
    // #given both TOKEN_FILE and TOKEN are set
    const secretFile = join(tmpDir, 'token-both.txt')
    writeFileSync(secretFile, 'from-file')
    process.env.TOKEN_FILE = secretFile
    process.env.TOKEN = 'from-env'

    // #when
    const result = readSecret('TOKEN')

    // #then file takes precedence
    expect(result).toBe('from-file')
  })

  it('falls through to process.env.TOKEN when TOKEN_FILE points to a non-existent file', () => {
    // #given TOKEN_FILE points to a missing path, TOKEN is set
    process.env.TOKEN_FILE = join(tmpDir, 'does-not-exist.txt')
    process.env.TOKEN = 'fallback-env-value'

    // #when
    const result = readSecret('TOKEN')

    // #then falls through to env var
    expect(result).toBe('fallback-env-value')
  })
})

// ---------------------------------------------------------------------------
// readOptionalSecret
// ---------------------------------------------------------------------------

describe('readOptionalSecret', () => {
  it('returns null when neither variant is set', () => {
    // #given nothing set for MISSING

    // #when
    const result = readOptionalSecret('MISSING')

    // #then
    expect(result).toBeNull()
  })

  it('returns file content when MISSING_FILE is set and file exists', () => {
    // #given
    const secretFile = join(tmpDir, 'optional.txt')
    writeFileSync(secretFile, 'optional-value')
    process.env.MISSING_FILE = secretFile

    // #when
    const result = readOptionalSecret('MISSING')

    // #then
    expect(result).toBe('optional-value')
  })

  it('returns null when MISSING_FILE points to an empty file', () => {
    // #given an empty file — e.g. `touch deploy/secrets/discord-guild-id` for global registration
    const secretFile = join(tmpDir, 'empty.txt')
    writeFileSync(secretFile, '')
    process.env.MISSING_FILE = secretFile

    // #when
    const result = readOptionalSecret('MISSING')

    // #then empty file is treated as "not set"
    expect(result).toBeNull()
  })

  it('returns null when MISSING_FILE points to a whitespace-only file', () => {
    // #given a file containing only whitespace/newlines
    const secretFile = join(tmpDir, 'whitespace.txt')
    writeFileSync(secretFile, '  \n  \n')
    process.env.MISSING_FILE = secretFile

    // #when
    const result = readOptionalSecret('MISSING')

    // #then whitespace-only is treated as "not set"
    expect(result).toBeNull()
  })

  it('returns null when env var is set to an empty string', () => {
    process.env.EMPTY_ENV_VAR = ''
    expect(readOptionalSecret('EMPTY_ENV_VAR')).toBeNull()
    delete process.env.EMPTY_ENV_VAR
  })

  it('returns null when env var is set to whitespace only', () => {
    process.env.WS_ENV_VAR = '   '
    expect(readOptionalSecret('WS_ENV_VAR')).toBeNull()
    delete process.env.WS_ENV_VAR
  })

  it('preserves leading whitespace in file contents', () => {
    // Some operators may legitimately have secrets with leading whitespace
    // (e.g. tokens copied from a UI that quoted with leading padding).
    // The env-var path preserves it via process.env[name]; the file-backed
    // path must too, for consistency.
    const secretFile = join(tmpDir, 'leading-ws.txt')
    writeFileSync(secretFile, '  some-value\n')
    process.env.MISSING_FILE = secretFile

    // #when
    const result = readOptionalSecret('MISSING')

    // #then leading whitespace is preserved, trailing newline stripped
    expect(result).toBe('  some-value')
  })
})

// ---------------------------------------------------------------------------
// loadGatewayConfig
// ---------------------------------------------------------------------------

function setRequiredEnv(): void {
  process.env.DISCORD_TOKEN = 'test-token'
  process.env.DISCORD_APPLICATION_ID = 'test-app-id'
  process.env.S3_BUCKET = 'test-bucket'
  process.env.S3_REGION = 'us-east-1'
}

describe('loadGatewayConfig', () => {
  it('returns valid config when all required env vars are set', () => {
    // #given
    setRequiredEnv()

    // #when
    const config: GatewayConfig = loadGatewayConfig()

    // #then
    expect(config.discordToken).toBe('test-token')
    expect(config.discordApplicationId).toBe('test-app-id')
    expect(config.discordGuildId).toBeNull()
    expect(config.objectStore.bucket).toBe('test-bucket')
    expect(config.objectStore.region).toBe('us-east-1')
    expect(config.objectStore.enabled).toBe(true)
  })

  it('uses default identity "discord-gateway" when GATEWAY_IDENTITY is unset', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.identity).toBe('discord-gateway')
  })

  it('uses provided GATEWAY_IDENTITY when set', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_IDENTITY = 'my-custom-gateway'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.identity).toBe('my-custom-gateway')
  })

  it('uses default log level "info" when LOG_LEVEL is unset', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.logLevel).toBe('info')
  })

  it('uses default S3 prefix "fro-bot-state" when S3_PREFIX is unset', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.objectStore.prefix).toBe('fro-bot-state')
  })

  it('throws with a clear message when DISCORD_TOKEN is missing', () => {
    // #given only partial env
    process.env.DISCORD_APPLICATION_ID = 'test-app-id'
    process.env.S3_BUCKET = 'test-bucket'
    process.env.S3_REGION = 'us-east-1'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Missing required secret: DISCORD_TOKEN')
  })

  it('throws with a clear message when S3_BUCKET is missing', () => {
    // #given
    process.env.DISCORD_TOKEN = 'test-token'
    process.env.DISCORD_APPLICATION_ID = 'test-app-id'
    process.env.S3_REGION = 'us-east-1'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Missing required secret: S3_BUCKET')
  })

  it('throws with a clear message for invalid LOG_LEVEL', () => {
    // #given
    setRequiredEnv()
    process.env.LOG_LEVEL = 'verbose'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Invalid LOG_LEVEL value: "verbose" (valid values: debug, info, warn, error)',
    )
  })

  it('includes DISCORD_GUILD_ID when set', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_GUILD_ID = '123456789'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.discordGuildId).toBe('123456789')
  })

  it('includes S3_ENDPOINT in objectStore when set', () => {
    // #given
    setRequiredEnv()
    process.env.S3_ENDPOINT = 'https://my-minio.example.com'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.objectStore.endpoint).toBe('https://my-minio.example.com')
  })

  it('omits S3_ENDPOINT from objectStore when not set', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.objectStore.endpoint).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AWS credentials
// ---------------------------------------------------------------------------

describe('AWS credentials', () => {
  it('happy path: both credentials set, no session token', () => {
    // #given
    setRequiredEnv()
    const keyFile = join(tmpDir, 'aws-key-id.txt')
    const secretFile = join(tmpDir, 'aws-secret.txt')
    writeFileSync(keyFile, 'AKIAIOSFODNN7EXAMPLE')
    writeFileSync(secretFile, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    process.env.AWS_ACCESS_KEY_ID_FILE = keyFile
    process.env.AWS_SECRET_ACCESS_KEY_FILE = secretFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.objectStore.credentials).toEqual({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    })
    expect(config.objectStore.credentials).not.toHaveProperty('sessionToken')
  })

  it('happy path: all three credentials set', () => {
    // #given
    setRequiredEnv()
    const keyFile = join(tmpDir, 'aws-key-id.txt')
    const secretFile = join(tmpDir, 'aws-secret.txt')
    const tokenFile = join(tmpDir, 'aws-session-token.txt')
    writeFileSync(keyFile, 'AKIAIOSFODNN7EXAMPLE')
    writeFileSync(secretFile, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    writeFileSync(tokenFile, 'AQoXnyc4lcK4w4OIaHPuTZat//SESSION_TOKEN')
    process.env.AWS_ACCESS_KEY_ID_FILE = keyFile
    process.env.AWS_SECRET_ACCESS_KEY_FILE = secretFile
    process.env.AWS_SESSION_TOKEN_FILE = tokenFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.objectStore.credentials).toEqual({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'AQoXnyc4lcK4w4OIaHPuTZat//SESSION_TOKEN',
    })
  })

  it('happy path: no credentials set — credentials is undefined', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.objectStore.credentials).toBeUndefined()
  })

  it('edge case: empty credential files treated as not set — credentials is undefined', () => {
    // #given
    setRequiredEnv()
    const keyFile = join(tmpDir, 'aws-key-id-empty.txt')
    const secretFile = join(tmpDir, 'aws-secret-empty.txt')
    writeFileSync(keyFile, '')
    writeFileSync(secretFile, '')
    process.env.AWS_ACCESS_KEY_ID_FILE = keyFile
    process.env.AWS_SECRET_ACCESS_KEY_FILE = secretFile

    // #when
    const config = loadGatewayConfig()

    // #then — empty files are treated as "not set" by readOptionalSecret
    expect(config.objectStore.credentials).toBeUndefined()
  })

  it('edge case: pair present + empty session-token file — sessionToken omitted', () => {
    // #given
    setRequiredEnv()
    const keyFile = join(tmpDir, 'aws-key-id.txt')
    const secretFile = join(tmpDir, 'aws-secret.txt')
    const tokenFile = join(tmpDir, 'aws-session-token-empty.txt')
    writeFileSync(keyFile, 'AKIAIOSFODNN7EXAMPLE')
    writeFileSync(secretFile, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    writeFileSync(tokenFile, '')
    process.env.AWS_ACCESS_KEY_ID_FILE = keyFile
    process.env.AWS_SECRET_ACCESS_KEY_FILE = secretFile
    process.env.AWS_SESSION_TOKEN_FILE = tokenFile

    // #when
    const config = loadGatewayConfig()

    // #then — empty session token file is treated as "not set"
    expect(config.objectStore.credentials).toEqual({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    })
    expect(config.objectStore.credentials).not.toHaveProperty('sessionToken')
  })

  it('error path: only AWS_ACCESS_KEY_ID set — throws with pair error message', () => {
    // #given
    setRequiredEnv()
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: AWS_ACCESS_KEY_ID)',
    )
  })

  it('error path: only AWS_SECRET_ACCESS_KEY set — throws with pair error message', () => {
    // #given
    setRequiredEnv()
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (received: AWS_SECRET_ACCESS_KEY)',
    )
  })

  it('edge case: orphan session token — no throw, credentials undefined, warning logged', () => {
    // #given
    setRequiredEnv()
    process.env.AWS_SESSION_TOKEN = 'AQoXnyc4lcK4w4OIaHPuTZat//SESSION_TOKEN'
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    // #when
    const config = loadGatewayConfig()

    // #then — assert before restoring spy so mock.calls is still populated
    expect(config.objectStore.credentials).toBeUndefined()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    const loggedArg: unknown = consoleSpy.mock.calls[0]?.[0]
    expect(typeof loggedArg).toBe('string')
    const parsed: unknown = JSON.parse(loggedArg as string)
    expect(parsed).toMatchObject({
      level: 'info',
      msg: expect.stringContaining(
        'AWS_SESSION_TOKEN is set without AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY',
      ) as unknown,
    })
    consoleSpy.mockRestore()
  })
})
