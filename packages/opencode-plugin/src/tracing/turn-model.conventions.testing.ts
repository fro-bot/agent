/** Replays one primary request and the calls made during its step, for the turn model's #2403 tests. */

import type {Observation} from './observation.js'
import type {SpanRecord, ToolRecord} from './turn-model.js'

import {replay} from './turn-model.testing.js'

export const SES = 'a'
export const STEP = 's1'

export type ObservationInput = Observation extends infer Each
  ? Each extends Observation
    ? Omit<Each, 'at'>
    : never
  : never

export interface TurnOptions {
  /** What the primary request hook carried as its `content`. */
  readonly request?: unknown
  readonly agent?: string | undefined
  /** The step names its own start, so it binds to the hook. Undefined: the step carries no start time and cannot be bound. */
  readonly bindStep?: boolean
  /** An observation was lost after the step bound and before the calls: what the step carries can no longer be trusted. */
  readonly lossBeforeCalls?: boolean
}

export interface Call {
  readonly id: string
  /** The name from `session.tool.input.started`. Undefined: no name event and no hook, so the name stays unknown. */
  readonly name?: string | undefined
  /** The step the called event names. Undefined: no message id. */
  readonly messageId?: string | undefined
  readonly executed?: boolean
  /** The `execute.before` hook's agent. Undefined: the hook did not fire (a refusal before the hook). */
  readonly hookAgent?: string | undefined
  readonly succeeded: boolean
  readonly message?: string
}

/** One primary request and its step, with the given calls made during the step. */
export function turn(calls: readonly Call[], options: TurnOptions = {}): SpanRecord[] {
  const observations: Observation[] = []
  let at = 0
  const add = (observation: ObservationInput): void => {
    at += 1
    observations.push({...observation, at})
  }
  add({kind: 'prompt', sessionId: SES, messageId: 'm1', delivery: 'steer', content: 'hi'})
  add({kind: 'inbox.enqueued', sessionId: SES, inboxId: 'm1', item: 'user'})
  add({kind: 'execution.started', sessionId: SES})
  add({kind: 'inbox.delivered', sessionId: SES, inboxId: 'm1'})
  add({
    kind: 'request',
    sessionId: SES,
    requestKind: 'primary',
    agent: 'agent' in options ? options.agent : 'build',
    model: 'm',
    provider: 'p',
    content: 'request' in options ? options.request : {tools: {}},
  })
  const hookAt = at
  add({
    kind: 'step.started',
    sessionId: SES,
    messageId: STEP,
    started: options.bindStep === false ? undefined : hookAt,
    agent: 'build',
    model: 'm',
    provider: 'p',
  })
  if (options.lossBeforeCalls === true) add({kind: 'loss', sessionIds: [SES], reason: 'test'})
  for (const call of calls) {
    if (call.name !== undefined) add({kind: 'tool.named', sessionId: SES, callId: call.id, tool: call.name})
    add({
      kind: 'tool.called',
      sessionId: SES,
      callId: call.id,
      messageId: call.messageId,
      executed: call.executed === true,
      input: {},
    })
    if (call.hookAgent !== undefined) {
      add({
        kind: 'tool.before',
        sessionId: SES,
        callId: call.id,
        tool: call.name ?? 'unknown-from-hook',
        agent: call.hookAgent,
        input: {},
      })
    }
    add({
      kind: 'tool.ended',
      sessionId: SES,
      callId: call.id,
      succeeded: call.succeeded,
      ...(call.message === undefined ? {} : {message: call.message}),
    })
  }
  add({kind: 'step.ended', sessionId: SES, messageId: STEP, finish: 'stop', rawFinish: 'stop'})
  add({kind: 'execution.ended', sessionId: SES, outcome: 'succeeded'})
  return [...replay(observations).records]
}

export const toolsOf = (records: readonly SpanRecord[]): ToolRecord[] =>
  records.filter((record): record is ToolRecord => record.kind === 'execute_tool')
export const byCall = (records: readonly SpanRecord[], id: string): ToolRecord | undefined =>
  toolsOf(records).find(record => record.callId === id)
