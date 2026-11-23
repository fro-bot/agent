import type {LifecycleSpan, LifecycleTracer, SpanResult} from '../shared/lifecycle-tracer.js'
import type {Logger} from '../shared/logger.js'
import process from 'node:process'
import * as core from '@actions/core'
import {readLifecycleRunIdentity} from '../services/setup/tracing.js'
import {getInvocationIdentity} from '../shared/env.js'
import {createLifecycleTracer, NOOP_SPAN, parseTraceIds} from '../shared/lifecycle-tracer.js'
import {createSecretRegistry} from '../shared/secret-registry.js'
import {STATE_KEYS} from './config/state-keys.js'
import {parseTraceInputs, takeTraceInputs} from './config/trace-inputs.js'

/**
 * The post step's part of the lifecycle trace: one span, added to the trace the main step started, after its root ended.
 *
 * The post step is a separate process. What reaches it from the main step is one identity record in Action state (the trace id,
 * the root span id and the invocation id: ids only, never an input or a credential) and, when the run got that far, the session
 * id. What it re-reads for itself is the trace inputs, which the runner injects again for the post stage (checked on a hosted
 * runner, normal and cancelled). Everything it needs to scrub with it rebuilds from its own environment, through the same
 * registry the main step uses, so it does not depend on GitHub's log masking or on anything the main step knew.
 *
 * Nothing is sent, and nothing new is logged, when the record is missing, partial or malformed, when the inputs are off, or
 * when `NODE_DEBUG` is set (the tracer refuses, as in the main step). An input that is set but refused gets the same fixed-text
 * warning, with no value in it, as in the main step.
 */

export interface PostTrace {
  /** False when nothing will be sent. */
  readonly enabled: boolean
  /** The one post span: children are the work it did. A no-op when `enabled` is false. */
  readonly span: LifecycleSpan
  /**
   * Ends the post span and exports, bounded. Never rejects and never throws. Idempotent: the export happens once.
   */
  readonly finish: (result: SpanResult) => Promise<void>
}

export interface StartPostTraceOptions {
  readonly logger: Logger
  /** Where the runner's environment is read from. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** How long the export waits for the collector. Default: the tracer's own bound. */
  readonly flushBoundMs?: number
}

const OFF: PostTrace = {enabled: false, span: NOOP_SPAN, finish: async () => undefined}

export function startPostTrace(options: StartPostTraceOptions): PostTrace {
  try {
    return buildPostTrace(options)
  } catch {
    // Tracing never changes what post does, and what threw may hold a value: nothing is logged.
    return OFF
  }
}

function buildPostTrace(options: StartPostTraceOptions): PostTrace {
  const env = options.env ?? process.env
  const registry = createSecretRegistry(value => core.setSecret(value))

  // First of everything, before anything that can fail: read the two inputs, mask every form of them, and remove them from
  // the environment. Nothing is validated and nothing is said here, so a run with no trace record stays silent.
  const raw = takeTraceInputs({getInput: name => core.getInput(name), env}, {mask: value => registry.mask(value)})

  // The post process's own copies of everything the main step masked. The runner's masking is not what this relies on.
  try {
    registry.addSecretEnv(env)
    registry.addAuthJson(env['INPUT_AUTH-JSON'] ?? '')
    registry.addOpencodeConfig(env['INPUT_OPENCODE-CONFIG'] ?? '')
    registry.add(env['INPUT_APP-PRIVATE-KEY'])
  } catch {
    // The registry never throws on a value; whatever did must not stop post from doing its work.
  }

  const ids = parseTraceIds(core.getState(STATE_KEYS.LIFECYCLE_TRACE))
  if (ids === null) return OFF

  const inputs = parseTraceInputs(raw, {
    warning: message => core.warning(message),
    // The main step said it once; post says only what is wrong.
    notice: () => undefined,
    info: () => undefined,
    mask: () => undefined,
  })
  if (!inputs.enabled) return OFF

  const tracer: LifecycleTracer = createLifecycleTracer({
    inputs,
    logger: options.logger,
    registry,
    identity: readLifecycleRunIdentity(env, getInvocationIdentity()),
    continueFrom: ids,
    env,
    ...(options.flushBoundMs === undefined ? {} : {flushBoundMs: options.flushBoundMs}),
  })
  if (!tracer.enabled) return OFF

  // Set at flush only if scrubbing leaves it exactly as it is (the tracer decides), so a redacted id is never exported.
  const sessionId = core.getState(STATE_KEYS.LIFECYCLE_SESSION)
  if (sessionId.length > 0) tracer.setSessionId(sessionId)

  const span = tracer.startSpan('post')
  let finished: Promise<void> | undefined
  return {
    enabled: true,
    span,
    finish: async result => {
      finished ??= (async () => {
        try {
          span.end(result)
          await tracer.flush(options.flushBoundMs === undefined ? undefined : {boundMs: options.flushBoundMs})
        } catch {
          // Tracing never changes what post does.
        }
      })()
      await finished
    },
  }
}
