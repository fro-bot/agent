/**
 * Discord question transport.
 *
 * Posts an agent question into the run's Discord thread and attaches the render
 * that rewrites the prompt when the question settles. The question counterpart of
 * `discord-transport.ts`, with the same seam: the run's question coordinator
 * registers the question with the gate first (register-before-send), then calls
 * the hook this module returns.
 *
 * ### What it posts
 *
 * `planQuestionPrompt` decides. A question that fits Discord's component limits
 * gets a native prompt (buttons or a select, Skip, and an optional text modal).
 * Anything else gets a fixed-copy notice that points to the operator web surface;
 * the notice never carries question text, and the request stays answerable from
 * the web and is skipped at its deadline like any other.
 *
 * ### Delivery failure never settles the question
 *
 * Unlike a tool approval, a question that could not be posted is not rejected:
 * web operators can still answer it, and the deadline still skips it. A terminal
 * failure (the thread is gone, or the bot lost access) is logged once with ids and
 * the Discord error code; a retryable failure is logged and left alone.
 *
 * ### Untrusted text
 *
 * Logs here carry request ids, run ids, fallback reason codes and Discord error
 * codes — never question or answer text, and never an error message (a Discord
 * error message can echo request content). Every send goes through the reply
 * sink, whose Discord implementation always applies `allowedMentions: {parse: []}`;
 * every edit goes through `editMessage`, which does the same.
 */

import type {Result} from '@fro-bot/runtime'
import type {Message} from 'discord.js'

import type {GatewayLogger} from '../discord/client.js'
import type {ReplySink} from '../execute/launch-types.js'
import type {QuestionAskedRequest} from './question-coordinator.js'
import type {QuestionInfo, QuestionRegistry, QuestionSettlement} from './question-registry.js'

import {DiscordAPIError} from 'discord.js'

import {editMessage} from '../discord/io.js'
import {
  buildQuestionFallbackNotice,
  buildQuestionSettledEmbed,
  planQuestionPrompt,
  QUESTION_FALLBACK_RESOLVED_NOTICE,
} from '../discord/questions.js'
import {isTerminalDeliveryFailure} from './discord-transport.js'

export interface DiscordQuestionTransportDeps {
  /** Program-scoped question registry; the transport attaches its settle render here. */
  readonly questionRegistry: Pick<QuestionRegistry, 'attachMessage'>
  /**
   * The gateway's configured public operator origin (`https://…`), used for the link in the
   * fallback notice. `undefined` when the operator web surface is not configured.
   */
  readonly operatorOrigin: string | undefined
  readonly logger: GatewayLogger
}

/** Per-run context supplied by the run engine. */
export interface DiscordQuestionTransportContext {
  /** The run's reply sink; its Discord implementation posts into the run's thread. */
  readonly replySink: ReplySink
  readonly runId: string
}

export type DiscordQuestionOnRegistered = (request: QuestionAskedRequest) => void

function errorFields(error: unknown): {readonly code?: number; readonly errName: string} {
  if (error instanceof DiscordAPIError && typeof error.code === 'number') return {code: error.code, errName: error.name}
  return {errName: error instanceof Error ? error.name : 'non-error'}
}

/**
 * Build the Discord fan-out for a run. The returned hook posts the prompt (or the
 * fallback notice) and attaches the settled render. It returns immediately, never
 * throws, and never rejects: all work after the first synchronous step is
 * fire-and-forget with its own failure handling.
 */
export function createDiscordQuestionOnRegistered(
  deps: DiscordQuestionTransportDeps,
): (context: DiscordQuestionTransportContext) => DiscordQuestionOnRegistered {
  const {questionRegistry, operatorOrigin, logger} = deps

  return (ctx: DiscordQuestionTransportContext): DiscordQuestionOnRegistered => {
    const {replySink, runId} = ctx

    function undeliverable(requestID: string, error: unknown, stage: 'send' | 'attach'): void {
      if (isTerminalDeliveryFailure(error)) {
        logger.error(
          {requestID, runId, stage, ...errorFields(error)},
          'discord-question-transport: question undeliverable (terminal Discord error) — still answerable from the web, deadline will skip it',
        )
        return
      }
      logger.warn(
        {requestID, runId, stage, ...errorFields(error)},
        'discord-question-transport: question post failed (retryable) — still answerable from the web',
      )
    }

    function attachSettledRender(
      requestID: string,
      posted: Message,
      render: (questions: readonly QuestionInfo[], settlement: QuestionSettlement) => Parameters<typeof editMessage>[1],
    ): void {
      try {
        questionRegistry.attachMessage(requestID, async (questions, settlement) => {
          try {
            const result = await editMessage(posted, render(questions, settlement), logger)
            if (result.success === false) {
              logger.warn(
                {requestID, runId, reason: settlement.reason, ...errorFields(result.error)},
                'discord-question-transport: failed to edit the settled question message',
              )
            }
          } catch (error: unknown) {
            logger.warn(
              {requestID, runId, ...errorFields(error)},
              'discord-question-transport: settled render threw (fail-soft; settlement already applied)',
            )
          }
        })
      } catch (error: unknown) {
        logger.warn({requestID, runId, ...errorFields(error)}, 'discord-question-transport: attachMessage threw')
      }
    }

    return function onRegistered(request: QuestionAskedRequest): void {
      const {requestID, questions} = request

      let plan: ReturnType<typeof planQuestionPrompt>
      let content: string | undefined
      try {
        plan = planQuestionPrompt(requestID, questions)
        if (plan.kind === 'fallback') {
          logger.info(
            {requestID, runId, reason: plan.reason},
            'discord-question-transport: question cannot be shown natively — posting a web-fallback notice',
          )
          content = buildQuestionFallbackNotice(operatorOrigin)
        }
      } catch (error: unknown) {
        // A builder rejected the shape (for example a value Discord's validators refuse).
        logger.warn(
          {requestID, runId, ...errorFields(error)},
          'discord-question-transport: building the prompt failed — still answerable from the web',
        )
        return
      }

      const settle = replySink.markVisibleOutputPending()
      const message =
        plan.kind === 'prompt' ? {embeds: [plan.embed], components: [...plan.components]} : {content: content ?? ''}

      // eslint-disable-next-line no-void
      void replySink
        .send('thread', message)
        .then(result => {
          const sent = result as Result<Message, Error> | undefined
          if (sent?.success === true) {
            settle(true)
            if (plan.kind === 'prompt') {
              attachSettledRender(requestID, sent.data, (promptQuestions, settlement) => ({
                embeds: [buildQuestionSettledEmbed(promptQuestions[0], settlement)],
                components: [],
              }))
            } else {
              attachSettledRender(requestID, sent.data, () => ({
                content: QUESTION_FALLBACK_RESOLVED_NOTICE,
                components: [],
              }))
            }
            return
          }
          settle(false)
          undeliverable(requestID, sent?.success === false ? sent.error : undefined, 'send')
        })
        .catch((error: unknown) => {
          settle(false)
          undeliverable(requestID, error, 'send')
        })
    }
  }
}

/**
 * Run several question hooks as one. Each hook runs independently: one that throws
 * is logged by request id and error name and never stops the others. The
 * composition itself never throws.
 */
export function composeQuestionHooks(
  hooks: readonly (DiscordQuestionOnRegistered | undefined)[],
  logger: GatewayLogger,
): DiscordQuestionOnRegistered {
  return (request: QuestionAskedRequest): void => {
    for (const hook of hooks) {
      if (hook === undefined) continue
      try {
        hook(request)
      } catch (error: unknown) {
        logger.warn(
          {requestID: request.requestID, ...errorFields(error)},
          'question-transport: a transport hook threw — continuing with the others',
        )
      }
    }
  }
}
