import {getObjectProperty, getStringProperty} from './payload-accessors.js'

/** `sessionID` of a payload object, own-only. */
export function getSessionID(value: unknown): string | null {
  return getStringProperty(value, 'sessionID')
}

/**
 * Event kind of a raw server event. Non-sync events return `event.type` as-is. Sync events return `event.name` with
 * the trailing `.N` index stripped.
 */
export function getEventKind(event: unknown): string | null {
  const eventType = getStringProperty(event, 'type')
  if (eventType !== 'sync') return eventType

  return getStringProperty(event, 'name')?.replace(/\.\d+$/, '') ?? eventType
}

/** Canonical payload of a raw server event: `properties`, falling back to `data` (sync events carry `data`). */
export function getEventPayload(event: unknown): unknown {
  return getObjectProperty(event, 'properties') ?? getObjectProperty(event, 'data')
}

/** Session ID of a raw server event: `properties.sessionID`, then `data.sessionID`. */
export function getEventSessionID(event: unknown): string | null {
  return getSessionID(getObjectProperty(event, 'properties')) ?? getSessionID(getObjectProperty(event, 'data'))
}
