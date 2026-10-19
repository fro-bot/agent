/**
 * Tests for the backfill-runner shared runner function.
 *
 * Verifies:
 * - createS3Adapter is called with TWO args (config, logger) — arity fix
 * - dryRun threads through to backfillActiveBindingDenyKeys
 * - missing env vars → non-zero exit code (no unhandled throw)
 * - happy path returns exit code 0
 * - makeWriteBinding: exact S3 key shape, body serialization, error propagation
 *
 * BDD comments: #given / #when / #then.
 */

import type {ObjectStoreAdapter} from '@fro-bot/runtime'

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// ---------------------------------------------------------------------------
// Mock the factory modules so the runner never hits real S3 or GitHub
// ---------------------------------------------------------------------------

const mockCreateS3Adapter = vi.fn()
const mockCreateAppClient = vi.fn()
const mockCreateBindingsStore = vi.fn()
const mockBackfill = vi.fn()

vi.mock('@fro-bot/runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...actual,
    createS3Adapter: mockCreateS3Adapter,
  }
})

vi.mock('../github/app-client.js', () => ({
  createAppClient: mockCreateAppClient,
}))

vi.mock('./store.js', () => ({
  createBindingsStore: mockCreateBindingsStore,
}))

vi.mock('./backfill-deny-keys.js', () => ({
  backfillActiveBindingDenyKeys: mockBackfill,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every name the runner reads (the object-store loader's names and the required credentials), plus each `_FILE` form.
// Cleared before every test so ambient values never leak in, and restored afterwards.
const SCRUBBED_ENV_NAMES = [
  'S3_BUCKET',
  'S3_REGION',
  'AWS_REGION',
  'S3_ENDPOINT',
  'S3_PREFIX',
  'S3_SSE',
  'S3_ALLOW_INSECURE_ENDPOINT',
  'S3_EXPECTED_BUCKET_OWNER',
  'S3_SSE_KMS_KEY_ID',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GATEWAY_IDENTITY',
].flatMap(name => [name, `${name}_FILE`])

function setRequiredEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const key of SCRUBBED_ENV_NAMES) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  const vars: Record<string, string> = {
    GITHUB_APP_ID: 'test-app-id',
    GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----',
    S3_BUCKET: 'test-bucket',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test-key-id',
    AWS_SECRET_ACCESS_KEY: 'test-secret',
  }
  for (const [key, value] of Object.entries(vars)) {
    process.env[key] = value
  }
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function makeSpyLogger() {
  const error = vi.fn()
  return {error, logger: {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error}}
}

function makeMockAdapter() {
  return {
    upload: vi.fn(),
    getObject: vi.fn(),
    list: vi.fn(),
    conditionalPut: vi.fn().mockResolvedValue({success: true, data: {etag: 'etag-1'}}),
    conditionalDelete: vi.fn(),
  }
}

function makeMockAppClient() {
  return {
    authForRepo: vi.fn(),
    getRepoIdentity: vi.fn(),
    invalidateCache: vi.fn(),
  }
}

function makeMockBindingsStore() {
  return {
    createBinding: vi.fn(),
    getBindingByRepo: vi.fn(),
    getBindingByChannelId: vi.fn(),
    listBindings: vi.fn(),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDenyKeyBackfill', () => {
  let savedEnv: Record<string, string | undefined>
  let tmpDir: string

  function writeValueFile(name: string, contents: string): string {
    const file = join(tmpDir, name)
    writeFileSync(file, contents, {mode: 0o600})
    return file
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'backfill-runner-test-'))
    savedEnv = setRequiredEnv()

    // Set up default mock return values
    const mockAdapter = makeMockAdapter()
    const mockAppClient = makeMockAppClient()
    const mockStore = makeMockBindingsStore()

    mockCreateS3Adapter.mockReturnValue(mockAdapter)
    mockCreateAppClient.mockReturnValue(mockAppClient)
    mockCreateBindingsStore.mockReturnValue(mockStore)
  })

  afterEach(() => {
    restoreEnv(savedEnv)
    rmSync(tmpDir, {recursive: true, force: true})
  })

  // -------------------------------------------------------------------------
  // Arity fix: createS3Adapter must be called with 2 args
  // -------------------------------------------------------------------------

  it('happy path: createS3Adapter is called with (config, logger) — 2 args, logger is defined', async () => {
    // #given — all env vars set, backfill succeeds
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 3, updated: 2, skipped: 1, failed: 0}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — exit code 0 (success)
    expect(exitCode).toBe(0)

    // #and — createS3Adapter was called with exactly 2 args
    expect(mockCreateS3Adapter).toHaveBeenCalledTimes(1)
    const s3Call = mockCreateS3Adapter.mock.calls[0] as [unknown, unknown] | undefined
    expect(s3Call).toBeDefined()
    const s3Config = s3Call?.[0]
    const s3Logger = s3Call?.[1]
    expect(s3Config).toBeDefined()
    expect(s3Logger).toBeDefined()
    // The second arg is the logger — must not be undefined
    expect(typeof s3Logger).toBe('object')
    // Logger must have the runtime Logger interface methods
    const loggerObj = s3Logger as {debug: unknown; info: unknown; warning: unknown; error: unknown}
    expect(typeof loggerObj.debug).toBe('function')
    expect(typeof loggerObj.info).toBe('function')
    expect(typeof loggerObj.warning).toBe('function')
    expect(typeof loggerObj.error).toBe('function')
  })

  it('happy path: backfillActiveBindingDenyKeys is called exactly once with constructed deps', async () => {
    // #given — all env vars set, backfill succeeds
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 1, updated: 1, skipped: 0, failed: 0}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — exit code 0
    expect(exitCode).toBe(0)
    // #and — backfill called once
    expect(mockBackfill).toHaveBeenCalledTimes(1)
    // #and — deps are defined
    interface BackfillDepsShape {
      bindingsStore: unknown
      getRepoIdentity: unknown
      writeBinding: unknown
      logger: unknown
    }
    const backfillCall = mockBackfill.mock.calls[0] as [BackfillDepsShape] | undefined
    const deps = backfillCall?.[0]
    expect(deps?.bindingsStore).toBeDefined()
    expect(typeof deps?.getRepoIdentity).toBe('function')
    expect(typeof deps?.writeBinding).toBe('function')
    expect(deps?.logger).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // dryRun threading
  // -------------------------------------------------------------------------

  it('dryRun: true threads through to backfillActiveBindingDenyKeys', async () => {
    // #given — all env vars set, backfill succeeds
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 2, updated: 2, skipped: 0, failed: 0}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    await runDenyKeyBackfill({dryRun: true})

    // #then — backfill received dryRun: true
    expect(mockBackfill).toHaveBeenCalledTimes(1)
    const backfillCall = mockBackfill.mock.calls[0] as [{dryRun: unknown}] | undefined
    expect(backfillCall?.[0]?.dryRun).toBe(true)
  })

  it('dryRun: false threads through to backfillActiveBindingDenyKeys', async () => {
    // #given — all env vars set, backfill succeeds
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    await runDenyKeyBackfill({dryRun: false})

    // #then — backfill received dryRun: false
    expect(mockBackfill).toHaveBeenCalledTimes(1)
    const backfillCall = mockBackfill.mock.calls[0] as [{dryRun: unknown}] | undefined
    expect(backfillCall?.[0]?.dryRun).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Missing env vars → non-zero exit code
  // -------------------------------------------------------------------------

  it('missing required env var → returns exit code 1 (no unhandled throw)', async () => {
    // #given — remove a required env var
    delete process.env.GITHUB_APP_ID

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — non-zero exit code, no throw
    expect(exitCode).toBe(1)
    // #and — backfill was never called
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('missing S3_BUCKET env var → returns exit code 1', async () => {
    // #given — remove S3_BUCKET
    delete process.env.S3_BUCKET

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — non-zero exit code
    expect(exitCode).toBe(1)
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Exit code mapping
  // -------------------------------------------------------------------------

  it('backfill result with failed > 0 → returns exit code 2', async () => {
    // #given — backfill completes but some bindings failed
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 3, updated: 2, skipped: 0, failed: 1}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — exit code 2 (partial failure)
    expect(exitCode).toBe(2)
  })

  it('backfill result with failed = 0 → returns exit code 0', async () => {
    // #given — backfill completes cleanly
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 5, updated: 5, skipped: 0, failed: 0}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — exit code 0
    expect(exitCode).toBe(0)
  })

  it('backfill returns err → returns exit code 1', async () => {
    // #given — backfill fails entirely
    const {err} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(err(new Error('S3 unavailable')))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then — exit code 1
    expect(exitCode).toBe(1)
  })

  // -------------------------------------------------------------------------
  // No dynamic import of @fro-bot/runtime
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Shared object-store settings (S3_REGION, endpoint, SSE)
  // -------------------------------------------------------------------------

  function lastStoreConfig(): Record<string, unknown> {
    const call = mockCreateS3Adapter.mock.calls[0] as [Record<string, unknown>, unknown] | undefined
    return call?.[0] ?? {}
  }

  it('honours S3_REGION when AWS_REGION is unset', async () => {
    // #given — only S3_REGION carries the region
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    delete process.env.AWS_REGION
    process.env.S3_REGION = 'eu-west-2'

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig().region).toBe('eu-west-2')
  })

  it('prefers S3_REGION over AWS_REGION when both are set', async () => {
    // #given — AWS_REGION=us-east-1 comes from the fixture
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_REGION = 'eu-west-2'

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(lastStoreConfig().region).toBe('eu-west-2')
  })

  it('still works with the AWS_REGION-only fixture and keeps the credentials on the store config', async () => {
    // #given — the pre-existing fixture: AWS_REGION and the two credential vars
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig()).toMatchObject({
      enabled: true,
      bucket: 'test-bucket',
      region: 'us-east-1',
      prefix: 'fro-bot-state',
      credentials: {accessKeyId: 'test-key-id', secretAccessKey: 'test-secret'},
    })
  })

  it('passes S3_ENDPOINT, S3_SSE and the insecure opt-in through to the store config', async () => {
    // #given
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_ENDPOINT = 'http://minio:9000'
    process.env.S3_ALLOW_INSECURE_ENDPOINT = 'true'
    process.env.S3_SSE = 'AES256'
    process.env.S3_PREFIX = 'custom-state'

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig()).toMatchObject({
      endpoint: 'http://minio:9000',
      allowInsecureEndpoint: true,
      sseEncryption: 'AES256',
      prefix: 'custom-state',
    })
  })

  it('falls back to the default prefix when S3_PREFIX is an empty string', async () => {
    // #given
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_PREFIX = ''

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(lastStoreConfig().prefix).toBe('fro-bot-state')
  })

  it('invalid endpoint → exits 1 with a logged error naming S3_ENDPOINT, before any adapter or App client', async () => {
    // #given — http endpoint without the opt-in
    process.env.S3_ENDPOINT = 'http://minio:9000'
    const error = vi.fn()
    const logger = {debug: vi.fn(), info: vi.fn(), warning: vi.fn(), error}

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false, logger})

    // #then
    expect(exitCode).toBe(1)
    expect(error).toHaveBeenCalledTimes(1)
    const [, context] = error.mock.calls[0] as [string, {error: string}]
    expect(context.error).toMatch(/^S3_ENDPOINT: /)
    expect(mockCreateS3Adapter).not.toHaveBeenCalled()
    expect(mockCreateAppClient).not.toHaveBeenCalled()
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('neither S3_REGION nor AWS_REGION set → exits 1 and the logged error names every candidate', async () => {
    // #given
    delete process.env.AWS_REGION
    const {error, logger} = makeSpyLogger()

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false, logger})

    // #then
    expect(exitCode).toBe(1)
    const [, context] = error.mock.calls[0] as [string, {error: string}]
    expect(context.error).toBe('S3_REGION or AWS_REGION is required')
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('uses S3_REGION from env when S3_REGION_FILE is empty, not AWS_REGION', async () => {
    // #given an empty bind-mounted S3_REGION_FILE, a real S3_REGION and a different AWS_REGION
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_REGION_FILE = writeValueFile('s3-region-empty', '')
    process.env.S3_REGION = 'eu-west-2'
    process.env.AWS_REGION = 'us-east-1'

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig().region).toBe('eu-west-2')
  })

  it('keeps S3_ENDPOINT from env when S3_ENDPOINT_FILE is empty', async () => {
    // #given the compose default: an empty endpoint file, with the endpoint set in env
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_ENDPOINT_FILE = writeValueFile('s3-endpoint-empty', '')
    process.env.S3_ENDPOINT = 'https://my-minio.example.com'

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig().endpoint).toBe('https://my-minio.example.com')
  })

  it('trims a padded S3_BUCKET and S3_REGION', async () => {
    // #given
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_BUCKET = ' test-bucket '
    process.env.S3_REGION = ' eu-west-2 '

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(lastStoreConfig()).toMatchObject({bucket: 'test-bucket', region: 'eu-west-2'})
  })

  it('rejects a KMS key with a custom endpoint and no S3_SSE → exits 1 naming S3_SSE_KMS_KEY_ID', async () => {
    // #given a custom endpoint derives AES256, so the key would be silently dropped
    process.env.S3_ENDPOINT = 'https://my-minio.example.com'
    process.env.S3_SSE_KMS_KEY_ID = 'alias/fro-bot'
    const {error, logger} = makeSpyLogger()

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false, logger})

    // #then
    expect(exitCode).toBe(1)
    const [, context] = error.mock.calls[0] as [string, {error: string}]
    expect(context.error).toMatch(/^S3_SSE_KMS_KEY_ID: /)
    expect(mockCreateS3Adapter).not.toHaveBeenCalled()
  })

  it('accepts a KMS key with a custom endpoint when S3_SSE=aws:kms', async () => {
    // #given
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.S3_ENDPOINT = 'https://my-minio.example.com'
    process.env.S3_SSE = 'aws:kms'
    process.env.S3_SSE_KMS_KEY_ID = 'alias/fro-bot'
    process.env.S3_EXPECTED_BUCKET_OWNER = '123456789012'

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig()).toMatchObject({
      sseEncryption: 'aws:kms',
      sseKmsKeyId: 'alias/fro-bot',
      expectedBucketOwner: '123456789012',
    })
  })

  it('rejects a metadata endpoint even with S3_ALLOW_INSECURE_ENDPOINT=true → exits 1', async () => {
    // #given
    process.env.S3_ENDPOINT = 'http://169.254.169.254'
    process.env.S3_ALLOW_INSECURE_ENDPOINT = 'true'
    const {error, logger} = makeSpyLogger()

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false, logger})

    // #then
    expect(exitCode).toBe(1)
    const [, context] = error.mock.calls[0] as [string, {error: string}]
    expect(context.error).toContain('cloud instance metadata services')
  })

  it('rejects a malformed S3_EXPECTED_BUCKET_OWNER → exits 1 naming the variable, not the value', async () => {
    // #given
    process.env.S3_EXPECTED_BUCKET_OWNER = 'not-an-account'
    const {error, logger} = makeSpyLogger()

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false, logger})

    // #then
    expect(exitCode).toBe(1)
    const [, context] = error.mock.calls[0] as [string, {error: string}]
    expect(context.error).toMatch(/^S3_EXPECTED_BUCKET_OWNER: /)
    expect(context.error).not.toContain('not-an-account')
  })

  // -------------------------------------------------------------------------
  // Required reads share the gateway rule: an empty `_FILE` counts as unset
  // -------------------------------------------------------------------------

  it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY'])(
    'empty %s_FILE with the env var unset → exits 1 and logs the variable name',
    async name => {
      // #given an empty bind-mounted file and no env value
      delete process.env[name]
      process.env[`${name}_FILE`] = writeValueFile(`${name}-empty`, '')
      const {error, logger} = makeSpyLogger()

      // #when
      const {runDenyKeyBackfill} = await import('./backfill-runner.js')
      const exitCode = await runDenyKeyBackfill({dryRun: false, logger})

      // #then the empty file is not passed through as ''
      expect(exitCode).toBe(1)
      const [, context] = error.mock.calls[0] as [string, {error: string}]
      expect(context.error).toContain(name)
      expect(mockCreateS3Adapter).not.toHaveBeenCalled()
      expect(mockCreateAppClient).not.toHaveBeenCalled()
    },
  )

  it('empty AWS_ACCESS_KEY_ID_FILE with the env var set → uses the env value', async () => {
    // #given
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    process.env.AWS_ACCESS_KEY_ID_FILE = writeValueFile('aws-key-empty', '')

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig()).toMatchObject({credentials: {accessKeyId: 'test-key-id', secretAccessKey: 'test-secret'}})
  })

  it('reads credentials and the GitHub App ID from non-empty _FILE values', async () => {
    // #given
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
    delete process.env.GITHUB_APP_ID
    process.env.AWS_ACCESS_KEY_ID_FILE = writeValueFile('aws-key', 'file-key-id\n')
    process.env.AWS_SECRET_ACCESS_KEY_FILE = writeValueFile('aws-secret', 'file-secret\n')
    process.env.GITHUB_APP_ID_FILE = writeValueFile('app-id', '424242\n')

    // #when
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    const exitCode = await runDenyKeyBackfill({dryRun: false})

    // #then
    expect(exitCode).toBe(0)
    expect(lastStoreConfig()).toMatchObject({credentials: {accessKeyId: 'file-key-id', secretAccessKey: 'file-secret'}})
    expect((mockCreateAppClient.mock.calls[0] as [{appId: string}])[0].appId).toBe('424242')
  })

  it('createS3Adapter is called via static import (not dynamic) — no dynamic import branch', async () => {
    // #given — backfill succeeds
    const {ok} = await import('@fro-bot/runtime')
    mockBackfill.mockResolvedValue(ok({total: 0, updated: 0, skipped: 0, failed: 0}))

    // #when — the mock intercepts the static import; if dynamic import were used,
    // the mock would NOT intercept it and mockCreateS3Adapter would not be called
    const {runDenyKeyBackfill} = await import('./backfill-runner.js')
    await runDenyKeyBackfill({dryRun: false})

    // #then — the static-import mock was called (proves no dynamic import branch)
    expect(mockCreateS3Adapter).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// makeWriteBinding — focused tests pinning the exact S3 key and body
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for makeWriteBinding tests
// ---------------------------------------------------------------------------

function makeMockWriteAdapter(conditionalPutImpl?: ReturnType<typeof vi.fn>): ObjectStoreAdapter {
  return {
    upload: vi.fn(),
    download: vi.fn(),
    getObject: vi.fn(),
    list: vi.fn(),
    conditionalPut: (conditionalPutImpl ??
      vi.fn().mockResolvedValue({
        success: true,
        data: {etag: 'etag-abc'},
      })) as unknown as ObjectStoreAdapter['conditionalPut'],
    conditionalDelete: vi.fn(),
  }
}

function makeTestBinding(
  overrides?: Partial<{
    owner: string
    repo: string
    channelId: string
    channelName: string
    workspacePath: string
    createdAt: string
    createdByDiscordId: string
    databaseId: number
    nodeId: string
  }>,
) {
  return {
    owner: 'acme',
    repo: 'widget',
    channelId: 'ch-123',
    channelName: 'acme-widget',
    workspacePath: '/workspaces/acme/widget',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdByDiscordId: 'discord-user-1',
    databaseId: 99999,
    nodeId: 'R_kgDOABCDEF',
    ...overrides,
  }
}

const TEST_STORE_CONFIG = {
  enabled: true as const,
  bucket: 'test-bucket',
  region: 'us-east-1',
  prefix: 'fro-bot-state',
  credentials: {accessKeyId: 'key', secretAccessKey: 'secret'},
}

describe('makeWriteBinding', () => {
  it('calls conditionalPut with the EXACT S3 key for a known owner/repo/identity', async () => {
    // #given — a mock adapter and a known storeConfig + identity
    const mockConditionalPut = vi.fn().mockResolvedValue({success: true, data: {etag: 'etag-abc'}})
    const mockAdapter = makeMockWriteAdapter(mockConditionalPut)
    const binding = makeTestBinding()

    // #when — call the real makeWriteBinding factory and invoke the closure
    const {makeWriteBinding} = await import('./backfill-runner.js')
    const writeBinding = makeWriteBinding(mockAdapter, TEST_STORE_CONFIG, 'discord-gateway')
    const result = await writeBinding(binding)

    // #then — conditionalPut was called exactly once
    expect(mockConditionalPut).toHaveBeenCalledTimes(1)

    // #and — the key contains the identity segment (not /coordination/)
    const [key, body, condition] = mockConditionalPut.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(key).toContain('/discord-gateway/')
    expect(key).not.toContain('/coordination/')

    // #and — the key contains the bindings/repo.json segments
    expect(key).toContain('/bindings/repo.json')

    // #and — the key contains the owner/repo path
    expect(key).toContain('acme')
    expect(key).toContain('widget')

    // #and — the full key matches the expected pattern exactly
    // Pattern: {prefix}/{identity}/{owner}/{repo}/bindings/repo.json
    // (buildObjectStoreKey uses prefix/identity/suffix/...segments)
    expect(key).toBe('fro-bot-state/discord-gateway/acme/widget/bindings/repo.json')

    // #and — the body is the JSON-stringified binding WITH databaseId and nodeId
    const parsedBody = JSON.parse(body) as typeof binding
    expect(parsedBody.databaseId).toBe(99999)
    expect(parsedBody.nodeId).toBe('R_kgDOABCDEF')
    expect(parsedBody.owner).toBe('acme')
    expect(parsedBody.repo).toBe('widget')

    // #and — the condition is unconditional (empty object — no ifNoneMatch/ifMatch)
    expect(condition).toEqual({})

    // #and — result is ok
    expect(result.success).toBe(true)
  })

  it('returns err when conditionalPut returns err', async () => {
    // #given — adapter whose conditionalPut fails
    const putError = new Error('S3 write failed')
    const mockConditionalPut = vi.fn().mockResolvedValue({success: false, error: putError})
    const mockAdapter = makeMockWriteAdapter(mockConditionalPut)
    const binding = makeTestBinding({databaseId: 42, nodeId: 'R_kgDOXYZ'})

    // #when
    const {makeWriteBinding} = await import('./backfill-runner.js')
    const writeBinding = makeWriteBinding(mockAdapter, TEST_STORE_CONFIG, 'discord-gateway')
    const result = await writeBinding(binding)

    // #then — result is err with the adapter's error
    expect(result.success).toBe(false)
    // Access error directly — result.success is false so this is safe
    const errorResult = result as {success: false; error: Error}
    expect(errorResult.error).toBe(putError)
  })

  it('returns err when adapter has no conditionalPut', async () => {
    // #given — adapter without conditionalPut (testing the null-guard branch)
    const mockAdapter: ObjectStoreAdapter = {
      upload: vi.fn(),
      download: vi.fn(),
      list: vi.fn(),
      // conditionalPut intentionally absent — undefined by default (optional field)
    }

    const binding = makeTestBinding()

    // #when
    const {makeWriteBinding} = await import('./backfill-runner.js')
    const writeBinding = makeWriteBinding(mockAdapter, TEST_STORE_CONFIG, 'discord-gateway')
    const result = await writeBinding(binding)

    // #then — result is err
    expect(result.success).toBe(false)
    // Access error directly — result.success is false so this is safe
    const errorResult = result as {success: false; error: Error}
    expect(errorResult.error.message).toContain('conditionalPut')
  })

  it('conditionalPut is called with an EMPTY condition object — unconditional overwrite, no ifMatch/ifNoneMatch', async () => {
    // #given — a mock adapter and a known binding
    const mockConditionalPut = vi.fn().mockResolvedValue({success: true, data: {etag: 'etag-unconditional'}})
    const mockAdapter = makeMockWriteAdapter(mockConditionalPut)
    const binding = makeTestBinding({databaseId: 77777, nodeId: 'R_kgDOUNCOND'})

    // #when — invoke the real makeWriteBinding factory
    const {makeWriteBinding} = await import('./backfill-runner.js')
    const writeBinding = makeWriteBinding(mockAdapter, TEST_STORE_CONFIG, 'discord-gateway')
    await writeBinding(binding)

    // #then — conditionalPut was called exactly once
    expect(mockConditionalPut).toHaveBeenCalledTimes(1)

    // #and — the third argument (condition) is an empty object: no ifMatch, no ifNoneMatch
    const [, , condition] = mockConditionalPut.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(condition).toEqual({})
    expect(condition).not.toHaveProperty('ifMatch')
    expect(condition).not.toHaveProperty('ifNoneMatch')
  })

  it('uses the default identity (discord-gateway) in the key when identity is discord-gateway', async () => {
    // #given — default identity
    const mockConditionalPut = vi.fn().mockResolvedValue({success: true, data: {etag: 'etag-1'}})
    const mockAdapter = makeMockWriteAdapter(mockConditionalPut)
    const binding = makeTestBinding({owner: 'org', repo: 'myrepo', databaseId: 1234, nodeId: 'R_kgDO1234'})

    const altStoreConfig = {
      enabled: true as const,
      bucket: 'my-bucket',
      region: 'eu-west-1',
      prefix: 'fro-bot-state',
      credentials: {accessKeyId: 'k', secretAccessKey: 's'},
    }

    // #when
    const {makeWriteBinding} = await import('./backfill-runner.js')
    const writeBinding = makeWriteBinding(mockAdapter, altStoreConfig, 'discord-gateway')
    await writeBinding(binding)

    // #then — key contains /discord-gateway/ and NOT /coordination/
    const [key] = mockConditionalPut.mock.calls[0] as [string]
    expect(key).toContain('/discord-gateway/')
    expect(key).not.toContain('/coordination/')
    expect(key).toContain('/bindings/repo.json')
  })
})

// ---------------------------------------------------------------------------
// USAGE text
// ---------------------------------------------------------------------------

describe('USAGE', () => {
  it('lists the required variables and points at the deploy guide for the optional S3 settings', async () => {
    // #given / #when
    const {USAGE} = await import('./backfill-runner.js')

    // #then the required variables are listed
    for (const name of [
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY',
      'S3_BUCKET',
      'S3_REGION',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'GATEWAY_IDENTITY',
    ]) {
      expect(USAGE).toContain(name)
    }

    // #and the optional S3 settings live in one place, the deploy guide
    expect(USAGE).toContain('deploy/README.md')
    expect(USAGE).toContain('Object-store settings')
    expect(USAGE).not.toContain('S3_ALLOW_INSECURE_ENDPOINT')
    expect(USAGE).not.toContain('S3_SSE_KMS_KEY_ID')
  })
})
