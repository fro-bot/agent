import type {Logger} from './opencode-server.js'

import {describe, expect, it, vi} from 'vitest'

import {
  modelProviderId,
  parseAuthBlob,
  provisionCredentials,
  spawnConfigFromMergedConfig,
  verifyCredentialGate,
  WORKSPACE_CREDENTIAL_LABEL,
} from './opencode-credentials-v2.js'

const KEY = 'sk-ant-SUPERSECRETKEY-1234'

function capturingLogger(): {logger: Logger; serialized: () => string} {
  const calls: unknown[] = []
  const record =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      calls.push({level, message, meta})
    }
  return {
    logger: {info: record('info'), warn: record('warn'), error: record('error')},
    serialized: () => JSON.stringify(calls),
  }
}

function handleWith(respond: (pathname: string, init?: RequestInit) => Response | Promise<Response>): {
  fetch: (pathname: string, init?: RequestInit) => Promise<Response>
  calls: {pathname: string; init?: RequestInit}[]
} {
  const calls: {pathname: string; init?: RequestInit}[] = []
  return {
    calls,
    fetch: async (pathname, init) => {
      calls.push({pathname, init})
      return respond(pathname, init)
    },
  }
}

describe('parseAuthBlob', () => {
  it('parses API-key entries for every provider', () => {
    // #given the blob shape the V1 path writes to auth.json
    const raw = JSON.stringify({anthropic: {type: 'api', key: KEY}, openai: {type: 'api', key: 'sk-2'}})

    // #when
    const result = parseAuthBlob(raw)

    // #then
    expect(result).toEqual({
      success: true,
      data: [
        {providerId: 'anthropic', key: KEY},
        {providerId: 'openai', key: 'sk-2'},
      ],
    })
  })

  it('accepts a pretty-printed blob, as the entrypoint does', () => {
    expect(parseAuthBlob(`{\n  "anthropic": {\n    "type": "api",\n    "key": "k"\n  }\n}\n`).success).toBe(true)
  })

  it.each([
    ['oauth', {anthropic: {type: 'oauth', access: 'SUPERSECRETACCESS', refresh: 'r', expires: 1}}],
    ['wellknown', {anthropic: {type: 'wellknown', key: 'SUPERSECRETKEY', token: 't'}}],
    ['no type', {anthropic: {key: 'SUPERSECRETKEY'}}],
    ['non-object entry', {anthropic: 'SUPERSECRETKEY'}],
  ])('refuses a %s entry, naming the provider id and nothing else', (_label, blob) => {
    // #when
    const result = parseAuthBlob(JSON.stringify(blob))

    // #then
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.kind).toBe('credential-blob-invalid')
    expect(result.error.providers).toEqual(['anthropic'])
    expect(JSON.stringify(result.error)).not.toContain('SUPERSECRET')
  })

  it.each([
    ['an empty key', {anthropic: {type: 'api', key: '   '}}],
    ['a non-string key', {anthropic: {type: 'api', key: 42}}],
  ])('refuses %s', (_label, blob) => {
    const result = parseAuthBlob(JSON.stringify(blob))
    expect(result).toMatchObject({success: false, error: {providers: ['anthropic']}})
  })

  it('refuses an empty object, a non-object and a provider id with a path separator', () => {
    for (const raw of ['{}', '[]', '"x"', '{"a/b":{"type":"api","key":"k"}}']) {
      const result = parseAuthBlob(raw)
      expect(result.success).toBe(false)
    }
  })

  it('does not forward the JSON parse error, which quotes the input', () => {
    // #given malformed JSON that starts like a secret
    const result = parseAuthBlob(`{"anthropic": ${KEY}`)

    // #then
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.message).not.toContain('SUPERSECRET')
    expect(JSON.stringify(result.error)).not.toContain(KEY)
  })
})

describe('modelProviderId', () => {
  it.each([
    ['anthropic/claude-sonnet-4-6', 'anthropic'],
    ['  openai/gpt-5.4-mini ', 'openai'],
    ['openrouter/anthropic/claude', 'openrouter'],
    ['', undefined],
    ['   ', undefined],
    [undefined, undefined],
    ['/model', undefined],
  ])('reads %j as %j', (model, expected) => {
    expect(modelProviderId(model)).toBe(expected)
  })
})

describe('spawnConfigFromMergedConfig', () => {
  it('reads the model the merged config names, wherever it came from (env model or overlay)', () => {
    // #given the file merge-config writes: base + overlay, with the env model winning only when it is non-blank
    const merged = JSON.stringify({
      autoupdate: false,
      provider: {openai: {options: {baseURL: 'https://x/v1'}}},
      model: 'openai/gpt-5.4-mini',
    })

    // #then
    expect(spawnConfigFromMergedConfig(merged)).toEqual({
      success: true,
      data: {model: 'openai/gpt-5.4-mini', authenticatedProviders: []},
    })
  })

  it.each([
    ['no model', {autoupdate: false}],
    ['a blank model', {model: '   '}],
    ['a non-string model', {model: {id: 'x'}}],
  ])('reads %s as no model', (_label, config) => {
    expect(spawnConfigFromMergedConfig(JSON.stringify(config))).toEqual({
      success: true,
      data: {authenticatedProviders: []},
    })
  })

  it('trims the model', () => {
    expect(spawnConfigFromMergedConfig('{"model":"  anthropic/claude-sonnet-4-6 "}')).toMatchObject({
      success: true,
      data: {model: 'anthropic/claude-sonnet-4-6'},
    })
  })

  it.each([
    ['options.apiKey (V1 shape)', {anthropic: {options: {apiKey: 'sk-INLINE'}}}],
    ['settings.apiKey (V2 shape)', {anthropic: {settings: {apiKey: 'sk-INLINE'}}}],
    ['options.authToken', {anthropic: {options: {authToken: 'tok-INLINE'}}}],
    ['settings.accessToken', {anthropic: {settings: {accessToken: 'tok-INLINE'}}}],
  ])(
    'counts a provider with an inline %s as authenticated, naming the provider and never the value',
    (_label, provider) => {
      // #when
      const result = spawnConfigFromMergedConfig(JSON.stringify({provider}))

      // #then
      expect(result).toEqual({success: true, data: {authenticatedProviders: ['anthropic']}})
      expect(JSON.stringify(result)).not.toContain('INLINE')
    },
  )

  it.each([
    ['an empty key', {anthropic: {options: {apiKey: ''}}}],
    ['a blank key', {anthropic: {options: {apiKey: '   '}}}],
    ['a non-string key', {anthropic: {options: {apiKey: 42}}}],
    ['a baseURL only', {anthropic: {options: {baseURL: 'https://x/v1'}}}],
    ['an env reference that may resolve to nothing', {anthropic: {options: {apiKey: '{env:ANTHROPIC_API_KEY}'}}}],
    ['a file reference that may resolve to nothing', {anthropic: {options: {apiKey: '{file:/run/key}'}}}],
    ['a model-level key (not provider auth)', {anthropic: {models: {m: {options: {apiKey: 'sk-INLINE'}}}}}],
    ['a provider that is not an object', {anthropic: 'sk-INLINE'}],
  ])('does not count %s as authentication', (_label, provider) => {
    expect(spawnConfigFromMergedConfig(JSON.stringify({provider}))).toEqual({
      success: true,
      data: {authenticatedProviders: []},
    })
  })

  it('lists only the providers that carry one', () => {
    const result = spawnConfigFromMergedConfig(
      JSON.stringify({provider: {anthropic: {options: {baseURL: 'x'}}, openai: {options: {apiKey: 'k'}}}}),
    )
    expect(result).toEqual({success: true, data: {authenticatedProviders: ['openai']}})
  })

  it('refuses a config that is not a JSON object, without quoting it (it may hold an inline key)', () => {
    for (const raw of ['{"provider": {"x": {"options": {"apiKey": "sk-SUPERSECRET', '[]', '"model"']) {
      const result = spawnConfigFromMergedConfig(raw)
      expect(result.success).toBe(false)
      expect(JSON.stringify(result)).not.toContain('SUPERSECRET')
    }
  })
})

describe('provisionCredentials', () => {
  const entries = [
    {providerId: 'anthropic', key: KEY},
    {providerId: 'openai', key: 'sk-openai-SUPERSECRETKEY'},
  ] as const

  it('posts one key credential per provider to the credential route', async () => {
    // #given
    const handle = handleWith(() => new Response('{}', {status: 200}))
    const capture = capturingLogger()

    // #when
    const result = await provisionCredentials({handle, entries, requestTimeoutMs: 1000, logger: capture.logger})

    // #then
    expect(result).toEqual({success: true, data: ['anthropic', 'openai']})
    expect(handle.calls.map(call => call.pathname)).toEqual(['/api/credential', '/api/credential'])
    expect(handle.calls.map(call => call.init?.method)).toEqual(['POST', 'POST'])
    expect(handle.calls.map(call => JSON.parse(String(call.init?.body)) as unknown)).toEqual([
      {integrationID: 'anthropic', label: WORKSPACE_CREDENTIAL_LABEL, value: {type: 'key', key: KEY}},
      {
        integrationID: 'openai',
        label: WORKSPACE_CREDENTIAL_LABEL,
        value: {type: 'key', key: 'sk-openai-SUPERSECRETKEY'},
      },
    ])
    expect(handle.calls[0]?.init?.headers).toEqual({'content-type': 'application/json'})
    expect(capture.serialized()).not.toContain('SUPERSECRETKEY')
  })

  it('discards the response body unread, because the create route echoes the secret', async () => {
    // #given a body that records whether anyone consumed it
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      pull: controller => controller.enqueue(new TextEncoder().encode(`{"value":{"key":"${KEY}"}}`)),
      cancel,
    })
    const handle = handleWith(() => new Response(body, {status: 200}))

    // #when
    await provisionCredentials({
      handle,
      entries: [entries[0]],
      requestTimeoutMs: 1000,
      logger: capturingLogger().logger,
    })

    // #then
    expect(cancel).toHaveBeenCalled()
  })

  it('stops at the first refusal and reports the provider and status only', async () => {
    // #given a route that conflicts, with a body that echoes the key
    const handle = handleWith(() => new Response(`{"message":"${KEY}"}`, {status: 409}))
    const capture = capturingLogger()

    // #when
    const result = await provisionCredentials({handle, entries, requestTimeoutMs: 1000, logger: capture.logger})

    // #then
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toEqual({
      kind: 'credential-provision-failed',
      message: 'Provider "anthropic": credential route answered HTTP 409',
      providers: ['anthropic'],
    })
    expect(handle.calls).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET')
    expect(capture.serialized()).not.toContain('SUPERSECRET')
  })

  it('reports a transport error without its text, which may quote the request', async () => {
    // #given
    const handle = handleWith(() => {
      throw new Error(`write failed: ${KEY}`)
    })

    // #when
    const result = await provisionCredentials({
      handle,
      entries,
      requestTimeoutMs: 1000,
      logger: capturingLogger().logger,
    })

    // #then
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.kind).toBe('credential-provision-failed')
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET')
  })

  it('bounds a request that never answers', async () => {
    // #given a route that never responds
    const handle = handleWith(async () => new Promise<Response>(() => undefined))

    // #when
    const result = await provisionCredentials({
      handle,
      entries: [entries[0]],
      requestTimeoutMs: 30,
      logger: capturingLogger().logger,
    })

    // #then
    expect(result).toMatchObject({success: false, error: {kind: 'credential-provision-failed'}})
  })

  it('stops when the service aborts', async () => {
    // #given
    const controller = new AbortController()
    controller.abort()
    const handle = handleWith(async () => new Promise<Response>(() => undefined))

    // #when
    const result = await provisionCredentials({
      handle,
      entries: [entries[0]],
      requestTimeoutMs: 5000,
      signal: controller.signal,
      logger: capturingLogger().logger,
    })

    // #then
    expect(result.success).toBe(false)
  })
})

describe('verifyCredentialGate', () => {
  const connected = (id: string): Response =>
    new Response(
      JSON.stringify({
        data: {
          id,
          name: id,
          methods: [{type: 'key'}],
          connections: [{type: 'credential', id: 'cred_1', label: 'workspace', method: 'key'}],
        },
      }),
      {status: 200},
    )

  it('passes when the provider lists a credential connection', async () => {
    // #given
    const handle = handleWith(() => connected('anthropic'))

    // #when
    const result = await verifyCredentialGate({handle, providers: ['anthropic'], requestTimeoutMs: 1000})

    // #then
    expect(result).toEqual({success: true, data: ['anthropic']})
    expect(handle.calls[0]?.pathname).toBe('/api/integration/anthropic')
  })

  it('accepts an env connection, which V2 also resolves', async () => {
    const handle = handleWith(
      () =>
        new Response(JSON.stringify({data: {connections: [{type: 'env', name: 'ANTHROPIC_API_KEY'}]}}), {status: 200}),
    )
    const result = await verifyCredentialGate({handle, providers: ['anthropic'], requestTimeoutMs: 1000})
    expect(result.success).toBe(true)
  })

  it.each([
    ['no connections', () => new Response(JSON.stringify({data: {connections: []}}), {status: 200})],
    ['an unknown integration', () => new Response('{}', {status: 404})],
    ['a server error', () => new Response('{}', {status: 500})],
    ['a body without data', () => new Response('{}', {status: 200})],
    ['a body that is not JSON', () => new Response('not json', {status: 200})],
  ])('refuses on %s with credential-missing, naming the provider', async (_label, respond) => {
    // #given
    const handle = handleWith(respond)

    // #when
    const result = await verifyCredentialGate({handle, providers: ['anthropic'], requestTimeoutMs: 1000})

    // #then
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.kind).toBe('credential-missing')
    expect(result.error.providers).toEqual(['anthropic'])
    expect(result.error.message).toContain('anthropic')
  })

  it('refuses when the read cannot complete', async () => {
    const handle = handleWith(() => {
      throw new Error('ECONNREFUSED')
    })
    const result = await verifyCredentialGate({handle, providers: ['anthropic'], requestTimeoutMs: 1000})
    expect(result.success).toBe(false)
  })

  it('lists every missing provider, and encodes the provider id in the path', async () => {
    // #given one provider connected and one not
    const handle = handleWith(pathname =>
      pathname === '/api/integration/anthropic' ? connected('anthropic') : new Response('{}', {status: 404}),
    )

    // #when
    const result = await verifyCredentialGate({
      handle,
      providers: ['anthropic', 'a b/c'],
      requestTimeoutMs: 1000,
    })

    // #then
    expect(result).toMatchObject({success: false, error: {providers: ['a b/c']}})
    expect(handle.calls.map(call => call.pathname)).toContain('/api/integration/a%20b%2Fc')
  })
})

describe('verifyCredentialGate with inline authentication', () => {
  it('passes a provider whose merged config carries an inline key, without asking the server', async () => {
    // #given a server that lists no connection at all
    const handle = handleWith(() => new Response(JSON.stringify({data: {connections: []}}), {status: 200}))

    // #when
    const result = await verifyCredentialGate({
      handle,
      providers: ['anthropic'],
      configuredAuth: ['anthropic'],
      requestTimeoutMs: 1000,
    })

    // #then
    expect(result).toEqual({success: true, data: ['anthropic']})
    expect(handle.calls).toHaveLength(0)
  })

  it('still refuses a provider that has neither a connection nor an inline key', async () => {
    const handle = handleWith(() => new Response(JSON.stringify({data: {connections: []}}), {status: 200}))

    const result = await verifyCredentialGate({
      handle,
      providers: ['openai'],
      configuredAuth: ['anthropic'],
      requestTimeoutMs: 1000,
    })

    expect(result).toMatchObject({success: false, error: {kind: 'credential-missing', providers: ['openai']}})
    expect(handle.calls).toHaveLength(1)
  })
})

describe('request bounds after the headers arrive', () => {
  const entry = [{providerId: 'anthropic', key: KEY}] as const

  /** Headers now, a body that never produces a byte and never closes. */
  const stalledBody = (): Response =>
    new Response(new ReadableStream<Uint8Array>({start: () => undefined}), {status: 200})

  it('bounds a gate read whose integration JSON body stalls', async () => {
    // #given
    const handle = handleWith(stalledBody)
    const started = Date.now()

    // #when
    const result = await verifyCredentialGate({handle, providers: ['anthropic'], requestTimeoutMs: 40})

    // #then it gave up at the whole-request bound and refused, instead of waiting on the body
    expect(result).toMatchObject({success: false, error: {kind: 'credential-missing'}})
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('bounds a credential response whose body cancellation never settles', async () => {
    // #given a created response whose body ignores cancel(): the transport honours neither the signal nor the cancel
    const body = new ReadableStream<Uint8Array>({
      start: () => undefined,
      cancel: async () => new Promise<void>(() => undefined),
    })
    const handle = handleWith(() => new Response(body, {status: 200}))
    const started = Date.now()

    // #when
    const result = await provisionCredentials({
      handle,
      entries: entry,
      requestTimeoutMs: 40,
      logger: capturingLogger().logger,
    })

    // #then the whole-request bound ended it: a provisioning failure naming the provider, not a hang
    expect(result).toMatchObject({
      success: false,
      error: {kind: 'credential-provision-failed', providers: ['anthropic']},
    })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('bounds a credential response whose headers never arrive', async () => {
    const handle = handleWith(async () => new Promise<Response>(() => undefined))
    const result = await provisionCredentials({
      handle,
      entries: entry,
      requestTimeoutMs: 40,
      logger: capturingLogger().logger,
    })
    expect(result).toMatchObject({success: false, error: {kind: 'credential-provision-failed'}})
  })
})
