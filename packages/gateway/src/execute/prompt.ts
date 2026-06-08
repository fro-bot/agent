/**
 * Minimal Discord prompt builder.
 *
 * Keeps prompt construction separate from execution so it is independently
 * testable and the execution core (`run-core.ts`) stays free of string
 * formatting concerns.
 */

/**
 * Discord-mechanical guidance prepended to every mention prompt.
 *
 * Instructs the agent on chat-appropriate behavior:
 * - Concise, direct responses (no process narration)
 * - Chat-native formatting (markdown, code blocks)
 * - SC2 resolution: summarize or attach long enumerations — never paste raw lists inline
 * - Persona anti-patterns: no sycophancy, no sign-offs, no apologies
 */
export const DISCORD_MECHANICAL_GUIDANCE = `You are responding in a Discord thread. Follow these rules:
- Be concise and direct. Do not narrate your internal process or reasoning steps.
- Format for chat: use markdown, code blocks for code, short paragraphs.
- For long enumerations (file lists, search results, logs, command output): summarize the key points or attach the full content — never paste a long raw list inline.
- No sycophancy, no sign-offs, no apologies. Get to the point.`

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
  /**
   * Optional canonical persona text (e.g. from `GATEWAY_PERSONA_FILE`).
   * When present and non-empty, prepended before the Discord-mechanical guidance.
   * Absent, null, empty, or whitespace-only → omitted (fail-soft).
   */
  readonly persona?: string | null
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
 * Escape all regex metacharacters in `s` so it can be safely interpolated
 * into a `RegExp` pattern and matched literally.
 *
 * Discord snowflakes are digits-only in practice, but this guard removes the
 * theoretical broken-regex path for any future ID format.
 */
function escapeRegExp(s: string): string {
  return s.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
}

/**
 * Strip leading Discord mention token(s) (`<@ID>` or `<@!ID>`) that match
 * `botUserId` from the start of `text`. Removes as many consecutive leading
 * matches as are present, then trims the result.
 */
function stripLeadingMentions(text: string, botUserId: string): string {
  // A single mention pattern: optional whitespace, then <@ID> or <@!ID>.
  // escapeRegExp ensures botUserId is matched literally even if it contains
  // regex metacharacters (e.g. a dot in a non-snowflake ID).
  const escapedId = escapeRegExp(botUserId)
  const mentionPattern = new RegExp(String.raw`^\s*<@!?${escapedId}>`, '')
  let result = text
  let prev: string
  do {
    prev = result
    result = result.replace(mentionPattern, '')
  } while (result !== prev)
  return result.trim()
}

/**
 * Build a Discord prompt for the OpenCode agent.
 *
 * Composition order (persona-then-task, mirrors Action-tier layering):
 * 1. Persona (if present and non-empty) — canonical Fro Bot voice
 * 2. Discord-mechanical guidance — conciseness, formatting, SC2 long-enumeration policy
 * 3. Repository context — `Repository: owner/repo`
 * 4. User message — verbatim (after stripping leading bot-mention tokens)
 *
 * The user text is stripped of leading bot-mention tokens (e.g. `<@1234>`)
 * and trimmed before use. If the remaining text is empty, `EmptyPromptError`
 * is thrown so callers can reply with a coarse "nothing to do" message
 * without dispatching a run.
 *
 * Fail-soft: missing/null/empty/whitespace-only persona → mechanical guidance
 * + repo + message only (no error thrown).
 *
 * @throws {EmptyPromptError} if `messageText` is empty, whitespace-only, or
 *   contains only bot mention token(s) after stripping.
 */
export function buildDiscordPrompt(params: DiscordPromptParams): string {
  const {messageText, owner, repo, botUserId, persona} = params
  const stripped = botUserId === undefined ? messageText.trim() : stripLeadingMentions(messageText, botUserId)
  if (stripped.length === 0) {
    throw new EmptyPromptError()
  }

  const sections: string[] = []

  // 1. Persona (fail-soft: absent/null/empty/whitespace → omit)
  // Scoped with a header so the persona defines VOICE/STYLE only and cannot
  // override the Discord-mechanical guidance that follows.
  const trimmedPersona = persona?.trim() ?? ''
  if (trimmedPersona.length > 0) {
    sections.push(`--- Persona (voice and style only) ---\n${trimmedPersona}\n--- End Persona ---`)
  }

  // 2. Discord-mechanical guidance (always present; takes precedence over persona)
  sections.push(DISCORD_MECHANICAL_GUIDANCE)

  // 3. Repository context
  sections.push(`Repository: ${owner}/${repo}`)

  // 4. User message (verbatim after stripping)
  sections.push(stripped)

  return sections.join('\n\n')
}
