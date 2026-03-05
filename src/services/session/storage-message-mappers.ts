import type {Message, Part, ToolState} from './types.js'

import {isRecord, mapSdkFileDiffs, readBoolean, readNumber, readString} from './storage-mappers.js'

function mapSdkToolState(s: Record<string, unknown>): ToolState {
  const status = readString(s.status) ?? 'pending'
  if (status === 'running')
    return {
      status: 'running',
      input: isRecord(s.input) ? s.input : {},
      time: {start: readNumber(isRecord(s.time) ? s.time.start : null) ?? 0},
    }
  if (status === 'error')
    return {
      status: 'error',
      input: isRecord(s.input) ? s.input : {},
      error: readString(s.error) ?? '',
      time: {
        start: readNumber(isRecord(s.time) ? s.time.start : null) ?? 0,
        end: readNumber(isRecord(s.time) ? s.time.end : null) ?? 0,
      },
    }
  if (status !== 'completed') return {status: 'pending'}
  const t = isRecord(s.time) ? s.time : null
  return {
    status: 'completed',
    input: isRecord(s.input) ? s.input : {},
    output: readString(s.output) ?? '',
    title: readString(s.title) ?? '',
    metadata: isRecord(s.metadata) ? s.metadata : {},
    time: {
      start: readNumber(t?.start) ?? 0,
      end: readNumber(t?.end) ?? 0,
      compacted: readNumber(t?.compacted) ?? undefined,
    },
    attachments: undefined,
  }
}

export function mapSdkPartToPart(p: unknown): Part {
  if (!isRecord(p)) return {id: '', sessionID: '', messageID: '', type: 'text', text: ''}
  const base = {
    id: readString(p.id) ?? '',
    sessionID: readString(p.sessionID) ?? readString(p.sessionId) ?? '',
    messageID: readString(p.messageID) ?? readString(p.messageId) ?? '',
  }
  const type = readString(p.type)
  if (type === 'text')
    return {
      ...base,
      type: 'text',
      text: readString(p.text) ?? '',
      synthetic: readBoolean(p.synthetic) ?? undefined,
      ignored: readBoolean(p.ignored) ?? undefined,
      time: isRecord(p.time)
        ? {start: readNumber(p.time.start) ?? 0, end: readNumber(p.time.end) ?? undefined}
        : undefined,
      metadata: isRecord(p.metadata) ? p.metadata : undefined,
    }
  if (type === 'reasoning')
    return {
      ...base,
      type: 'reasoning',
      reasoning: readString(p.reasoning) ?? '',
      time: isRecord(p.time)
        ? {start: readNumber(p.time.start) ?? 0, end: readNumber(p.time.end) ?? undefined}
        : undefined,
    }
  if (type === 'tool')
    return {
      ...base,
      type: 'tool',
      callID: readString(p.callID) ?? readString(p.callId) ?? '',
      tool: readString(p.tool) ?? '',
      state: mapSdkToolState(isRecord(p.state) ? p.state : {status: 'pending'}),
      metadata: isRecord(p.metadata) ? p.metadata : undefined,
    }
  if (type !== 'step-finish') return {...base, type: 'text', text: readString(p.text) ?? ''}
  const tokens = isRecord(p.tokens) ? p.tokens : null
  const cache = isRecord(tokens?.cache) ? tokens.cache : null
  return {
    ...base,
    type: 'step-finish',
    reason: readString(p.reason) ?? '',
    snapshot: readString(p.snapshot) ?? undefined,
    cost: readNumber(p.cost) ?? 0,
    tokens: {
      input: readNumber(tokens?.input) ?? 0,
      output: readNumber(tokens?.output) ?? 0,
      reasoning: readNumber(tokens?.reasoning) ?? 0,
      cache: {read: readNumber(cache?.read) ?? 0, write: readNumber(cache?.write) ?? 0},
    },
  }
}

export function mapSdkMessageToMessage(m: unknown): Message {
  if (!isRecord(m))
    return {id: '', sessionID: '', role: 'user', time: {created: 0}, agent: '', model: {providerID: '', modelID: ''}}
  if (readString(m.role) !== 'assistant') {
    const model = isRecord(m.model) ? m.model : null
    return {
      id: readString(m.id) ?? '',
      sessionID: readString(m.sessionID) ?? readString(m.sessionId) ?? '',
      role: 'user',
      time: {created: readNumber(isRecord(m.time) ? m.time.created : null) ?? 0},
      summary: isRecord(m.summary)
        ? {
            title: readString(m.summary.title) ?? undefined,
            body: readString(m.summary.body) ?? undefined,
            diffs: mapSdkFileDiffs(m.summary.diffs) ?? [],
          }
        : undefined,
      agent: readString(m.agent) ?? '',
      model: {
        providerID:
          readString(model?.providerID) ??
          readString(model?.providerId) ??
          readString(m.providerID) ??
          readString(m.providerId) ??
          '',
        modelID:
          readString(model?.modelID) ??
          readString(model?.modelId) ??
          readString(m.modelID) ??
          readString(m.modelId) ??
          '',
      },
      system: readString(m.system) ?? undefined,
      tools: isRecord(m.tools) ? (m.tools as Record<string, boolean>) : undefined,
      variant: readString(m.variant) ?? undefined,
    }
  }
  const t = isRecord(m.time) ? m.time : null
  const tokens = isRecord(m.tokens) ? m.tokens : null
  const cache = isRecord(tokens?.cache) ? tokens.cache : null
  const path = isRecord(m.path) ? m.path : null
  return {
    id: readString(m.id) ?? '',
    sessionID: readString(m.sessionID) ?? readString(m.sessionId) ?? '',
    role: 'assistant',
    time: {created: readNumber(t?.created) ?? 0, completed: readNumber(t?.completed) ?? undefined},
    parentID: readString(m.parentID) ?? readString(m.parentId) ?? '',
    modelID: readString(m.modelID) ?? readString(m.modelId) ?? '',
    providerID: readString(m.providerID) ?? readString(m.providerId) ?? '',
    mode: readString(m.mode) ?? '',
    agent: readString(m.agent) ?? '',
    path: {cwd: readString(path?.cwd) ?? '', root: readString(path?.root) ?? ''},
    summary: readBoolean(m.summary) ?? undefined,
    cost: readNumber(m.cost) ?? 0,
    tokens: {
      input: readNumber(tokens?.input) ?? 0,
      output: readNumber(tokens?.output) ?? 0,
      reasoning: readNumber(tokens?.reasoning) ?? 0,
      cache: {read: readNumber(cache?.read) ?? 0, write: readNumber(cache?.write) ?? 0},
    },
    finish: readString(m.finish) ?? undefined,
    error: isRecord(m.error)
      ? {name: readString(m.error.name) ?? '', message: readString(m.error.message) ?? ''}
      : undefined,
  }
}

export function mapSdkMessages(v: unknown): readonly Message[] {
  if (!Array.isArray(v)) return []
  return [
    ...v.map(item => {
      const message = mapSdkMessageToMessage(item)
      if (!isRecord(item)) return message
      const parts = Array.isArray(item.parts) ? item.parts.map(mapSdkPartToPart) : undefined
      return parts == null || parts.length === 0 ? message : ({...message, parts} as unknown as Message)
    }),
  ].sort((a, b) => a.time.created - b.time.created)
}
