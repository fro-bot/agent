import type {EventType} from '../../services/github/types.js'
import type {OutputMode, ResolvedOutputMode} from '../../shared/types.js'

export type {OutputMode, ResolvedOutputMode} from '../../shared/types.js'

// Frozen phrase list for the `auto` heuristic. New branch/PR delivery phrases
// must be added here. NOTE: an additional special case is checked in
// resolveAutoMode() for `pull the request` to preserve a documented v1 false
// positive — keep the two locations in sync if you add or remove phrases.
const BRANCH_PR_PHRASES = [
  'pull request',
  'open a pr',
  'create a pr',
  'create pr',
  'gh pr ',
  'push to origin',
  'git push',
  'auto-merge',
  'create branch',
  'update branch',
  'branch workflow',
] as const

function resolveAutoMode(prompt: string | null): ResolvedOutputMode {
  const normalizedPrompt = prompt?.toLowerCase().trim() ?? ''

  if (normalizedPrompt.length === 0) {
    return 'working-dir'
  }

  for (const phrase of BRANCH_PR_PHRASES) {
    if (normalizedPrompt.includes(phrase)) {
      return 'branch-pr'
    }
  }

  // Special case (lives outside BRANCH_PR_PHRASES intentionally — see plan
  // 2026-04-17-001): the documented v1 false positive "pull the request body
  // into the summary" must resolve to branch-pr even though it does not
  // contain any of the frozen phrases verbatim.
  if (normalizedPrompt.includes('pull the request')) {
    return 'branch-pr'
  }

  return 'working-dir'
}

export function resolveOutputMode(
  eventType: EventType,
  prompt: string | null,
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
          return resolveAutoMode(prompt)
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
