import type {SessionInfo, TodoItem} from './types.js'

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

export function mapSdkSessionToSessionInfo(s: unknown): SessionInfo {
  if (!isRecord(s))
    return {id: '', version: '', projectID: '', directory: '', title: '', time: {created: 0, updated: 0}}
  return {
    id: readString(s.id) ?? '',
    version: readString(s.version) ?? '',
    projectID: readString(s.projectID) ?? readString(s.projectId) ?? '',
    directory: readString(s.directory) ?? '',
    parentID: readString(s.parentID) ?? readString(s.parentId) ?? undefined,
    title: readString(s.title) ?? '',
    time: isRecord(s.time)
      ? {
          created: readNumber(s.time.created) ?? 0,
          updated: readNumber(s.time.updated) ?? 0,
          compacting: readNumber(s.time.compacting) ?? undefined,
          archived: readNumber(s.time.archived) ?? undefined,
        }
      : {created: 0, updated: 0},
    summary: isRecord(s.summary)
      ? {
          additions: readNumber(s.summary.additions) ?? 0,
          deletions: readNumber(s.summary.deletions) ?? 0,
          files: readNumber(s.summary.files) ?? 0,
          diffs: mapSdkFileDiffs(s.summary.diffs),
        }
      : undefined,
    share: isRecord(s.share) && readString(s.share.url) != null ? {url: readString(s.share.url) ?? ''} : undefined,
    permission: isRecord(s.permission)
      ? {rules: Array.isArray(s.permission.rules) ? s.permission.rules : []}
      : undefined,
    revert: isRecord(s.revert)
      ? {
          messageID: readString(s.revert.messageID) ?? readString(s.revert.messageId) ?? '',
          partID: readString(s.revert.partID) ?? readString(s.revert.partId) ?? undefined,
          snapshot: readString(s.revert.snapshot) ?? undefined,
          diff: readString(s.revert.diff) ?? undefined,
        }
      : undefined,
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
