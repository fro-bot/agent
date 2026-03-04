import type {TodoItem} from './types.js'

import {isRecord, readString} from './storage-value-readers.js'

export function mapSdkTodos(v: unknown): readonly TodoItem[] {
  if (!Array.isArray(v)) return []
  const todos: TodoItem[] = []
  for (const item of v) {
    if (!isRecord(item)) continue
    const content = readString(item.content)
    const status = readString(item.status)
    const priority = readString(item.priority)
    if (content == null || status == null || priority == null) continue
    todos.push({
      ...((readString(item.id) == null ? {} : {id: readString(item.id) ?? ''}) as {id?: string}),
      content,
      status:
        status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'cancelled'
          ? status
          : 'pending',
      priority: priority === 'high' || priority === 'medium' || priority === 'low' ? priority : 'medium',
    })
  }
  return todos
}
