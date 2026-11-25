import type {OtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {startOtlpSink} from '../../packages/runtime/src/tracing/otlp-sink.testing.js'
import {createMockLogger} from '../shared/test-helpers.js'
import {ok} from '../shared/types.js'

/**
 * The post step's span, in process, against a real OTLP receiver. Core, the cache and the object store are mocked as in
 * `post.test.ts`; the trace-input reader, the secret registry, the tracer and its exporter are the real ones. The real entry
 * point (the exit bound, `NODE_DEBUG` on stderr) is in `post-entry.test.ts`.
 */

const inputs = vi.hoisted(() => ({values: new Map<string, string>(), state: new Map<string, string>()}))

vi.mock('@actions/core', () => ({
  getInput: vi.fn((name: string) => inputs.values.get(name) ?? ''),
  getState: vi.fn((key: string) => inputs.state.get(key) ?? ''),
  saveState: vi.fn(),
  setSecret: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    addRaw: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../services/cache/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/cache/index.js')>()),
  saveCache: vi.fn(),
}))
vi.mock('../services/artifact/index.js', () => ({uploadLogArtifact: vi.fn()}))
vi.mock('@fro-bot/runtime', async importOriginal => ({
  ...(await importOriginal<typeof import('@fro-bot/runtime')>()),
  createS3Adapter: vi.fn(),
  releaseLockIfHolder: vi.fn(),
  syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
  syncMetadataToStore: vi.fn(async () => ({success: true})),
}))

const IDS = {traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), invocationId: 'c'.repeat(16)}
const GITHUB_TOKEN = 'ghp_postTokenCanary0123456789'
const AWS_KEY = 'AKIAPOSTCANARY0123456'
const CREDENTIAL = 'Basic cG9zdC1jcmVkLWNhbmFyeTpzZWNyZXQtcG9zdC1jYW5hcnk='
const STORE = {
  'storeConfig.enabled': 'true',
  'storeConfig.bucket': 'b',
  'storeConfig.region': 'us-east-1',
  'storeConfig.prefix': 'p',
}

interface Decoded {
  readonly name: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly attributes: {key: string; value: {stringValue?: string; intValue?: string}}[]
  readonly status?: {code?: number}
  readonly events?: {name: string; attributes?: {key: string; value: {stringValue?: string}}[]}[]
}

const spansOf = (target: OtlpSink): Decoded[] =>
  target
    .accepted()
    .flatMap(request => (request.body as {resourceSpans: {scopeSpans: {spans: Decoded[]}[]}[]}).resourceSpans)
    .flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
const attr = (span: Decoded, key: string): string | undefined => {
  const value = span.attributes.find(item => item.key === key)?.value
  return value?.stringValue ?? value?.intValue
}
const named = (spans: readonly Decoded[], name: string): Decoded => {
  const found = spans.find(span => span.name === name)
  if (found === undefined) throw new Error(`no span named ${name}`)
  return found
}
const exceptionMessage = (span: Decoded): string | undefined =>
  span.events?.find(event => event.name === 'exception')?.attributes?.find(item => item.key === 'exception.message')
    ?.value.stringValue

let target: OtlpSink
const sinks: OtlpSink[] = []

function setState(state: Record<string, string>): void {
  inputs.state.clear()
  for (const [key, value] of Object.entries(state)) inputs.state.set(key, value)
}
const traced = (extra: Readonly<Record<string, string | undefined>> = {}): Record<string, string> => ({
  shouldSaveCache: 'true',
  cacheSaved: 'not-persisted',
  lifecycleTrace: JSON.stringify(IDS),
  ...Object.fromEntries(Object.entries(extra).filter((entry): entry is [string, string] => entry[1] !== undefined)),
})

async function post(flushBoundMs?: number) {
  const {runPost} = await import('./post.js')
  const logger = createMockLogger()
  await runPost({logger, ...(flushBoundMs === undefined ? {} : {flushBoundMs})})
  return logger
}

describe('the post step’s span', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    inputs.values.clear()
    inputs.state.clear()
    target = await startOtlpSink()
    sinks.push(target)
    inputs.values.set('trace-endpoint', target.url)
    vi.stubEnv('GITHUB_REPOSITORY', 'fro-bot/agent')
    vi.stubEnv('GITHUB_RUN_ID', '77')
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1')
    vi.stubEnv('GITHUB_EVENT_NAME', 'issue_comment')
    vi.stubEnv('GITHUB_JOB', 'triage')
    vi.stubEnv('GITHUB_WORKSPACE', '/tmp/ws')
    vi.stubEnv('NODE_DEBUG', '')
    const {saveCache} = await import('../services/cache/index.js')
    vi.mocked(saveCache).mockResolvedValue({cachePersisted: true, storePersisted: false, outcome: 'persisted'})
    const {createS3Adapter, releaseLockIfHolder} = await import('@fro-bot/runtime')
    vi.mocked(createS3Adapter).mockReturnValue({
      upload: async () => ok(undefined),
      download: async () => ok(undefined),
      list: async () => ok([]),
    })
    vi.mocked(releaseLockIfHolder).mockResolvedValue(ok('released'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(sinks.splice(0).map(async sink => sink.stop()))
  })

  describe('what it sends', () => {
    it('adds one post span to the run’s trace, under the main step’s root, with the retried save’s result', async () => {
      // #given a main step that did not save, and its saved identity and session
      setState(traced({lifecycleSession: 'fro-bot/agent:issue-42'}))

      // #when post retries the save
      await post()

      // #then one request: the post span in the main trace, hung from the saved root span, no second root
      expect(target.accepted()).toHaveLength(1)
      const spans = spansOf(target)
      expect(spans.map(span => span.name).toSorted()).toEqual(['cache save retry', 'post'])
      const span = named(spans, 'post')
      expect(span.traceId).toBe(IDS.traceId)
      expect(span.parentSpanId).toBe(IDS.rootSpanId)
      expect(named(spans, 'cache save retry').parentSpanId).toBe(span.spanId)
      expect(attr(span, 'fro_bot.post.action')).toBe('retry-save')
      expect(attr(span, 'fro_bot.outcome')).toBe('succeeded')
      expect(attr(span, 'fro_bot.cache.save_result')).toBe('persisted')
      expect(attr(span, 'fro_bot.cache.state')).toBe('not-persisted')
      // #and it carries the run's identity, the invocation id of the main step and the session
      expect(attr(span, 'fro_bot.invocation.id')).toBe(IDS.invocationId)
      expect(attr(span, 'fro_bot.repository')).toBe('fro-bot/agent')
      expect(attr(span, 'fro_bot.run.id')).toBe('77')
      expect(attr(span, 'langfuse.session.id')).toBe('fro-bot/agent:issue-42')
      expect(spans.some(item => item.name === 'action.main')).toBe(false)
    })

    it.each([
      {state: {shouldSaveCache: 'false'}, action: 'skip', reason: 'event-not-processed'},
      {state: {cacheSaved: 'durable'}, action: 'skip', reason: 'saved-durable'},
      {state: {cacheSaved: 'store-only'}, action: 'skip', reason: 'saved-store-only'},
      {state: {cacheSaved: 'skipped'}, action: 'skip', reason: 'main-skipped'},
      {state: {cacheSaved: 'declined-for-safety'}, action: 'safety-skip', reason: 'persistence-declined'},
      {state: {isolatedRun: 'true'}, action: 'safety-skip', reason: 'sandbox-unconfirmed'},
      {
        state: {isolatedRun: 'true', sandboxState: 'restored'},
        action: 'safety-skip',
        reason: 'no-save-recorded',
      },
      {state: {skipCache: 'true'}, action: 'skip', reason: 'skip-cache'},
    ])('records $action ($reason) as a skipped post span, with no error status', async ({state, action, reason}) => {
      // #given a main step that left this state
      setState(traced(state))

      // #when
      await post()

      // #then
      const span = named(spansOf(target), 'post')
      expect(attr(span, 'fro_bot.post.action')).toBe(action)
      expect(attr(span, 'fro_bot.outcome')).toBe('skipped')
      expect(attr(span, 'fro_bot.reason')).toBe(reason)
      expect(span.status?.code ?? 0).toBe(0)
    })

    it('ends the post span failed, with the error on the child span, when the retried save throws', async () => {
      // #given
      setState(traced())
      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockRejectedValue(new Error('cache backend down'))

      // #when
      await post()

      // #then
      const spans = spansOf(target)
      expect(attr(named(spans, 'post'), 'fro_bot.outcome')).toBe('failed')
      expect(attr(named(spans, 'post'), 'fro_bot.reason')).toBe('save-failed')
      expect(exceptionMessage(named(spans, 'cache save retry'))).toBe('cache backend down')
    })

    it('exports the post span exactly once', async () => {
      // #given / #when
      setState(traced())
      await post()

      // #then
      expect(target.received()).toBe(1)
    })

    it('omits a session id that scrubbing would change, rather than send a redacted one', async () => {
      // #given a repository whose name trips the scrubber's name/value rule
      setState(traced({lifecycleSession: 'acme/password-manager:issue-42'}))

      // #when
      await post()

      // #then
      expect(attr(named(spansOf(target), 'post'), 'langfuse.session.id')).toBeUndefined()
      expect(target.requests.map(request => request.text).join('')).not.toContain('REDACTED')
    })

    it('sends no prompt, output or tool content keys', async () => {
      // #given / #when
      setState(traced())
      await post()

      // #then
      const keys = spansOf(target).flatMap(span => span.attributes.map(item => item.key))
      expect(keys.filter(key => /prompt|completion|output|input|tool\.|gen_ai/i.test(key))).toEqual([])
    })
  })

  describe('when it sends nothing', () => {
    /** What a step that sends nothing leaves behind: requests received, and warnings said anywhere. */
    const afterPost = async (): Promise<{received: number; warnings: number}> => {
      const logger = await post()
      const core = await import('@actions/core')
      return {
        received: target.received(),
        warnings: vi.mocked(core.warning).mock.calls.length + vi.mocked(logger.warning).mock.calls.length,
      }
    }

    it('with no state at all', async () => {
      setState({shouldSaveCache: 'true', cacheSaved: 'not-persisted'})
      expect(await afterPost()).toEqual({received: 0, warnings: 0})
    })

    it.each([
      ['partial', JSON.stringify({traceId: IDS.traceId, rootSpanId: IDS.rootSpanId})],
      ['not JSON', '{traceId'],
      ['an array', '[]'],
      ['a bad trace id', JSON.stringify({...IDS, traceId: 'xyz'})],
      ['an all-zero trace id', JSON.stringify({...IDS, traceId: '0'.repeat(32)})],
      ['an uppercase span id', JSON.stringify({...IDS, rootSpanId: 'B'.repeat(16)})],
      ['a short invocation id', JSON.stringify({...IDS, invocationId: 'c'.repeat(8)})],
      ['an extra key (an input leaked into state)', JSON.stringify({...IDS, token: 'x'})],
      ['non-string ids', JSON.stringify({traceId: 1, rootSpanId: 2, invocationId: 3})],
    ])('with a record that is %s, and says nothing about it', async (_name, record) => {
      setState({shouldSaveCache: 'true', cacheSaved: 'not-persisted', lifecycleTrace: record})
      expect(await afterPost()).toEqual({received: 0, warnings: 0})
    })

    it('with state but no trace inputs', async () => {
      inputs.values.clear()
      setState(traced())
      expect(await afterPost()).toEqual({received: 0, warnings: 0})
    })

    it('with an endpoint it refuses: one fixed-text warning that holds no value, nothing sent', async () => {
      // #given an http endpoint with a credential, which the input rules refuse
      inputs.values.set('trace-endpoint', 'http://collector.example.test/v1/traces')
      inputs.values.set('trace-headers', `Authorization: ${CREDENTIAL}`)
      setState(traced())

      // #when
      await post()

      // #then
      const core = await import('@actions/core')
      expect(target.received()).toBe(0)
      expect(vi.mocked(core.warning)).toHaveBeenCalledTimes(1)
      const message = String(vi.mocked(core.warning).mock.calls[0]?.[0])
      expect(message).toContain('trace-endpoint')
      expect(message).not.toContain('collector.example.test')
      expect(message).not.toContain(CREDENTIAL)
    })

    it.each(['*', 'HT*', 'http,tls', 'Net'])('with NODE_DEBUG=%s: one fixed warning, nothing sent', async value => {
      // #given Node could print transport details
      vi.stubEnv('NODE_DEBUG', value)
      setState(traced())

      // #when
      const logger = await post()

      // #then
      expect(target.received()).toBe(0)
      expect(logger.warning).toHaveBeenCalledTimes(1)
      expect(String(vi.mocked(logger.warning).mock.calls[0]?.[0])).toContain('NODE_DEBUG')
      expect(JSON.stringify(vi.mocked(logger.warning).mock.calls)).not.toContain(target.url)
    })

    it('still masks and removes the trace inputs from the environment, before anything else', async () => {
      // #given a post environment holding the two inputs, and no trace record
      vi.stubEnv('INPUT_TRACE-ENDPOINT', target.url)
      vi.stubEnv('INPUT_TRACE-HEADERS', `Authorization: ${CREDENTIAL}`)
      inputs.values.set('trace-headers', `Authorization: ${CREDENTIAL}`)
      setState({shouldSaveCache: 'true', cacheSaved: 'not-persisted'})

      // #when
      await post()

      // #then
      const core = await import('@actions/core')
      expect(process.env['INPUT_TRACE-ENDPOINT']).toBeUndefined()
      expect(process.env['INPUT_TRACE-HEADERS']).toBeUndefined()
      expect(vi.mocked(core.setSecret)).toHaveBeenCalledWith(target.url)
      expect(target.received()).toBe(0)
    })

    it('masks the inputs before it reads the state record', async () => {
      // #given a state read that observes whether the inputs are already gone
      vi.stubEnv('INPUT_TRACE-ENDPOINT', target.url)
      const core = await import('@actions/core')
      const seen: (string | undefined)[] = []
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'lifecycleTrace') seen.push(process.env['INPUT_TRACE-ENDPOINT'])
        return inputs.state.get(key) ?? ''
      })
      setState(traced())

      // #when
      await post()

      // #then the record was read after the endpoint had been removed from the environment
      expect(seen).toEqual([undefined])
    })
  })

  describe('what it redacts', () => {
    it('a retried Actions-cache save whose error carries the GitHub token', async () => {
      // #given the token in post's own environment (as the runner injects it), and a save that fails with it in the message
      vi.stubEnv('INPUT_GITHUB-TOKEN', GITHUB_TOKEN)
      setState(traced())
      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockRejectedValue(new Error(`cache service refused ${GITHUB_TOKEN} for this run`))

      // #when
      await post()

      // #then the span carries the message with the token redacted, and the token is in no byte of the request
      const message = exceptionMessage(named(spansOf(target), 'cache save retry'))
      expect(message).toContain('cache service refused')
      expect(message).toContain('[REDACTED]')
      expect(target.requests.map(request => request.text).join('')).not.toContain(GITHUB_TOKEN)
    })

    it('an object-store metadata sync error carrying an AWS key', async () => {
      // #given an AWS key in the environment and a metadata upload that fails with it in the message
      vi.stubEnv('AWS_ACCESS_KEY_ID', AWS_KEY)
      setState(traced(STORE))
      const {syncMetadataToStore} = await import('@fro-bot/runtime')
      vi.mocked(syncMetadataToStore).mockRejectedValue(new Error(`S3 said no to ${AWS_KEY}`))

      // #when
      await post()

      // #then
      const message = exceptionMessage(named(spansOf(target), 'object store sync'))
      expect(message).toContain('S3 said no')
      expect(message).toContain('[REDACTED]')
      expect(target.requests.map(request => request.text).join('')).not.toContain(AWS_KEY)
    })

    it('a log sync error carrying an AWS secret key', async () => {
      // #given
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret-canary-0123456789abcdef')
      setState(traced({...STORE, cleanupMetadataWritten: 'true'}))
      const {syncArtifactsToStore} = await import('@fro-bot/runtime')
      vi.mocked(syncArtifactsToStore).mockRejectedValue(new Error('upload failed: aws-secret-canary-0123456789abcdef'))

      // #when
      await post()

      // #then
      expect(target.requests.map(request => request.text).join('')).not.toContain('aws-secret-canary-0123456789abcdef')
      expect(exceptionMessage(named(spansOf(target), 'object store sync'))).toContain('[REDACTED]')
    })

    it('every leaf of auth-json and opencode-config, not only the ones the runner masks', async () => {
      // #given leaves in the post environment's own copies of the two inputs
      vi.stubEnv('INPUT_AUTH-JSON', JSON.stringify({anthropic: {type: 'api', key: 'opaque-auth-leaf-canary-0001'}}))
      vi.stubEnv(
        'INPUT_OPENCODE-CONFIG',
        JSON.stringify({mcp: {remote: {headers: {Authorization: 'Bearer mcp-leaf-canary-0002'}}}}),
      )
      setState(traced())
      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockRejectedValue(
        new Error('failed with opaque-auth-leaf-canary-0001 and mcp-leaf-canary-0002'),
      )

      // #when
      await post()

      // #then
      const body = target.requests.map(request => request.text).join('')
      expect(body).not.toContain('opaque-auth-leaf-canary-0001')
      expect(body).not.toContain('mcp-leaf-canary-0002')
    })

    it.each([
      [
        'a short opencode-config secret',
        {env: {'INPUT_OPENCODE-CONFIG': JSON.stringify({apiKey: 'short1'})}, canary: 'short1'},
      ],
      [
        'a long opencode-config secret',
        (() => {
          const long = `L${'x'.repeat(65_536)}`
          return {env: {'INPUT_OPENCODE-CONFIG': JSON.stringify({apiKey: long})}, canary: long}
        })(),
      ],
    ])('%s: nothing of it in the body, and no free text at all', async (_name, row) => {
      // #given a registered value outside the scrubber's range, and a message that carries it
      for (const [key, value] of Object.entries(row.env)) vi.stubEnv(key, value)
      setState(traced())
      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockRejectedValue(new Error(`the save failed near ${row.canary} and other text`))

      // #when
      await post()

      // #then fail closed: the exception message is its category, so neither the canary nor the surrounding text goes out
      const body = target.requests.map(request => request.text).join('')
      expect(body).not.toContain(row.canary)
      expect(body).not.toContain('and other text')
      expect(exceptionMessage(named(spansOf(target), 'cache save retry'))).toBe('Error')
    })
  })
})
