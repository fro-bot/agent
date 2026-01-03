import type {ActionOutputs} from './types.js'
import * as core from '@actions/core'

/**
 * Set action outputs for GitHub Actions.
 *
 * @param outputs - The outputs to set
 */
export function setActionOutputs(outputs: ActionOutputs): void {
  core.setOutput('session-id', outputs.sessionId ?? '')
  core.setOutput('cache-status', outputs.cacheStatus)
  core.setOutput('duration', outputs.duration)
}
