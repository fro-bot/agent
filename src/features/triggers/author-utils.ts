import type {TriggerConfig} from './types.js'

export function isAuthorizedAssociation(association: string, allowed: TriggerConfig['allowedAssociations']): boolean {
  return allowed.includes(association)
}

export function isBotUser(login: string): boolean {
  return login.endsWith('[bot]')
}

/** True when `login` is the Action's own login. Case-insensitive; an unknown Action login matches nothing. */
export function isActionLogin(login: string, botLogin: TriggerConfig['botLogin']): boolean {
  return botLogin != null && botLogin !== '' && login.toLowerCase() === botLogin.toLowerCase()
}
