import type {CacheSaveResult} from './cache-save-result.js'
import type {SpanResult} from './lifecycle-tracer.js'

// Its own module, not part of `cache-save-result.ts`: that file is reachable from the runtime package's declaration build, and
// a type import of the tracer there pulls the Action's tracer into a package that must not depend on it.
/** A cache save span's result: the save's own outcome is the reason, and only a thrown or errored save is a failure. */
export function cacheSaveSpanResult(saved: CacheSaveResult): SpanResult {
  switch (saved.outcome) {
    case 'persisted':
      return {outcome: 'succeeded', reason: saved.outcome}
    case 'cache-error':
    case 'cache-rejected':
      return {outcome: 'failed', reason: saved.outcome}
    case 'skipped-by-configuration':
    case 'skipped-empty':
    case 'checkpoint-declined':
    case 'ownership-declined':
      return {outcome: 'skipped', reason: saved.outcome}
  }
}
