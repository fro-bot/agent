import type {Result} from '@bfra.me/es/result'
import type {ActionInputs} from './types.js'
import * as core from '@actions/core'
import {DEFAULT_MAX_COMMENT_LENGTH, DEFAULT_MODEL, DEFAULT_SESSION_RETENTION_DAYS} from './constants.js'
import {err, ok} from './types.js'

/**
 * Parse and validate action inputs from GitHub Actions environment.
 *
 * @returns Result containing validated ActionInputs or an Error
 */
export function parseActionInputs(): Result<ActionInputs, Error> {
  try {
    // Required inputs
    const githubToken = core.getInput('github-token').trim()
    if (githubToken.length === 0) {
      return err(new Error('github-token is required but was not provided'))
    }

    // Optional string inputs with defaults
    const opencodeModelRaw = core.getInput('opencode-model').trim()
    const opencodeModel = opencodeModelRaw.length > 0 ? opencodeModelRaw : DEFAULT_MODEL

    // Optional numeric inputs with defaults
    const sessionRetentionDaysRaw = core.getInput('session-retention-days').trim()
    let sessionRetentionDays = DEFAULT_SESSION_RETENTION_DAYS
    if (sessionRetentionDaysRaw.length > 0) {
      const parsed = Number.parseInt(sessionRetentionDaysRaw, 10)
      if (Number.isNaN(parsed)) {
        return err(new Error(`session-retention-days must be a valid integer, received: ${sessionRetentionDaysRaw}`))
      }
      if (parsed <= 0) {
        return err(new Error(`session-retention-days must be a positive integer, received: ${parsed}`))
      }
      sessionRetentionDays = parsed
    }

    const maxCommentLengthRaw = core.getInput('max-comment-length').trim()
    let maxCommentLength = DEFAULT_MAX_COMMENT_LENGTH
    if (maxCommentLengthRaw.length > 0) {
      const parsed = Number.parseInt(maxCommentLengthRaw, 10)
      if (Number.isNaN(parsed)) {
        return err(new Error(`max-comment-length must be a valid integer, received: ${maxCommentLengthRaw}`))
      }
      if (parsed <= 0) {
        return err(new Error(`max-comment-length must be a positive integer, received: ${parsed}`))
      }
      maxCommentLength = parsed
    }

    // Boolean inputs
    const safeMode = core.getBooleanInput('safe-mode')
    const debug = core.getBooleanInput('debug')

    return ok({
      githubToken,
      opencodeModel,
      sessionRetentionDays,
      maxCommentLength,
      safeMode,
      debug,
    })
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)))
  }
}
