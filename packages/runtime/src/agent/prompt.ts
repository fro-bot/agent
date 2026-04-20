/**
 * Agent prompt construction for RFC-012.
 *
 * Builds the complete agent prompt with GitHub context, session management
 * instructions, gh CLI examples, and run summary requirements.
 */

import type {Logger} from '../shared/logger.js'
import type {ResolvedOutputMode} from './output-mode.js'
import type {
  AgentContext,
  DiffContext,
  HydratedContext,
  PromptOptions,
  PromptResult,
  ReferenceFile,
  SessionContext,
  SessionSearchResult,
  TriggerContext,
} from './types.js'
import {cleanMarkdownBody} from '../shared/format.js'
import {
  buildCurrentThreadContextSection,
  buildHarnessRulesSection,
  buildThreadIdentitySection,
} from './prompt-thread.js'

export interface TriggerDirective {
  readonly directive: string
  readonly appendMode: boolean
}

function wrapXml(tag: string, content: string): string {
  return `<${tag}>\n${content.trim()}\n</${tag}>`
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

function buildDeliveryModePreamble(resolvedMode: ResolvedOutputMode): string {
  if (resolvedMode === 'working-dir') {
    return [
      '## Delivery Mode',
      '- **Resolved output mode:** `working-dir`',
      '- Write all requested file changes directly in the checked-out working tree.',
      '- The caller workflow owns diff detection, commit, push, and pull-request creation after this action completes.',
      '- Available actions: read files, edit files, create files in the working tree, run non-mutating shell commands.',
      '- Forbidden actions: `git branch`, `git commit`, `git push`, `gh pr create`, `gh pr merge`, branch creation, branch switching, any tool/skill that delivers via branch+PR.',
      '- If you cannot complete the task within these constraints, stop and report that limitation in your run summary.',
      '',
    ].join('\n')
  }

  return [
    '## Delivery Mode',
    '- **Resolved output mode:** `branch-pr`',
    '- Deliver the result through a branch/commit/push/pull-request workflow.',
    '- Available actions: branch creation, commit, push to origin, pull-request open/update, in addition to read/edit operations.',
    '- Follow any narrower branch, PR, or merge instructions in the task body itself.',
    '',
  ].join('\n')
}

export function buildTaskSection(
  context: TriggerContext,
  promptInput: string | null,
  resolvedMode: ResolvedOutputMode | null,
): string {
  const {directive, appendMode} = getTriggerDirective(context, promptInput)
  const lines: string[] = []

  if ((context.eventType === 'schedule' || context.eventType === 'workflow_dispatch') && resolvedMode != null) {
    lines.push(buildDeliveryModePreamble(resolvedMode))
  }

  lines.push('## Task')

  if (appendMode) {
    lines.push(directive)
  } else {
    lines.push(directive)
  }

  lines.push('')
  return lines.join('\n')
}

function buildAgentContextSection(context: AgentContext, cacheStatus: string, sessionId: string | undefined): string {
  const issueNum = context.issueNumber ?? '<number>'
  const hasResponseProtocol = context.issueNumber != null

  const lines: string[] = [
    '## Agent Context',
    'You are the Fro Bot Agent running in a non-interactive CI environment (GitHub Actions).',
    '',
    '### Operating Environment',
    '- **This is NOT an interactive session.** There is no human reading your assistant messages in real time.',
    '- Your assistant messages are logged to the GitHub Actions job output. Use them only for diagnostic information (e.g., files read, decisions made, errors encountered) that helps troubleshoot issues in CI logs.',
    '- The human who invoked you will ONLY see what you post as a GitHub comment or review. Your assistant messages are invisible to them.',
    '- You MUST post your response using the gh CLI (see Response Protocol below). Do not rely on assistant message output to communicate with the user.',
    '',
    '### Session Management (REQUIRED)',
    'Before investigating any issue:',
    '1. Use `session_search` to find relevant prior sessions for this repository',
    '2. Use `session_read` to review prior work if found',
    '3. Avoid repeating investigation already completed in previous sessions',
    '',
    'Before completing:',
    '1. Ensure your session contains a summary of work done',
    '2. Include key decisions, findings, and outcomes',
    '3. This summary will be searchable in future agent runs',
  ]

  if (context.issueNumber != null) {
    lines.push('', buildResponseProtocolSection(context, cacheStatus, sessionId))
  }

  lines.push(
    '',
    `### GitHub Operations
The \`gh\` CLI is pre-authenticated. Use it for all GitHub operations.${
      hasResponseProtocol
        ? ` Post exactly one comment or review per run (see Response Protocol).

\`\`\`bash
gh pr comment ${issueNum} --body "Your response with Run Summary"
gh pr review ${issueNum} --approve --body "Your review with Run Summary"
gh issue comment ${issueNum} --body "Your response with Run Summary"
gh api repos/${context.repo}/pulls/${issueNum}/files --jq '.[].filename'
\`\`\``
        : ''
    }`,
  )

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
export function buildAgentPrompt(options: PromptOptions, logger: Logger): PromptResult {
  const {
    context,
    customPrompt,
    cacheStatus,
    sessionContext,
    logicalKey,
    isContinuation,
    currentThreadSessionId,
    resolvedOutputMode,
  } = options
  const parts: string[] = []
  const referenceFiles: ReferenceFile[] = []
  const continuationEnabled = isContinuation === true
  const cleanedCommentBody = context.commentBody == null ? null : cleanMarkdownBody(context.commentBody)
  const triggerCommentEvent = options.triggerContext?.eventType ?? context.eventName
  const renderTriggerComment =
    cleanedCommentBody != null &&
    (triggerCommentEvent === 'issue_comment' ||
      triggerCommentEvent === 'discussion_comment' ||
      triggerCommentEvent === 'pull_request_review_comment')

  parts.push(wrapXml('harness_rules', buildHarnessRulesSection()))

  const threadIdentitySection = buildThreadIdentitySection(logicalKey ?? null, continuationEnabled, null)
  if (threadIdentitySection.length > 0) {
    parts.push(wrapXml('identity', threadIdentitySection))
  }

  const currentThreadContextText =
    sessionContext != null && continuationEnabled && currentThreadSessionId != null
      ? buildCurrentThreadPriorWorkText(sessionContext.priorWorkContext, currentThreadSessionId)
      : null

  parts.push(
    wrapXml(
      'environment',
      `## Environment
- **Repository:** ${context.repo}
- **Branch/Ref:** ${context.ref}
- **Event:** ${context.eventName}
- **Actor:** ${context.actor}
- **Run ID:** ${context.runId}
- **Cache Status:** ${cacheStatus}
`,
    ),
  )

  if (context.hydratedContext != null) {
    const extracted = extractExternalContent(context.hydratedContext)
    for (const file of extracted) {
      referenceFiles.push(file)
    }
    parts.push(
      wrapXml(
        context.hydratedContext.type === 'pull_request' ? 'pull_request' : 'issue',
        buildHydratedContextSection(context.hydratedContext, extracted, context.diffContext),
      ),
    )
  } else if (context.diffContext != null && context.issueType === 'pr' && context.issueNumber != null) {
    parts.push(
      wrapXml(
        'pull_request',
        buildDiffOnlyPullRequestSection(context.issueNumber, context.issueTitle, context.diffContext),
      ),
    )
  } else if (context.issueNumber != null) {
    const typeLabel = context.issueType === 'pr' ? 'Pull Request' : 'Issue'
    parts.push(
      wrapXml(
        context.issueType === 'pr' ? 'pull_request' : 'issue',
        `## ${typeLabel} #${context.issueNumber}
- **Title:** ${context.issueTitle ?? 'N/A'}
- **Type:** ${context.issueType ?? 'unknown'}
`,
      ),
    )
  }

  if (sessionContext != null) {
    const historicalSection = buildHistoricalSessionContext(
      sessionContext,
      continuationEnabled,
      currentThreadSessionId,
      currentThreadContextText != null,
    )
    if (historicalSection != null && historicalSection.content.trim().length > 0) {
      parts.push(wrapXml('session_context', historicalSection.content))
    }
  }

  const trimmedCustomPrompt = customPrompt?.trim() ?? null
  const trimmedCommentBody = cleanedCommentBody?.trim() ?? null
  const triggerCommentDuplicatesTask =
    trimmedCustomPrompt != null &&
    trimmedCustomPrompt.length > 0 &&
    trimmedCommentBody != null &&
    trimmedCommentBody.length > 0 &&
    trimmedCustomPrompt === trimmedCommentBody

  if (renderTriggerComment && !triggerCommentDuplicatesTask) {
    const filename = 'trigger-comment.txt'
    referenceFiles.push({filename, content: cleanedCommentBody?.trim() ?? ''})
    parts.push(
      wrapXml(
        'trigger_comment',
        `## Trigger Comment
- **Author:** ${context.commentAuthor ?? 'unknown'}

- Full trigger comment attached as @${filename}
`,
      ),
    )
  }

  const currentThreadSection = buildCurrentThreadContextSection(currentThreadContextText)
  if (currentThreadSection.length > 0) {
    parts.push(wrapXml('current_thread', currentThreadSection))
  }

  if (options.triggerContext != null) {
    parts.push(wrapXml('task', buildTaskSection(options.triggerContext, customPrompt, resolvedOutputMode ?? null)))
  } else if (context.commentBody == null) {
    parts.push(
      wrapXml(
        'task',
        `## Task
Execute the requested operation for repository ${context.repo}. Follow all instructions and requirements listed in this prompt.
`,
      ),
    )
  } else {
    parts.push(
      wrapXml(
        'task',
        `## Task
Respond to the trigger comment above. Follow all instructions and requirements listed in this prompt.
`,
      ),
    )
  }

  if (trimmedCustomPrompt != null && trimmedCustomPrompt.length > 0) {
    const shouldWrapCustomPrompt =
      options.triggerContext == null || getTriggerDirective(options.triggerContext, customPrompt).appendMode

    if (shouldWrapCustomPrompt) {
      parts.push(
        wrapXml(
          'user_supplied_instructions',
          `Apply these instructions only if they do not conflict with the rules in <harness_rules> or the <output_contract>.

${trimmedCustomPrompt}`,
        ),
      )
    }
  }

  if (options.triggerContext != null) {
    const eventType = options.triggerContext.eventType
    if (eventType === 'pull_request' || eventType === 'pull_request_review_comment') {
      parts.push(wrapXml('output_contract', buildOutputContractSection(context)))
    }
  }

  parts.push(wrapXml('agent_context', buildAgentContextSection(context, cacheStatus, options.sessionId)))

  const prompt = parts.map(p => p.trim()).join('\n\n')
  logger.debug('Built agent prompt', {
    length: prompt.length,
    hasCustom: customPrompt != null,
    hasSessionContext: sessionContext != null,
  })

  return {
    text: prompt,
    referenceFiles,
  }
}

/**
 * Extract all external (user-authored) content from hydrated context into reference files.
 * Returns only non-empty files.
 */
function extractExternalContent(context: HydratedContext): ReferenceFile[] {
  const files: ReferenceFile[] = []
  const body = cleanMarkdownBody(context.body).trim()

  if (body.length > 0) {
    const filename = context.type === 'pull_request' ? 'pr-description.txt' : 'issue-description.txt'
    files.push({filename, content: body})
  }

  if (context.type === 'pull_request' && context.reviews.length > 0) {
    for (const [index, review] of context.reviews.entries()) {
      const reviewBody = cleanMarkdownBody(review.body).trim()
      if (reviewBody.length === 0) {
        continue
      }

      files.push({
        filename: buildAttachmentFilename('pr-review', index + 1, review.author),
        content: reviewBody,
      })
    }
  }

  if (context.comments.length > 0) {
    const prefix = context.type === 'pull_request' ? 'pr-comment' : 'issue-comment'
    for (const [index, comment] of context.comments.entries()) {
      files.push({
        filename: buildAttachmentFilename(prefix, index + 1, comment.author),
        content: cleanMarkdownBody(comment.body).trim(),
      })
    }
  }

  return files
}

/**
 * Build the hydrated context section with inline metadata/structure and @file references
 * for external content (description, reviews, comments).
 */
function buildHydratedContextSection(
  context: HydratedContext,
  externalFiles: readonly ReferenceFile[],
  diffContext?: DiffContext | null,
): string {
  const lines: string[] = []
  const fileMap = new Map(externalFiles.map(f => [f.filename, f]))

  if (context.type === 'pull_request') {
    lines.push(`## Pull Request #${context.number}`)
    lines.push(`- **Title:** ${context.title}`)
    lines.push(`- **State:** ${context.state}`)
    lines.push(`- **Author:** ${context.author ?? 'unknown'}`)
    lines.push(`- **Created:** ${context.createdAt}`)
    lines.push(`- **Base:** ${context.baseBranch} ← **Head:** ${context.headBranch}`)
    if (context.isFork) {
      lines.push('- **Fork:** Yes (external contributor)')
    }
    if (context.labels.length > 0) {
      lines.push(`- **Labels:** ${context.labels.map(l => l.name).join(', ')}`)
    }
    if (context.assignees.length > 0) {
      lines.push(`- **Assignees:** ${context.assignees.map(a => a.login).join(', ')}`)
    }

    const descFile = fileMap.get('pr-description.txt')
    if (descFile != null) {
      lines.push(`- **Description:** @pr-description.txt`)
    }
    if (diffContext != null) {
      lines.push(`- **Changed Files:** ${diffContext.changedFiles}`)
      lines.push(`- **Additions:** +${diffContext.additions}`)
      lines.push(`- **Deletions:** -${diffContext.deletions}`)
    }
    if (context.bodyTruncated) {
      lines.push('*Note: Description was truncated due to size limits.*')
    }

    if (context.files.length > 0) {
      const mergedStatuses = mergeDiffStatuses(context, diffContext)
      lines.push('')
      lines.push(
        `### Files Changed (${context.files.length}${context.filesTruncated ? ` of ${context.totalFiles}` : ''})`,
      )
      if (mergedStatuses == null) {
        lines.push('| File | +/- |')
        lines.push('|------|-----|')
        for (const file of context.files) {
          lines.push(`| \`${file.path}\` | +${file.additions}/-${file.deletions} |`)
        }
      } else {
        lines.push('| File | Status | +/- |')
        lines.push('|------|--------|-----|')
        for (const file of context.files) {
          lines.push(
            `| \`${file.path}\` | ${mergedStatuses.get(file.path) ?? 'unknown'} | +${file.additions}/-${file.deletions} |`,
          )
        }
      }
    }

    if (context.commits.length > 0) {
      lines.push('')
      lines.push(
        `### Commits (${context.commits.length}${context.commitsTruncated ? ` of ${context.totalCommits}` : ''})`,
      )
      for (const commit of context.commits) {
        const shortOid = commit.oid.slice(0, 7)
        lines.push(`- \`${shortOid}\` ${commit.message.split('\n')[0]}`)
      }
    }

    lines.push('')
    lines.push(
      `### Reviews (${context.reviews.length}${context.reviewsTruncated ? ` of ${context.totalReviews}` : ''})`,
    )
    if (context.reviews.length === 0) {
      lines.push('[none]')
    } else {
      for (const [index, review] of context.reviews.entries()) {
        if (index > 0) {
          lines.push('')
        }

        lines.push(`- **Author:** ${review.author ?? 'unknown'}`)
        lines.push(`- **Status:** ${review.state}`)

        const reviewFilename = buildAttachmentFilename('pr-review', index + 1, review.author)
        if (fileMap.has(reviewFilename)) {
          lines.push(`- **Body:** @${reviewFilename}`)
        }
      }
    }

    lines.push('')
    lines.push(
      `### Comments (${context.comments.length}${context.commentsTruncated ? ` of ${context.totalComments}` : ''})`,
    )
    if (context.comments.length === 0) {
      lines.push('[none]')
    } else {
      for (const [index, comment] of context.comments.entries()) {
        if (index > 0) {
          lines.push('')
        }

        const commentFilename = buildAttachmentFilename('pr-comment', index + 1, comment.author)
        lines.push(`- **Author:** ${comment.author ?? 'unknown'}`)
        lines.push(`- **Date:** ${comment.createdAt}`)
        lines.push(`- **Body:** @${commentFilename}`)
      }
    }
  } else {
    lines.push(`## Issue #${context.number}`)
    lines.push(`- **Title:** ${context.title}`)
    lines.push(`- **State:** ${context.state}`)
    lines.push(`- **Author:** ${context.author ?? 'unknown'}`)
    lines.push(`- **Created:** ${context.createdAt}`)
    if (context.labels.length > 0) {
      lines.push(`- **Labels:** ${context.labels.map(l => l.name).join(', ')}`)
    }
    if (context.assignees.length > 0) {
      lines.push(`- **Assignees:** ${context.assignees.map(a => a.login).join(', ')}`)
    }

    const bodyFile = fileMap.get('issue-description.txt')
    if (bodyFile != null) {
      lines.push(`- **Body:** @issue-description.txt`)
    }
    if (context.bodyTruncated) {
      lines.push('*Note: Body was truncated due to size limits.*')
    }

    lines.push('')
    lines.push(
      `### Comments (${context.comments.length}${context.commentsTruncated ? ` of ${context.totalComments}` : ''})`,
    )
    if (context.comments.length === 0) {
      lines.push('[none]')
    } else {
      for (const [index, comment] of context.comments.entries()) {
        if (index > 0) {
          lines.push('')
        }

        const commentFilename = buildAttachmentFilename('issue-comment', index + 1, comment.author)
        lines.push(`- **Author:** ${comment.author ?? 'unknown'}`)
        lines.push(`- **Date:** ${comment.createdAt}`)
        lines.push(`- **Body:** @${commentFilename}`)
      }
    }
  }

  return lines.join('\n')
}

function buildAttachmentFilename(prefix: string, index: number, author: string | null): string {
  const slug = (author ?? 'unknown')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '')

  return `${prefix}-${String(index).padStart(3, '0')}-${slug.length > 0 ? slug : 'unknown'}.txt`
}

function mergeDiffStatuses(
  context: Extract<HydratedContext, {readonly type: 'pull_request'}>,
  diffContext: DiffContext | null | undefined,
): ReadonlyMap<string, string> | null {
  if (diffContext == null || context.files.length === 0 || diffContext.files.length !== context.files.length) {
    return null
  }

  const statusMap = new Map(diffContext.files.map(file => [file.filename, file.status]))

  for (const file of context.files) {
    if (!statusMap.has(file.path)) {
      return null
    }
  }

  return statusMap
}

function buildDiffOnlyPullRequestSection(issueNumber: number, title: string | null, diffContext: DiffContext): string {
  const lines: string[] = [`## Pull Request #${issueNumber}`]
  lines.push(`- **Title:** ${title ?? 'N/A'}`)
  lines.push(`- **Changed Files:** ${diffContext.changedFiles}`)
  lines.push(`- **Additions:** +${diffContext.additions}`)
  lines.push(`- **Deletions:** -${diffContext.deletions}`)

  if (diffContext.truncated) {
    lines.push('- **Note:** Diff was truncated due to size limits')
  }

  if (diffContext.files.length > 0) {
    lines.push('')
    lines.push('### Files Changed')
    lines.push('| File | Status | +/- |')
    lines.push('|------|--------|-----|')
    for (const file of diffContext.files) {
      lines.push(`| \`${file.filename}\` | ${file.status} | +${file.additions}/-${file.deletions} |`)
    }
  }

  return lines.join('\n')
}

function buildResponseProtocolSection(
  context: AgentContext,
  cacheStatus: string,
  sessionId: string | undefined,
): string {
  const issueNum = context.issueNumber ?? '<number>'
  return `### Response Protocol (REQUIRED)
You MUST post exactly ONE comment or review per invocation. All of your output — your response content AND the Run Summary — goes into that single artifact.
**Rules:**
1. **One output per run.** Post exactly ONE comment (via \`gh issue comment\` or \`gh pr comment\`) or ONE review (via \`gh pr review\`). Never both. Never multiple comments.
2. **Include the Run Summary.** Append the Run Summary block (see template below) at the end of your response body. It is part of the same comment/review, not a separate post.
3. **NEVER post the Run Summary as a separate comment.** This is the most common mistake. The Run Summary goes INSIDE your response.
4. **Include the bot marker.** Your response must contain \`<!-- fro-bot-agent -->\` (inside the Run Summary block) so the system can identify your comment.
5. **For PR reviews:** When using \`gh pr review --approve\` or \`gh pr review --request-changes\`, put your full response (analysis + Run Summary) in the \`--body\` argument. Do not post a separate PR comment afterward.
6. **For issue/PR comments:** Post a single \`gh issue comment ${issueNum}\` or \`gh pr comment ${issueNum}\` with your full response including Run Summary.

**Response Format:**
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
function buildSessionContextSection(
  sessionContext: SessionContext,
  sectionTitle: string,
  priorWorkContext: readonly SessionSearchResult[],
): string {
  const lines: string[] = [sectionTitle]

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

  if (priorWorkContext.length > 0) {
    lines.push('')
    lines.push('### Relevant Prior Work')
    lines.push('The following sessions contain content related to this issue:')
    lines.push('')

    for (const result of priorWorkContext.slice(0, 3)) {
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

function buildCurrentThreadPriorWorkText(
  priorWorkContext: readonly SessionSearchResult[],
  currentThreadSessionId: string,
): string | null {
  const currentThreadResults = priorWorkContext.filter(result => result.sessionId === currentThreadSessionId)

  if (currentThreadResults.length === 0) {
    return null
  }

  const lines: string[] = []
  for (const result of currentThreadResults.slice(0, 1)) {
    lines.push(`**Session ${result.sessionId}:**`)
    lines.push('```markdown')
    for (const match of result.matches.slice(0, 3)) {
      lines.push(`- ${match.excerpt}`)
    }
    lines.push('```')
  }

  return lines.join('\n')
}

function buildHistoricalSessionContext(
  sessionContext: SessionContext,
  isContinuation: boolean,
  currentThreadSessionId: string | null | undefined,
  hasCurrentThreadContext: boolean,
): {readonly title: string; readonly content: string} | null {
  if (isContinuation && currentThreadSessionId != null) {
    const relatedPriorWork = sessionContext.priorWorkContext.filter(
      result => result.sessionId !== currentThreadSessionId,
    )

    if (sessionContext.recentSessions.length === 0 && relatedPriorWork.length === 0) {
      return null
    }

    return {
      title: '## Related Historical Context',
      content: buildSessionContextSection(sessionContext, '## Related Historical Context', relatedPriorWork),
    }
  }

  if (
    sessionContext.recentSessions.length === 0 &&
    sessionContext.priorWorkContext.length === 0 &&
    hasCurrentThreadContext
  ) {
    return null
  }

  if (sessionContext.recentSessions.length === 0 && sessionContext.priorWorkContext.length === 0) {
    return null
  }

  return {
    title: '## Prior Session Context',
    content: buildSessionContextSection(sessionContext, '## Prior Session Context', sessionContext.priorWorkContext),
  }
}

function buildOutputContractSection(context: AgentContext): string {
  const lines: string[] = ['## Output Contract']
  lines.push(`- Review action: approve/request-changes if confident; otherwise comment-only`)
  lines.push(`- Requested reviewer: ${context.isRequestedReviewer ? 'yes' : 'no'}`)
  if (context.authorAssociation != null) {
    lines.push(`- Author association: ${context.authorAssociation}`)
  }
  return lines.join('\n')
}
