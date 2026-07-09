import type {GatewayConfig} from './config.js'

import {Buffer} from 'node:buffer'
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {GatewayIntentBits} from 'discord.js'
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
    'DISCORD_PRIVILEGED_INTENTS',
    'DISCORD_PRIVILEGED_INTENTS_FILE',
    'GITHUB_APP_ID',
    'GITHUB_APP_ID_FILE',
    'GITHUB_APP_PRIVATE_KEY',
    'GITHUB_APP_PRIVATE_KEY_FILE',
    'GATEWAY_GITHUB_APP_INSTALL_URL',
    'GATEWAY_WEBHOOK_SECRET',
    'GATEWAY_WEBHOOK_SECRET_FILE',
    'GATEWAY_PRESENCE_CHANNEL_ID',
    'GATEWAY_PRESENCE_CHANNEL_ID_FILE',
    'GATEWAY_HTTP_PORT',
    'WORKSPACE_AGENT_URL',
    'WORKSPACE_OPENCODE_URL',
    'WORKSPACE_OPENCODE_TOKEN',
    'WORKSPACE_OPENCODE_TOKEN_FILE',
    'GATEWAY_TRIGGER_ROLE_ID',
    'GATEWAY_MAX_CONCURRENT_RUNS',
    'GATEWAY_RUN_TIMEOUT_MS',
    'GATEWAY_RUN_INACTIVITY_TIMEOUT_MS',
    'GATEWAY_APPROVAL_MODE',
    'GATEWAY_APPROVAL_MODE_FILE',
    'GATEWAY_STATUS_MODE',
    'GATEWAY_STATUS_MODE_FILE',
    'GATEWAY_PERSONA',
    'GATEWAY_PERSONA_FILE',
    'GATEWAY_OPERATOR_BIND_HOST',
    'GATEWAY_OPERATOR_BIND_PORT',
    'GATEWAY_OPERATOR_PUBLIC_ORIGIN',
    'GATEWAY_OPERATOR_GITHUB_CLIENT_ID',
    'GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET',
    'GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS',
    'GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS',
    'GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS',
    'GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE',
    'GATEWAY_OPERATOR_CSRF_SECRET',
    'GATEWAY_OPERATOR_CSRF_SECRET_FILE',
    'GATEWAY_OPERATOR_ALLOWLIST',
    'GATEWAY_OPERATOR_ALLOWLIST_FILE',
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

  it('throws with a clear message when _FILE points to a directory', () => {
    // #given a temp directory (simulates a Docker bind-mount where the host path doesn't exist,
    // causing Docker to create a directory at the container mount point instead of a file)
    const dirPath = mkdtempSync(join(tmpDir, 'fake-dir-secret-'))
    process.env.FAKE_DIR_FILE = dirPath

    // #when / #then
    expect(() => readOptionalSecret('FAKE_DIR')).toThrow('not a regular file')
    expect(() => readOptionalSecret('FAKE_DIR')).toThrow('directory')

    delete process.env.FAKE_DIR_FILE
  })

  // readOptionalSecret uses readSecretFile which lstat-checks before reading — ENOENT falls
  // through to the env-var fallback; all other non-regular-file types throw immediately.

  it('throws with a clear message when secret file contains embedded newline mid-value', () => {
    // #given a file with an embedded newline (copy-paste from a wrapped terminal)
    const secretFile = join(tmpDir, 'embedded-newline.txt')
    writeFileSync(secretFile, 'AKIA\nIOSFODNN7EXAMPLE')
    process.env.MISSING_FILE = secretFile

    // #when / #then
    expect(() => readOptionalSecret('MISSING')).toThrow(secretFile)
    expect(() => readOptionalSecret('MISSING')).toThrow('contains embedded line-breaking characters')

    delete process.env.MISSING_FILE
  })

  it('throws with a clear message when env var contains embedded newline mid-value', () => {
    // #given an env var with an embedded newline (copy-paste with line-wrapping)
    process.env.NEWLINE_SECRET = 'AKIA\nIOSFODNN7EXAMPLE'

    // #when / #then
    expect(() => readOptionalSecret('NEWLINE_SECRET')).toThrow('NEWLINE_SECRET')
    expect(() => readOptionalSecret('NEWLINE_SECRET')).toThrow('contains embedded line-breaking characters')

    delete process.env.NEWLINE_SECRET
  })

  it('rejects env var with Unicode next-line character (U+0085)', () => {
    // #given an env var with U+0085 (NEL) — line-breaking character not in basic [\r\n]
    process.env.NEL_SECRET = 'AKIA\u0085IOSFODNN7EXAMPLE'

    // #when / #then
    expect(() => readOptionalSecret('NEL_SECRET')).toThrow('NEL_SECRET')
    expect(() => readOptionalSecret('NEL_SECRET')).toThrow('contains embedded line-breaking characters')

    delete process.env.NEL_SECRET
  })

  it('rejects secret file with embedded carriage return (U+000D)', () => {
    // #given a file with U+000D (\r) — single CR without LF
    const secretFile = join(tmpDir, 'cr.txt')
    writeFileSync(secretFile, 'AKIA\rIOSFODNN7EXAMPLE')
    process.env.CR_SECRET_FILE = secretFile

    // #when / #then
    expect(() => readOptionalSecret('CR_SECRET')).toThrow('contains embedded line-breaking characters')

    delete process.env.CR_SECRET_FILE
  })

  it('rejects secret file with Unicode line separator (U+2028)', () => {
    // #given a file with U+2028 — a character that bypasses the trivial [\r\n] check
    const secretFile = join(tmpDir, 'u2028.txt')
    writeFileSync(secretFile, 'AKIA\u2028IOSFODNN7EXAMPLE')
    process.env.U2028_SECRET_FILE = secretFile

    // #when / #then
    expect(() => readOptionalSecret('U2028_SECRET')).toThrow('contains embedded line-breaking characters')

    delete process.env.U2028_SECRET_FILE
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
// readOptionalSecret — path validation (hardened readSecretFile)
// ---------------------------------------------------------------------------

describe('readOptionalSecret — path validation', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'gateway-secret-test-'))
  })

  afterEach(() => {
    rmSync(testDir, {recursive: true, force: true})
    delete process.env.PATH_TEST_FILE
    delete process.env.PATH_TEST
  })

  it('rejects symlink to another file (does not follow)', () => {
    // #given a symlink to a real file
    const realFile = join(testDir, 'real.txt')
    const symlinkPath = join(testDir, 'link.txt')
    writeFileSync(realFile, 'AKIA-real-secret')
    symlinkSync(realFile, symlinkPath)
    process.env.PATH_TEST_FILE = symlinkPath

    // #when / #then
    expect(() => readOptionalSecret('PATH_TEST')).toThrow('not a regular file')
    expect(() => readOptionalSecret('PATH_TEST')).toThrow('symlink')
  })

  it('rejects directory pointed at by _FILE env var', () => {
    // #given a directory at the secret path
    const dirPath = join(testDir, 'a-dir')
    mkdirSync(dirPath)
    process.env.PATH_TEST_FILE = dirPath

    // #when / #then
    expect(() => readOptionalSecret('PATH_TEST')).toThrow('not a regular file')
    expect(() => readOptionalSecret('PATH_TEST')).toThrow('directory')
  })

  it('rejects file exceeding size limit', () => {
    // #given a file > 4096 bytes
    const largePath = join(testDir, 'large.txt')
    writeFileSync(largePath, 'x'.repeat(5000))
    process.env.PATH_TEST_FILE = largePath

    // #when / #then
    expect(() => readOptionalSecret('PATH_TEST')).toThrow('too large')
    expect(() => readOptionalSecret('PATH_TEST')).toThrow('5000 bytes')
  })

  it('accepts file at exactly the size limit', () => {
    // #given a file at exactly 4096 bytes
    const limitPath = join(testDir, 'limit.txt')
    writeFileSync(limitPath, 'x'.repeat(4096))
    process.env.PATH_TEST_FILE = limitPath

    // #when / #then
    expect(readOptionalSecret('PATH_TEST')).toBe('x'.repeat(4096))
  })

  it('reports ENOENT through readOptionalSecret as null (env var fallback)', () => {
    // #given a path that does not exist
    process.env.PATH_TEST_FILE = join(testDir, 'missing.txt')
    delete process.env.PATH_TEST

    // #when / #then — falls through to env-var fallback, which is also unset → null
    expect(readOptionalSecret('PATH_TEST')).toBe(null)
  })

  it('falls through to env-var fallback when _FILE points to nonexistent file but env var is set', () => {
    // #given _FILE missing but env var set
    process.env.PATH_TEST_FILE = join(testDir, 'missing.txt')
    process.env.PATH_TEST = 'env-var-value'

    // #when / #then — uses env var
    expect(readOptionalSecret('PATH_TEST')).toBe('env-var-value')
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
  process.env.GITHUB_APP_ID = 'test-github-app-id'
  // Private key has embedded newlines — must be provided via _FILE, not env var.
  const keyFile = join(tmpDir, 'github-app-private-key-default')
  writeFileSync(keyFile, '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----', {mode: 0o600})
  process.env.GITHUB_APP_PRIVATE_KEY_FILE = keyFile
  process.env.GATEWAY_WEBHOOK_SECRET = 'test-webhook-secret'
  process.env.GATEWAY_PRESENCE_CHANNEL_ID = 'test-presence-channel-id'
  process.env.WORKSPACE_OPENCODE_TOKEN = 'test-opencode-token'
}

/**
 * Set the minimum operator web env vars for a valid config.
 * Call after setRequiredEnv() when testing operator web happy paths.
 * Includes CSRF secret and allowlist (required when operator web is enabled).
 */
function setOperatorWebEnv(overrides: {bindHost?: string; bindPort?: string; publicOrigin?: string} = {}): void {
  process.env.GATEWAY_OPERATOR_BIND_HOST = overrides.bindHost ?? '172.20.0.2'
  process.env.GATEWAY_OPERATOR_BIND_PORT = overrides.bindPort ?? '4000'
  process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = overrides.publicOrigin ?? 'https://operator.example.com'
  process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID = 'test-oauth-client-id'
  process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET = 'test-oauth-client-secret'
  // CSRF secret and allowlist are required when operator web is enabled.
  process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
  process.env.GATEWAY_OPERATOR_ALLOWLIST = '42\n99'
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
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    // #when
    const config = loadGatewayConfig()

    // #then — assert before restoring spy so mock.calls is still populated
    expect(config.objectStore.credentials).toBeUndefined()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    const loggedArg: unknown = consoleSpy.mock.calls[0]?.[0]
    expect(typeof loggedArg).toBe('string')
    const parsed: unknown = JSON.parse(String(loggedArg)) as unknown
    const sessionTokenMsg = expect.stringContaining(
      'AWS_SESSION_TOKEN is set without AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY',
    ) as unknown
    expect(parsed).toMatchObject({level: 'warn', msg: sessionTokenMsg})
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// DISCORD_PRIVILEGED_INTENTS
// ---------------------------------------------------------------------------

describe('DISCORD_PRIVILEGED_INTENTS', () => {
  it('happy: unset → privilegedIntents is []', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.privilegedIntents).toEqual([])
  })

  it('happy: MessageContent → [GatewayIntentBits.MessageContent]', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'MessageContent'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.MessageContent])
  })

  it('happy: GuildMembers → [GatewayIntentBits.GuildMembers]', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'GuildMembers'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.GuildMembers])
  })

  it('happy: MessageContent,GuildMembers → both values, ordered as parsed', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'MessageContent,GuildMembers'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers])
  })

  it('edge: empty string → [] (treated as null by readOptionalSecret)', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = ''

    // #when
    const config = loadGatewayConfig()

    // #then — empty string is treated as "not set"
    expect(config.privilegedIntents).toEqual([])
  })

  it('edge: extra whitespace around tokens → both parsed correctly', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = ' MessageContent , GuildMembers '

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers])
  })

  it('edge: duplicate token → deduped to single value', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'MessageContent,MessageContent'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.MessageContent])
  })

  it('edge: empty middle token (MessageContent,,GuildMembers) → both parsed, no error', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'MessageContent,,GuildMembers'

    // #when
    const config = loadGatewayConfig()

    // #then — empty tokens are filtered out
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers])
  })

  it('error: typo "MesageContent" → throws with offending value and allowed list', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'MesageContent'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "MesageContent"/)
    expect(() => loadGatewayConfig()).toThrow(/MessageContent, GuildMembers/)
  })

  it('error: wrong case "messagecontent" → throws (case-sensitive)', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'messagecontent'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "messagecontent"/)
  })

  it('error: non-privileged intent "Guilds" → throws', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'Guilds'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "Guilds"/)
  })

  it('error: privileged intent not on allowlist "GuildPresences" → throws', () => {
    // #given
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'GuildPresences'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "GuildPresences"/)
  })

  it('rejects prototype-property tokens (constructor)', () => {
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'constructor'
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "constructor"/)
  })

  it('rejects prototype-property tokens (__proto__)', () => {
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = '__proto__'
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "__proto__"/)
  })

  it('rejects prototype-property tokens (toString)', () => {
    setRequiredEnv()
    process.env.DISCORD_PRIVILEGED_INTENTS = 'toString'
    expect(() => loadGatewayConfig()).toThrow(/Invalid DISCORD_PRIVILEGED_INTENTS value: "toString"/)
  })

  it('edge: DISCORD_PRIVILEGED_INTENTS_FILE with trailing newline → parsed correctly', () => {
    // #given
    setRequiredEnv()
    const intentFile = join(tmpDir, 'privileged-intents.txt')
    writeFileSync(intentFile, 'MessageContent\n', {mode: 0o600})
    process.env.DISCORD_PRIVILEGED_INTENTS_FILE = intentFile

    // #when
    const config = loadGatewayConfig()

    // #then — trailing newline stripped by readOptionalSecret, value parsed correctly
    expect(config.privilegedIntents).toEqual([GatewayIntentBits.MessageContent])
  })
})

// ---------------------------------------------------------------------------
// GitHub App config
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — GitHub App credentials', () => {
  it('happy path: both secrets present → config includes githubAppId and githubAppPrivateKey', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.githubAppId).toBe('test-github-app-id')
    expect(config.githubAppPrivateKey).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('happy path: GITHUB_APP_ID_FILE → reads from file', () => {
    // #given
    setRequiredEnv()
    delete process.env.GITHUB_APP_ID
    const idFile = join(tmpDir, 'github-app-id')
    writeFileSync(idFile, '99999\n', {mode: 0o600})
    process.env.GITHUB_APP_ID_FILE = idFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.githubAppId).toBe('99999')
  })

  it('happy path: GITHUB_APP_PRIVATE_KEY_FILE → reads from file', () => {
    // #given
    setRequiredEnv()
    delete process.env.GITHUB_APP_PRIVATE_KEY
    delete process.env.GITHUB_APP_PRIVATE_KEY_FILE
    const keyFile = join(tmpDir, 'github-app-private-key')
    writeFileSync(keyFile, '-----BEGIN RSA PRIVATE KEY-----\nfromfile\n-----END RSA PRIVATE KEY-----', {mode: 0o600})
    process.env.GITHUB_APP_PRIVATE_KEY_FILE = keyFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.githubAppPrivateKey).toContain('fromfile')
  })

  it('error: GITHUB_APP_ID unset → throws with clear message', () => {
    // #given
    setRequiredEnv()
    delete process.env.GITHUB_APP_ID

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GITHUB_APP_ID/)
  })

  it('error: GITHUB_APP_PRIVATE_KEY unset → throws with clear message', () => {
    // #given
    setRequiredEnv()
    delete process.env.GITHUB_APP_PRIVATE_KEY
    delete process.env.GITHUB_APP_PRIVATE_KEY_FILE

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GITHUB_APP_PRIVATE_KEY/)
  })

  it('happy path: GATEWAY_GITHUB_APP_INSTALL_URL overridden via env', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_GITHUB_APP_INSTALL_URL = 'https://github.com/apps/my-custom-app/installations/new'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.gatewayGitHubAppInstallUrl).toBe('https://github.com/apps/my-custom-app/installations/new')
  })

  it('happy path: GATEWAY_GITHUB_APP_INSTALL_URL defaults to fro-bot install URL', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.gatewayGitHubAppInstallUrl).toBe('https://github.com/apps/fro-bot-agent/installations/new')
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_WEBHOOK_SECRET, GATEWAY_PRESENCE_CHANNEL_ID, GATEWAY_HTTP_PORT
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — webhook secret, presence channel, http port', () => {
  it('happy path: all three vars set → config reflects their values', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_HTTP_PORT = '8080'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.announce?.webhookSecret).toBe('test-webhook-secret')
    expect(config.announce?.presenceChannelId).toBe('test-presence-channel-id')
    expect(config.announce?.httpPort).toBe(8080)
  })

  it('happy path: GATEWAY_HTTP_PORT unset → httpPort defaults to 3000', () => {
    // #given — announce secrets present so httpPort is read
    setRequiredEnv()
    // GATEWAY_HTTP_PORT not set

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.announce?.httpPort).toBe(3000)
  })

  it('happy path (#738 regression): neither announce secret set → config.announce is undefined, no throw', () => {
    // #given — announce secrets absent (the default deploy path that was crash-looping)
    setRequiredEnv()
    delete process.env.GATEWAY_WEBHOOK_SECRET
    delete process.env.GATEWAY_PRESENCE_CHANNEL_ID

    // #when / #then — must NOT throw; announce is opt-in
    let config: GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()
    expect(config?.announce).toBeUndefined()
  })

  it('happy path: both GATEWAY_WEBHOOK_SECRET and GATEWAY_PRESENCE_CHANNEL_ID set → config.announce has both values', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_WEBHOOK_SECRET = 'my-webhook-secret'
    process.env.GATEWAY_PRESENCE_CHANNEL_ID = 'my-channel-id'

    // #when
    const config = loadGatewayConfig()

    // #then — announce includes httpPort (defaults to 3000 when GATEWAY_HTTP_PORT unset)
    expect(config.announce).toEqual({
      webhookSecret: 'my-webhook-secret',
      presenceChannelId: 'my-channel-id',
      httpPort: 3000,
    })
  })

  it('error: only GATEWAY_WEBHOOK_SECRET set → throws both-or-neither error naming received and missing vars', () => {
    // #given — webhook present, presence absent
    setRequiredEnv()
    process.env.GATEWAY_WEBHOOK_SECRET = 'my-webhook-secret'
    delete process.env.GATEWAY_PRESENCE_CHANNEL_ID

    // #when / #then — error must name the received var and the missing var directionally
    expect(() => loadGatewayConfig()).toThrow('received: GATEWAY_WEBHOOK_SECRET')
    expect(() => loadGatewayConfig()).toThrow('missing: GATEWAY_PRESENCE_CHANNEL_ID')
  })

  it('error: only GATEWAY_PRESENCE_CHANNEL_ID set → throws both-or-neither error naming received and missing vars', () => {
    // #given — presence present, webhook absent
    setRequiredEnv()
    delete process.env.GATEWAY_WEBHOOK_SECRET
    process.env.GATEWAY_PRESENCE_CHANNEL_ID = 'my-channel-id'

    // #when / #then — error must name the received var and the missing var directionally
    expect(() => loadGatewayConfig()).toThrow('received: GATEWAY_PRESENCE_CHANNEL_ID')
    expect(() => loadGatewayConfig()).toThrow('missing: GATEWAY_WEBHOOK_SECRET')
  })

  it('edge: empty GATEWAY_WEBHOOK_SECRET with valid GATEWAY_PRESENCE_CHANNEL_ID → both-or-neither error (empty = absent)', () => {
    // #given — empty webhook secret is treated as absent by readOptionalSecret
    setRequiredEnv()
    process.env.GATEWAY_WEBHOOK_SECRET = ''
    process.env.GATEWAY_PRESENCE_CHANNEL_ID = 'my-channel-id'

    // #when / #then — empty secret cannot enable a half-configured announce endpoint
    expect(() => loadGatewayConfig()).toThrow('GATEWAY_WEBHOOK_SECRET')
    expect(() => loadGatewayConfig()).toThrow('GATEWAY_PRESENCE_CHANNEL_ID')
  })

  it('edge: whitespace-only GATEWAY_WEBHOOK_SECRET with valid GATEWAY_PRESENCE_CHANNEL_ID → both-or-neither error', () => {
    // #given — whitespace-only is treated as absent by readOptionalSecret
    setRequiredEnv()
    process.env.GATEWAY_WEBHOOK_SECRET = '   '
    process.env.GATEWAY_PRESENCE_CHANNEL_ID = 'my-channel-id'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('GATEWAY_WEBHOOK_SECRET')
    expect(() => loadGatewayConfig()).toThrow('GATEWAY_PRESENCE_CHANNEL_ID')
  })

  it('edge: _FILE variants honored — both via GATEWAY_WEBHOOK_SECRET_FILE / GATEWAY_PRESENCE_CHANNEL_ID_FILE → announce object built', () => {
    // #given — both secrets provided via _FILE (the compose bind-mount pattern)
    setRequiredEnv()
    delete process.env.GATEWAY_WEBHOOK_SECRET
    delete process.env.GATEWAY_PRESENCE_CHANNEL_ID
    const webhookFile = join(tmpDir, 'webhook-secret-file.txt')
    const channelFile = join(tmpDir, 'presence-channel-id-file.txt')
    writeFileSync(webhookFile, 'file-webhook-secret\n', {mode: 0o600})
    writeFileSync(channelFile, 'file-channel-id\n', {mode: 0o600})
    process.env.GATEWAY_WEBHOOK_SECRET_FILE = webhookFile
    process.env.GATEWAY_PRESENCE_CHANNEL_ID_FILE = channelFile

    // #when
    const config = loadGatewayConfig()

    // #then — _FILE values are read and trimmed; announce object is built (httpPort defaults to 3000)
    expect(config.announce).toEqual({
      webhookSecret: 'file-webhook-secret',
      presenceChannelId: 'file-channel-id',
      httpPort: 3000,
    })
  })

  it('edge: GATEWAY_HTTP_PORT = "0" → throws invalid port error (announce secrets set)', () => {
    // #given — announce secrets must be set so httpPort is actually read+validated
    setRequiredEnv()
    process.env.GATEWAY_HTTP_PORT = '0'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_HTTP_PORT value: "0"')
  })

  it('edge: GATEWAY_HTTP_PORT = "70000" → throws invalid port error (announce secrets set)', () => {
    // #given — announce secrets must be set so httpPort is actually read+validated
    setRequiredEnv()
    process.env.GATEWAY_HTTP_PORT = '70000'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_HTTP_PORT value: "70000"')
  })

  it('edge: GATEWAY_HTTP_PORT = "abc" → throws invalid port error (announce secrets set)', () => {
    // #given — announce secrets must be set so httpPort is actually read+validated
    setRequiredEnv()
    process.env.GATEWAY_HTTP_PORT = 'abc'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_HTTP_PORT value: "abc"')
  })

  it('edge: GATEWAY_HTTP_PORT = "1" → accepted (boundary, minimum port)', () => {
    // #given — announce secrets present so httpPort is read
    setRequiredEnv()
    process.env.GATEWAY_HTTP_PORT = '1'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.announce?.httpPort).toBe(1)
  })

  it('edge: GATEWAY_HTTP_PORT = "65535" → accepted (boundary, maximum port)', () => {
    // #given — announce secrets present so httpPort is read
    setRequiredEnv()
    process.env.GATEWAY_HTTP_PORT = '65535'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.announce?.httpPort).toBe(65535)
  })

  it('regression (#738-adjacent): announce secrets absent + invalid GATEWAY_HTTP_PORT → no throw, config.announce is undefined', () => {
    // #given — no announce secrets; invalid port value that would have crashed boot before this fix
    setRequiredEnv()
    delete process.env.GATEWAY_WEBHOOK_SECRET
    delete process.env.GATEWAY_PRESENCE_CHANNEL_ID
    process.env.GATEWAY_HTTP_PORT = '999999'

    // #when / #then — must NOT throw; httpPort is only read when announce is enabled
    let config: GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()
    expect(config?.announce).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // workspaceOpencodeUrl / workspaceOpencodeToken / triggerRoleId / maxConcurrentRuns
  // ---------------------------------------------------------------------------

  it('defaults workspaceOpencodeUrl to http://workspace:9200 when WORKSPACE_OPENCODE_URL is unset', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.workspaceOpencodeUrl).toBe('http://workspace:9200')
  })

  it('reads WORKSPACE_OPENCODE_URL from env', () => {
    // #given
    setRequiredEnv()
    process.env.WORKSPACE_OPENCODE_URL = 'http://custom-workspace:9200'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.workspaceOpencodeUrl).toBe('http://custom-workspace:9200')
  })

  it('reads WORKSPACE_OPENCODE_TOKEN from env', () => {
    // #given
    setRequiredEnv()
    process.env.WORKSPACE_OPENCODE_TOKEN = 'my-secret-token'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.workspaceOpencodeToken).toBe('my-secret-token')
  })

  it('throws when WORKSPACE_OPENCODE_TOKEN is missing', () => {
    // #given
    setRequiredEnv()
    delete process.env.WORKSPACE_OPENCODE_TOKEN

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Missing required secret: WORKSPACE_OPENCODE_TOKEN')
  })

  it('defaults triggerRoleId to null when GATEWAY_TRIGGER_ROLE_ID is unset', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.triggerRoleId).toBeNull()
  })

  it('reads GATEWAY_TRIGGER_ROLE_ID from env', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_TRIGGER_ROLE_ID = '1234567890'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.triggerRoleId).toBe('1234567890')
  })

  it('defaults maxConcurrentRuns to 3 when GATEWAY_MAX_CONCURRENT_RUNS is unset', () => {
    // #given
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.maxConcurrentRuns).toBe(3)
  })

  it('reads GATEWAY_MAX_CONCURRENT_RUNS from env', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_MAX_CONCURRENT_RUNS = '5'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.maxConcurrentRuns).toBe(5)
  })

  it('throws when GATEWAY_MAX_CONCURRENT_RUNS is not a positive integer', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_MAX_CONCURRENT_RUNS = 'banana'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_MAX_CONCURRENT_RUNS')
  })

  it('throws when GATEWAY_MAX_CONCURRENT_RUNS is 0 (below minimum)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_MAX_CONCURRENT_RUNS = '0'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_MAX_CONCURRENT_RUNS')
  })

  it('edge: GATEWAY_WEBHOOK_SECRET_FILE with trailing newline → trimmed and accepted', () => {
    // #given — webhook via _FILE, presence via env (both present → announce object built)
    setRequiredEnv()
    delete process.env.GATEWAY_WEBHOOK_SECRET
    const secretFile = join(tmpDir, 'webhook-secret.txt')
    writeFileSync(secretFile, 'file-webhook-secret\n', {mode: 0o600})
    process.env.GATEWAY_WEBHOOK_SECRET_FILE = secretFile

    // #when
    const config = loadGatewayConfig()

    // #then trailing newline trimmed; announce object built with both values
    expect(config.announce?.webhookSecret).toBe('file-webhook-secret')
    expect(config.announce?.presenceChannelId).toBe('test-presence-channel-id')
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_APPROVAL_MODE
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — GATEWAY_APPROVAL_MODE', () => {
  it('happy path: unset GATEWAY_APPROVAL_MODE → approvalMode defaults to "approval-required"', () => {
    // #given — GATEWAY_APPROVAL_MODE not set
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.approvalMode).toBe('approval-required')
  })

  it('happy path: GATEWAY_APPROVAL_MODE=approval-required → approvalMode is "approval-required"', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_APPROVAL_MODE = 'approval-required'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.approvalMode).toBe('approval-required')
  })

  it('error path: GATEWAY_APPROVAL_MODE=autonomous-low-risk → explicitly rejected with deferred error', () => {
    // #given — autonomous-low-risk is deferred (unsafe due to OpenCode last-match-wins evaluation)
    setRequiredEnv()
    process.env.GATEWAY_APPROVAL_MODE = 'autonomous-low-risk'

    // #when / #then — must throw with a clear explanation, not silently fall back
    expect(() => loadGatewayConfig()).toThrow('GATEWAY_APPROVAL_MODE value "autonomous-low-risk" is not supported')
  })

  it('error path: unknown GATEWAY_APPROVAL_MODE value → throws with clear config error', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_APPROVAL_MODE = 'auto-approve-everything'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Invalid GATEWAY_APPROVAL_MODE value: "auto-approve-everything" (valid values: approval-required)',
    )
  })

  it('edge case: empty GATEWAY_APPROVAL_MODE → treated as unset, defaults to "approval-required"', () => {
    // #given — empty string is treated as absent by readOptionalSecret
    setRequiredEnv()
    process.env.GATEWAY_APPROVAL_MODE = ''

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.approvalMode).toBe('approval-required')
  })

  it('edge case: whitespace-only GATEWAY_APPROVAL_MODE → treated as unset, defaults to "approval-required"', () => {
    // #given — whitespace-only is treated as absent by readOptionalSecret
    setRequiredEnv()
    process.env.GATEWAY_APPROVAL_MODE = '   '

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.approvalMode).toBe('approval-required')
  })

  it('edge case: GATEWAY_APPROVAL_MODE_FILE with approval-required value → reads from file', () => {
    // #given — value provided via _FILE (the compose bind-mount pattern)
    setRequiredEnv()
    const modeFile = join(tmpDir, 'approval-mode.txt')
    writeFileSync(modeFile, 'approval-required\n', {mode: 0o600})
    process.env.GATEWAY_APPROVAL_MODE_FILE = modeFile

    // #when
    const config = loadGatewayConfig()

    // #then — trailing newline stripped; value parsed correctly
    expect(config.approvalMode).toBe('approval-required')
  })

  it('edge case: GATEWAY_APPROVAL_MODE_FILE with autonomous-low-risk → explicitly rejected', () => {
    // #given — deferred mode via file
    setRequiredEnv()
    const modeFile = join(tmpDir, 'approval-mode-deferred.txt')
    writeFileSync(modeFile, 'autonomous-low-risk\n', {mode: 0o600})
    process.env.GATEWAY_APPROVAL_MODE_FILE = modeFile

    // #when / #then — must throw with deferred error
    expect(() => loadGatewayConfig()).toThrow('GATEWAY_APPROVAL_MODE value "autonomous-low-risk" is not supported')
  })

  it('edge case: GATEWAY_APPROVAL_MODE_FILE with empty file → defaults to "approval-required"', () => {
    // #given — empty file is treated as absent by readOptionalSecret
    setRequiredEnv()
    const modeFile = join(tmpDir, 'approval-mode-empty.txt')
    writeFileSync(modeFile, '', {mode: 0o600})
    process.env.GATEWAY_APPROVAL_MODE_FILE = modeFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.approvalMode).toBe('approval-required')
  })

  it('error path: GATEWAY_APPROVAL_MODE_FILE with unknown value → throws with clear config error', () => {
    // #given
    setRequiredEnv()
    const modeFile = join(tmpDir, 'approval-mode-bad.txt')
    writeFileSync(modeFile, 'full-auto\n', {mode: 0o600})
    process.env.GATEWAY_APPROVAL_MODE_FILE = modeFile

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Invalid GATEWAY_APPROVAL_MODE value: "full-auto" (valid values: approval-required)',
    )
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_PERSONA_FILE
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — GATEWAY_PERSONA_FILE (persona)', () => {
  it('happy path: GATEWAY_PERSONA_FILE unset → config.persona is null', () => {
    // #given — no persona env var or file
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.persona).toBeNull()
  })

  it('happy path: GATEWAY_PERSONA_FILE set to a file with content → config.persona is the trimmed content', () => {
    // #given — persona file with multi-line markdown content
    setRequiredEnv()
    const personaFile = join(tmpDir, 'persona.md')
    writeFileSync(
      personaFile,
      '# Fro Bot\n\nYou are Fro Bot, a capable engineering assistant.\n\nBe direct and concise.\n',
      {mode: 0o600},
    )
    process.env.GATEWAY_PERSONA_FILE = personaFile

    // #when
    const config = loadGatewayConfig()

    // #then — content is read and trailing whitespace trimmed
    expect(config.persona).toBe(
      '# Fro Bot\n\nYou are Fro Bot, a capable engineering assistant.\n\nBe direct and concise.',
    )
  })

  it('edge: GATEWAY_PERSONA_FILE points to empty file → config.persona is null', () => {
    // #given — empty file is treated as absent
    setRequiredEnv()
    const personaFile = join(tmpDir, 'persona-empty.md')
    writeFileSync(personaFile, '', {mode: 0o600})
    process.env.GATEWAY_PERSONA_FILE = personaFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.persona).toBeNull()
  })

  it('edge: GATEWAY_PERSONA_FILE points to whitespace-only file → config.persona is null', () => {
    // #given — whitespace-only file is treated as absent
    setRequiredEnv()
    const personaFile = join(tmpDir, 'persona-ws.md')
    writeFileSync(personaFile, '   \n  \n', {mode: 0o600})
    process.env.GATEWAY_PERSONA_FILE = personaFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.persona).toBeNull()
  })

  it('edge: GATEWAY_PERSONA_FILE content is trimmed (trailing newline stripped)', () => {
    // #given — file with trailing newline (common in text editors)
    setRequiredEnv()
    const personaFile = join(tmpDir, 'persona-trailing.md')
    writeFileSync(personaFile, 'You are Fro Bot.\n', {mode: 0o600})
    process.env.GATEWAY_PERSONA_FILE = personaFile

    // #when
    const config = loadGatewayConfig()

    // #then — trailing newline stripped
    expect(config.persona).toBe('You are Fro Bot.')
  })

  it('edge: GATEWAY_PERSONA_FILE points to non-existent file → config.persona is null (fail-soft)', () => {
    // #given — _FILE points to a missing path, no env var fallback
    setRequiredEnv()
    process.env.GATEWAY_PERSONA_FILE = join(tmpDir, 'does-not-exist.md')

    // #when / #then — must NOT throw; absent persona is fail-soft
    let config: import('./config.js').GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()
    expect(config?.persona).toBeNull()
  })

  it('edge: GATEWAY_PERSONA env var set → config.persona is the value (env var path)', () => {
    // #given — persona provided directly via env var (single-line for readOptionalMultilineSecret)
    setRequiredEnv()
    process.env.GATEWAY_PERSONA = 'You are Fro Bot, a capable engineering assistant.'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.persona).toBe('You are Fro Bot, a capable engineering assistant.')

    delete process.env.GATEWAY_PERSONA
  })

  it('fail-soft: GATEWAY_PERSONA_FILE points to a directory → persona is null, startup continues', () => {
    // #given — _FILE points to a directory (Docker bind-mount misconfiguration)
    setRequiredEnv()
    const dirPath = mkdtempSync(join(tmpDir, 'persona-dir-'))
    process.env.GATEWAY_PERSONA_FILE = dirPath

    // #when / #then — must NOT throw; persona degrades to null
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let config: import('./config.js').GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()
    expect(config?.persona).toBeNull()
    consoleSpy.mockRestore()
  })

  it('fail-soft: GATEWAY_PERSONA_FILE points to oversized file → persona is null, startup continues', () => {
    // #given — file exceeds MAX_SECRET_BYTES (4096)
    setRequiredEnv()
    const largePath = join(tmpDir, 'persona-large.md')
    writeFileSync(largePath, 'x'.repeat(5000), {mode: 0o600})
    process.env.GATEWAY_PERSONA_FILE = largePath

    // #when / #then — must NOT throw; persona degrades to null
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let config: import('./config.js').GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()
    expect(config?.persona).toBeNull()
    consoleSpy.mockRestore()
  })

  it('fail-soft: GATEWAY_PERSONA_FILE points to non-existent file → persona is null, no warning (ENOENT is normal)', () => {
    // #given — _FILE points to a missing path, no env var fallback
    setRequiredEnv()
    process.env.GATEWAY_PERSONA_FILE = join(tmpDir, 'does-not-exist-2.md')

    // #when / #then — must NOT throw; absent persona is fail-soft (ENOENT falls through to null)
    let config: import('./config.js').GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()
    expect(config?.persona).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_STATUS_MODE
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — GATEWAY_STATUS_MODE', () => {
  it('happy path: unset GATEWAY_STATUS_MODE → statusMode defaults to "live-status"', () => {
    // #given — GATEWAY_STATUS_MODE not set
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.statusMode).toBe('live-status')
  })

  it('happy path: GATEWAY_STATUS_MODE=live-status → statusMode is "live-status"', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_STATUS_MODE = 'live-status'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.statusMode).toBe('live-status')
  })

  it('happy path: GATEWAY_STATUS_MODE=typing-only → statusMode is "typing-only"', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_STATUS_MODE = 'typing-only'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.statusMode).toBe('typing-only')
  })

  it('edge case: empty GATEWAY_STATUS_MODE → treated as unset, defaults to "live-status"', () => {
    // #given — empty string is treated as absent by readOptionalSecret
    setRequiredEnv()
    process.env.GATEWAY_STATUS_MODE = ''

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.statusMode).toBe('live-status')
  })

  it('edge case: whitespace-only GATEWAY_STATUS_MODE → treated as unset, defaults to "live-status"', () => {
    // #given — whitespace-only is treated as absent by readOptionalSecret
    setRequiredEnv()
    process.env.GATEWAY_STATUS_MODE = '   '

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.statusMode).toBe('live-status')
  })

  it('error path: unknown GATEWAY_STATUS_MODE value → throws with clear config error naming valid values', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_STATUS_MODE = 'silent'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Invalid GATEWAY_STATUS_MODE value: "silent" (valid values: live-status, typing-only)',
    )
  })

  it('error path: GATEWAY_STATUS_MODE_FILE with unknown value → throws with clear config error', () => {
    // #given
    setRequiredEnv()
    const modeFile = join(tmpDir, 'status-mode-bad.txt')
    writeFileSync(modeFile, 'verbose\n', {mode: 0o600})
    process.env.GATEWAY_STATUS_MODE_FILE = modeFile

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(
      'Invalid GATEWAY_STATUS_MODE value: "verbose" (valid values: live-status, typing-only)',
    )
  })

  it('edge case: GATEWAY_STATUS_MODE_FILE with typing-only value → reads from file', () => {
    // #given — value provided via _FILE (the compose bind-mount pattern)
    setRequiredEnv()
    const modeFile = join(tmpDir, 'status-mode.txt')
    writeFileSync(modeFile, 'typing-only\n', {mode: 0o600})
    process.env.GATEWAY_STATUS_MODE_FILE = modeFile

    // #when
    const config = loadGatewayConfig()

    // #then — trailing newline stripped; value parsed correctly
    expect(config.statusMode).toBe('typing-only')
  })

  it('edge case: GATEWAY_STATUS_MODE_FILE with empty file → defaults to "live-status"', () => {
    // #given — empty file is treated as absent by readOptionalSecret
    setRequiredEnv()
    const modeFile = join(tmpDir, 'status-mode-empty.txt')
    writeFileSync(modeFile, '', {mode: 0o600})
    process.env.GATEWAY_STATUS_MODE_FILE = modeFile

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.statusMode).toBe('live-status')
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_OPERATOR_* — operator web surface config
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — operator web surface', () => {
  it('happy path: all three operator vars absent → operatorWeb is undefined (listener disabled)', () => {
    // #given — no operator vars set
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then — operator listener is disabled
    expect(config.operatorWeb).toBeUndefined()
  })

  it('happy path: all three operator vars set → operatorWeb is populated', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb).toMatchObject({
      bindHost: '172.20.0.2',
      bindPort: 4000,
      publicOrigin: 'https://operator.example.com',
      oauthClientId: 'test-oauth-client-id',
      oauthClientSecret: 'test-oauth-client-secret',
      oauthAllowedReturnPaths: ['/operator'],
      oauthStateTtlMs: 600_000,
      oauthMaxOutstandingAttemptsPerKey: 5,
    })
  })

  it('error path: only GATEWAY_OPERATOR_BIND_HOST set → fails closed (partial config)', () => {
    // #given — partial config
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'

    // #when / #then — must throw with a clear message
    expect(() => loadGatewayConfig()).toThrow(/partial operator web config/i)
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN/)
  })

  it('error path: only GATEWAY_OPERATOR_BIND_PORT set → fails closed (partial config)', () => {
    // #given — partial config
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/partial operator web config/i)
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_BIND_HOST/)
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN/)
  })

  it('error path: only GATEWAY_OPERATOR_PUBLIC_ORIGIN set → fails closed (partial config)', () => {
    // #given — partial config
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/partial operator web config/i)
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_BIND_HOST/)
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=0.0.0.0 → throws (all-interfaces bind rejected)', () => {
    // #given — all-interfaces bind is not allowed for the operator listener
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '0.0.0.0'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be "0\.0\.0\.0"/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=127.0.0.1 → throws (loopback bind rejected)', () => {
    // #given — loopback bind is not allowed for the operator listener
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '127.0.0.1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be "127\.0\.0\.1"/)
  })

  it('security: GATEWAY_OPERATOR_PUBLIC_ORIGIN with http:// → throws (TLS required)', () => {
    // #given — http:// origin is not allowed; TLS must be terminated by the reverse proxy
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'http://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must use https:\/\//)
  })

  it('error path: GATEWAY_OPERATOR_PUBLIC_ORIGIN is not a valid URL → throws', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'not-a-url'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid GATEWAY_OPERATOR_PUBLIC_ORIGIN/)
  })

  it('error path: GATEWAY_OPERATOR_BIND_PORT=0 → throws (invalid port)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '0'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid GATEWAY_OPERATOR_BIND_PORT/)
  })

  it('error path: GATEWAY_OPERATOR_BIND_PORT=70000 → throws (port out of range)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '70000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid GATEWAY_OPERATOR_BIND_PORT/)
  })

  it('error path: GATEWAY_OPERATOR_BIND_PORT=not-a-number → throws (non-integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = 'not-a-port'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/Invalid GATEWAY_OPERATOR_BIND_PORT/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=::1 → throws (IPv6 loopback rejected)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '::1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be "::1"/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=0:0:0:0:0:0:0:1 → throws (full-form IPv6 loopback rejected)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '0:0:0:0:0:0:0:1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be "0:0:0:0:0:0:0:1"/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=127.0.0.2 → throws (127.0.0.0/8 loopback range rejected)', () => {
    // #given — any 127.x.x.x address is loopback, not just 127.0.0.1
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '127.0.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be "127\.0\.0\.2"/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=10.0.0.2 → throws (sandbox-net rejected)', () => {
    // #given — 10.0.0.0/8 is the Docker internal sandbox-net; operator must be on gateway-net
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '10.0.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/10\.0\.0\.0\/8 is the sandbox-net/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=10.255.255.1 → throws (sandbox-net range rejected)', () => {
    // #given — any 10.x.x.x address is sandbox-net
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '10.255.255.1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/sandbox-net/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=:: → throws (IPv6 all-interfaces rejected)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '::'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be "::"/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=localhost → throws (hostname not allowed)', () => {
    // #given — only literal IP addresses are accepted; hostnames are rejected
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = 'localhost'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must be a literal IP address/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=gateway.internal → throws (hostname not allowed)', () => {
    // #given — DNS names are not accepted; only literal IPs
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = 'gateway.internal'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must be a literal IP address/)
  })

  it('happy path: GATEWAY_OPERATOR_BIND_HOST=172.20.0.5 → accepted (gateway-net address)', () => {
    // #given — gateway-net addresses (172.20.x.x) must remain valid
    setRequiredEnv()
    setOperatorWebEnv({bindHost: '172.20.0.5'})

    // #when
    const config = loadGatewayConfig()

    // #then — gateway-net address is accepted
    expect(config.operatorWeb?.bindHost).toBe('172.20.0.5')
  })

  // ---------------------------------------------------------------------------
  // IPv6 bind host — all IPv6 literals rejected (gateway-net is IPv4-only)
  // ---------------------------------------------------------------------------

  it('security: GATEWAY_OPERATOR_BIND_HOST=fe80::1 → throws (IPv6 link-local rejected)', () => {
    // #given — link-local IPv6 address; gateway-net is IPv4-only
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = 'fe80::1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then — all IPv6 literals are rejected until IPv6 gateway-net topology exists
    expect(() => loadGatewayConfig()).toThrow(/must not be an IPv6 address/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=fc00::1 → throws (IPv6 ULA rejected)', () => {
    // #given — ULA (Unique Local Address) IPv6; gateway-net is IPv4-only
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = 'fc00::1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be an IPv6 address/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=2001:db8::1 → throws (IPv6 global unicast rejected)', () => {
    // #given — documentation-range IPv6 global unicast; gateway-net is IPv4-only
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '2001:db8::1'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be an IPv6 address/)
  })

  it('security: GATEWAY_OPERATOR_BIND_HOST=0:0:0:0:0:0:0:2 → throws (full-form IPv6 non-loopback rejected)', () => {
    // #given — full-form IPv6 address that is not loopback or all-interfaces;
    // the all-interfaces (0:0:0:0:0:0:0:0) and loopback (0:0:0:0:0:0:0:1) forms
    // are caught by earlier guards; this verifies the IPv6 catch-all fires for others.
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '0:0:0:0:0:0:0:2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/must not be an IPv6 address/)
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_OPERATOR_PUBLIC_ORIGIN — canonical origin validation
// ---------------------------------------------------------------------------

function setOperatorEnv(origin: string): void {
  setRequiredEnv()
  process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
  process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
  process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = origin
  process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID = 'test-oauth-client-id'
  process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET = 'test-oauth-client-secret'
  // CSRF secret and allowlist are required when operator web is enabled.
  process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
  process.env.GATEWAY_OPERATOR_ALLOWLIST = '42\n99'
}

describe('loadGatewayConfig — GATEWAY_OPERATOR_PUBLIC_ORIGIN canonical origin validation', () => {
  it('happy path: bare https origin with no path → accepted', () => {
    // #given
    setOperatorEnv('https://ops.example.com')

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.publicOrigin).toBe('https://ops.example.com')
  })

  it('happy path: https origin with explicit port → accepted', () => {
    // #given
    setOperatorEnv('https://ops.example.com:8443')

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.publicOrigin).toBe('https://ops.example.com:8443')
  })

  it('error path: origin with a path beyond / → rejected', () => {
    // #given — paths beyond the root are not allowed in a canonical origin
    setOperatorEnv('https://ops.example.com/some/path')

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/canonical origin/)
  })

  it('error path: origin with a query string → rejected', () => {
    // #given
    setOperatorEnv('https://ops.example.com?foo=bar')

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/canonical origin/)
  })

  it('error path: origin with a hash fragment → rejected', () => {
    // #given
    setOperatorEnv('https://ops.example.com#section')

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/canonical origin/)
  })

  it('error path: origin with a username → rejected', () => {
    // #given
    setOperatorEnv('https://user@ops.example.com')

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/canonical origin/)
  })

  it('error path: origin with a password → rejected', () => {
    // #given
    setOperatorEnv('https://user:pass@ops.example.com')

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/canonical origin/)
  })

  it('edge: origin with trailing slash only (/) → accepted and normalized (trailing slash stripped)', () => {
    // #given — https://ops.example.com/ is a valid canonical origin (pathname='/'); accepted
    setOperatorEnv('https://ops.example.com/')

    // #when
    const config = loadGatewayConfig()

    // #then — stored as parsedPublicOrigin.origin which strips the trailing slash
    expect(config.operatorWeb?.publicOrigin).toBe('https://ops.example.com')
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_OPERATOR_GITHUB_CLIENT_ID / CLIENT_SECRET — OAuth credential validation
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — operator web OAuth credentials', () => {
  it('error path: GATEWAY_OPERATOR_GITHUB_CLIENT_ID missing → throws', () => {
    // #given — all three operator vars set but no OAuth client id
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'
    process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET = 'test-secret'
    // GATEWAY_OPERATOR_GITHUB_CLIENT_ID intentionally absent

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_GITHUB_CLIENT_ID/)
  })

  it('error path: GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET missing → throws', () => {
    // #given — all three operator vars set but no OAuth client secret
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'
    process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID = 'test-client-id'
    // GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET intentionally absent

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET/)
  })

  it('happy path: OAuth credentials present → oauthClientId and oauthClientSecret populated', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthClientId).toBe('test-oauth-client-id')
    expect(config.operatorWeb?.oauthClientSecret).toBe('test-oauth-client-secret')
  })

  it('happy path: GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS overrides default', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS = '/operator/dashboard,/operator/runs'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthAllowedReturnPaths).toEqual(['/operator/dashboard', '/operator/runs'])
  })

  it('happy path: GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS defaults to ["/operator"]', () => {
    // #given — no override
    setRequiredEnv()
    setOperatorWebEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthAllowedReturnPaths).toEqual(['/operator'])
  })

  it('happy path: GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS overrides default', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS = '300000'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthStateTtlMs).toBe(300_000)
  })

  it('happy path: GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS defaults to 600000', () => {
    // #given — no override
    setRequiredEnv()
    setOperatorWebEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthStateTtlMs).toBe(600_000)
  })

  it('error path: GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS=0 → throws', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS = '0'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS/)
  })

  it('happy path: GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS overrides default', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS = '10'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthMaxOutstandingAttemptsPerKey).toBe(10)
  })

  it('happy path: GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS defaults to 5', () => {
    // #given — no override
    setRequiredEnv()
    setOperatorWebEnv()

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.oauthMaxOutstandingAttemptsPerKey).toBe(5)
  })

  it('error path: GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS=abc → throws (non-integer)', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS = 'abc'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS/)
  })

  it('error path: GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS=-1 → throws (negative not allowed)', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS = '-1'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS/)
  })

  it('error path: GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS=0 → throws', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS = '0'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS/)
  })

  it('error path: GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS=banana → throws (non-integer)', () => {
    // #given
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS = 'banana'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS/)
  })

  it('happy path: GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE → reads client id from file', () => {
    // #given — client id provided via _FILE (the compose bind-mount pattern)
    setRequiredEnv()
    process.env.GATEWAY_OPERATOR_BIND_HOST = '172.20.0.2'
    process.env.GATEWAY_OPERATOR_BIND_PORT = '4000'
    process.env.GATEWAY_OPERATOR_PUBLIC_ORIGIN = 'https://operator.example.com'
    process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET = 'test-oauth-client-secret'
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
    process.env.GATEWAY_OPERATOR_ALLOWLIST = '42\n99'
    delete process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID
    const clientIdFile = join(tmpDir, 'github-client-id.txt')
    writeFileSync(clientIdFile, 'file-client-id\n', {mode: 0o600})
    process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE = clientIdFile

    // #when
    const config = loadGatewayConfig()

    // #then — _FILE value is read and trimmed
    expect(config.operatorWeb?.oauthClientId).toBe('file-client-id')

    delete process.env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID_FILE
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_OPERATOR_CSRF_SECRET and GATEWAY_OPERATOR_ALLOWLIST
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — CSRF secret and operator allowlist', () => {
  it('error path: operator web enabled but GATEWAY_OPERATOR_CSRF_SECRET missing → throws', () => {
    // #given — all operator web vars set but no CSRF secret
    setRequiredEnv()
    setOperatorWebEnv()
    // Explicitly remove the CSRF secret that setOperatorWebEnv() sets
    delete process.env.GATEWAY_OPERATOR_CSRF_SECRET
    delete process.env.GATEWAY_OPERATOR_CSRF_SECRET_FILE

    // #when / #then — must fail closed, not silently disable the gate
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_CSRF_SECRET/)
  })

  it('error path: operator web enabled but GATEWAY_OPERATOR_ALLOWLIST missing → throws', () => {
    // #given — all operator web vars + CSRF secret set but no allowlist
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
    // Explicitly remove the allowlist that setOperatorWebEnv() sets
    delete process.env.GATEWAY_OPERATOR_ALLOWLIST
    delete process.env.GATEWAY_OPERATOR_ALLOWLIST_FILE

    // #when / #then — must fail closed
    expect(() => loadGatewayConfig()).toThrow(/GATEWAY_OPERATOR_ALLOWLIST/)
  })

  it('error path: GATEWAY_OPERATOR_ALLOWLIST file is empty → throws (fail closed)', () => {
    // #given — allowlist file exists but is empty
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
    const allowlistFile = join(tmpDir, 'allowlist-empty.txt')
    writeFileSync(allowlistFile, '', {mode: 0o600})
    process.env.GATEWAY_OPERATOR_ALLOWLIST_FILE = allowlistFile

    // #when / #then — empty allowlist must fail closed
    expect(() => loadGatewayConfig()).toThrow(/allowlist/i)
  })

  it('error path: GATEWAY_OPERATOR_ALLOWLIST file has malformed entries → throws (fail closed)', () => {
    // #given — allowlist file with non-numeric entries
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
    const allowlistFile = join(tmpDir, 'allowlist-bad.txt')
    writeFileSync(allowlistFile, 'not-a-number\n', {mode: 0o600})
    process.env.GATEWAY_OPERATOR_ALLOWLIST_FILE = allowlistFile

    // #when / #then — malformed allowlist must fail closed
    expect(() => loadGatewayConfig()).toThrow(/allowlist/i)
  })

  it('happy path: CSRF secret and allowlist both present → config includes csrfSecret and allowlist', () => {
    // #given — all operator web vars + CSRF secret + valid allowlist
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
    const allowlistFile = join(tmpDir, 'allowlist-valid.txt')
    writeFileSync(allowlistFile, '# comment\n42\n99\n', {mode: 0o600})
    process.env.GATEWAY_OPERATOR_ALLOWLIST_FILE = allowlistFile

    // #when
    const config = loadGatewayConfig()

    // #then — csrfSecret and allowlist are present in operatorWeb
    expect(config.operatorWeb?.csrfSecret).toBe('dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE')
    expect(config.operatorWeb?.allowlist).toBeDefined()
    expect(config.operatorWeb?.allowlist?.isAuthorized(42)).toBe(true)
    expect(config.operatorWeb?.allowlist?.isAuthorized(99)).toBe(true)
    expect(config.operatorWeb?.allowlist?.isAuthorized(1)).toBe(false)
  })

  it('happy path: GATEWAY_OPERATOR_ALLOWLIST env var (inline text) → parsed as allowlist', () => {
    // #given — allowlist provided inline via env var (not file)
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'
    process.env.GATEWAY_OPERATOR_ALLOWLIST = '42\n99'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.allowlist?.isAuthorized(42)).toBe(true)
    expect(config.operatorWeb?.allowlist?.isAuthorized(99)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_OPERATOR_CSRF_SECRET — strict base64url validation (Fix 1)
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — CSRF secret strict base64url validation', () => {
  it('happy path: valid base64url CSRF secret (32 bytes) → parses and stores csrfSecret', () => {
    // #given — 32 bytes of CSPRNG entropy, base64url-encoded (no padding)
    setRequiredEnv()
    setOperatorWebEnv()
    // 32 bytes → 43 base64url chars (no padding)
    const validSecret = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE'

    // #when
    const config = loadGatewayConfig()

    // #then — csrfSecret is stored as-is
    expect(config.operatorWeb?.csrfSecret).toBe(validSecret)
  })

  it('happy path: valid base64url CSRF secret (64 bytes) → accepted (more than minimum)', () => {
    // #given — 64 bytes → 86 base64url chars
    setRequiredEnv()
    setOperatorWebEnv()
    // Generate a valid 64-byte base64url string (no padding)
    const secret64 = Buffer.alloc(64, 0xab).toString('base64url')
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = secret64

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.csrfSecret).toBe(secret64)
  })

  it('error path: CSRF secret with base64 padding (=) → throws (not strict base64url)', () => {
    // #given — base64 with padding is not strict base64url
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nISE='

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/strict base64url/)
  })

  it('error path: CSRF secret with + character → throws (not base64url)', () => {
    // #given — base64 standard uses + which is not base64url
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nIS+='

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/strict base64url/)
  })

  it('error path: CSRF secret with / character → throws (not base64url)', () => {
    // #given — base64 standard uses / which is not base64url
    setRequiredEnv()
    setOperatorWebEnv()
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = 'dGVzdC1jc3JmLXNlY3JldC0zMi1ieXRlcy1sb25nIS/='

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/strict base64url/)
  })

  it('error path: CSRF secret decodes to fewer than 32 bytes → throws (too short)', () => {
    // #given — 16 bytes → 22 base64url chars (below 32-byte minimum)
    setRequiredEnv()
    setOperatorWebEnv()
    const shortSecret = Buffer.alloc(16, 0xaa).toString('base64url')
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = shortSecret

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/at least 32 bytes/)
  })

  it('error path: CSRF secret decodes to exactly 31 bytes → throws (one byte short)', () => {
    // #given — 31 bytes is one byte below the 32-byte minimum
    setRequiredEnv()
    setOperatorWebEnv()
    const shortSecret = Buffer.alloc(31, 0xbb).toString('base64url')
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = shortSecret

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow(/at least 32 bytes/)
  })

  it('happy path: CSRF secret decodes to exactly 32 bytes → accepted (minimum boundary)', () => {
    // #given — exactly 32 bytes is the minimum
    setRequiredEnv()
    setOperatorWebEnv()
    const minSecret = Buffer.alloc(32, 0xcc).toString('base64url')
    process.env.GATEWAY_OPERATOR_CSRF_SECRET = minSecret

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.operatorWeb?.csrfSecret).toBe(minSecret)
  })
})

// ---------------------------------------------------------------------------
// GATEWAY_RUN_TIMEOUT_MS and GATEWAY_RUN_INACTIVITY_TIMEOUT_MS
// ---------------------------------------------------------------------------

describe('loadGatewayConfig — GATEWAY_RUN_TIMEOUT_MS', () => {
  it('happy path: unset → runTimeoutMs defaults to 1800000 (30 minutes)', () => {
    // #given — GATEWAY_RUN_TIMEOUT_MS not set
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then — default is 30 minutes (1800000 ms)
    expect(config.runTimeoutMs).toBe(1_800_000)
  })

  it('happy path: GATEWAY_RUN_TIMEOUT_MS=600000 → runTimeoutMs is 600000', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '600000'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.runTimeoutMs).toBe(600_000)
  })

  it('happy path: GATEWAY_RUN_TIMEOUT_MS=1 → accepted (minimum positive integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '1'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.runTimeoutMs).toBe(1)
  })

  it('error path: GATEWAY_RUN_TIMEOUT_MS=0 → throws (zero is not a positive integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '0'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_RUN_TIMEOUT_MS value: "0"')
  })

  it('error path: GATEWAY_RUN_TIMEOUT_MS=banana → throws with clear error', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = 'banana'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_RUN_TIMEOUT_MS value: "banana"')
  })

  it('error path: GATEWAY_RUN_TIMEOUT_MS=-1 → throws (negative is not a positive integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '-1'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_RUN_TIMEOUT_MS value: "-1"')
  })
})

describe('loadGatewayConfig — GATEWAY_RUN_INACTIVITY_TIMEOUT_MS', () => {
  it('happy path: unset → runInactivityTimeoutMs defaults to 300000 (5 minutes)', () => {
    // #given — GATEWAY_RUN_INACTIVITY_TIMEOUT_MS not set
    setRequiredEnv()

    // #when
    const config = loadGatewayConfig()

    // #then — default is 5 minutes (300000 ms)
    expect(config.runInactivityTimeoutMs).toBe(300_000)
  })

  it('happy path: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS=60000 → runInactivityTimeoutMs is 60000', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '60000'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.runInactivityTimeoutMs).toBe(60_000)
  })

  it('happy path: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS=1 → accepted (minimum positive integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '1'

    // #when
    const config = loadGatewayConfig()

    // #then
    expect(config.runInactivityTimeoutMs).toBe(1)
  })

  it('error path: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS=0 → throws (zero is not a positive integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '0'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_RUN_INACTIVITY_TIMEOUT_MS value: "0"')
  })

  it('error path: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS=banana → throws with clear error', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = 'banana'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_RUN_INACTIVITY_TIMEOUT_MS value: "banana"')
  })

  it('error path: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS=-1 → throws (negative is not a positive integer)', () => {
    // #given
    setRequiredEnv()
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '-1'

    // #when / #then
    expect(() => loadGatewayConfig()).toThrow('Invalid GATEWAY_RUN_INACTIVITY_TIMEOUT_MS value: "-1"')
  })

  it('soft warning: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS >= GATEWAY_RUN_TIMEOUT_MS emits a console.warn (does not throw)', () => {
    // #given — inactivity timeout equals the hard ceiling (dead config, but valid)
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '60000'
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '60000'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // #when — must NOT throw
    let config: GatewayConfig | undefined
    expect(() => {
      config = loadGatewayConfig()
    }).not.toThrow()

    // #then — warning emitted, config still valid
    expect(config?.runInactivityTimeoutMs).toBe(60_000)
    expect(warnSpy).toHaveBeenCalledOnce()
    const warnArg = warnSpy.mock.calls[0]?.[0] as string
    expect(warnArg).toContain('inactivity timer can never fire')

    warnSpy.mockRestore()
  })

  it('soft warning: GATEWAY_RUN_INACTIVITY_TIMEOUT_MS > GATEWAY_RUN_TIMEOUT_MS also warns', () => {
    // #given — inactivity timeout exceeds the hard ceiling
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '60000'
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '120000'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // #when
    expect(() => loadGatewayConfig()).not.toThrow()

    // #then — warning emitted
    expect(warnSpy).toHaveBeenCalledOnce()
    warnSpy.mockRestore()
  })

  it('no warning when GATEWAY_RUN_INACTIVITY_TIMEOUT_MS < GATEWAY_RUN_TIMEOUT_MS (normal config)', () => {
    // #given — inactivity timeout is less than the hard ceiling (correct config)
    setRequiredEnv()
    process.env.GATEWAY_RUN_TIMEOUT_MS = '1800000'
    process.env.GATEWAY_RUN_INACTIVITY_TIMEOUT_MS = '300000'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // #when
    loadGatewayConfig()

    // #then — no inactivity warning (there may be other console.warn calls from persona etc.)
    const inactivityWarns = warnSpy.mock.calls.filter(
      call => typeof call[0] === 'string' && call[0].includes('inactivity timer can never fire'),
    )
    expect(inactivityWarns).toHaveLength(0)

    warnSpy.mockRestore()
  })
})
