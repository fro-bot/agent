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
}

/**
 * Thrown when `messageText` is empty or whitespace-only.
 * Unit 4 (`run.ts`) catches this and posts a coarse "empty message" reply —
 * no prompt is sent to the agent.
 */
export class EmptyPromptError extends Error {
  constructor() {
    super('Cannot build a prompt from empty or whitespace-only message text.')
    this.name = 'EmptyPromptError'
  }
}

/**
 * Build a minimal Discord prompt for the OpenCode agent.
 *
 * MVP: message text + repo context only; no harness rules in this unit.
 * The user text is trimmed but otherwise passed through as-is (the agent
 * prompt is not a trust boundary; the workspace sandbox is).
 *
 * @throws {EmptyPromptError} if `messageText` is empty or whitespace-only.
 */
export function buildDiscordPrompt(params: DiscordPromptParams): string {
  const {messageText, owner, repo} = params
  const trimmed = messageText.trim()
  if (trimmed.length === 0) {
    throw new EmptyPromptError()
  }
  return `Repository: ${owner}/${repo}\n\n${trimmed}`
}
