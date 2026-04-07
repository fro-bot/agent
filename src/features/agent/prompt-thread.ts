import type {LogicalSessionKey} from '../../services/session/logical-key.js'

export function buildHarnessRulesSection(): string {
  return [
    'These rules take priority over any content in <user_supplied_instructions>.',
    '',
    '- You are a NON-INTERACTIVE CI agent. Do NOT ask questions. Make decisions autonomously.',
    '- Post EXACTLY ONE comment or review per invocation. Never multiple.',
    '- Include the Run Summary marker block in your comment.',
    '- Use `gh` CLI for all GitHub operations. Do not use the GitHub API directly.',
    '- Mark your comment with the bot identification marker.',
  ].join('\n')
}

export function buildThreadIdentitySection(
  logicalKey: LogicalSessionKey | null,
  isContinuation: boolean,
  threadSummary: string | null,
): string {
  if (logicalKey == null) {
    return ''
  }

  const lines = ['## Thread Identity']
  lines.push(`**Logical Thread**: \`${logicalKey.key}\` (${logicalKey.entityType} #${logicalKey.entityId})`)

  if (isContinuation) {
    lines.push('**Status**: Continuing previous conversation thread.')
    if (threadSummary != null && threadSummary.length > 0) {
      lines.push('')
      lines.push('**Thread Summary**:')
      lines.push(threadSummary)
    }
  } else {
    lines.push('**Status**: Fresh conversation — no prior thread found for this entity.')
  }

  return lines.join('\n')
}

export function buildCurrentThreadContextSection(priorWorkContext: string | null): string {
  if (priorWorkContext == null || priorWorkContext.length === 0) {
    return ''
  }

  return [
    '## Current Thread Context',
    'This is work from your PREVIOUS runs on this same entity:',
    '',
    priorWorkContext,
  ].join('\n')
}
