// Backend types (SDK-only)
export type {SessionClient} from './backend.js'

export {findProjectByWorkspace, listProjectsViaSDK} from './discovery.js'

// Pruning
export {DEFAULT_PRUNING_CONFIG, pruneSessions} from './prune.js'

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
  PruningConfig,
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
export {compareVersions, getOpenCodeDbPath, OPENCODE_SQLITE_VERSION} from './version.js'

// Writeback
export {writeSessionSummary} from './writeback.js'
