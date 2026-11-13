import type {Result} from '../shared/types.js'
import {validateUpstreamUrl} from '../object-store/validation.js'
import {err, ok} from '../shared/types.js'

/**
 * What the key proxy forwards for one provider. A provider is served under the prefix `/<providerId>`, and the client's
 * base URL is that prefix alone: OpenCode appends the protocol path to it. The paths below were captured from stock
 * OpenCode 2.2.7 (`POST <base>/messages?beta=true` for the `anthropic` provider id, `POST <base>/messages` for another id,
 * `POST <base>/responses`, `POST <base>/chat/completions`), and the table is checked against that client by the tests.
 *
 * Each route fixes the credential header the client sends and the same header the proxy sets upstream. A protocol that
 * is not listed here, and every path outside the table, is answered locally.
 */

export type KeyProxyProtocol = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

export const KEY_PROXY_PROTOCOLS: readonly KeyProxyProtocol[] = [
  'anthropic-messages',
  'openai-responses',
  'openai-chat',
]

/** `x-api-key` for Messages, `Authorization: Bearer` for Responses and Chat. */
export type KeyProxyAuthStyle = 'bearer' | 'x-api-key'

export interface KeyProxyRoute {
  readonly method: 'GET' | 'POST'
  /** The path after the provider prefix, exactly as the client sends it. */
  readonly path: string
  /** The raw query strings accepted for this route, without the `?`. `''` means no query. */
  readonly queries: readonly string[]
  readonly auth: KeyProxyAuthStyle
  /** The absolute path on the upstream origin. */
  readonly upstreamPath: string
  readonly kind: 'inference' | 'models'
}

export interface KeyProxyUpstream {
  /** `https://host[:port]`, no path. */
  readonly origin: string
  readonly routes: readonly KeyProxyRoute[]
}

export interface BuildKeyProxyUpstreamOptions {
  readonly providerId: string
  /** The operator's literal base URL, or null to use the provider's built-in default. */
  readonly baseUrl: string | null
  readonly protocols: readonly KeyProxyProtocol[]
}

interface DefaultUpstream {
  readonly origin: string
  /** Base path per protocol family, or absent when the default does not serve it. */
  readonly messagesBase?: string
  readonly openaiBase?: string
  readonly modelsPath: string
}

const DEFAULT_UPSTREAMS: ReadonlyMap<string, DefaultUpstream> = new Map([
  ['anthropic', {origin: 'https://api.anthropic.com', messagesBase: '/v1', modelsPath: '/v1/models'}],
  ['openai', {origin: 'https://api.openai.com', openaiBase: '/v1', modelsPath: '/v1/models'}],
  [
    'opencode-go',
    {
      origin: 'https://opencode.ai',
      messagesBase: '/inference/go/anthropic/v1',
      openaiBase: '/inference/go/openai/v1',
      modelsPath: '/inference/go/v1/models',
    },
  ],
])

/** Provider ids that have a built-in default upstream. Any other id needs an operator base URL. */
export const KEY_PROXY_DEFAULT_PROVIDER_IDS: readonly string[] = [...DEFAULT_UPSTREAMS.keys()]

const MESSAGES_QUERIES = ['', 'beta=true'] as const

function joinPath(base: string, path: string): string {
  return `${base}${path}`
}

/** The base path of a validated URL with its trailing slashes removed. Null when the path cannot be joined safely. */
function basePathOf(url: URL): string | null {
  const trimmed = url.pathname.replace(/\/+$/, '')
  if (trimmed.includes('//') || trimmed.includes('%')) return null
  return trimmed
}

function hasOpenAi(protocols: readonly KeyProxyProtocol[]): boolean {
  return protocols.includes('openai-responses') || protocols.includes('openai-chat')
}

/**
 * The upstream origin and the allowlisted routes for one provider. Fails, with a message that names the rule and not
 * the value, when the URL is not a safe https upstream, when the provider has no base URL and no built-in default, or
 * when the default does not serve a requested protocol.
 */
export function buildKeyProxyUpstream(options: BuildKeyProxyUpstreamOptions): Result<KeyProxyUpstream, string> {
  const {providerId, baseUrl, protocols} = options
  const wanted = new Set(protocols)
  if (wanted.size === 0) return err('the provider has no supported protocol')

  let origin: string
  let messagesBase: string | undefined
  let openaiBase: string | undefined
  let modelsPath: string

  if (baseUrl === null) {
    const defaults = DEFAULT_UPSTREAMS.get(providerId)
    if (defaults === undefined) return err('the provider has no built-in default upstream and no base URL')
    if (wanted.has('anthropic-messages') && defaults.messagesBase === undefined) {
      return err('the built-in upstream does not serve the Anthropic Messages protocol')
    }
    if (hasOpenAi(protocols) && defaults.openaiBase === undefined) {
      return err('the built-in upstream does not serve the OpenAI protocols')
    }
    origin = defaults.origin
    messagesBase = defaults.messagesBase
    openaiBase = defaults.openaiBase
    modelsPath = defaults.modelsPath
  } else {
    const validated = validateUpstreamUrl(baseUrl)
    if (!validated.success) return err(validated.error)
    const base = basePathOf(validated.data)
    if (base === null) return err('the upstream path must not contain empty segments or percent-encoding')
    origin = validated.data.origin
    messagesBase = base
    openaiBase = base
    modelsPath = joinPath(base, '/models')
  }

  const routes: KeyProxyRoute[] = []
  if (wanted.has('anthropic-messages') && messagesBase !== undefined) {
    routes.push({
      method: 'POST',
      path: '/messages',
      // `beta=true` is sent only for the `anthropic` provider id; another id sends no query.
      queries: MESSAGES_QUERIES,
      auth: 'x-api-key',
      upstreamPath: joinPath(messagesBase, '/messages'),
      kind: 'inference',
    })
  }
  if (openaiBase !== undefined) {
    if (wanted.has('openai-responses')) {
      for (const path of ['/responses', '/responses/compact']) {
        routes.push({
          method: 'POST',
          path,
          queries: [''],
          auth: 'bearer',
          upstreamPath: joinPath(openaiBase, path),
          kind: 'inference',
        })
      }
    }
    if (wanted.has('openai-chat')) {
      routes.push({
        method: 'POST',
        path: '/chat/completions',
        queries: [''],
        auth: 'bearer',
        upstreamPath: joinPath(openaiBase, '/chat/completions'),
        kind: 'inference',
      })
    }
  }
  routes.push({
    method: 'GET',
    path: '/models',
    queries: [''],
    auth: hasOpenAi(protocols) ? 'bearer' : 'x-api-key',
    upstreamPath: modelsPath,
    kind: 'models',
  })
  return ok({origin, routes})
}

/** The route for an exact method, path and raw query string, or undefined. No decoding, no prefix matching. */
export function matchKeyProxyRoute(
  routes: readonly KeyProxyRoute[],
  method: string,
  path: string,
  query: string,
): KeyProxyRoute | undefined {
  return routes.find(route => route.method === method && route.path === path && route.queries.includes(query))
}
