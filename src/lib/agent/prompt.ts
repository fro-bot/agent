/**
 * Agent prompt construction for RFC-012.
 *
 * Builds the complete agent prompt with GitHub context, session management
 * instructions, gh CLI examples, and run summary requirements.
 */

import type {Logger} from '../logger.js'
import type {TriggerContext} from '../triggers/types.js'
import type {AgentContext, DiffContext, PromptOptions, SessionContext} from './types.js'
import {formatContextForPrompt} from '../context/index.js'
import {MAX_FILES_IN_PROMPT} from './diff-context.js'

export interface TriggerDirective {
  readonly directive: string
  readonly appendMode: boolean
}

export function getTriggerDirective(context: TriggerContext, promptInput: string | null): TriggerDirective {
  switch (context.eventType) {
    case 'issue_comment':
      return {
        directive: 'Respond to the comment above. Post your response as a single comment on this thread.',
        appendMode: true,
      }

    case 'discussion_comment':
      return {
        directive: 'Respond to the discussion comment above. Post your response as a single comment.',
        appendMode: true,
      }

    case 'issues':
      if (context.action === 'opened') {
        return {
          directive:
            'Triage this issue: summarize, reproduce if possible, propose next steps. Post your response as a single comment.',
          appendMode: true,
        }
      }
      return {
        directive: 'Respond to the mention in this issue. Post your response as a single comment.',
        appendMode: true,
      }

    case 'pull_request':
      return {
        directive: [
          'Review this pull request for code quality, potential bugs, and improvements.',
          'If you are a requested reviewer, submit a review via `gh pr review` with your full response (including Run Summary) in the --body.',
          'Include the Run Summary in the review body. Do not post a separate comment.',
          'If the author is a collaborator, prioritize actionable feedback over style nits.',
        ].join('\n'),
        appendMode: true,
      }

    case 'pull_request_review_comment':
      return {directive: buildReviewCommentDirective(context), appendMode: true}

    case 'schedule':
    case 'workflow_dispatch':
      return {directive: promptInput ?? '', appendMode: false}

    case 'unsupported':
    default:
      return {directive: 'Execute the requested operation.', appendMode: true}
  }
}

function buildReviewCommentDirective(context: TriggerContext): string {
  const target = context.target
  const lines: string[] = ['Respond to the review comment.', '']

  if (target?.path != null) {
    lines.push(`**File:** \`${target.path}\``)
  }
  if (target?.line != null) {
    lines.push(`**Line:** ${target.line}`)
  }
  if (target?.commitId != null) {
    lines.push(`**Commit:** \`${target.commitId}\``)
  }
  if (target?.diffHunk != null && target.diffHunk.length > 0) {
    lines.push('', '**Diff Context:**', '```diff', target.diffHunk, '```')
  }

  return lines.join('\n')
}

export function buildTaskSection(context: TriggerContext, promptInput: string | null): string {
  const {directive, appendMode} = getTriggerDirective(context, promptInput)
  const lines: string[] = ['## Task', '']

  if (appendMode) {
    lines.push(directive)
    if (promptInput != null && promptInput.trim().length > 0) {
      lines.push('', '**Additional Instructions:**', promptInput.trim())
    }
  } else {
    lines.push(directive)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Build the complete agent prompt with GitHub context and instructions.
 *
 * The prompt includes:
 * - Environment context (repo, branch, event, actor)
 * - Issue/PR context when applicable
 * - Triggering comment when applicable
 * - Prior session context (if available)
 * - Session management instructions
 * - gh CLI operation examples
 * - Run summary requirement
 * - Custom prompt if provided
 */
export function buildAgentPrompt(options: PromptOptions, logger: Logger): string {
  const {context, customPrompt, cacheStatus, sessionContext} = options
  const parts: string[] = []

  // System context header
  parts.push(`# Agent Context

You are the Fro Bot Agent running in a non-interactive CI environment (GitHub Actions).

## Operating Environment

- **This is NOT an interactive session.** There is no human reading your assistant messages in real time.
- Your assistant messages are logged to the GitHub Actions job output. Use them only for diagnostic information (e.g., files read, decisions made, errors encountered) that helps troubleshoot issues in CI logs.
- The human who invoked you will ONLY see what you post as a GitHub comment or review. Your assistant messages are invisible to them.
- You MUST post your response using the gh CLI (see Response Protocol below). Do not rely on assistant message output to communicate with the user.
`)

  if (customPrompt != null && customPrompt.trim().length > 0 && options.triggerContext == null) {
    parts.push(`
${customPrompt.trim()}

`)
  }

  // Task section
  if (options.triggerContext != null) {
    parts.push(buildTaskSection(options.triggerContext, customPrompt))
  } else if (context.commentBody == null) {
    parts.push(`## Task

Execute the requested operation for repository ${context.repo}. Follow all instructions and requirements listed in this prompt.
`)
  } else {
    parts.push(`## Task

Respond to the trigger comment above. Follow all instructions and requirements listed in this prompt.
`)
  }

  // Output Contract section (PR triggers only)
  if (options.triggerContext != null) {
    const eventType = options.triggerContext.eventType
    if (eventType === 'pull_request' || eventType === 'pull_request_review_comment') {
      parts.push(buildOutputContractSection(context))
    }
  }

  // Environment context
  parts.push(`
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

  // Prior session context (RFC-004 integration)
  if (sessionContext != null) {
    parts.push(buildSessionContextSection(sessionContext))
  }

  // PR diff context (RFC-009 integration)
  if (context.diffContext != null) {
    parts.push(buildDiffContextSection(context.diffContext))
  }

  // Hydrated issue/PR context (RFC-015 integration)
  if (context.hydratedContext != null) {
    parts.push(formatContextForPrompt(context.hydratedContext))
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

  if (context.issueNumber != null) {
    parts.push(buildResponseProtocolSection(context, cacheStatus, options.sessionId))
  }

  // GitHub CLI instructions
  const issueNum = context.issueNumber ?? '<number>'
  const hasResponseProtocol = context.issueNumber != null
  parts.push(`## GitHub Operations (Use gh CLI)

The \`gh\` CLI is pre-authenticated. Use it for all GitHub operations.
${
  hasResponseProtocol
    ? `
### Posting Your Response

See **Response Protocol** above. Post exactly one comment or review per run.

\`\`\`bash
# Post response as PR comment (use --body-file for long responses)
gh pr comment ${issueNum} --body "Your response with Run Summary"

# Submit PR review with response in body
gh pr review ${issueNum} --approve --body "Your review with Run Summary"

# Post response as issue comment
gh issue comment ${issueNum} --body "Your response with Run Summary"
\`\`\``
    : ''
}

### Creating PRs
\`\`\`bash
gh pr create --title "feat(scope): description" --body "Details..." --base ${context.defaultBranch} --head feature-branch
\`\`\`

### Pushing Commits
\`\`\`bash
git add .
git commit -m "type(scope): description"
git push origin HEAD
\`\`\`

### API Calls
\`\`\`bash
gh api repos/${context.repo}/issues --jq '.[].title'
gh api repos/${context.repo}/pulls/${issueNum}/files --jq '.[].filename'
\`\`\`
`)

  const prompt = parts.join('\n')
  logger.debug('Built agent prompt', {
    length: prompt.length,
    hasCustom: customPrompt != null,
    hasSessionContext: sessionContext != null,
  })
  return prompt
}

function buildResponseProtocolSection(
  context: AgentContext,
  cacheStatus: string,
  sessionId: string | undefined,
): string {
  const issueNum = context.issueNumber ?? '<number>'
  return `## Response Protocol (REQUIRED)

You MUST post exactly ONE comment or review per invocation. All of your output — your response content AND the Run Summary — goes into that single artifact.

### Rules

1. **One output per run.** Post exactly ONE comment (via \`gh issue comment\` or \`gh pr comment\`) or ONE review (via \`gh pr review\`). Never both. Never multiple comments.
2. **Include the Run Summary.** Append the Run Summary block (see template below) at the end of your response body. It is part of the same comment/review, not a separate post.
3. **NEVER post the Run Summary as a separate comment.** This is the most common mistake. The Run Summary goes INSIDE your response.
4. **Include the bot marker.** Your response must contain \`<!-- fro-bot-agent -->\` (inside the Run Summary block) so the system can identify your comment.
5. **For PR reviews:** When using \`gh pr review --approve\` or \`gh pr review --request-changes\`, put your full response (analysis + Run Summary) in the \`--body\` argument. Do not post a separate PR comment afterward.
6. **For issue/PR comments:** Post a single \`gh issue comment ${issueNum}\` or \`gh pr comment ${issueNum}\` with your full response including Run Summary.

### Unified Response Format

Every response you post — regardless of channel (issue, PR, discussion, review) — MUST follow this structure:

\`\`\`markdown
[Your response content here]

---

<!-- fro-bot-agent -->
<details>
<summary>Run Summary</summary>

| Field | Value |
|-------|-------|
| Event | ${context.eventName} |
| Repository | ${context.repo} |
| Run ID | ${context.runId} |
| Cache | ${cacheStatus} |
| Session | ${sessionId ?? '<your_session_id>'} |

</details>
\`\`\`
`
}

/**
 * Build the session context section for the prompt.
 * Provides lightweight metadata and search excerpts to avoid prompt bloat.
 */
function buildSessionContextSection(sessionContext: SessionContext): string {
  const lines: string[] = ['## Prior Session Context']

  // Recent sessions (lightweight metadata only)
  if (sessionContext.recentSessions.length > 0) {
    lines.push('')
    lines.push('### Recent Sessions')
    lines.push('| ID | Title | Updated | Messages | Agents |')
    lines.push('|----|-------|---------|----------|--------|')

    for (const session of sessionContext.recentSessions.slice(0, 5)) {
      const updatedDate = new Date(session.updatedAt).toISOString().split('T')[0]
      const agents = session.agents.join(', ') || 'N/A'
      const title = session.title || 'Untitled'
      lines.push(`| ${session.id} | ${title} | ${updatedDate} | ${session.messageCount} | ${agents} |`)
    }

    lines.push('')
    lines.push('Use `session_read` to review any of these sessions in detail.')
  }

  // Prior work context (search results)
  if (sessionContext.priorWorkContext.length > 0) {
    lines.push('')
    lines.push('### Relevant Prior Work')
    lines.push('')
    lines.push('The following sessions contain content related to this issue:')
    lines.push('')

    for (const result of sessionContext.priorWorkContext.slice(0, 3)) {
      lines.push(`**Session ${result.sessionId}:**`)
      lines.push('```markdown')
      for (const match of result.matches.slice(0, 2)) {
        lines.push(`- ${match.excerpt}`)
      }
      lines.push('```')
      lines.push('')
    }

    lines.push('Use `session_read` to review full context before starting new investigation.')
  }

  lines.push('')
  return lines.join('\n')
}

function buildDiffContextSection(diffContext: DiffContext): string {
  const lines: string[] = ['## Pull Request Diff Summary']
  lines.push('')
  lines.push(`- **Changed Files:** ${diffContext.changedFiles}`)
  lines.push(`- **Additions:** +${diffContext.additions}`)
  lines.push(`- **Deletions:** -${diffContext.deletions}`)

  if (diffContext.truncated) {
    lines.push('- **Note:** Diff was truncated due to size limits')
  }

  if (diffContext.files.length > 0) {
    lines.push('')
    lines.push('### Changed Files')
    lines.push('| File | Status | +/- |')
    lines.push('|------|--------|-----|')

    for (const file of diffContext.files.slice(0, MAX_FILES_IN_PROMPT)) {
      lines.push(`| \`${file.filename}\` | ${file.status} | +${file.additions}/-${file.deletions} |`)
    }

    if (diffContext.files.length > MAX_FILES_IN_PROMPT) {
      lines.push(`| ... | | +${diffContext.files.length - MAX_FILES_IN_PROMPT} more files |`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

function buildOutputContractSection(context: AgentContext): string {
  const lines: string[] = ['## Output Contract', '']
  lines.push(`- Review action: approve/request-changes if confident; otherwise comment-only`)
  lines.push(`- Requested reviewer: ${context.isRequestedReviewer ? 'yes' : 'no'}`)
  if (context.authorAssociation != null) {
    lines.push(`- Author association: ${context.authorAssociation}`)
  }
  lines.push('')
  return lines.join('\n')
}
