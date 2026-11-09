import type {V2ErrorInfo} from '@fro-bot/runtime'
import {describe, expect, it} from 'vitest'
import {failureFromV2Error} from '../packages/gateway/src/execute/provider-failure-v2.js'
import {classifyV2Error} from '../src/features/agent/streaming-v2.js'

// The Action and the gateway both classify a V2 structured error through the shared `classifyProviderFailure`, after
// reading its fields with the shared `terminalSignalFromPayload`. Each builds the payload from a `V2ErrorInfo` in its
// own adapter (the Action's `classifyV2Error`, the gateway's `failureFromV2Error`). This test runs the same
// fixtures through BOTH adapters and asserts they agree on the failure kind, so an adapter that grows its own field
// mapping, precedence or message handling breaks here instead of silently labelling the same error differently.
//
// The gateway reports a closed operator reason rather than a failure class, so each Action class maps to the reason
// the gateway must produce for it. Fixtures are limited to the evidence both adapters read (type, message, status):
// the Action also reads the structured quota family (`provider.quota`, `provider.free-limit`, the budget limits) and
// the retryable set, which the gateway adapter does not, so those rows are not parity cases.

const QUOTA_TEXT = 'Usage limit reached. Enable usage from your available balance'

interface Fixture {
  readonly label: string
  readonly error: Pick<V2ErrorInfo, 'type' | 'message' | 'status'>
  /** The Action's failure class for this error. */
  readonly actionType: string
  /** The gateway's closed reason that class must map to. */
  readonly gatewayReason: string
  /** The Action settles terminal on it. */
  readonly terminal: boolean
}

const FIXTURES: readonly Fixture[] = [
  {
    label: 'the structured auth type',
    error: {type: 'provider.auth', message: 'rejected', status: 401},
    actionType: 'provider_auth_error',
    gatewayReason: 'provider auth unavailable',
    terminal: true,
  },
  {
    label: 'usage-limit text on an unrecognized type',
    error: {type: 'provider.unknown', message: QUOTA_TEXT, status: null},
    actionType: 'quota_exceeded',
    gatewayReason: 'provider quota exceeded',
    terminal: true,
  },
  {
    label: 'usage-limit text past 2048 characters',
    error: {type: 'provider.unknown', message: `${'x'.repeat(3_000)} ${QUOTA_TEXT}`, status: null},
    actionType: 'quota_exceeded',
    gatewayReason: 'provider quota exceeded',
    terminal: true,
  },
  {
    label: 'a 402 status on an unrecognized type',
    error: {type: 'provider.unknown', message: 'x', status: 402},
    actionType: 'quota_exceeded',
    gatewayReason: 'provider quota exceeded',
    terminal: true,
  },
  {
    label: 'a "Model not found:" message',
    error: {type: 'provider.unknown', message: 'Model not found: openai/gpt-9. Did you mean: gpt-5?', status: null},
    actionType: 'model_not_found',
    gatewayReason: 'model not available',
    terminal: true,
  },
  {
    label: 'a plain 400 with no evidence',
    error: {type: 'provider.unknown', message: 'Bad Request', status: 400},
    actionType: 'configuration',
    gatewayReason: 'session error',
    terminal: false,
  },
  {
    label: 'a rate limit',
    error: {type: 'provider.rate-limit', message: 'slow down', status: 429},
    actionType: 'rate_limit',
    gatewayReason: 'session error',
    terminal: false,
  },
  {
    label: 'a transport failure',
    error: {type: 'provider.transport', message: 'fetch failed', status: null},
    actionType: 'llm_fetch_error',
    gatewayReason: 'session error',
    terminal: false,
  },
  {
    label: 'an empty message with no status',
    error: {type: 'provider.unknown', message: '', status: null},
    actionType: 'configuration',
    gatewayReason: 'session error',
    terminal: false,
  },
]

describe('the Action and the gateway classify the same V2 error the same way', () => {
  it.each(FIXTURES)('$label', ({error, actionType, gatewayReason, terminal}) => {
    // #given the same V2 structured error
    const info: V2ErrorInfo = {...error, retryAfterMs: null}

    // #when each surface runs its own adapter
    const action = classifyV2Error(info, null)
    const gateway = failureFromV2Error(info)

    // #then the Action's class and the gateway's reason come from the same classification, and the Action settles
    // terminal exactly on the stop decision
    expect(action.error.type).toBe(actionType)
    expect(gateway.reason).toBe(gatewayReason)
    expect(action.terminal).toBe(terminal)
  })
})
