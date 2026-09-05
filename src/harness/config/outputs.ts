import type {OutputModeMigrationState} from '@fro-bot/runtime'
import type {CacheSaveStateValue} from '../../shared/cache-save-result.js'
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
  core.setOutput('delivery-kind', outputs.deliveryKind)
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

export function setDeliveryKindOutput(deliveryKind: ActionOutputs['deliveryKind']): void {
  core.setOutput('delivery-kind', deliveryKind)
}

/**
 * Sets the `cache-save-result` output. Called directly from `cleanup.ts` rather than
 * folded into `setActionOutputs`/`ActionOutputs` (which comes from `@fro-bot/runtime` and
 * is out of this layer's reach) -- `runFinalizeWithResult` (which calls `setActionOutputs`)
 * runs before `runCleanup`, and the cache save has not happened yet when finalize writes
 * its outputs. This is a standalone setter for the same reason `setDeliveryKindOutput`
 * is: the value it carries is only known after `setActionOutputs`'s own call site has
 * already run.
 *
 * Not called from the post-action hook: post-hook outputs are written to a step-scoped
 * `GITHUB_OUTPUT` file (`core.setOutput`, `@actions/core/lib/core.js`), but `post:` runs
 * after every other step in the job, so no later step could ever read a value set there
 * regardless of whether the write itself succeeds. See the comment at the `post.ts` retry
 * call site.
 */
export function setCacheSaveResultOutput(value: CacheSaveStateValue): void {
  core.setOutput('cache-save-result', value)
}
