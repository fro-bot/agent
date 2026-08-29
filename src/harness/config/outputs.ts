import type {OutputModeMigrationState} from '@fro-bot/runtime'
import type {ActionOutputs} from '../../shared/types.js'
import * as core from '@actions/core'
import {serializeBrokeredPushAllowlist} from '../../features/delegated/brokered-push-validation.js'

export function setOutputModeMigration(outputModeMigration: OutputModeMigrationState): void {
  core.setOutput('output-mode-migration', JSON.stringify(outputModeMigration))
}

/**
 * Set action outputs for GitHub Actions.
 *
 * @param outputs - The outputs to set
 */
export function setActionOutputs(outputs: ActionOutputs): void {
  core.setOutput('session-id', outputs.sessionId ?? '')
  core.setOutput('resolved-output-mode', outputs.resolvedOutputMode ?? '')
  if (outputs.outputModeMigration != null) {
    setOutputModeMigration(outputs.outputModeMigration)
  }
  core.setOutput(
    'brokered-push-allowlist',
    outputs.brokeredPushAllowlist == null ? '' : serializeBrokeredPushAllowlist(outputs.brokeredPushAllowlist),
  )
  core.setOutput('cache-status', outputs.cacheStatus)
  core.setOutput('duration', outputs.duration)
}
