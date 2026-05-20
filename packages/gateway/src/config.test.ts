import type {GatewayConfig} from './config.js'

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
