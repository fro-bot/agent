/** V2 session model, projected down to what the session tools read. */

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
  /** Synthetic messages count as user, compaction summaries as assistant. */
  readonly role: 'user' | 'assistant'
  readonly agent?: string
  readonly createdAt: number
  readonly parts: readonly PartV2[]
  /** The todo list the message's last completed `todowrite` call set, if it made one. */
  readonly todos?: readonly TodoItemV2[]
}
