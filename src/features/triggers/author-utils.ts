import type {TriggerConfig} from './types.js'
import {BOT_COMMENT_MARKER} from '../../services/github/types.js'

export function isAuthorizedAssociation(association: string, allowed: TriggerConfig['allowedAssociations']): boolean {
  return allowed.includes(association)
}

export function isBotUser(login: string): boolean {
  return login.endsWith('[bot]')
}

function normalizeLogin(login: string): string {
  return login.replace(/\[bot\]$/i, '').toLowerCase()
}

/**
 * True when the comment is one the Action posted: its body carries the Action's marker and its author is the Action's
 * login (case-insensitive, ignoring a trailing `[bot]` on either side). An unmarked comment, or an unknown Action login,
 * never matches, so a person using the Action's token can still mention it.
 */
export function isActionPostedComment(
  login: string,
  commentBody: string | null,
  botLogin: TriggerConfig['botLogin'],
): boolean {
  return (
    botLogin != null &&
    botLogin !== '' &&
    commentBody?.includes(BOT_COMMENT_MARKER) === true &&
    normalizeLogin(login) === normalizeLogin(botLogin)
  )
}
