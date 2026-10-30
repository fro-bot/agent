/** V2 sibling of `backend.ts`: the smallest structural client surface the storage layer needs; callers adapt to it. */

export interface SessionListQueryV2 {
  /** Exact-string match on the directory the session was created with. */
  readonly directory?: string
  readonly limit?: number
  /** Opaque cursor from the previous page. */
  readonly cursor?: string
  readonly order?: 'asc' | 'desc'
  /** `null` selects root sessions only. */
  readonly parentID?: string | null
  readonly archived?: boolean
}

export interface SessionClientV2 {
  /** One page of sessions: `{data: [...], cursor?: {next?}}`. */
  readonly list: (query: SessionListQueryV2) => Promise<unknown>
  /** The session, or `null` when it does not exist. Rejects only on a real failure. */
  readonly get: (sessionID: string) => Promise<unknown>
  /** The session's messages, oldest first. For the plugin context: the active window since the last compaction. */
  readonly messages: (sessionID: string) => Promise<unknown>
}
