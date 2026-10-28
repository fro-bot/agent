/**
 * V2 sibling of `backend.ts`.
 *
 * V1 aliased the SDK client type. The V2 plugin context (`ctx.session`) and the Promise client expose differently
 * shaped, branded-ID methods, and neither is a dependency of this package. So the V2 backend is the smallest
 * structural surface the storage layer needs, and each caller adapts its own client to it. Every method resolves to the
 * raw payload: `storage-mappers-v2.ts` parses it, so a shape change upstream degrades one read instead of throwing.
 */

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
  /**
   * The session's messages, oldest first. For the plugin context this is the active context window: messages after
   * the last compaction, with the compaction summary standing in for what came before.
   */
  readonly messages: (sessionID: string) => Promise<unknown>
}
