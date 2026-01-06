/**
 * Agent prompt construction for RFC-012.
 *
 * Builds the complete agent prompt with GitHub context, session management
 * instructions, gh CLI examples, and run summary requirements.
 */

import type {Logger} from '../logger.js'
import type {PromptOptions} from './types.js'

/**
 * Build the complete agent prompt with GitHub context and instructions.
 *
 * The prompt includes:
 * - Environment context (repo, branch, event, actor)
 * - Issue/PR context when applicable
 * - Triggering comment when applicable
 * - Session management instructions
 * - gh CLI operation examples
 * - Run summary requirement
 * - Custom prompt if provided
 */
export function buildAgentPrompt(options: PromptOptions, logger: Logger): string {
  const {context, customPrompt, cacheStatus} = options
  const parts: string[] = []

  // System context header
  parts.push(`# Agent Context

You are the Fro Bot Agent running in GitHub Actions.

## Environment
- **Repository:** ${context.repo}
- **Branch/Ref:** ${context.ref}
- **Event:** ${context.eventName}
- **Actor:** ${context.actor}
- **Run ID:** ${context.runId}
- **Cache Status:** ${cacheStatus}
`)

  // Issue/PR context
  if (context.issueNumber != null) {
    const typeLabel = context.issueType === 'pr' ? 'Pull Request' : 'Issue'
    parts.push(`## ${typeLabel} Context
- **Number:** #${context.issueNumber}
- **Title:** ${context.issueTitle ?? 'N/A'}
- **Type:** ${context.issueType ?? 'unknown'}
`)
  }

  // Triggering comment
  if (context.commentBody != null) {
    parts.push(`## Trigger Comment
**Author:** ${context.commentAuthor ?? 'unknown'}

\`\`\`
${context.commentBody}
\`\`\`
`)
  }

  // Session management instructions (REQUIRED)
  parts.push(`## Session Management (REQUIRED)

Before investigating any issue:
1. Use \`session_search\` to find relevant prior sessions for this repository
2. Use \`session_read\` to review prior work if found
3. Avoid repeating investigation already completed in previous sessions

Before completing:
1. Ensure your session contains a summary of work done
2. Include key decisions, findings, and outcomes
3. This summary will be searchable in future agent runs
`)

  // GitHub CLI instructions
  const issueNum = context.issueNumber ?? '<number>'
  parts.push(`## GitHub Operations (Use gh CLI)

The \`gh\` CLI is pre-authenticated. Use it for all GitHub operations:

### Commenting
\`\`\`bash
# Comment on issue
gh issue comment ${issueNum} --body "Your message"

# Comment on PR
gh pr comment ${issueNum} --body "Your message"
\`\`\`

### Creating PRs
\`\`\`bash
# Create a new PR
gh pr create --title "feat(scope): description" --body "Details..." --base ${context.defaultBranch} --head feature-branch
\`\`\`

### Pushing Commits
\`\`\`bash
# Commit and push changes
git add .
git commit -m "type(scope): description"
git push origin HEAD
\`\`\`

### API Calls
\`\`\`bash
# Query the GitHub API
gh api repos/${context.repo}/issues --jq '.[].title'
gh api repos/${context.repo}/pulls/${issueNum}/files --jq '.[].filename'
\`\`\`
`)

  // Run summary requirement
  parts.push(`## Run Summary (REQUIRED)

Every comment you post MUST include a collapsed details block at the end:

\`\`\`markdown
<details>
<summary>Run Summary</summary>

| Field | Value |
|-------|-------|
| Event | ${context.eventName} |
| Repository | ${context.repo} |
| Run ID | ${context.runId} |
| Cache | ${cacheStatus} |
| Session | <your_session_id> |

</details>
\`\`\`
`)

  // Custom prompt if provided
  if (customPrompt != null && customPrompt.trim().length > 0) {
    parts.push(`## Custom Instructions

${customPrompt.trim()}
`)
  }

  // Task directive
  if (context.commentBody == null) {
    parts.push(`## Task

Execute the requested operation for repository ${context.repo}. Follow all instructions and requirements listed in this prompt.
`)
  } else {
    parts.push(`## Task

Respond to the trigger comment above. Follow all instructions and requirements listed in this prompt.
`)
  }

  const prompt = parts.join('\n')
  logger.debug('Built agent prompt', {length: prompt.length, hasCustom: customPrompt != null})
  return prompt
}
