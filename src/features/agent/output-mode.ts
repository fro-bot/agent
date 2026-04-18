import type {EventType} from '../../services/github/types.js'
import type {OutputMode, ResolvedOutputMode} from '../../shared/types.js'

export type {OutputMode, ResolvedOutputMode} from '../../shared/types.js'

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
      }

    default: {
      // Compile-time exhaustiveness check: adding a new EventType variant without
      // updating this switch will fail TypeScript here.
      const exhaustiveCheck: never = eventType
      return exhaustiveCheck
    }
  }
}
