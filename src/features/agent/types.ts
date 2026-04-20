/**
 * Agent-specific type definitions for RFC-012, RFC-013, and RFC-014.
 *
 * These types are used for agent context collection, prompt construction,
 * reactions/labels management, and OpenCode execution.
 */

export type {
  AcknowledgmentState,
  AgentContext,
  AgentResult,
  DiffContext,
  DiffFileSummary,
  EnsureOpenCodeResult,
  ExecutionConfig,
  PromptOptions,
  PromptResult,
  ReactionContext,
  ReferenceFile,
  SessionContext,
} from '@fro-bot/runtime'

export {
  DEFAULT_CONTEXT_BUDGET,
  ERROR_TYPES,
  EVENT_TYPES,
  WORKING_LABEL,
  WORKING_LABEL_COLOR,
  WORKING_LABEL_DESCRIPTION,
} from '@fro-bot/runtime'

export type {
  ContextBudget,
  ErrorInfo,
  ErrorType,
  EventType,
  HydratedContext,
  IssueContext,
  ParsedCommand,
  PullRequestContext,
  TriggerContext,
  TriggerTarget,
} from '@fro-bot/runtime'

export type {OutputMode, ResolvedOutputMode} from '@fro-bot/runtime'
