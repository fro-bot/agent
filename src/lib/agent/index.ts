/**
 * Agent module public exports for RFC-012 and RFC-013.
 *
 * Provides the core agent execution primitives:
 * - Context collection from GitHub Actions
 * - Prompt construction with session/CLI instructions
 * - Reactions and labels for acknowledgment UX
 * - OpenCode SDK execution (RFC-013)
 */

// Context collection
export {collectAgentContext} from './context.js'
export type {CollectAgentContextOptions} from './context.js'

// Diff context collection (RFC-009) - used internally by collectAgentContext
export {collectDiffContext} from './diff-context.js'

// OpenCode execution (RFC-013: SDK mode)
export {bootstrapOpenCodeServer, ensureOpenCodeAvailable, executeOpenCode, verifyOpenCodeAvailable} from './opencode.js'
export type {OpenCodeServerHandle} from './opencode.js'

// Prompt construction
export {buildAgentPrompt, buildTaskSection, getTriggerDirective} from './prompt.js'

export type {TriggerDirective} from './prompt.js'

// Reactions & labels
export {
  acknowledgeReceipt,
  addEyesReaction,
  addWorkingLabel,
  completeAcknowledgment,
  removeWorkingLabel,
  updateReactionOnFailure,
  updateReactionOnSuccess,
} from './reactions.js'

// Types
export type {
  AcknowledgmentState,
  AgentContext,
  AgentResult,
  EnsureOpenCodeResult,
  ExecutionConfig,
  PromptOptions,
  ReactionContext,
} from './types.js'

export {WORKING_LABEL, WORKING_LABEL_COLOR, WORKING_LABEL_DESCRIPTION} from './types.js'
