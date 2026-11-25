/**
 * Span content: extraction by named field, the content ceilings, and the Action identity attributes.
 *
 * Scrubbing and bounding live in the shared runtime (`@fro-bot/runtime/tracing/scrub`): `scrubSpan` is the only way to
 * produce a `ScrubbedSpan`, and the exporter takes nothing else. They are re-exported here so the rest of the plugin keeps
 * one import site for "span content". The plugin bundles that module inline; it never imports the runtime when it runs.
 *
 * Extraction is plain functions over what OpenCode reports, by named field: no SDK, no I/O, no clock.
 */

import type {ActionIdentity} from './settings.js'

export * from '@fro-bot/runtime/tracing/scrub'

/** Per-attribute ceilings for content, in serialized characters. */
export const CONTENT_MAX_CHARS = {
  systemInstructions: 128 * 1024,
  toolDefinitions: 128 * 1024,
  inputMessages: 512 * 1024,
  outputMessages: 128 * 1024,
  toolArguments: 64 * 1024,
  toolResult: 64 * 1024,
  prompt: 64 * 1024,
} as const

// ---------------------------------------------------------------------------------------------------------------------
// Extraction by named field
// ---------------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** `gen_ai.system_instructions`: `[{type: 'text', content}]`. Takes each part's `text` and nothing else (no metadata). */
export function extractSystemInstructions(system: unknown): {type: 'text'; content: string}[] | undefined {
  if (!Array.isArray(system)) return undefined
  const parts: {type: 'text'; content: string}[] = []
  for (const part of system) {
    const text = isRecord(part) ? asString(part.text) : undefined
    if (text !== undefined) parts.push({type: 'text', content: text})
  }
  return parts.length === 0 ? undefined : parts
}

export interface MessageExtraction {
  readonly messages: readonly Json[]
  /** Parts that were attachments or of a kind this plugin does not read, counted, never serialized. */
  readonly omittedParts: number
}

/** The value of a tool result part as the spec's `response`: text for `text` and `content`, the value for `json`. */
function responseOf(result: unknown): unknown {
  if (!isRecord(result)) return result
  const value = result.value
  if (result.type === 'content' && Array.isArray(value)) {
    return value
      .map(item => {
        if (!isRecord(item)) return ''
        if (item.type === 'text') return asString(item.text) ?? ''
        return `[file: ${asString(item.name) ?? asString(item.mime) ?? 'attachment'}]`
      })
      .join('\n')
  }
  return value
}

function messagePart(part: unknown): {part?: Json; omitted: boolean} {
  if (!isRecord(part)) return {omitted: true}
  switch (part.type) {
    case 'text': {
      const text = asString(part.text)
      return text === undefined ? {omitted: true} : {part: {type: 'text', content: text}, omitted: false}
    }
    case 'reasoning': {
      const text = asString(part.text)
      return text === undefined ? {omitted: true} : {part: {type: 'reasoning', content: text}, omitted: false}
    }
    case 'tool-call':
      return {
        part: {
          type: 'tool_call',
          id: asString(part.id) ?? null,
          name: asString(part.name) ?? 'unknown',
          arguments: part.input,
        },
        omitted: false,
      }
    case 'tool-result':
      return {
        part: {type: 'tool_call_response', id: asString(part.id) ?? null, response: responseOf(part.result)},
        omitted: false,
      }
    default:
      // media, files and anything unknown: not serialized.
      return {omitted: true}
  }
}

/** `gen_ai.input.messages`: role and parts of each message, by named field. */
export function extractInputMessages(messages: unknown): MessageExtraction | undefined {
  if (!Array.isArray(messages)) return undefined
  const out: Json[] = []
  let omittedParts = 0
  for (const message of messages) {
    if (!isRecord(message)) continue
    const role = asString(message.role)
    if (role === undefined) continue
    const content = message.content
    const rawParts =
      typeof content === 'string' ? [{type: 'text', text: content}] : Array.isArray(content) ? content : []
    const parts: Json[] = []
    for (const raw of rawParts) {
      const {part, omitted} = messagePart(raw)
      if (part !== undefined) parts.push(part)
      if (omitted) omittedParts += 1
    }
    out.push({role, parts})
  }
  return {messages: out, omittedParts}
}

/** `gen_ai.tool.definitions`: `[{type: 'function', name, description, parameters}]`. */
export function extractToolDefinitions(tools: unknown): Json[] | undefined {
  if (!isRecord(tools)) return undefined
  const names = Object.keys(tools)
  if (names.length === 0) return undefined
  return names.map(name => {
    const tool = tools[name]
    const description = isRecord(tool) ? asString(tool.description) : undefined
    const parameters = isRecord(tool) && isRecord(tool.input) ? tool.input : undefined
    return {
      type: 'function',
      name,
      ...(description === undefined ? {} : {description}),
      ...(parameters === undefined ? {} : {parameters}),
    }
  })
}

/** `gen_ai.tool.call.arguments`: an object. A string is parsed; anything else is wrapped as `{value}`. */
export function extractToolArguments(input: unknown): Json | undefined {
  if (input === undefined) return undefined
  if (isRecord(input)) return input
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      if (isRecord(parsed)) return parsed
    } catch {
      // Not JSON: wrapped below.
    }
  }
  return {value: input}
}

export interface ToolResultExtraction {
  readonly value: Json
  /** The tool reported that it cut its own output. */
  readonly ownTruncation: boolean
}

/**
 * `gen_ai.tool.call.result`: the content the model saw, `{content: [...]}` (files by name and type only, never their
 * location), or `{output}` for a tool that returned only structured output. Metadata is not captured; only its
 * `truncated` flag, as a marker.
 */
export function extractToolResult(result: unknown): ToolResultExtraction | undefined {
  if (!isRecord(result)) return undefined
  const metadata = isRecord(result.metadata) ? result.metadata : undefined
  const ownTruncation = metadata?.truncated === true
  const content = result.content
  if (typeof content === 'string') return {value: {content: [{type: 'text', text: content}]}, ownTruncation}
  if (Array.isArray(content)) {
    const parts = content.flatMap((item): Json[] => {
      if (!isRecord(item)) return []
      if (item.type === 'text') return [{type: 'text', text: asString(item.text) ?? ''}]
      if (item.type === 'file') {
        const name = asString(item.name)
        return [
          {
            type: 'file',
            mime: asString(item.mime) ?? 'application/octet-stream',
            ...(name === undefined ? {} : {name}),
          },
        ]
      }
      return []
    })
    return {value: {content: parts}, ownTruncation}
  }
  if (result.output !== undefined) return {value: {output: result.output}, ownTruncation}
  return undefined
}

export interface OutputInput {
  readonly texts: readonly string[]
  readonly reasoning: readonly string[]
  readonly toolCalls: readonly {readonly callId: string; readonly tool: string; readonly input?: unknown}[]
}

/** `gen_ai.output.messages`: one assistant message with reasoning, text and the tool calls the response asked for. */
export function extractOutputMessages(output: OutputInput): Json[] | undefined {
  const parts: Json[] = [
    ...output.reasoning.map(content => ({type: 'reasoning', content})),
    ...output.texts.map(content => ({type: 'text', content})),
    ...output.toolCalls.map(call => ({
      type: 'tool_call',
      id: call.callId,
      name: call.tool,
      arguments: extractToolArguments(call.input) ?? null,
    })),
  ]
  return parts.length === 0 ? undefined : [{role: 'assistant', parts}]
}

/** A user prompt's `text`, as an input message. Attachments are not read. */
export function extractPromptMessage(prompt: unknown): Json | undefined {
  const text = isRecord(prompt) ? asString(prompt.text) : undefined
  return text === undefined ? undefined : {role: 'user', parts: [{type: 'text', content: text}]}
}

/**
 * Identity the Action supplies, as the attributes every span of its runs carries: the `fro_bot.*` names, and a mirror of each
 * under `langfuse.trace.metadata.<key>`. Langfuse's OTLP ingestion (`extractMetadata` in langfuse/langfuse
 * `OtelIngestionProcessor.ts`) reads every `langfuse.trace.metadata.*` attribute of every span into that span's metadata at the top
 * level, where it is shown and filterable, and treats a span carrying one as a trace update; a string value is kept as sent
 * (JSON-decoding applies only to its own SDKs). The values are strings and the very same ones as their twins, so they pass the
 * same scrubber and identifier bounds. The keys are short and stable.
 *
 * The launcher's invocation id, when it has one, is part of the same identity: it names the one Action step that started the
 * server, which `run.id`, `run.attempt` and `job` cannot do (two steps of one job share all three).
 */
export const actionIdentityAttributes = (
  identity: ActionIdentity,
  invocationId?: string | undefined,
): Record<string, string> => ({
  'fro_bot.repository': identity.repository,
  'fro_bot.run.id': identity.runId,
  'fro_bot.run.attempt': identity.attempt,
  'fro_bot.job': identity.job,
  'fro_bot.trigger': identity.trigger,
  'langfuse.trace.metadata.repository': identity.repository,
  'langfuse.trace.metadata.run_id': identity.runId,
  'langfuse.trace.metadata.run_attempt': identity.attempt,
  'langfuse.trace.metadata.job': identity.job,
  'langfuse.trace.metadata.trigger': identity.trigger,
  ...(invocationId === undefined
    ? {}
    : {'fro_bot.invocation.id': invocationId, 'langfuse.trace.metadata.invocation_id': invocationId}),
})
