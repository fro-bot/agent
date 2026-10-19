import {getBooleanProperty, getStringProperty} from './payload-accessors.js'

/** `<task id="{childSessionId}" state="completed|error">` — see `renderOutput` in upstream `tool/task.ts`. */
export const TASK_NOTICE_PATTERN = /<task id="([^"]+)" state="(completed|error)">/

export interface TaskNotice {
  readonly childSessionId: string
  readonly state: 'completed' | 'error'
}

/** Parse the opening tag of an injected background-task notice. The `running` state is never injected. */
export function parseTaskNotice(text: string): TaskNotice | null {
  const match = TASK_NOTICE_PATTERN.exec(text)
  const childSessionId = match?.[1]
  const state = match?.[2]
  if (childSessionId === undefined || (state !== 'completed' && state !== 'error')) return null
  return {childSessionId, state}
}

/** A notice parsed out of a persisted/streamed message part, or null when the part is not one. */
export function parseSyntheticNoticePart(part: unknown): TaskNotice | null {
  if (getStringProperty(part, 'type') !== 'text') return null
  if (getBooleanProperty(part, 'synthetic') !== true) return null
  const text = getStringProperty(part, 'text')
  return text === null ? null : parseTaskNotice(text)
}
