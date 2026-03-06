import type {Session as SdkSession} from '@opencode-ai/sdk'

import type {SessionInfo, TodoItem} from './types.js'

type SdkSessionExtended = SdkSession & {
  readonly permission?: {rules: readonly unknown[]}
  readonly time: SdkSession['time'] & {archived?: number}
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v != null
export const readString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
export const readNumber = (v: unknown): number | null => (typeof v === 'number' ? v : null)
export const readBoolean = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

export function mapSdkFileDiffs(
  v: unknown,
): readonly {file: string; additions: number; deletions: number}[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter(isRecord).map(d => ({
    file: readString(d.file) ?? '',
    additions: readNumber(d.additions) ?? 0,
    deletions: readNumber(d.deletions) ?? 0,
  }))
}

export function mapSdkSessionToSessionInfo(s: SdkSessionExtended): SessionInfo {
  return {
    id: s.id,
    version: s.version,
    projectID: s.projectID,
    directory: s.directory,
    parentID: s.parentID,
    title: s.title,
    time: {
      created: s.time.created,
      updated: s.time.updated,
      compacting: s.time.compacting,
      archived: s.time.archived,
    },
    summary:
      s.summary == null
        ? undefined
        : {
            additions: s.summary.additions,
            deletions: s.summary.deletions,
            files: s.summary.files,
            diffs: mapSdkFileDiffs(s.summary.diffs),
          },
    share: s.share?.url == null ? undefined : {url: s.share.url},
    permission: s.permission == null ? undefined : {rules: s.permission.rules},
    revert:
      s.revert == null
        ? undefined
        : {
            messageID: s.revert.messageID,
            partID: s.revert.partID,
            snapshot: s.revert.snapshot,
            diff: s.revert.diff,
          },
  }
}

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
