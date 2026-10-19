import {describe, expect, it} from 'vitest'
import {failureFromErrorObject, failureFromErrorText} from '../packages/gateway/src/execute/provider-failure.js'
import {classifyTerminalPayloadError, observeClassification} from '../src/features/agent/streaming.js'

// The Action and the gateway both classify an OpenCode error payload through the shared
// `classifyProviderFailure`, after reading its fields with the shared `terminalSignalFromPayload`. This test
// runs the same payload fixtures through BOTH surfaces' adapters (the Action's `classifyTerminalPayloadError`,
// the gateway's `failureFromErrorObject`/`failureFromErrorText`) and asserts they agree on the failure kind and
// the stop decision. A surface that grows its own field read, precedence, or message handling again breaks here
// instead of silently labelling the same payload differently.
//
// The gateway reports a closed operator reason rather than a `kind`, so the expected kind is mapped to the reason
// it produces. The gateway fails the run on every terminal payload, so `stop` is checked on the Action side and
// against the shared rule: it is the Action that settles early on it.

const QUOTA_TEXT = 'Usage limit reached. Enable usage from your available balance'

type Kind = 'auth' | 'quota' | 'model-not-found' | 'context-overflow' | 'aborted' | 'unclassified'

interface Fixture {
  readonly label: string
  readonly payload: unknown
  readonly kind: Kind
  /** The shared rule's stop decision (`context-overflow` is surface policy, so it is false here). */
  readonly stop: boolean
}

const FIXTURES: readonly Fixture[] = [
  {
    label: 'message only at the top level',
    payload: {name: 'UnknownError', message: QUOTA_TEXT},
    kind: 'quota',
    stop: true,
  },
  {
    label: 'message only in data (the OpenCode wire shape)',
    payload: {name: 'UnknownError', data: {message: QUOTA_TEXT}},
    kind: 'quota',
    stop: true,
  },
  {
    label: 'a top-level and a data message that differ (data wins)',
    payload: {name: 'UnknownError', message: QUOTA_TEXT, data: {message: 'something odd'}},
    kind: 'unclassified',
    stop: false,
  },
  {
    label: 'a non-string data.message (the top-level message is still read)',
    payload: {name: 'UnknownError', message: QUOTA_TEXT, data: {message: {nested: true}}},
    kind: 'quota',
    stop: true,
  },
  {
    label: 'a name only in data',
    payload: {data: {name: 'ProviderAuthError'}},
    kind: 'auth',
    stop: true,
  },
  {
    label: 'a top-level name',
    payload: {name: 'ProviderAuthError', data: {message: 'rejected'}},
    kind: 'auth',
    stop: true,
  },
  {
    label: 'a string status next to a numeric data.statusCode',
    payload: {name: 'APIError', status: '500', data: {statusCode: 402, message: 'boom'}},
    kind: 'quota',
    stop: true,
  },
  {
    label: 'a string status alone',
    payload: {name: 'APIError', status: '402', data: {message: 'boom'}},
    kind: 'unclassified',
    stop: false,
  },
  {
    label: 'a quota code in data',
    payload: {name: 'APIError', data: {code: 'insufficient_quota'}},
    kind: 'quota',
    stop: true,
  },
  {
    label: 'a "Model not found:" message in data',
    payload: {name: 'UnknownError', data: {message: 'Model not found: openai/gpt-9. Did you mean: gpt-5?'}},
    kind: 'model-not-found',
    stop: true,
  },
  {
    label: 'auth wording (a hint: labelled, never a stop)',
    payload: {name: 'UnknownError', data: {message: 'no auth available'}},
    kind: 'auth',
    stop: false,
  },
  {
    label: 'model wording (a hint: labelled, never a stop)',
    payload: {name: 'APIError', data: {message: 'model is not supported', isRetryable: true}},
    kind: 'model-not-found',
    stop: false,
  },
  {
    label: 'usage-limit text past 2048 characters',
    payload: {name: 'APIError', data: {message: `${'x'.repeat(3_000)} ${QUOTA_TEXT}`}},
    kind: 'quota',
    stop: true,
  },
  {
    label: 'a context overflow',
    payload: {name: 'ContextOverflowError', data: {message: 'too long'}},
    kind: 'context-overflow',
    stop: false,
  },
  {
    label: 'an abort',
    payload: {name: 'MessageAbortedError', data: {message: 'aborted'}},
    kind: 'aborted',
    stop: false,
  },
  {
    label: 'a plain APIError with no evidence',
    payload: {name: 'APIError', data: {message: 'Bad Request', statusCode: 400}},
    kind: 'unclassified',
    stop: false,
  },
  {
    label: 'a payload with no usable fields',
    payload: {},
    kind: 'unclassified',
    stop: false,
  },
]

/** What the gateway's closed reason must be for a shared kind (`APIError` refines `unclassified`). */
function expectedGatewayReason(kind: Kind, name: string | undefined): string {
  switch (kind) {
    case 'auth':
      return 'provider auth unavailable'
    case 'quota':
      return 'provider quota exceeded'
    case 'model-not-found':
      return 'model not available'
    case 'unclassified':
      return name === 'APIError' ? 'model provider rejected the request' : 'session error'
    case 'context-overflow':
    case 'aborted':
      return 'session error'
  }
}

function payloadName(payload: unknown): string | undefined {
  const name = (payload as {name?: unknown}).name
  return typeof name === 'string' ? name : undefined
}

describe('the Action and the gateway classify the same payload the same way', () => {
  it.each(FIXTURES)('$label', ({payload, kind, stop}) => {
    // #given the same OpenCode error payload

    // #when each surface runs its own adapter
    const action = classifyTerminalPayloadError(payload, null)
    const gateway = failureFromErrorObject(payload)

    // #then the shared rule's kind and stop decision are identical, and the gateway's reason is that kind's reason
    expect(action.classification.kind).toBe(kind)
    expect(action.classification.stop).toBe(stop)
    expect(gateway.reason).toBe(expectedGatewayReason(kind, payloadName(payload)))
  })

  it.each(FIXTURES)('the Action settles terminal exactly when the rule stops (or overflows): $label', ({payload}) => {
    // #given / #when
    const {classification} = classifyTerminalPayloadError(payload, null)
    const observed = observeClassification(classification)

    // #then the single terminal decision is the rule's stop, plus the Action's overflow policy
    expect(observed.terminal).toBe(classification.stop || classification.kind === 'context-overflow')
  })

  it.each([
    {text: QUOTA_TEXT, kind: 'quota' as const},
    {text: 'Model not found: openai/gpt-9. Did you mean: gpt-5?', kind: 'model-not-found' as const},
    {text: 'no auth available', kind: 'auth' as const},
    {text: 'LLM quota exceeded', kind: 'unclassified' as const},
    {text: '', kind: 'unclassified' as const},
  ])('a plain string payload %j is classified the same on both surfaces', ({text, kind}) => {
    // #given a `session.error` whose error is a bare string

    // #when
    const action = classifyTerminalPayloadError(text, null)
    const gateway = failureFromErrorText(text)

    // #then
    expect(action.classification.kind).toBe(kind)
    expect(gateway.reason).toBe(expectedGatewayReason(kind, undefined))
  })
})
