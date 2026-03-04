import type {Part, ToolState} from './types.js'

import {isRecord, readBoolean, readNumber, readString} from './storage-value-readers.js'

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
