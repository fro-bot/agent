/**
 * The session tools `session_list`, `session_read`, `session_search` and `session_info` on the V2 session API.
 *
 * Transcripts and search read the session's active context window (messages since the last compaction, with its summary
 * standing in for older ones); todos are the list the last `todowrite` call in that window set.
 *
 * `run()` never throws: every failure returns `session store unavailable: <reason>`, one line and length-capped.
 */

import type {MessageV2, SessionClientV2, SessionInfoV2} from '@fro-bot/runtime/session-v2'

import {
  getSessionInfoV2,
  getSessionMessagesV2,
  getSessionTodosV2,
  getSessionV2,
  listSessionsV2,
  searchSessionsV2,
} from '@fro-bot/runtime/session-v2'
import {Schema} from 'effect'

const UNAVAILABLE_PREFIX = 'session store unavailable'
const REASON_MAX_CHARS = 200

export const TRANSCRIPT_CHAR_CAP = 48_000

export const SESSION_TOOL_NAMES = {
  list: 'session_list',
  read: 'session_read',
  search: 'session_search',
  info: 'session_info',
} as const

/** No-op logger: plugins have no logging channel. */
const silentLogger = {
  debug: (): void => {},
  info: (): void => {},
  warning: (): void => {},
  error: (): void => {},
}

export interface SessionToolSpec<Input extends Schema.Top = Schema.Top> {
  readonly name: string
  readonly description: string
  readonly input: Input
  /** Takes the decoded tool input, defensively re-checked; never throws. */
  readonly run: (args: Readonly<Record<string, unknown>>) => Promise<string>
}

export interface SessionToolSet {
  readonly list: SessionToolSpec<typeof ListInput>
  readonly read: SessionToolSpec<typeof ReadInput>
  readonly search: SessionToolSpec<typeof SearchInput>
  readonly info: SessionToolSpec<typeof InfoInput>
}

function unavailable(reason: string): string {
  return `${UNAVAILABLE_PREFIX}: ${reason}`
}

/** One line, capped. Effect tagged errors can have an empty message, so fall back to the tag. */
function describeFailure(error: unknown): string {
  let raw: string
  if (error instanceof Error) {
    const tag: unknown = Reflect.get(error, '_tag')
    raw = error.message.length > 0 ? error.message : typeof tag === 'string' ? tag : error.name
  } else {
    raw = typeof error === 'string' ? error : 'unknown error'
  }
  const firstLine = raw.split('\n')[0] ?? ''
  return firstLine.length > REASON_MAX_CHARS ? `${firstLine.slice(0, REASON_MAX_CHARS)}...` : firstLine
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

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString()
}

function titleOf(session: SessionInfoV2): string {
  return session.title.length > 0 ? session.title : '(untitled)'
}

function formatMessageForTranscript(message: MessageV2): string {
  const text = message.parts.map(part => part.text).join(' ')
  return text.length > 0 ? `[${message.role}] ${text}` : `[${message.role}] (no content)`
}

/** Renders messages oldest-first, capping total rendered size so a huge transcript can't blow the response. */
function renderTranscript(messages: readonly MessageV2[]): string[] {
  const lines: string[] = []
  let size = 0
  let shown = 0

  for (const message of messages) {
    const line = `  ${formatMessageForTranscript(message)}`
    if (size + line.length > TRANSCRIPT_CHAR_CAP) break
    lines.push(line)
    size += line.length
    shown += 1
  }

  if (shown < messages.length) {
    lines.push(`  ... transcript truncated (${shown} of ${messages.length} messages shown)`)
  }
  return lines
}

function sessionHeader(session: SessionInfoV2): string[] {
  return [
    `Session ${session.id}`,
    `Title: ${titleOf(session)}`,
    `Created: ${formatTimestamp(session.time.created)}`,
    `Updated: ${formatTimestamp(session.time.updated)}`,
  ]
}

const CONTEXT_WINDOW_NOTE =
  "Covers the session's active context window: messages since its last compaction, plus the compaction summary."

const ListInput = Schema.Struct({
  limit: Schema.optionalKey(Schema.Number).annotate({description: 'Maximum number of sessions to return.'}),
  from_date: Schema.optionalKey(Schema.String).annotate({
    description: 'Only include sessions created on or after this date (YYYY-MM-DD).',
  }),
  to_date: Schema.optionalKey(Schema.String).annotate({
    description: 'Only include sessions created on or before this date (YYYY-MM-DD).',
  }),
  project_path: Schema.optionalKey(Schema.String).annotate({
    description: 'Workspace/project directory to list sessions for.',
  }),
})

const ReadInput = Schema.Struct({
  session_id: Schema.String.annotate({description: 'The session id to read (required).'}),
  include_todos: Schema.optionalKey(Schema.Boolean).annotate({description: 'Include the session todo list.'}),
  include_transcript: Schema.optionalKey(Schema.Boolean).annotate({description: 'Include the message transcript.'}),
  limit: Schema.optionalKey(Schema.Number).annotate({
    description: 'Maximum number of transcript messages to include.',
  }),
})

const SearchInput = Schema.Struct({
  query: Schema.String.annotate({description: 'Text to search for (required).'}),
  session_id: Schema.optionalKey(Schema.String).annotate({description: 'Restrict the search to a single session id.'}),
  case_sensitive: Schema.optionalKey(Schema.Boolean).annotate({description: 'Match case-sensitively.'}),
  limit: Schema.optionalKey(Schema.Number).annotate({description: 'Maximum number of matches to return.'}),
})

const InfoInput = Schema.Struct({
  session_id: Schema.String.annotate({description: 'The session id to summarize (required).'}),
})

/**
 * Builds the four tool definitions against an injected client. `directory` is the workspace the tools default to:
 * `session_list` honours a `project_path` override, `session_search` always searches the workspace.
 */
export function createSessionTools(options: {
  readonly client: SessionClientV2
  readonly directory: string
}): SessionToolSet {
  const {client, directory} = options
  const logger = silentLogger

  const list: SessionToolSpec<typeof ListInput> = {
    name: SESSION_TOOL_NAMES.list,
    description: 'List recent OpenCode sessions for the current workspace, most recently updated first.',
    input: ListInput,
    async run(args) {
      try {
        const sessions = await listSessionsV2(
          client,
          asString(args.project_path) ?? directory,
          {
            limit: normalizeLimit(asNumber(args.limit)),
            fromDate: parseDate(asString(args.from_date)),
            toDate: parseEndOfDayDate(asString(args.to_date)),
          },
          logger,
        )
        if (!sessions.success) return unavailable(describeFailure(sessions.error))
        if (sessions.data.length === 0) return 'No sessions found.'

        return sessions.data
          .map(session => `${session.id}  ${titleOf(session)}  updated ${formatTimestamp(session.time.updated)}`)
          .join('\n')
      } catch (error) {
        return unavailable(describeFailure(error))
      }
    },
  }

  const read: SessionToolSpec<typeof ReadInput> = {
    name: SESSION_TOOL_NAMES.read,
    description: `Read a session: header, optional todos, and optional transcript. ${CONTEXT_WINDOW_NOTE}`,
    input: ReadInput,
    async run(args) {
      const sessionId = asString(args.session_id)
      if (sessionId == null) return unavailable('session_id is required')

      try {
        const found = await getSessionV2(client, sessionId, logger)
        if (!found.success) return unavailable(describeFailure(found.error))
        if (found.data == null) return `session not found: ${sessionId}`

        const lines = sessionHeader(found.data)

        if (asBoolean(args.include_todos) === true) {
          const todos = await getSessionTodosV2(client, sessionId, logger)
          if (!todos.success) return unavailable(describeFailure(todos.error))
          lines.push('', 'Todos:')
          if (todos.data.length === 0) {
            lines.push('  (none)')
          } else {
            for (const todo of todos.data) lines.push(`  [${todo.status}] ${todo.content}`)
          }
        }

        if (asBoolean(args.include_transcript) === true) {
          const messages = await getSessionMessagesV2(client, sessionId, logger)
          if (!messages.success) return unavailable(describeFailure(messages.error))
          // Oldest-first; a limit returns the earliest N messages.
          const limit = normalizeLimit(asNumber(args.limit))
          const sliced = limit == null ? messages.data : messages.data.slice(0, limit)
          lines.push('', 'Transcript:')
          if (sliced.length === 0) {
            lines.push('  (empty)')
          } else {
            lines.push(...renderTranscript(sliced))
          }
        }

        return lines.join('\n')
      } catch (error) {
        return unavailable(describeFailure(error))
      }
    },
  }

  const search: SessionToolSpec<typeof SearchInput> = {
    name: SESSION_TOOL_NAMES.search,
    description: `Search prior session content for matching text, optionally scoped to one session. ${CONTEXT_WINDOW_NOTE}`,
    input: SearchInput,
    async run(args) {
      const query = asString(args.query)
      if (query == null) return unavailable('query is required')

      try {
        const scopedSessionId = asString(args.session_id)
        if (scopedSessionId != null) {
          const found = await getSessionV2(client, scopedSessionId, logger)
          if (!found.success) return unavailable(describeFailure(found.error))
          if (found.data == null) return `session not found: ${scopedSessionId}`
        }

        // Search always scopes to the current workspace; there is no project_path.
        const results = await searchSessionsV2(
          query,
          client,
          directory,
          {
            limit: normalizeLimit(asNumber(args.limit)),
            caseSensitive: asBoolean(args.case_sensitive),
            sessionId: scopedSessionId,
          },
          logger,
        )
        if (!results.success) return unavailable(describeFailure(results.error))
        if (results.data.length === 0) return 'No matches found.'

        const lines: string[] = []
        for (const result of results.data) {
          lines.push(`Session ${result.sessionId}:`)
          for (const match of result.matches) {
            lines.push(`  [${match.role}${match.agent == null ? '' : `/${match.agent}`}] ${match.excerpt}`)
          }
        }
        return lines.join('\n')
      } catch (error) {
        return unavailable(describeFailure(error))
      }
    },
  }

  const info: SessionToolSpec<typeof InfoInput> = {
    name: SESSION_TOOL_NAMES.info,
    description: `Summarize a session: id, title, timestamps, message and todo counts. ${CONTEXT_WINDOW_NOTE}`,
    input: InfoInput,
    async run(args) {
      const sessionId = asString(args.session_id)
      if (sessionId == null) return unavailable('session_id is required')

      try {
        const details = await getSessionInfoV2(client, sessionId, logger)
        if (!details.success) return unavailable(describeFailure(details.error))
        if (details.data == null) return `session not found: ${sessionId}`

        const {session, messageCount, agents, hasTodos, todoCount, completedTodos} = details.data
        return [
          ...sessionHeader(session),
          `Messages: ${messageCount}`,
          `Agents: ${agents.length > 0 ? agents.join(', ') : '(none)'}`,
          `Todos: ${hasTodos ? `${completedTodos}/${todoCount} completed` : '(none)'}`,
        ].join('\n')
      } catch (error) {
        return unavailable(describeFailure(error))
      }
    },
  }

  return {list, read, search, info}
}
