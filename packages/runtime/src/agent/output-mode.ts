import type {OutputMode, ResolvedOutputMode} from '../shared/types.js'
import type {EventType} from './types.js'

export type {OutputMode, ResolvedOutputMode} from '../shared/types.js'

export function resolveOutputMode(
  eventType: EventType,
  _prompt: string | null,
  configuredMode: OutputMode,
): ResolvedOutputMode | null {
  switch (eventType) {
    case 'discussion_comment':
    case 'issue_comment':
    case 'issues':
    case 'pull_request':
    case 'pull_request_review_comment':
    case 'unsupported':
      return null

    case 'schedule':
    case 'workflow_dispatch':
      switch (configuredMode) {
        case 'working-dir':
          return 'working-dir'
        case 'branch-pr':
          return 'branch-pr'
        case 'auto':
          // `auto` remains a public compatibility value, but prompts are never
          // authoritative for the output mode.
          return 'working-dir'
        default: {
          // Compile-time exhaustiveness check: adding a new OutputMode variant
          // without updating this inner switch will fail TypeScript here.
          const exhaustiveModeCheck: never = configuredMode
          return exhaustiveModeCheck
        }
      }

    default: {
      // Compile-time exhaustiveness check: adding a new EventType variant without
      // updating this switch will fail TypeScript here.
      const exhaustiveCheck: never = eventType
      return exhaustiveCheck
    }
  }
}
