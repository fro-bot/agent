import type {TriggerConfig} from './types.js'

export function isAuthorizedAssociation(association: string, allowed: TriggerConfig['allowedAssociations']): boolean {
  return allowed.includes(association)
}

export function isBotUser(login: string): boolean {
  return login.endsWith('[bot]')
}
