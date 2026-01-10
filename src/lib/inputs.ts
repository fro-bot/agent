import type {Result} from '@bfra.me/es/result'
import type {ActionInputs, ModelConfig} from './types.js'
import * as core from '@actions/core'
import {validateJsonString, validatePositiveInteger} from '../utils/validation.js'
import {DEFAULT_AGENT, DEFAULT_SESSION_RETENTION, DEFAULT_TIMEOUT_MS} from './constants.js'
import {err, ok} from './types.js'

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

function parseTimeoutMs(value: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`timeout must be a non-negative integer, received: ${value}`)
  }

  const parsed = Number.parseInt(trimmed, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`timeout must be a non-negative integer, received: ${value}`)
  }

  return parsed
}

/**
 * Parse and validate action inputs from GitHub Actions environment.
 * Inputs are defined per RFC-001.
 *
 * @returns Result containing validated ActionInputs or an Error
 */
export function parseActionInputs(): Result<ActionInputs, Error> {
  try {
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
    const s3Bucket = s3BucketRaw.length > 0 ? s3BucketRaw : null

    const awsRegionRaw = core.getInput('aws-region').trim()
    const awsRegion = awsRegionRaw.length > 0 ? awsRegionRaw : null

    // RFC-013: SDK execution configuration
    const agentRaw = core.getInput('agent').trim()
    const agent = agentRaw.length > 0 ? agentRaw : DEFAULT_AGENT

    const modelRaw = core.getInput('model').trim()
    const model = modelRaw.length > 0 ? parseModelInput(modelRaw) : null

    const timeoutRaw = core.getInput('timeout').trim()
    const timeoutMs = timeoutRaw.length > 0 ? parseTimeoutMs(timeoutRaw) : DEFAULT_TIMEOUT_MS

    return ok({
      githubToken,
      authJson,
      prompt,
      sessionRetention,
      s3Backup,
      s3Bucket,
      awsRegion,
      agent,
      model,
      timeoutMs,
    })
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}
