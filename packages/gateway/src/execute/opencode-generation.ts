/**
 * Which OpenCode generation the workspace runs, and the selection that follows from it.
 *
 * The workspace reports its OpenCode version on its control API (`GET /readyz`, field `opencodeVersion`). The gateway
 * reads it when it attaches and runs the V1 or the V2 loop from the major version: 2 or above is V2. The workspace image
 * pin is the only switch. The gateway keeps no second setting that could disagree with it.
 *
 * The selector itself (`selectOpenCodeGeneration`) lives in `@fro-bot/runtime`, shared with the Action's cache keys.
 * A workspace that reports no version runs V1; a version that is present but unreadable selects nothing.
 */

import type {Result} from '@fro-bot/runtime'
import type {GatewayLogger} from '../discord/client.js'
import type {RepoQuiescence} from '../runtime-effect.js'
import type {ReadyzResponse, WorkspaceError} from '../workspace-api/types.js'
import type {RepoQuiescenceChecker} from './repo-quiescence.js'

import {selectOpenCodeGeneration} from '@fro-bot/runtime'

export interface GenerationAwareQuiescenceOptions {
  readonly readyz: () => Promise<Result<ReadyzResponse, WorkspaceError>>
  readonly v1: RepoQuiescenceChecker
  readonly v2: RepoQuiescenceChecker
  readonly logger: GatewayLogger
}

function unknown(reason: string): RepoQuiescence {
  return {kind: 'unknown', source: 'unavailable', directory: null, reason}
}

/**
 * A quiescence checker that picks the V1 or V2 check from the workspace's reported version on every call.
 *
 * Quiescence gates lock replacement and recovery, so it fails closed: when the workspace cannot be asked or reports a
 * version this code cannot read, the answer is `unknown`, which blocks. The version is read per call rather than cached,
 * because the workspace can be redeployed without a gateway restart.
 */
export function createGenerationAwareQuiescenceChecker(
  options: GenerationAwareQuiescenceOptions,
): RepoQuiescenceChecker {
  const {readyz, v1, v2, logger} = options

  return async context => {
    const aborted = new Promise<'aborted'>(resolve => {
      if (context.signal.aborted) resolve('aborted')
      else context.signal.addEventListener('abort', () => resolve('aborted'), {once: true})
    })
    const answer = await Promise.race([
      readyz().then(
        result => ({result}) as const,
        () => 'failed' as const,
      ),
      aborted,
    ])
    if (answer === 'aborted' || answer === 'failed' || !answer.result.success) {
      logger.warn(
        {repo: context.repo},
        'repo-quiescence: could not read the workspace OpenCode version; treating as unknown',
      )
      return unknown('generation-unavailable')
    }

    const selected = selectOpenCodeGeneration(answer.result.data.opencodeVersion)
    if (!selected.success) {
      logger.warn(
        {repo: context.repo},
        'repo-quiescence: the workspace OpenCode version is unreadable; treating as unknown',
      )
      return unknown('generation-unreadable')
    }
    return selected.data === 'v2' ? v2(context) : v1(context)
  }
}
