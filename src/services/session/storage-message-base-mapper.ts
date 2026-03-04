import type {Message} from './types.js'

import {isRecord, readBoolean, readNumber, readString} from './storage-value-readers.js'

function mapSdkFileDiffs(v: unknown): readonly {file: string; additions: number; deletions: number}[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter(isRecord).map(d => ({
    file: readString(d.file) ?? '',
    additions: readNumber(d.additions) ?? 0,
    deletions: readNumber(d.deletions) ?? 0,
  }))
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
