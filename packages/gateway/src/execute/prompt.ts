/**
 * Minimal Discord prompt builder.
 *
 * Keeps prompt construction separate from execution so it is independently
 * testable and the execution core (`run-core.ts`) stays free of string
 * formatting concerns.
 */

/** Parameters for building a Discord agent prompt. */
export interface DiscordPromptParams {
  /** Raw message text from the Discord mention (treated as untrusted input). */
  readonly messageText: string
  /** Repository owner (GitHub org or user). */
  readonly owner: string
  /** Repository name. */
  readonly repo: string
  /**
   * Discord user ID of the bot. When provided, leading mention tokens of the
   * form `<@ID>` or `<@!ID>` are stripped from `messageText` before the
   * empty-prompt check. This prevents a bare bot mention from silently
   * dispatching a no-op run.
   */
  readonly botUserId?: string
}

/**
 * Thrown when `messageText` is empty (or only contains a bot mention) after
 * stripping leading mention tokens. `run.ts` catches this and posts a coarse
 * "empty message" reply — no prompt is sent to the agent.
 */
export class EmptyPromptError extends Error {
  constructor() {
    super('Cannot build a prompt from empty or whitespace-only message text.')
    this.name = 'EmptyPromptError'
  }
}

/**
 * Strip leading Discord mention token(s) (`<@ID>` or `<@!ID>`) that match
 * `botUserId` from the start of `text`. Removes as many consecutive leading
 * matches as are present, then trims the result.
 */
function stripLeadingMentions(text: string, botUserId: string): string {
  // A single mention pattern: optional whitespace, then <@ID> or <@!ID>.
  const mentionPattern = new RegExp(String.raw`^\s*<@!?${botUserId}>`, '')
  let result = text
  let prev: string
  do {
    prev = result
    result = result.replace(mentionPattern, '')
  } while (result !== prev)
  return result.trim()
}

/**
 * Build a minimal Discord prompt for the OpenCode agent.
 *
 * The user text is stripped of leading bot-mention tokens (e.g. `<@1234>`)
 * and trimmed before use. If the remaining text is empty, `EmptyPromptError`
 * is thrown so callers can reply with a coarse "nothing to do" message
 * without dispatching a run.
 *
 * @throws {EmptyPromptError} if `messageText` is empty, whitespace-only, or
 *   contains only bot mention token(s) after stripping.
 */
export function buildDiscordPrompt(params: DiscordPromptParams): string {
  const {messageText, owner, repo, botUserId} = params
  const stripped = botUserId === undefined ? messageText.trim() : stripLeadingMentions(messageText, botUserId)
  if (stripped.length === 0) {
    throw new EmptyPromptError()
  }
  return `Repository: ${owner}/${repo}\n\n${stripped}`
}
