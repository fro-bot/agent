import type {Result} from '@bfra.me/es/result'
import type {ObjectStoreConfig} from '@fro-bot/runtime'
import type {ActionInputs, ModelConfig, OutputMode, ResponseMode} from '../../shared/types.js'
import process from 'node:process'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {parseObjectStoreSettings} from '@fro-bot/runtime'
import {parseBrokeredPushExtraPaths} from '../../shared/brokered-push-paths.js'
import {
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_OPENCODE_VERSION,
  DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS,
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

const VALID_OUTPUT_MODES = ['auto', 'working-dir', 'branch-pr'] as const
const VALID_RESPONSE_MODES = ['github', 'none'] as const

// A server that has not finished starting (runtime boot, config parse, plugin loading,
// DB open) within two minutes is not going to - it will hang until the GitHub Actions
// job timeout instead of failing fast, which is the opposite of the observability this
// input exists for. 120000ms gives generous headroom over the 5000ms SDK default for a
// contended runner while still failing well inside any realistic job timeout.
const MAX_SERVER_BOOTSTRAP_TIMEOUT_MS = 120_000

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
    // Mask the token value everywhere @actions/core controls log output. Masking is
    // by VALUE, so this also covers the GH_TOKEN/GITHUB_TOKEN copies of the same string.
    core.setSecret(githubToken)
    // Delete the raw input from env (same hyphen-key gotcha as auth-json below:
    // @actions/core maps `github-token` to `INPUT_GITHUB-TOKEN`) so the OpenCode
    // server child (spawned with `{ ...process.env }`) does not inherit this copy.
    // Note: this removes the INPUT_* copy only; GH_TOKEN is still exported for the
    // agent's own gh/git use — reducing that further is tracked as an infra change.
    delete process.env['INPUT_GITHUB-TOKEN']

    const authJson = core.getInput('auth-json', {required: true}).trim()
    if (authJson.length === 0) {
      return err(new Error('auth-json is required but was not provided'))
    }
    validateJsonString(authJson, 'auth-json')
    core.setSecret(authJson)
    // @actions/core maps input names to env vars via name.replace(/ /g, '_').toUpperCase() —
    // spaces become underscores but hyphens are preserved, so `auth-json` reads from
    // `INPUT_AUTH-JSON` (not `INPUT_AUTH_JSON`). Delete the correct key so the raw secret is
    // not inherited by the OpenCode server child (spawned with `{ ...process.env }`).
    delete process.env['INPUT_AUTH-JSON']

    // Optional string inputs (null if empty)
    const trustedHeadSha = core.getInput('trusted-head-sha').trim()

    const promptRaw = core.getInput('prompt').trim()
    const prompt = promptRaw.length > 0 ? promptRaw : null

    const outputModeRaw = core.getInput('output-mode').trim().toLowerCase()
    const outputMode: OutputMode = outputModeRaw.length > 0 ? parseOutputMode(outputModeRaw) : 'auto'

    const responseModeRaw = core.getInput('response-mode').trim().toLowerCase()
    const responseMode: ResponseMode = responseModeRaw.length > 0 ? parseResponseMode(responseModeRaw) : 'github'

    const reviewSkipLabelRaw = core.getInput('review-skip-label').trim()
    const reviewSkipLabel = reviewSkipLabelRaw.length > 0 ? reviewSkipLabelRaw : null

    const brokeredPushExtraPaths = parseBrokeredPushExtraPaths(core.getInput('brokered-push-extra-paths'))

    // Optional numeric input with default
    const sessionRetentionRaw = core.getInput('session-retention').trim()
    const sessionRetention =
      sessionRetentionRaw.length > 0
        ? validatePositiveInteger(sessionRetentionRaw, 'session-retention')
        : DEFAULT_SESSION_RETENTION

    // S3 backup configuration. Defaults and validation live in the shared runtime parser; this maps inputs onto it.
    const s3BackupRaw = core.getInput('s3-backup').trim().toLowerCase()
    const s3AllowInsecureEndpointRaw = core.getInput('s3-allow-insecure-endpoint').trim().toLowerCase()

    const storeConfigResult = parseObjectStoreSettings(
      {
        enabled: s3BackupRaw === 'true',
        bucket: {value: core.getInput('s3-bucket').trim(), source: 's3-bucket'},
        region: [{value: core.getInput('aws-region').trim(), source: 'aws-region'}],
        endpoint: {value: core.getInput('s3-endpoint').trim(), source: 's3-endpoint'},
        allowInsecureEndpoint: s3AllowInsecureEndpointRaw === 'true',
        prefix: {value: core.getInput('s3-prefix').trim(), source: 's3-prefix'},
        sseEncryption: {value: core.getInput('s3-sse-encryption').trim(), source: 's3-sse-encryption'},
        sseKmsKeyId: {value: core.getInput('s3-sse-kms-key-id').trim(), source: 's3-sse-kms-key-id'},
        expectedBucketOwner: {
          value: core.getInput('s3-expected-bucket-owner').trim(),
          source: 's3-expected-bucket-owner',
        },
      },
      {region: 'optional'},
    )
    if (storeConfigResult.success === false) {
      throw storeConfigResult.error
    }

    let storeConfig: ObjectStoreConfig = storeConfigResult.data

    if (storeConfig.enabled && isForkPullRequestPayload(github.context.payload)) {
      core.warning('S3 object store is disabled for fork pull requests')
      storeConfig = {
        ...storeConfig,
        enabled: false,
      }
    }

    // RFC-013: SDK execution configuration
    const agentRaw = core.getInput('agent').trim()
    const agent = agentRaw.length > 0 ? agentRaw : null

    const modelRaw = core.getInput('model').trim()
    const model = modelRaw.length > 0 ? parseModelInput(modelRaw) : null

    const timeoutRaw = core.getInput('timeout').trim()
    const timeoutMs = timeoutRaw.length > 0 ? parseTimeoutMs(timeoutRaw) : DEFAULT_TIMEOUT_MS

    const serverBootstrapTimeoutRaw = core.getInput('server-bootstrap-timeout').trim()
    const requestedServerBootstrapTimeoutMs =
      serverBootstrapTimeoutRaw.length > 0
        ? validatePositiveInteger(serverBootstrapTimeoutRaw, 'server-bootstrap-timeout')
        : DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS
    const serverBootstrapTimeoutMs = Math.min(requestedServerBootstrapTimeoutMs, MAX_SERVER_BOOTSTRAP_TIMEOUT_MS)
    if (serverBootstrapTimeoutMs !== requestedServerBootstrapTimeoutMs) {
      core.warning(
        `server-bootstrap-timeout of ${requestedServerBootstrapTimeoutMs}ms exceeds the maximum of ${MAX_SERVER_BOOTSTRAP_TIMEOUT_MS}ms and was clipped to ${MAX_SERVER_BOOTSTRAP_TIMEOUT_MS}ms. A server that has not started within that budget will not start.`,
      )
    }

    // Setup consolidation inputs
    const opencodeVersionRaw = core.getInput('opencode-version').trim()
    const opencodeVersion = opencodeVersionRaw.length > 0 ? opencodeVersionRaw : DEFAULT_OPENCODE_VERSION

    const skipCacheRaw = core.getInput('skip-cache').trim().toLowerCase()
    const skipCache = skipCacheRaw === 'true'

    const systematicVersionRaw = core.getInput('systematic-version').trim()
    const systematicVersion = systematicVersionRaw.length > 0 ? systematicVersionRaw : DEFAULT_SYSTEMATIC_VERSION

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
      trustedHeadSha,
      prompt,
      outputMode,
      responseMode,
      sessionRetention,
      storeConfig,
      agent,
      model,
      timeoutMs,
      serverBootstrapTimeoutMs,
      opencodeVersion,
      skipCache,
      systematicVersion,
      opencodeConfig,
      systematicConfig,
      dedupWindow,
      reviewSkipLabel,
      brokeredPushExtraPaths,
    })
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}

function parseOutputMode(input: string): OutputMode {
  switch (input) {
    case 'auto':
    case 'working-dir':
    case 'branch-pr':
      return input
    default:
      throw new Error(`Invalid output-mode value: "${input}". Valid values: ${VALID_OUTPUT_MODES.join(', ')}`)
  }
}

export function parseResponseMode(input: string): ResponseMode {
  switch (input) {
    case 'github':
    case 'none':
      return input
    default:
      throw new Error(`Invalid response-mode value: "${input}". Valid values: ${VALID_RESPONSE_MODES.join(', ')}`)
  }
}
