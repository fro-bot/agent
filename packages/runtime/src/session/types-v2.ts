/**
 * V2 session model, projected down to what the session tools read.
 *
 * V2 has no `{info, parts[]}` message shape: a message is one tagged record, and an assistant message carries its
 * content inline. `storage-message-mappers-v2.ts` flattens that into searchable text parts so search, transcript
 * rendering and todo extraction work on one small type instead of the upstream union.
 */

export interface SessionInfoV2 {
  readonly id: string
  readonly projectID: string
  /** Directory the session was created in (exact string, as stored). */
  readonly directory: string
  readonly parentID?: string
  readonly title: string
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly archived?: number
  }
}

export interface PartV2 {
  /** V2 content has no part ids; this is `<messageID>:<index>`. */
  readonly id: string
  readonly kind: 'text' | 'reasoning' | 'tool'
  readonly text: string
}

export interface TodoItemV2 {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

export interface MessageV2 {
  readonly id: string
  /** Synthetic and compaction messages are folded into these two; the rest of the V2 union is not conversation. */
  readonly role: 'user' | 'assistant'
  readonly agent?: string
  readonly createdAt: number
  readonly parts: readonly PartV2[]
  /** The todo list the message's last completed `todowrite` call set, if it made one. */
  readonly todos?: readonly TodoItemV2[]
}
