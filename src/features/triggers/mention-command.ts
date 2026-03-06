import type {ParsedCommand} from './types.js'

interface MentionAndCommand {
  readonly hasMention: boolean
  readonly command: ParsedCommand | null
}

export function hasBotMention(text: string, botLogin: string): boolean {
  if (botLogin.length === 0) {
    return false
  }

  const normalizedLogin = botLogin.replace(/\[bot\]$/i, '')
  if (normalizedLogin.length === 0) {
    return false
  }

  const pattern = new RegExp(String.raw`@${escapeRegExp(normalizedLogin)}(?:\[bot\])?(?:$|[^\w])`, 'i')
  return pattern.test(text)
}

function escapeRegExp(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

export function extractCommand(text: string, botLogin: string): ParsedCommand | null {
  if (botLogin.length === 0) {
    return null
  }

  const normalizedLogin = botLogin.replace(/\[bot\]$/i, '')
  if (normalizedLogin.length === 0) {
    return null
  }

  const pattern = new RegExp(String.raw`@${escapeRegExp(normalizedLogin)}(?:\[bot\])?\s*(.*)`, 'is')
  const match = pattern.exec(text)
  const captured = match?.[1]
  if (captured == null) {
    return null
  }

  const raw = captured.trim()
  if (raw.length === 0) {
    return {raw: '', action: null, args: ''}
  }

  const parts = raw.split(/\s+/)
  const firstPart = parts[0] ?? ''
  const action = firstPart === '' ? null : firstPart
  const args = parts.slice(1).join(' ')
  return {raw, action, args}
}

export function parseBotMentionAndCommand(commentBody: string | null, botLogin: string | null): MentionAndCommand {
  if (botLogin == null || botLogin === '' || commentBody == null) {
    return {hasMention: false, command: null}
  }

  const hasMention = hasBotMention(commentBody, botLogin)
  const command = hasMention ? extractCommand(commentBody, botLogin) : null
  return {hasMention, command}
}
