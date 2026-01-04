import type {Result} from '@bfra.me/es/result'
import type {ActionInputs} from './types.js'
import * as core from '@actions/core'
import {validateJsonString, validatePositiveInteger} from '../utils/validation.js'
import {DEFAULT_SESSION_RETENTION} from './constants.js'
import {err, ok} from './types.js'

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

    return ok({
      githubToken,
      authJson,
      prompt,
      sessionRetention,
      s3Backup,
      s3Bucket,
      awsRegion,
    })
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}
