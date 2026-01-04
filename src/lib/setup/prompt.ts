import type {Logger, PromptContext} from './types.js'
import process from 'node:process'

/**
 * Build the agent prompt with GitHub context.
 *
 * The prompt instructs the agent to:
 * 1. Use session tools to search prior work
 * 2. Use gh CLI for GitHub operations
 * 3. Include run summary in comments
 */
export function buildAgentPrompt(context: PromptContext, customPrompt: string | null, logger: Logger): string {
  const parts: string[] = []

  // System context
  parts.push(`# Agent Context

You are the Fro Bot Agent running in GitHub Actions.

## Environment
- **Repository:** ${context.repo}
- **Branch/Ref:** ${context.ref}
- **Event:** ${context.eventName}
- **Actor:** ${context.actor}
`)

  // Event-specific context
  if (context.issueNumber != null) {
    parts.push(`## Issue/PR Context
- **Number:** #${context.issueNumber}
- **Title:** ${context.issueTitle ?? 'N/A'}
`)
  }

  if (context.commentBody != null) {
    parts.push(`## Trigger Comment
\`\`\`
${context.commentBody}
\`\`\`
`)
  }

  // Session instructions
  parts.push(`## Session Management (REQUIRED)

Before investigating any issue:
1. Use \`session_search\` to find relevant prior sessions
2. Use \`session_read\` to review prior work if found
3. Avoid repeating investigation already done

Before completing:
1. Ensure session contains a summary of work done
2. This summary will be searchable in future runs
`)

  // GitHub CLI instructions
  parts.push(`## GitHub Operations (Use gh CLI)

For all GitHub operations, use the \`gh\` CLI which is pre-authenticated:

### Commenting
\`\`\`bash
gh issue comment <number> --body "message"
gh pr comment <number> --body "message"
\`\`\`

### Creating PRs
\`\`\`bash
gh pr create --title "title" --body "description" --base main --head feature-branch
\`\`\`

### Pushing Commits
\`\`\`bash
git add .
git commit -m "type(scope): description"
git push origin HEAD
\`\`\`

### API Calls
\`\`\`bash
gh api repos/{owner}/{repo}/issues --jq '.[].title'
\`\`\`
`)

  // Run summary requirement
  parts.push(`## Run Summary (REQUIRED)

Every comment you post MUST include a collapsed details block:

\`\`\`markdown
<details>
<summary>Run Summary</summary>

| Field | Value |
|-------|-------|
| Event | ${context.eventName} |
| Repo | ${context.repo} |
| Session | <session_id> |
| Cache | hit/miss |

</details>
\`\`\`
`)

  // Custom prompt if provided
  if (customPrompt != null && customPrompt.length > 0) {
    parts.push(`## Custom Instructions

${customPrompt}
`)
  }

  // Task
  if (context.commentBody != null) {
    parts.push(`## Task

Respond to the trigger comment above. Follow all instructions and requirements.
`)
  }

  const prompt = parts.join('\n')
  logger.debug('Built agent prompt', {length: prompt.length})
  return prompt
}

/**
 * Extract prompt context from GitHub Actions environment.
 */
export function extractPromptContext(): PromptContext {
  const eventName = process.env.GITHUB_EVENT_NAME ?? 'unknown'
  const repo = process.env.GITHUB_REPOSITORY ?? 'unknown/unknown'
  const ref = process.env.GITHUB_REF_NAME ?? 'main'
  const actor = process.env.GITHUB_ACTOR ?? 'unknown'

  // These would be extracted from the event payload in the actual implementation
  return {
    eventName,
    repo,
    ref,
    actor,
    issueNumber: null,
    issueTitle: null,
    commentBody: null,
    prNumber: null,
  }
}
