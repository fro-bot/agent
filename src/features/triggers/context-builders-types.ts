import type {AuthorInfo, ParsedCommand, TriggerContext} from './types.js'

export interface TriggerContextData {
  readonly author: AuthorInfo
  readonly target: NonNullable<TriggerContext['target']>
  readonly commentBody: string | null
  readonly commentId: number | null
  readonly hasMention: boolean
  readonly command: ParsedCommand | null
  readonly isBotReviewRequested: boolean
  readonly action: string | null
}
