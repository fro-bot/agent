import type {Message} from './types.js'

import {mapSdkMessageToMessage} from './storage-message-base-mapper.js'
import {mapSdkPartToPart} from './storage-part-mapper.js'
import {isRecord} from './storage-value-readers.js'

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
