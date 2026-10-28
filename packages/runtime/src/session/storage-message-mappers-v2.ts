/** V2 sibling of `storage-message-mappers.ts`: flatten V2 session messages (user, synthetic, assistant, compaction). */

import type {MessageV2, PartV2, TodoItemV2} from './types-v2.js'

import {isRecord, readNumber, readString, unwrapData} from './storage-mappers-v2.js'

const TODO_TOOL = 'todowrite'
const TODO_STATUSES: readonly TodoItemV2['status'][] = ['pending', 'in_progress', 'completed', 'cancelled']

function textPart(messageID: string, index: number, kind: PartV2['kind'], text: string): PartV2 {
  return {id: `${messageID}:${index}`, kind, text}
}

/** Joins the text items of a tool result. File items carry no searchable text. */
function readToolText(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const texts = content.filter(isRecord).flatMap(item => {
    const text = item.type === 'text' ? readString(item.text) : null
    return text == null ? [] : [text]
  })
  return texts.length === 0 ? null : texts.join('\n')
}

function readTodos(input: unknown): readonly TodoItemV2[] | null {
  if (!isRecord(input) || !Array.isArray(input.todos)) return null
  const todos: TodoItemV2[] = []
  for (const item of input.todos) {
    if (!isRecord(item)) continue
    const content = readString(item.content)
    if (content == null) continue
    const status = TODO_STATUSES.find(candidate => candidate === item.status)
    todos.push({content, status: status ?? 'pending'})
  }
  return todos
}

function mapAssistantContent(
  messageID: string,
  content: unknown,
): {readonly parts: readonly PartV2[]; readonly todos?: readonly TodoItemV2[]} {
  if (!Array.isArray(content)) return {parts: []}

  const parts: PartV2[] = []
  let todos: readonly TodoItemV2[] | undefined
  for (const item of content) {
    if (!isRecord(item)) continue
    const index = parts.length
    if (item.type === 'text') {
      const text = readString(item.text)
      if (text != null) parts.push(textPart(messageID, index, 'text', text))
    } else if (item.type === 'reasoning') {
      const text = readString(item.text)
      if (text != null) parts.push(textPart(messageID, index, 'reasoning', text))
    } else if (item.type === 'tool' && isRecord(item.state) && item.state.status === 'completed') {
      const name = readString(item.name)
      const output = readToolText(item.state.content)
      if (name != null && output != null) parts.push(textPart(messageID, index, 'tool', `${name}: ${output}`))
      if (name === TODO_TOOL) todos = readTodos(item.state.input) ?? todos
    }
  }
  return {parts, ...(todos == null ? {} : {todos})}
}

function mapMessageV2(v: unknown): MessageV2 | null {
  if (!isRecord(v)) return null
  const id = readString(v.id)
  const time = v.time
  const createdAt = isRecord(time) ? readNumber(time.created) : null
  if (id == null || createdAt == null) return null

  if (v.type === 'user' || v.type === 'synthetic') {
    const text = readString(v.text)
    return {id, role: 'user', createdAt, parts: text == null ? [] : [textPart(id, 0, 'text', text)]}
  }
  if (v.type === 'assistant') {
    const agent = readString(v.agent)
    return {
      id,
      role: 'assistant',
      ...(agent == null ? {} : {agent}),
      createdAt,
      ...mapAssistantContent(id, v.content),
    }
  }
  // A completed compaction is the only record of what came before the active window, so keep its summary searchable.
  if (v.type === 'compaction' && v.status === 'completed') {
    const summary = readString(v.summary)
    return {id, role: 'assistant', createdAt, parts: summary == null ? [] : [textPart(id, 0, 'text', summary)]}
  }
  return null
}

/** Maps a message list oldest-first, or `null` when the payload is not list-shaped. */
export function mapMessagesV2(v: unknown): readonly MessageV2[] | null {
  const items = unwrapData(v)
  if (!Array.isArray(items)) return null

  const messages: MessageV2[] = []
  for (const item of items) {
    const mapped = mapMessageV2(item)
    if (mapped != null) messages.push(mapped)
  }
  return messages.toSorted((a, b) => a.createdAt - b.createdAt)
}

/** The todo list set by the most recent completed `todowrite` call, or an empty list. */
export function latestTodosV2(messages: readonly MessageV2[]): readonly TodoItemV2[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const todos = messages[index]?.todos
    if (todos != null) return todos
  }
  return []
}
