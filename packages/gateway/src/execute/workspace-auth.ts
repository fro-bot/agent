/**
 * Auth headers for calls to the workspace OpenCode proxy.
 *
 * Every client the gateway builds against the workspace (the v1 handle from
 * `attachOpencode`, the v2 question client from `createQuestionEffects`) takes
 * its headers from here, so the two cannot drift.
 *
 * Security invariant: the token is NEVER logged.
 */
export function workspaceAuthHeaders(token: string): Readonly<Record<string, string>> {
  return {Authorization: `Bearer ${token}`}
}
