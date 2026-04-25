// Backend types (SDK-only)
export type {SessionClient} from './backend.js'

export {findProjectByWorkspace, listProjectsViaSDK} from './discovery.js'

// Logical session continuity
export {buildLogicalKey, buildSessionTitle, findSessionByTitle, resolveSessionForLogicalKey} from './logical-key.js'

export type {LogicalSessionKey, SessionResolution} from './logical-key.js'

// Pruning
export {DEFAULT_PRUNING_CONFIG, pruneSessions} from './prune.js'
// PruningConfig is already exported via shared/types.ts → shared/index.ts
// Search operations
export {getSessionInfo, listSessions, searchSessions} from './search.js'
// Storage utilities
export {
  deleteSession,
  findLatestSession,
  getSession,
  getSessionMessages,
  getSessionTodos,
  listSessionsForProject,
} from './storage.js'

// Title maintenance
export {reassertSessionTitle} from './title-reassert.js'

// Types
export type {
  AssistantMessage,
  FileDiff,
  FilePart,
  Logger,
  Message,
  MessageError,
  Part,
  PartBase,
  PermissionRuleset,
  ProjectInfo,
  PruneResult,
  ReasoningPart,
  SessionInfo,
  SessionMatch,
  SessionSearchResult,
  SessionSummary,
  StepFinishPart,
  TextPart,
  TodoItem,
  ToolPart,
  ToolState,
  ToolStateCompleted,
  ToolStateError,
  ToolStatePending,
  ToolStateRunning,
  UserMessage,
} from './types.js'

// Version detection
export {compareVersions, getOpenCodeDbPath, isSqliteBackend, OPENCODE_SQLITE_VERSION} from './version.js'

// Writeback
export {writeSessionSummary} from './writeback.js'
