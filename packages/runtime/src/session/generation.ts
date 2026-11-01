import type {Result} from '@bfra.me/es/result'
import type {SessionGeneration} from './version.js'

import {err, ok} from '@bfra.me/es/result'

export interface UnparseableVersion {
  readonly kind: 'unparseable-version'
}

/** `2.2.0`, `v2.2.0` and `1.19.4+harness.3` all lead with `major.minor.patch`. */
const VERSION_PATTERN = /^v?(\d+)\.\d+\.\d+/

/**
 * Which OpenCode generation a version string selects: a major of 2 or above is V2, anything older is V1.
 *
 * The one selector the gateway, the Action's cache keys and every later caller share, so they cannot disagree about a
 * version. A missing version predates the report and runs V1. A version that is present but unreadable selects
 * nothing: guessing could point the V1 loop at a V2 server, or the other way round. A caller that must always pick a
 * side (the Action's cache keys) decides what unreadable means for it; this function does not.
 */
export function selectOpenCodeGeneration(version: string | undefined): Result<SessionGeneration, UnparseableVersion> {
  if (version === undefined) return ok('v1')
  const match = VERSION_PATTERN.exec(version)
  const major = match?.[1]
  if (major === undefined) return err({kind: 'unparseable-version'})
  return ok(Number(major) >= 2 ? 'v2' : 'v1')
}
