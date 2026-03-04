import type {SkipCheckResult} from './skip-conditions-types.js'
import type {TriggerConfig, TriggerContext} from './types.js'

export function checkScheduleSkipConditions(config: TriggerConfig): SkipCheckResult {
  const promptInput = config.promptInput?.trim() ?? ''
  if (promptInput === '') {
    return {
      shouldSkip: true,
      reason: 'prompt_required',
      message: 'Schedule trigger requires prompt input',
    }
  }

  return {shouldSkip: false}
}

export function checkWorkflowDispatchSkipConditions(context: TriggerContext): SkipCheckResult {
  const promptInput = context.commentBody?.trim() ?? ''
  if (promptInput === '') {
    return {
      shouldSkip: true,
      reason: 'prompt_required',
      message: 'Workflow dispatch requires prompt input',
    }
  }

  return {shouldSkip: false}
}
