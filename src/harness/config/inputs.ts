import type {Result} from '@bfra.me/es/result'
import type {ObjectStoreConfig} from '../../services/object-store/index.js'
import type {ActionInputs, ModelConfig, OmoProviders, OutputMode} from '../../shared/types.js'
import process from 'node:process'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {validateEndpoint, validatePrefix} from '../../services/object-store/index.js'
import {
  DEFAULT_AGENT,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_OMO_PROVIDERS,
  DEFAULT_OMO_VERSION,
  DEFAULT_OPENCODE_VERSION,
  DEFAULT_S3_PREFIX,
  DEFAULT_SESSION_RETENTION,
  DEFAULT_SYSTEMATIC_VERSION,
  DEFAULT_TIMEOUT_MS,
} from '../../shared/constants.js'
import {err, ok} from '../../shared/types.js'
import {validateJsonString, validatePositiveInteger} from '../../shared/validation.js'

/**
 * Parse model input string in "provider/model" format.
 *
 * @param input - Model string in format "provider/model" (e.g., "anthropic/claude-sonnet-4-20250514")
 * @returns Parsed ModelConfig with providerID and modelID
 * @throws Error if format is invalid
 */
export function parseModelInput(input: string): ModelConfig {
  const trimmed = input.trim()
  const slashIndex = trimmed.indexOf('/')

  if (slashIndex === -1) {
    throw new Error(
      `Invalid model format: "${input}". Expected "provider/model" (e.g., "anthropic/claude-sonnet-4-20250514")`,
    )
  }

  const providerID = trimmed.slice(0, slashIndex).trim()
  const modelID = trimmed.slice(slashIndex + 1).trim()

  if (providerID.length === 0) {
    throw new Error(`Invalid model format: "${input}". Provider cannot be empty.`)
  }

  if (modelID.length === 0) {
    throw new Error(`Invalid model format: "${input}". Model ID cannot be empty.`)
  }

  return {providerID, modelID}
}

function parseTimeoutMs(value: string, inputName = 'timeout'): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${inputName} must be a non-negative integer, received: ${value}`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${inputName} must be a non-negative integer, received: ${value}`)
  }

  return parsed
}

const VALID_OMO_PROVIDERS = [
  'claude',
  'claude-max20',
  'copilot',
  'gemini',
  'openai',
  'opencode-zen',
  'zai-coding-plan',
  'kimi-for-coding',
] as const

const VALID_OUTPUT_MODES = ['auto', 'working-dir', 'branch-pr'] as const

type OutputModeInput = (typeof VALID_OUTPUT_MODES)[number]

type OmoProviderInput = (typeof VALID_OMO_PROVIDERS)[number]

function parseOmoProviders(input: string): OmoProviders {
  const providers = input
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(p => p.length > 0)

  let claude: 'no' | 'yes' | 'max20' = 'no'
  let copilot: 'no' | 'yes' = 'no'
  let gemini: 'no' | 'yes' = 'no'
  let openai: 'no' | 'yes' = 'no'
  let opencodeZen: 'no' | 'yes' = 'no'
  let zaiCodingPlan: 'no' | 'yes' = 'no'
  let kimiForCoding: 'no' | 'yes' = 'no'

  for (const provider of providers) {
    if (!VALID_OMO_PROVIDERS.includes(provider as OmoProviderInput)) {
      throw new Error(`Invalid omo-providers value: "${provider}". Valid values: ${VALID_OMO_PROVIDERS.join(', ')}`)
    }

    switch (provider) {
      case 'claude':
        claude = 'yes'
        break
      case 'claude-max20':
        claude = 'max20'
        break
      case 'copilot':
        copilot = 'yes'
        break
      case 'gemini':
        gemini = 'yes'
        break
      case 'openai':
        openai = 'yes'
        break
      case 'opencode-zen':
        opencodeZen = 'yes'
        break
      case 'zai-coding-plan':
        zaiCodingPlan = 'yes'
        break
      case 'kimi-for-coding':
        kimiForCoding = 'yes'
        break
    }
  }

  return {
    claude,
    copilot,
    gemini,
    openai,
    opencodeZen,
    zaiCodingPlan,
    kimiForCoding,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isForkPullRequestPayload(payload: unknown): boolean {
  if (isRecord(payload) === false) {
    return false
  }

  const pullRequest = payload.pull_request
  if (isRecord(pullRequest) === false) {
    return false
  }

  const head = pullRequest.head
  if (isRecord(head) === false) {
    return false
  }

  const repo = head.repo
  if (isRecord(repo) === false) {
    return false
  }

  return repo.fork === true
}

function parseSseEncryption(input: string): ObjectStoreConfig['sseEncryption'] {
  if (input.length === 0) {
    return undefined
  }

  if (input === 'aws:kms' || input === 'AES256') {
    return input
  }

  throw new Error("s3-sse-encryption must be either 'aws:kms' or 'AES256'")
}

/**
 * Parse and validate action inputs from GitHub Actions environment.
 * Inputs are defined per RFC-001.
 *
 * @returns Result containing validated ActionInputs or an Error
 */
export function parseActionInputs(): Result<ActionInputs, Error> {
  try {
    const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim() ?? ''
    if (awsAccessKeyId.length > 0) {
      core.setSecret(awsAccessKeyId)
    }

    const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim() ?? ''
    if (awsSecretAccessKey.length > 0) {
      core.setSecret(awsSecretAccessKey)
    }

    // Required inputs
    const githubToken = core.getInput('github-token', {required: true}).trim()
    if (githubToken.length === 0) {
      return err(new Error('github-token is required but was not provided'))
    }

    const authJson = core.getInput('auth-json', {required: true}).trim()
    if (authJson.length === 0) {
      return err(new Error('auth-json is required but was not provided'))
    }
    validateJsonString(authJson, 'auth-json')

    // Optional string inputs (null if empty)
    const promptRaw = core.getInput('prompt').trim()
    const prompt = promptRaw.length > 0 ? promptRaw : null

    const outputModeRaw = core.getInput('output-mode').trim().toLowerCase()
    const outputMode: OutputMode = outputModeRaw.length > 0 ? parseOutputMode(outputModeRaw) : 'auto'

    // Optional numeric input with default
    const sessionRetentionRaw = core.getInput('session-retention').trim()
    const sessionRetention =
      sessionRetentionRaw.length > 0
        ? validatePositiveInteger(sessionRetentionRaw, 'session-retention')
        : DEFAULT_SESSION_RETENTION

    // S3 backup configuration
    const s3BackupRaw = core.getInput('s3-backup').trim().toLowerCase()
    const s3Backup = s3BackupRaw === 'true'

    const s3BucketRaw = core.getInput('s3-bucket').trim()
    const s3Bucket = s3BucketRaw.length > 0 ? s3BucketRaw : ''

    const awsRegionRaw = core.getInput('aws-region').trim()
    const awsRegion = awsRegionRaw.length > 0 ? awsRegionRaw : ''

    const s3EndpointRaw = core.getInput('s3-endpoint').trim()
    const s3Endpoint = s3EndpointRaw.length > 0 ? s3EndpointRaw : undefined

    const s3PrefixRaw = core.getInput('s3-prefix').trim()
    const s3Prefix = s3PrefixRaw.length > 0 ? s3PrefixRaw : DEFAULT_S3_PREFIX

    const s3ExpectedBucketOwnerRaw = core.getInput('s3-expected-bucket-owner').trim()
    const s3ExpectedBucketOwner = s3ExpectedBucketOwnerRaw.length > 0 ? s3ExpectedBucketOwnerRaw : undefined

    const s3AllowInsecureEndpointRaw = core.getInput('s3-allow-insecure-endpoint').trim().toLowerCase()
    const s3AllowInsecureEndpoint = s3AllowInsecureEndpointRaw === 'true'

    const s3SseKmsKeyIdRaw = core.getInput('s3-sse-kms-key-id').trim()
    const s3SseKmsKeyId = s3SseKmsKeyIdRaw.length > 0 ? s3SseKmsKeyIdRaw : undefined

    const s3SseEncryptionRaw = core.getInput('s3-sse-encryption').trim()
    const s3SseEncryption = parseSseEncryption(s3SseEncryptionRaw)

    let storeConfig: ObjectStoreConfig = {
      enabled: s3Backup,
      bucket: s3Bucket,
      region: awsRegion,
      prefix: s3Prefix,
      endpoint: s3Endpoint,
      expectedBucketOwner: s3ExpectedBucketOwner,
      allowInsecureEndpoint: s3AllowInsecureEndpoint,
      sseEncryption: s3SseEncryption,
      sseKmsKeyId: s3SseKmsKeyId,
    }

    if (storeConfig.enabled) {
      if (storeConfig.bucket.length === 0) {
        throw new Error('s3-bucket is required when s3-backup is enabled')
      }

      const prefixResult = validatePrefix(storeConfig.prefix)
      if (!prefixResult.success) {
        throw prefixResult.error
      }

      if (storeConfig.endpoint != null) {
        const endpointResult = validateEndpoint(storeConfig.endpoint, storeConfig.allowInsecureEndpoint === true)
        if (!endpointResult.success) {
          throw endpointResult.error
        }
      }

      if (isForkPullRequestPayload(github.context.payload)) {
        core.warning('S3 object store is disabled for fork pull requests')
        storeConfig = {
          ...storeConfig,
          enabled: false,
        }
      }
    }

    // RFC-013: SDK execution configuration
    const agentRaw = core.getInput('agent').trim()
    const agent = agentRaw.length > 0 ? agentRaw : DEFAULT_AGENT

    const modelRaw = core.getInput('model').trim()
    const model = modelRaw.length > 0 ? parseModelInput(modelRaw) : null

    const timeoutRaw = core.getInput('timeout').trim()
    const timeoutMs = timeoutRaw.length > 0 ? parseTimeoutMs(timeoutRaw) : DEFAULT_TIMEOUT_MS

    // Setup consolidation inputs
    const opencodeVersionRaw = core.getInput('opencode-version').trim()
    const opencodeVersion = opencodeVersionRaw.length > 0 ? opencodeVersionRaw : DEFAULT_OPENCODE_VERSION

    const skipCacheRaw = core.getInput('skip-cache').trim().toLowerCase()
    const skipCache = skipCacheRaw === 'true'

    const omoVersionRaw = core.getInput('omo-version').trim()
    const omoVersion = omoVersionRaw.length > 0 ? omoVersionRaw : DEFAULT_OMO_VERSION

    const systematicVersionRaw = core.getInput('systematic-version').trim()
    const systematicVersion = systematicVersionRaw.length > 0 ? systematicVersionRaw : DEFAULT_SYSTEMATIC_VERSION

    const omoProvidersRaw = core.getInput('omo-providers').trim()
    const omoProviders = parseOmoProviders(omoProvidersRaw.length > 0 ? omoProvidersRaw : DEFAULT_OMO_PROVIDERS)

    const opencodeConfigRaw = core.getInput('opencode-config').trim()
    const opencodeConfig = opencodeConfigRaw.length > 0 ? opencodeConfigRaw : null

    const systematicConfigRaw = core.getInput('systematic-config').trim()
    const systematicConfig = systematicConfigRaw.length > 0 ? systematicConfigRaw : null

    const dedupWindowRaw = core.getInput('dedup-window').trim()
    const dedupWindow =
      dedupWindowRaw.length > 0 ? parseTimeoutMs(dedupWindowRaw, 'dedup-window') : DEFAULT_DEDUP_WINDOW_MS

    // Validate opencode-config is valid JSON if provided
    if (opencodeConfig != null) {
      validateJsonString(opencodeConfig, 'opencode-config')

      const parsedOpencodeConfig: unknown = JSON.parse(opencodeConfig)
      const isObject = typeof parsedOpencodeConfig === 'object'
      const isNull = parsedOpencodeConfig == null
      const isArray = Array.isArray(parsedOpencodeConfig)

      if (!isObject || isNull || isArray) {
        throw new Error("Input 'opencode-config' must be a JSON object")
      }
    }

    return ok({
      githubToken,
      authJson,
      prompt,
      outputMode,
      sessionRetention,
      storeConfig,
      agent,
      model,
      timeoutMs,
      opencodeVersion,
      skipCache,
      omoVersion,
      systematicVersion,
      omoProviders,
      opencodeConfig,
      systematicConfig,
      dedupWindow,
    })
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

function parseOutputMode(input: string): OutputMode {
  if (!VALID_OUTPUT_MODES.includes(input as OutputModeInput)) {
    throw new Error(`Invalid output-mode value: "${input}". Valid values: ${VALID_OUTPUT_MODES.join(', ')}`)
  }

  switch (input) {
    case 'auto':
    case 'working-dir':
    case 'branch-pr':
      return input
    default:
      throw new Error(`Invalid output-mode value: "${input}". Valid values: ${VALID_OUTPUT_MODES.join(', ')}`)
  }
}
