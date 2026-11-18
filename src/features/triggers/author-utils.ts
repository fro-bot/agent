import type {TriggerConfig} from './types.js'
import {BOT_COMMENT_MARKER} from '../../services/github/types.js'

export function isAuthorizedAssociation(association: string, allowed: TriggerConfig['allowedAssociations']): boolean {
  return allowed.includes(association)
}

export function isBotUser(login: string): boolean {
  return login.endsWith('[bot]')
}

/** True when the comment body carries the Action's post marker, so the Action posted it. */
export function isActionPostedComment(commentBody: string | null): boolean {
  return commentBody?.includes(BOT_COMMENT_MARKER) === true
}
