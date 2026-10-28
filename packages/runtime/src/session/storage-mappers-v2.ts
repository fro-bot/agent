/**
 * V2 sibling of `storage-mappers.ts`: parse raw V2 session payloads into the projected `SessionInfoV2`.
 *
 * Parse, don't validate: every mapper takes `unknown`, returns `null` for anything that is not the shape it expects, and
 * never throws. The plugin context returns bare payloads while the HTTP client wraps most of them in `{data}`, so each
 * mapper unwraps first and accepts both.
 */

import type {SessionInfoV2} from './types-v2.js'

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null
export const readString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const readNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Strips a `{data}` envelope. A bare payload passes through. */
export function unwrapData(v: unknown): unknown {
  return isRecord(v) && !Array.isArray(v) && 'data' in v ? v.data : v
}

export function mapSessionInfoV2(v: unknown): SessionInfoV2 | null {
  const payload = unwrapData(v)
  if (!isRecord(payload) || Array.isArray(payload)) return null

  const id = readString(payload.id)
  const projectID = readString(payload.projectID)
  const time = payload.time
  const location = payload.location
  if (id == null || projectID == null || !isRecord(time) || !isRecord(location)) return null

  const created = readNumber(time.created)
  const updated = readNumber(time.updated)
  const directory = readString(location.directory)
  if (created == null || updated == null || directory == null) return null

  const parentID = readString(payload.parentID)
  const archived = readNumber(time.archived)
  return {
    id,
    projectID,
    directory,
    ...(parentID == null ? {} : {parentID}),
    title: readString(payload.title) ?? '',
    time: {created, updated, ...(archived == null ? {} : {archived})},
  }
}

export interface SessionPageV2 {
  readonly sessions: readonly SessionInfoV2[]
  readonly nextCursor?: string
}

/**
 * Maps one page of sessions. Returns `null` when the payload is not list-shaped, so a protocol change is not mistaken
 * for "no sessions". Entries that fail to map are dropped.
 */
export function mapSessionPageV2(v: unknown): SessionPageV2 | null {
  const items = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v.data) ? v.data : null
  if (items == null) return null

  const sessions: SessionInfoV2[] = []
  for (const item of items) {
    const mapped = mapSessionInfoV2(item)
    if (mapped != null) sessions.push(mapped)
  }

  const cursor = isRecord(v) ? v.cursor : undefined
  const nextCursor = isRecord(cursor) ? readString(cursor.next) : null
  return {sessions, ...(nextCursor == null || nextCursor.length === 0 ? {} : {nextCursor})}
}
