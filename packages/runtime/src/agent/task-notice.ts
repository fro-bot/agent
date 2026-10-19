import {getBooleanProperty, getStringProperty} from './payload-accessors.js'

/**
 * Upstream's `task` tool injects a synthetic text prompt into the PARENT session when a background dispatch
 * finishes (see `inject()` / `renderOutput()` in upstream `tool/task.ts`), rendered as
 * `<task id="{childSessionId}" state="completed|error">...`. That tag is the only observable signal that a
 * background execution settled; no structured field carries it. The pattern matches the opening tag only, and the
 * running state is never injected this way.
 */
const TASK_NOTICE_PATTERN = /<task id="([^"]+)" state="(completed|error)">/

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
