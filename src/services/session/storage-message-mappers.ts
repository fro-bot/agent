import type {
  AssistantMessage as SdkAssistantMessage,
  Message as SdkMessage,
  Part as SdkPart,
  ToolState as SdkToolState,
  UserMessage as SdkUserMessage,
} from '@opencode-ai/sdk'

import type {Message, Part, ToolState} from './types.js'

import {mapSdkFileDiffs, readString} from './storage-mappers.js'

type SdkMessageExtended = (SdkAssistantMessage & {agent?: string}) | (SdkUserMessage & {variant?: string})
interface SdkMessageWithParts {
  info: SdkMessage
  parts: readonly SdkPart[]
}

function mapSdkToolState(s: SdkToolState): ToolState {
  if (s.status === 'running')
    return {
      status: 'running',
      input: s.input,
      time: {start: s.time.start},
    }
  if (s.status === 'error')
    return {
      status: 'error',
      input: s.input,
      error: s.error,
      time: {
        start: s.time.start,
        end: s.time.end,
      },
    }
  if (s.status === 'pending') return {status: 'pending'}
  return {
    status: 'completed',
    input: s.input,
    output: s.output,
    title: s.title,
    metadata: s.metadata,
    time: {
      start: s.time.start,
      end: s.time.end,
      compacted: s.time.compacted,
    },
    attachments: undefined,
  }
}

export function mapSdkPartToPart(p: SdkPart): Part {
  const base = {
    id: p.id,
    sessionID: p.sessionID,
    messageID: p.messageID,
  }
  if (p.type === 'text')
    return {
      ...base,
      type: 'text',
      text: p.text,
      synthetic: p.synthetic,
      ignored: p.ignored,
      time: p.time,
      metadata: p.metadata,
    }
  if (p.type === 'reasoning')
    return {
      ...base,
      type: 'reasoning',
      reasoning: (p as unknown as {reasoning?: string}).reasoning ?? p.text,
      time: p.time,
    }
  if (p.type === 'tool')
    return {
      ...base,
      type: 'tool',
      callID: p.callID,
      tool: p.tool,
      state: mapSdkToolState(p.state),
      metadata: p.metadata,
    }
  if (p.type !== 'step-finish') return {...base, type: 'text', text: 'text' in p ? (p as {text: string}).text : ''}
  const stepFinish = p
  return {
    ...base,
    type: 'step-finish',
    reason: stepFinish.reason,
    snapshot: stepFinish.snapshot,
    cost: stepFinish.cost,
    tokens: {
      input: stepFinish.tokens.input,
      output: stepFinish.tokens.output,
      reasoning: stepFinish.tokens.reasoning,
      cache: {read: stepFinish.tokens.cache.read, write: stepFinish.tokens.cache.write},
    },
  }
}

export function mapSdkMessageToMessage(m: SdkMessageExtended): Message {
  if (m.role === 'user') {
    const user = m as SdkUserMessage & {variant?: string}
    return {
      id: user.id,
      sessionID: user.sessionID,
      role: 'user',
      time: {created: user.time.created},
      summary:
        user.summary == null
          ? undefined
          : {
              title: user.summary.title,
              body: user.summary.body,
              diffs: mapSdkFileDiffs(user.summary.diffs) ?? [],
            },
      agent: user.agent,
      model: {
        providerID: user.model.providerID,
        modelID: user.model.modelID,
      },
      system: user.system,
      tools: user.tools,
      variant: user.variant,
    }
  }
  const assistant = m as SdkAssistantMessage & {agent?: string}
  return {
    id: assistant.id,
    sessionID: assistant.sessionID,
    role: 'assistant',
    time: {created: assistant.time.created, completed: assistant.time.completed},
    parentID: assistant.parentID,
    modelID: assistant.modelID,
    providerID: assistant.providerID,
    mode: assistant.mode,
    agent: assistant.agent ?? '',
    path: {cwd: assistant.path.cwd, root: assistant.path.root},
    summary: assistant.summary,
    cost: assistant.cost,
    tokens: {
      input: assistant.tokens.input,
      output: assistant.tokens.output,
      reasoning: assistant.tokens.reasoning,
      cache: {read: assistant.tokens.cache.read, write: assistant.tokens.cache.write},
    },
    finish: assistant.finish,
    error: assistant.error
      ? {name: assistant.error.name, message: readString(assistant.error.data.message) ?? ''}
      : undefined,
  }
}

export function mapSdkMessages(messages: readonly (SdkMessage | SdkMessageWithParts)[]): readonly Message[] {
  return [
    ...messages.map(item => {
      const sdkMessage = 'info' in item ? item.info : item
      const message = mapSdkMessageToMessage(sdkMessage as SdkMessageExtended)
      const parts = 'parts' in item ? item.parts.map(mapSdkPartToPart) : undefined
      return parts == null || parts.length === 0 ? message : ({...message, parts} as unknown as Message)
    }),
  ].sort((a, b) => a.time.created - b.time.created)
}
