/**
 * Native session tools — always-on implementations of the oMo session_* contract.
 *
 * Ships as a config-dir file tool (`tool/session.js`), loaded by OpenCode's tool
 * registry BEFORE plugin tools (`registry.ts:172-193`); oMo plugin tools with the
 * same id override these by id at registry time (later-wins), giving deterministic
 * precedence when oMo is installed.
 *
 * Constraints (do not relax):
 * - NO import from '@opencode-ai/plugin' — plain-object shape `{description, args, execute}`
 *   satisfies `isPluginTool` (registry.ts:346-348) with no bare package imports beyond the SDK client
 *   (node: builtins are fine; the bundler resolves them).
 * - NO import-time I/O. All env/network access happens inside `execute()`.
 * - NEVER throw. Every failure path returns a human-readable `'session store unavailable: ...'`
 *   string — a session-tool failure must never fail the run.
 * - Arg schemas MUST match the oMo contract exactly: same tool names, same params, same
 *   string-shaped outputs, so the override is invisible to the model.
 */

import type {Part, SessionInfo} from '../session/index.js'
import process from 'node:process'

import {createOpencodeClient} from '@opencode-ai/sdk'
import {z} from 'zod'
import {
  extractTextFromPart,
  getSession,
  getSessionInfo,
  getSessionMessages,
  getSessionTodos,
  listSessions,
  searchSessions,
} from '../session/index.js'

const UNAVAILABLE_PREFIX = 'session store unavailable'

/** No-op logger — session tools run inside the OpenCode server process, not the harness. */
const silentLogger = {
  debug: (): void => {},
  info: (): void => {},
  warning: (): void => {},
  error: (): void => {},
}

function unavailable(reason: string): string {
  return `${UNAVAILABLE_PREFIX}: ${reason}`
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

export interface SessionToolDefinition {
  readonly description: string
  readonly args: Readonly<Record<string, z.ZodType>>
  readonly execute: (args: Readonly<Record<string, unknown>>) => Promise<string>
}

export interface SessionTools {
  readonly list: SessionToolDefinition
  readonly read: SessionToolDefinition
  readonly search: SessionToolDefinition
  readonly info: SessionToolDefinition
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseDate(value: string | undefined): Date | undefined {
  if (value == null) return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** Parses a `to_date` bound to the END of that day (inclusive upper bound). */
function parseEndOfDayDate(value: string | undefined): Date | undefined {
  const parsed = parseDate(value)
  if (parsed == null) return undefined
  const endOfDay = new Date(parsed)
  endOfDay.setUTCHours(23, 59, 59, 999)
  return endOfDay
}

/** Any limit below 1 (including negative values) means "no limit". */
function normalizeLimit(value: number | undefined): number | undefined {
  return value == null || value < 1 ? undefined : value
}

function formatMessageForTranscript(message: {readonly role: string; readonly parts?: readonly Part[]}): string {
  const parts = message.parts ?? []
  const text = parts
    .map(part => extractTextFromPart(part))
    .filter((value): value is string => value != null)
    .join(' ')
  return text.length > 0 ? `[${message.role}] ${text}` : `[${message.role}] (no content)`
}

/**
 * Factory: creates the four session tool definitions against an injectable base-URL
 * resolver. The resolver is called inside `execute()` (never at import time) so tests
 * can inject a stub resolver without touching process env.
 */
export function createSessionTools(resolveBaseUrl: () => string | undefined): SessionTools {
  function resolveClientOrReason(): {baseUrl: string} | {reason: string} {
    const baseUrl = resolveBaseUrl()
    if (baseUrl == null || baseUrl.length === 0) {
      return {reason: 'FRO_BOT_OPENCODE_URL is not set'}
    }
    return {baseUrl}
  }

  const list: SessionToolDefinition = {
    description: 'List recent OpenCode sessions for the current workspace, most recently updated first.',
    args: {
      limit: z.number().describe('Maximum number of sessions to return.').optional(),
      from_date: z.string().describe('Only include sessions created on or after this date (YYYY-MM-DD).').optional(),
      to_date: z.string().describe('Only include sessions created on or before this date (YYYY-MM-DD).').optional(),
      project_path: z.string().describe('Workspace/project directory to list sessions for.').optional(),
    },
    async execute(args) {
      const resolved = resolveClientOrReason()
      if ('reason' in resolved) return unavailable(resolved.reason)

      try {
        const client = createOpencodeClient({baseUrl: resolved.baseUrl})
        const projectPath = asString(args.project_path) ?? process.cwd()
        const sessions = await listSessions(
          client,
          projectPath,
          {
            limit: normalizeLimit(asNumber(args.limit)),
            fromDate: parseDate(asString(args.from_date)),
            toDate: parseEndOfDayDate(asString(args.to_date)),
          },
          silentLogger,
        )

        if (sessions.length === 0) return 'No sessions found.'

        return sessions
          .map(
            session => `${session.id}  ${session.title || '(untitled)'}  updated ${formatTimestamp(session.updatedAt)}`,
          )
          .join('\n')
      } catch (error) {
        return unavailable(toErrorMessage(error))
      }
    },
  }

  const read: SessionToolDefinition = {
    description: 'Read a session: header, optional todos, and optional transcript.',
    args: {
      session_id: z.string().describe('The session id to read (required).'),
      include_todos: z.boolean().describe('Include the session todo list.').optional(),
      include_transcript: z.boolean().describe('Include the message transcript.').optional(),
      limit: z.number().describe('Maximum number of transcript messages to include.').optional(),
    },
    async execute(args) {
      const resolved = resolveClientOrReason()
      if ('reason' in resolved) return unavailable(resolved.reason)

      const sessionId = asString(args.session_id)
      if (sessionId == null) return unavailable('session_id is required')

      try {
        const client = createOpencodeClient({baseUrl: resolved.baseUrl})
        const session = await getSession(client, sessionId, silentLogger)
        if (session == null) return `session not found: ${sessionId}`

        const lines: string[] = [
          `Session ${session.id}`,
          `Title: ${session.title || '(untitled)'}`,
          `Created: ${formatTimestamp(session.time.created)}`,
          `Updated: ${formatTimestamp(session.time.updated)}`,
        ]

        if (asBoolean(args.include_todos) === true) {
          const todos = await getSessionTodos(client, sessionId, silentLogger)
          lines.push('', 'Todos:')
          if (todos.length === 0) {
            lines.push('  (none)')
          } else {
            for (const todo of todos) {
              lines.push(`  [${todo.status}] ${todo.content}`)
            }
          }
        }

        if (asBoolean(args.include_transcript) === true) {
          const limit = normalizeLimit(asNumber(args.limit))
          const messages = await getSessionMessages(client, sessionId, silentLogger)
          const sliced = limit == null ? messages : messages.slice(0, limit)
          lines.push('', 'Transcript:')
          if (sliced.length === 0) {
            lines.push('  (empty)')
          } else {
            for (const message of sliced) {
              lines.push(`  ${formatMessageForTranscript(message)}`)
            }
          }
        }

        return lines.join('\n')
      } catch (error) {
        return unavailable(toErrorMessage(error))
      }
    },
  }

  const search: SessionToolDefinition = {
    description: 'Search prior session content for matching text, optionally scoped to one session.',
    args: {
      query: z.string().describe('Text to search for (required).'),
      session_id: z.string().describe('Restrict the search to a single session id.').optional(),
      case_sensitive: z.boolean().describe('Match case-sensitively.').optional(),
      limit: z.number().describe('Maximum number of matches to return.').optional(),
    },
    async execute(args) {
      const resolved = resolveClientOrReason()
      if ('reason' in resolved) return unavailable(resolved.reason)

      const query = asString(args.query)
      if (query == null) return unavailable('query is required')

      try {
        const client = createOpencodeClient({baseUrl: resolved.baseUrl})
        const projectPath = process.cwd()
        const scopedSessionId = asString(args.session_id)
        if (scopedSessionId != null) {
          const session = await getSession(client, scopedSessionId, silentLogger)
          if (session == null) return `session not found: ${scopedSessionId}`
        }
        const results = await searchSessions(
          query,
          client,
          projectPath,
          {
            limit: normalizeLimit(asNumber(args.limit)),
            caseSensitive: asBoolean(args.case_sensitive),
            sessionId: scopedSessionId,
          },
          silentLogger,
        )

        if (results.length === 0) return 'No matches found.'

        const lines: string[] = []
        for (const result of results) {
          lines.push(`Session ${result.sessionId}:`)
          for (const match of result.matches) {
            lines.push(`  [${match.role}${match.agent == null ? '' : `/${match.agent}`}] ${match.excerpt}`)
          }
        }
        return lines.join('\n')
      } catch (error) {
        return unavailable(toErrorMessage(error))
      }
    },
  }

  const info: SessionToolDefinition = {
    description: 'Summarize a session: id, title, timestamps, message and todo counts.',
    args: {
      session_id: z.string().describe('The session id to summarize (required).'),
    },
    async execute(args) {
      const resolved = resolveClientOrReason()
      if ('reason' in resolved) return unavailable(resolved.reason)

      const sessionId = asString(args.session_id)
      if (sessionId == null) return unavailable('session_id is required')

      try {
        const client = createOpencodeClient({baseUrl: resolved.baseUrl})
        const details = await getSessionInfo(client, sessionId, silentLogger)
        if (details == null) return `session not found: ${sessionId}`

        return formatSessionInfoSummary(details.session, {
          messageCount: details.messageCount,
          agents: details.agents,
          hasTodos: details.hasTodos,
          todoCount: details.todoCount,
          completedTodos: details.completedTodos,
        })
      } catch (error) {
        return unavailable(toErrorMessage(error))
      }
    },
  }

  return {list, read, search, info}
}

function formatSessionInfoSummary(
  session: SessionInfo,
  extra: {
    readonly messageCount: number
    readonly agents: readonly string[]
    readonly hasTodos: boolean
    readonly todoCount: number
    readonly completedTodos: number
  },
): string {
  return [
    `Session ${session.id}`,
    `Title: ${session.title || '(untitled)'}`,
    `Created: ${formatTimestamp(session.time.created)}`,
    `Updated: ${formatTimestamp(session.time.updated)}`,
    `Messages: ${extra.messageCount}`,
    `Agents: ${extra.agents.length > 0 ? extra.agents.join(', ') : '(none)'}`,
    `Todos: ${extra.hasTodos ? `${extra.completedTodos}/${extra.todoCount} completed` : '(none)'}`,
  ].join('\n')
}

const defaultTools = createSessionTools(() => process.env.FRO_BOT_OPENCODE_URL)

export const {list, read, search, info} = defaultTools
