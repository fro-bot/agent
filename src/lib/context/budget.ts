import type {ContextBudget, HydratedContext, IssueContext, PullRequestContext, TruncateResult} from './types.js'

export {DEFAULT_CONTEXT_BUDGET} from './types.js'

const TRUNCATION_SUFFIX = '…[truncated]'

export function truncateBody(text: string, maxBytes: number): TruncateResult {
  if (text.length === 0) {
    return {text: '', truncated: false}
  }

  const encoder = new TextEncoder()
  const encoded = encoder.encode(text)

  if (encoded.length <= maxBytes) {
    return {text, truncated: false}
  }

  const suffixBytes = encoder.encode(TRUNCATION_SUFFIX).length
  const targetBytes = maxBytes - suffixBytes

  if (targetBytes <= 0) {
    return {text: TRUNCATION_SUFFIX, truncated: true}
  }

  let truncatedBytes = encoded.slice(0, targetBytes)
  let decoded = new TextDecoder('utf-8', {fatal: false}).decode(truncatedBytes)

  while (decoded.length > 0 && decoded.charCodeAt(decoded.length - 1) === 0xfffd) {
    truncatedBytes = truncatedBytes.slice(0, -1)
    decoded = new TextDecoder('utf-8', {fatal: false}).decode(truncatedBytes)
  }

  return {text: decoded + TRUNCATION_SUFFIX, truncated: true}
}

export function estimateContextSize(context: HydratedContext): number {
  const encoder = new TextEncoder()
  const json = JSON.stringify(context)
  return encoder.encode(json).length
}

export function exceedsBudget(context: HydratedContext, budget: ContextBudget): boolean {
  const size = estimateContextSize(context)
  return size > budget.maxTotalBytes
}

function formatLabels(labels: readonly {readonly name: string}[]): string {
  if (labels.length === 0) return ''
  return `**Labels:** ${labels.map(l => `\`${l.name}\``).join(', ')}\n`
}

function formatAssignees(assignees: readonly {readonly login: string}[]): string {
  if (assignees.length === 0) return ''
  return `**Assignees:** ${assignees.map(a => `@${a.login}`).join(', ')}\n`
}

function formatIssueContext(context: IssueContext): string {
  const lines: string[] = []

  lines.push(`## Issue #${context.number}`)
  lines.push('')
  lines.push(`**Title:** ${context.title}`)
  lines.push(`**State:** ${context.state}`)
  lines.push(`**Author:** ${context.author ?? 'unknown'}`)
  lines.push(`**Created:** ${context.createdAt}`)

  const labelsStr = formatLabels(context.labels)
  if (labelsStr.length > 0) lines.push(labelsStr.trimEnd())

  const assigneesStr = formatAssignees(context.assignees)
  if (assigneesStr.length > 0) lines.push(assigneesStr.trimEnd())

  lines.push('')
  lines.push('### Body')
  lines.push('')
  lines.push(context.body)
  if (context.bodyTruncated) {
    lines.push('')
    lines.push('*Note: Body was truncated due to size limits.*')
  }

  if (context.comments.length > 0) {
    lines.push('')
    lines.push(
      `### Comments (${context.comments.length}${context.commentsTruncated ? ` of ${context.totalComments}` : ''})`,
    )
    if (context.commentsTruncated) {
      lines.push('')
      lines.push('*Note: Comments were truncated due to limits.*')
    }
    lines.push('')

    for (const comment of context.comments) {
      lines.push(`**${comment.author ?? 'unknown'}** (${comment.createdAt}):`)
      lines.push(comment.body)
      lines.push('')
    }
  }

  return lines.join('\n')
}

function formatPullRequestContext(context: PullRequestContext): string {
  const lines: string[] = []

  lines.push(`## Pull Request #${context.number}`)
  lines.push('')
  lines.push(`**Title:** ${context.title}`)
  lines.push(`**State:** ${context.state}`)
  lines.push(`**Author:** ${context.author ?? 'unknown'}`)
  lines.push(`**Created:** ${context.createdAt}`)
  lines.push(`**Base:** ${context.baseBranch} ← **Head:** ${context.headBranch}`)

  if (context.isFork) {
    lines.push('**Fork:** Yes (external contributor)')
  }

  const labelsStr = formatLabels(context.labels)
  if (labelsStr.length > 0) lines.push(labelsStr.trimEnd())

  const assigneesStr = formatAssignees(context.assignees)
  if (assigneesStr.length > 0) lines.push(assigneesStr.trimEnd())

  lines.push('')
  lines.push('### Description')
  lines.push('')
  lines.push(context.body)
  if (context.bodyTruncated) {
    lines.push('')
    lines.push('*Note: Description was truncated due to size limits.*')
  }

  if (context.files.length > 0) {
    lines.push('')
    lines.push(
      `### Files Changed (${context.files.length}${context.filesTruncated ? ` of ${context.totalFiles}` : ''})`,
    )
    lines.push('')
    lines.push('| File | +/- |')
    lines.push('|------|-----|')
    for (const file of context.files) {
      lines.push(`| \`${file.path}\` | +${file.additions}/-${file.deletions} |`)
    }
  }

  if (context.commits.length > 0) {
    lines.push('')
    lines.push(
      `### Commits (${context.commits.length}${context.commitsTruncated ? ` of ${context.totalCommits}` : ''})`,
    )
    lines.push('')
    for (const commit of context.commits) {
      const shortOid = commit.oid.slice(0, 7)
      lines.push(`- \`${shortOid}\` ${commit.message.split('\n')[0]}`)
    }
  }

  if (context.reviews.length > 0) {
    lines.push('')
    lines.push(
      `### Reviews (${context.reviews.length}${context.reviewsTruncated ? ` of ${context.totalReviews}` : ''})`,
    )
    lines.push('')
    for (const review of context.reviews) {
      lines.push(`**${review.author ?? 'unknown'}** - ${review.state}`)
      if (review.body.length > 0) {
        lines.push(review.body)
      }
      lines.push('')
    }
  }

  if (context.comments.length > 0) {
    lines.push('')
    lines.push(
      `### Comments (${context.comments.length}${context.commentsTruncated ? ` of ${context.totalComments}` : ''})`,
    )
    lines.push('')
    for (const comment of context.comments) {
      lines.push(`**${comment.author ?? 'unknown'}** (${comment.createdAt}):`)
      lines.push(comment.body)
      lines.push('')
    }
  }

  return lines.join('\n')
}

export function formatContextForPrompt(context: HydratedContext): string {
  if (context.type === 'issue') {
    return formatIssueContext(context)
  }
  return formatPullRequestContext(context)
}
