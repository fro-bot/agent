import type {Result} from '@bfra.me/es/result'
import type {KeyProxyProtocol} from '@fro-bot/runtime'
import type {ProviderKeyEntryV2} from './credential-files-v2.js'
import {err, ok} from '@bfra.me/es/result'
import {buildKeyProxyUpstream, KEY_PROXY_PROTOCOLS} from '@fro-bot/runtime'
import {PROVIDER_ID_PATTERN} from './credential-files-v2.js'

/**
 * Maps the `auth-json` API keys and the operator's `opencode-config` to the providers the key proxy serves, and refuses
 * any config that would let a request skip the proxy. Pure: no I/O, no logging.
 *
 * Every refusal names the provider and the field, ends with a fix, and never carries a key, a URL or a header value.
 * Operator provider ids are echoed only when they pass `PROVIDER_ID_PATTERN`.
 */

export interface KeyProxyProviderPlan {
  readonly providerId: string
  /** The operator's literal base URL, or null for the provider's built-in default upstream. */
  readonly baseUrl: string | null
  readonly protocols: readonly KeyProxyProtocol[]
  /**
   * The provider's own `OpenAI-Organization` and `OpenAI-Project` header values, lowercase names, as the server sends them
   * for inference and the forwarder copies them on. Absent when the operator set none. A `{env:}`/`{file:}` value is left out.
   */
  readonly routingHeaders?: Readonly<Record<string, string>>
}

export type KeyProxyResolutionErrorKind =
  'bypass-field' | 'invalid-config' | 'missing-key' | 'signing-provider' | 'unmapped-provider' | 'unsafe-upstream'

export interface KeyProxyResolutionError {
  readonly kind: KeyProxyResolutionErrorKind
  readonly message: string
  /** Set only when the id itself passed `PROVIDER_ID_PATTERN`. */
  readonly providerId?: string
}

export interface ResolveKeyProxyProvidersOptions {
  readonly keys: readonly ProviderKeyEntryV2[]
  /** The `opencode-config` input as given, or null. */
  readonly opencodeConfig: string | null
}

type Bag = Record<string, unknown>

function isRecord(value: unknown): value is Bag {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function refuse(
  kind: KeyProxyResolutionErrorKind,
  providerId: string | undefined,
  problem: string,
  fix: string,
): Result<never, KeyProxyResolutionError> {
  const subject = providerId === undefined ? 'a provider' : `provider "${providerId}"`
  return err({
    kind,
    message: `isolate-agent: ${subject} ${problem}. Fix: ${fix}, or set \`isolate-agent: false\`.`,
    ...(providerId === undefined ? {} : {providerId}),
  })
}

type PackageClass = 'anthropic' | 'openai' | 'openai-compatible' | 'signing' | 'unknown'

const PACKAGE_CLASSES: ReadonlyMap<string, PackageClass> = new Map([
  ['@ai-sdk/anthropic', 'anthropic'],
  ['@opencode/ai/providers/anthropic', 'anthropic'],
  ['@ai-sdk/openai', 'openai'],
  ['@opencode/ai/providers/openai', 'openai'],
  ['@ai-sdk/openai-compatible', 'openai-compatible'],
  ['@opencode/ai/providers/openai-compatible', 'openai-compatible'],
])

/** Packages and ids whose requests are signed or use another wire protocol: header rewriting cannot serve them. */
const SIGNING_OR_UNSUPPORTED = /bedrock|vertex|^@ai-sdk\/google|^google$/i

function classifyPackage(name: string): PackageClass {
  if (SIGNING_OR_UNSUPPORTED.test(name)) return 'signing'
  return PACKAGE_CLASSES.get(name) ?? 'unknown'
}

const ID_PROTOCOLS: ReadonlyMap<string, readonly KeyProxyProtocol[]> = new Map([
  ['anthropic', ['anthropic-messages']],
  ['openai', ['openai-responses', 'openai-chat']],
  ['opencode-go', KEY_PROXY_PROTOCOLS],
])

function protocolsOf(packageClass: PackageClass): readonly KeyProxyProtocol[] {
  if (packageClass === 'anthropic') return ['anthropic-messages']
  return ['openai-responses', 'openai-chat']
}

interface ProviderSources {
  /** `provider.<id>` and `providers.<id>` as written, in that order. Non-records are dropped. */
  readonly blocks: readonly Bag[]
}

function providerBlocks(operator: Bag, providerId: string): ProviderSources {
  const blocks: Bag[] = []
  for (const container of ['provider', 'providers']) {
    const all = operator[container]
    if (!isRecord(all) || !Object.keys(all).includes(providerId)) continue
    const block = all[providerId]
    if (isRecord(block)) blocks.push(block)
  }
  return {blocks}
}

/** The `options` and `settings` bags of a provider or model block. */
function bagsOf(block: Bag): Bag[] {
  return [block.options, block.settings].filter(isRecord)
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

const ENDPOINT_KEY = /^(?:base[-_]?url|endpoint|api|api[-_]?url)$/i
const PLAIN_ID = /^[\w.:@/+-]{1,100}$/

/**
 * What a setting could do to a request, by its name. Credentials are not judged by name: a settings key called `token` may
 * be a schema property. The exact-value check on the serialized config (`findKeysInConfig`) catches a real key wherever it sits.
 */
type BypassKind = 'endpoint' | 'query'

interface BypassHit {
  readonly kind: BypassKind
  readonly field: string
  /** `model "m"`, `model "m" variant "v"`, or null for the provider scope. Ids that are not plain identifiers are not echoed. */
  readonly scope: string | null
}

interface Scope {
  readonly model?: string
  readonly variant?: string
}

function describeScope(scope: Scope): string | null {
  if (scope.model === undefined) return null
  const model = `model "${PLAIN_ID.test(scope.model) ? scope.model : '<unnamed>'}"`
  if (scope.variant === undefined) return model
  return `${model} variant "${PLAIN_ID.test(scope.variant) ? scope.variant : '<unnamed>'}"`
}

/** Whether a key and value would send a request around the proxy, wherever the key sits. Header names are not settings. */
function bypassKind(key: string, value: unknown): BypassKind | null {
  const lower = key.toLowerCase()
  if (lower === 'headers' || !isPresent(value)) return null
  if (lower === 'queryparams') return 'query'
  return ENDPOINT_KEY.test(key) ? 'endpoint' : null
}

/** The first endpoint or query setting under `value`, in any nested object or list. */
function findBypass(value: unknown, scope: Scope): BypassHit | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findBypass(item, scope)
      if (hit !== null) return hit
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [key, child] of Object.entries(value)) {
    const kind = bypassKind(key, child)
    if (kind !== null) return {kind, field: key, scope: describeScope(scope)}
    const hit = descend(key, child, scope)
    if (hit !== null) return hit
  }
  return null
}

/** Recurses into a child, entering a model or variant scope where the key names one. */
function descend(key: string, child: unknown, scope: Scope): BypassHit | null {
  // Header names are not settings.
  if (key.toLowerCase() === 'headers') return null
  if (key === 'models' && isRecord(child)) {
    for (const [modelId, model] of Object.entries(child)) {
      const hit = findBypass(model, {model: modelId})
      if (hit !== null) return hit
    }
    return null
  }
  if (key === 'variants') {
    const entries: [string, unknown][] = Array.isArray(child)
      ? child.map((item, index): [string, unknown] => [
          isRecord(item) && typeof item.id === 'string' ? item.id : `#${index}`,
          item,
        ])
      : isRecord(child)
        ? Object.entries(child)
        : []
    for (const [variantId, variant] of entries) {
      const hit = findBypass(variant, {...scope, variant: variantId})
      if (hit !== null) return hit
    }
    return null
  }
  return findBypass(child, scope)
}

/**
 * Scans a provider block, and every nested scope under it (models, variants, any other object), for settings that send a
 * request around the proxy. The one exception at each place is the field `resolveProvider` reads as the provider's own base
 * URL (`api` on the block, `baseURL` in `options` and `settings`): it checks those, string or not, itself.
 */
function findProviderBypass(block: Bag): BypassHit | null {
  const nodes: readonly (readonly [Bag, string])[] = [
    [block, 'api'],
    ...bagsOf(block).map((bag): readonly [Bag, string] => [bag, 'baseURL']),
  ]
  for (const [node, ownBaseUrlKey] of nodes) {
    for (const [key, child] of Object.entries(node)) {
      if (key === ownBaseUrlKey || (node === block && (key === 'options' || key === 'settings'))) continue
      const kind = bypassKind(key, child)
      if (kind !== null) return {kind, field: key, scope: null}
      const hit = descend(key, child, {})
      if (hit !== null) return hit
    }
  }
  return null
}

function bypassRefusal(providerId: string, hit: BypassHit): Result<never, KeyProxyResolutionError> {
  const at = hit.scope === null ? 'in its provider settings' : `on ${hit.scope}`
  switch (hit.kind) {
    case 'endpoint':
      return refuse(
        'bypass-field',
        providerId,
        `sets \`${hit.field}\` ${at}, which sends requests around the key proxy`,
        'remove it and set one provider-level `baseURL` (an https URL)',
      )
    case 'query':
      return refuse(
        'bypass-field',
        providerId,
        `sets \`queryParams\` ${at}, which the key proxy does not forward (its routes take no query string)`,
        'remove `queryParams`',
      )
  }
}

const OPENAI_ROUTING_HEADER_NAMES: ReadonlySet<string> = new Set(['openai-organization', 'openai-project'])
/** A header value a request can carry as written: printable ASCII, no reference the server would resolve later. */
const PLAIN_HEADER_VALUE = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/

/**
 * The provider's own `OpenAI-Organization` and `OpenAI-Project` headers (block, `options` and `settings` `headers`; a later
 * one wins), for the start-up probe to send as the server does for inference. Only a literal value is taken.
 */
function routingHeadersOf(blocks: readonly Bag[]): Record<string, string> {
  const found: Record<string, string> = {}
  for (const block of blocks) {
    for (const node of [block, ...bagsOf(block)]) {
      if (!isRecord(node.headers)) continue
      for (const [name, value] of Object.entries(node.headers)) {
        const lower = name.toLowerCase()
        if (!OPENAI_ROUTING_HEADER_NAMES.has(lower) || typeof value !== 'string') continue
        if (PLAIN_HEADER_VALUE.test(value) && !/\{(?:env|file):/.test(value)) found[lower] = value
      }
    }
  }
  return found
}

function modelPackages(model: Bag): string[] {
  const names: unknown[] = [model.npm, model.package]
  if (isRecord(model.provider)) names.push(model.provider.npm, model.provider.package)
  return names.filter((name): name is string => typeof name === 'string' && name.length > 0)
}

function modelsOf(block: Bag): Bag[] {
  return isRecord(block.models) ? Object.values(block.models).filter(isRecord) : []
}

/**
 * Resolves one provider. The operator's blocks are scanned for every field that could carry a request around the proxy
 * or put a credential into a header the proxy would have to trust.
 */
function resolveProvider(operator: Bag, providerId: string): Result<KeyProxyProviderPlan, KeyProxyResolutionError> {
  const {blocks} = providerBlocks(operator, providerId)

  // Signing and non-Messages/OpenAI providers first: nothing else about them matters.
  const providerPackages = blocks.flatMap(block => [block.npm, block.package]).filter(name => typeof name === 'string')
  const modelLevelPackages = blocks.flatMap(block => modelsOf(block).flatMap(modelPackages))
  if (
    SIGNING_OR_UNSUPPORTED.test(providerId) ||
    [...providerPackages, ...modelLevelPackages].some(name => classifyPackage(name) === 'signing')
  ) {
    return refuse(
      'signing-provider',
      providerId,
      'uses a signed or non-OpenAI/Anthropic protocol (Bedrock, Vertex or Google generateContent), which the key proxy cannot serve',
      'remove it from auth-json and opencode-config',
    )
  }

  const baseUrls: unknown[] = []
  for (const block of blocks) {
    if (isPresent(block.api)) baseUrls.push(block.api)
    for (const bag of bagsOf(block)) {
      if (isPresent(bag.baseURL)) baseUrls.push(bag.baseURL)
    }
    const hit = findProviderBypass(block)
    if (hit !== null) return bypassRefusal(providerId, hit)
  }

  // One literal base URL. A legacy and a V2 spelling must agree.
  let baseUrl: string | null = null
  for (const candidate of baseUrls) {
    if (typeof candidate !== 'string') {
      return refuse(
        'unsafe-upstream',
        providerId,
        'has a base URL that is not a string',
        'set `baseURL` to an https URL',
      )
    }
    if (candidate.includes('{env:') || candidate.includes('{file:')) {
      return refuse(
        'unsafe-upstream',
        providerId,
        'builds its base URL from `{env:}` or `{file:}`, which the key proxy cannot check',
        'write the https base URL literally',
      )
    }
    if (baseUrl !== null && baseUrl !== candidate) {
      return refuse(
        'unsafe-upstream',
        providerId,
        'sets two different base URLs (the legacy `options` and the V2 `settings`)',
        'keep one `baseURL`',
      )
    }
    baseUrl = candidate
  }

  // Protocols come from the provider package, else the provider id.
  let protocols: readonly KeyProxyProtocol[] | undefined
  const firstPackage = providerPackages.find(name => name.length > 0)
  if (firstPackage === undefined) {
    protocols = ID_PROTOCOLS.get(providerId)
  } else {
    const packageClass = classifyPackage(firstPackage)
    if (packageClass === 'unknown') {
      return refuse(
        'unmapped-provider',
        providerId,
        'uses a package the key proxy does not recognise',
        'use `@ai-sdk/openai-compatible`, `@ai-sdk/openai` or `@ai-sdk/anthropic` for it',
      )
    }
    protocols = protocolsOf(packageClass)
  }
  if (protocols === undefined) {
    return refuse(
      'unmapped-provider',
      providerId,
      'cannot be mapped to a key-proxy route: its protocol and upstream are unknown',
      `set \`provider.${providerId}.npm\` (\`@ai-sdk/openai-compatible\`, \`@ai-sdk/openai\` or \`@ai-sdk/anthropic\`) and \`provider.${providerId}.options.baseURL\`, or remove it from auth-json`,
    )
  }
  const withModels = new Set(protocols)
  for (const name of modelLevelPackages) {
    const packageClass = classifyPackage(name)
    if (packageClass === 'unknown') {
      return refuse(
        'unmapped-provider',
        providerId,
        'has a model on a package the key proxy does not recognise',
        'use `@ai-sdk/openai-compatible`, `@ai-sdk/openai` or `@ai-sdk/anthropic` for it',
      )
    }
    for (const protocol of protocolsOf(packageClass)) withModels.add(protocol)
  }
  const ordered = KEY_PROXY_PROTOCOLS.filter(protocol => withModels.has(protocol))

  const upstream = buildKeyProxyUpstream({providerId, baseUrl, protocols: ordered})
  if (!upstream.success) {
    if (baseUrl === null && !ID_PROTOCOLS.has(providerId)) {
      return refuse(
        'unmapped-provider',
        providerId,
        'has no built-in upstream',
        `set \`provider.${providerId}.options.baseURL\` to its https URL, or remove it from auth-json`,
      )
    }
    return refuse(
      'unsafe-upstream',
      providerId,
      `has an upstream the key proxy refuses (${upstream.error})`,
      'use an https base URL with no credentials, query or fragment that is not a cloud metadata host',
    )
  }
  const routingHeaders = routingHeadersOf(blocks)
  return ok({
    providerId,
    baseUrl,
    protocols: ordered,
    ...(Object.keys(routingHeaders).length === 0 ? {} : {routingHeaders}),
  })
}

export function resolveKeyProxyProviders(
  options: ResolveKeyProxyProvidersOptions,
): Result<readonly KeyProxyProviderPlan[], KeyProxyResolutionError> {
  let operator: Bag = {}
  if (options.opencodeConfig !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(options.opencodeConfig)
    } catch {
      return err({kind: 'invalid-config', message: 'opencode-config must be valid JSON'})
    }
    if (!isRecord(parsed)) return err({kind: 'invalid-config', message: 'opencode-config must be a JSON object'})
    operator = parsed
  }

  const keyIds = new Set(options.keys.map(entry => entry.providerId))
  // Every operator provider must be proxied, or the server could reach it without the proxy.
  for (const container of ['provider', 'providers']) {
    const all = operator[container]
    if (!isRecord(all)) continue
    for (const id of Object.keys(all)) {
      if (!PROVIDER_ID_PATTERN.test(id)) {
        return refuse(
          'bypass-field',
          undefined,
          'in opencode-config has an id with invalid characters',
          'rename or remove it',
        )
      }
      if (!keyIds.has(id)) {
        return refuse(
          'missing-key',
          id,
          'is configured in opencode-config but has no API-key entry in auth-json, so it would run without the key proxy',
          'add an API-key entry for it to the auth-json input, or remove it from opencode-config',
        )
      }
    }
  }

  const plans: KeyProxyProviderPlan[] = []
  for (const {providerId} of options.keys) {
    const resolved = resolveProvider(operator, providerId)
    if (!resolved.success) return resolved
    plans.push(resolved.data)
  }
  return ok(plans)
}

export interface ConfigTextToCheck {
  /** What the text is, for the message: `OPENCODE_CONFIG_CONTENT`, a file name. Never a value. */
  readonly label: string
  readonly text: string
}

/**
 * The last check before a config reaches the sandbox user: no `auth-json` key value may appear in any config text it will
 * read, raw or JSON-escaped. This is by value, not by field name, so it holds for a key written anywhere in `opencode-config`
 * (a root `apiKey`, a nested `api` object, a model setting) however the resolver or the config builder treats that field.
 * The refusal names the provider and the text, never the value.
 */
export function checkConfigForKeys(options: {
  readonly keys: readonly ProviderKeyEntryV2[]
  readonly configs: readonly ConfigTextToCheck[]
}): Result<null, string> {
  for (const {providerId, key} of options.keys) {
    if (key.length === 0) continue
    const escaped = JSON.stringify(key).slice(1, -1)
    for (const {label, text} of options.configs) {
      if (text.includes(key) || text.includes(escaped)) {
        return err(
          `isolate-agent: the API key for provider "${providerId}" appears in ${label}, which the sandbox user can read. ` +
            'Fix: remove the value from the `opencode-config` input (isolation keeps only `auth-json` keys out of the sandbox; ' +
            'values written into `opencode-config` stay visible to it), or set `isolate-agent: false`.',
        )
      }
    }
  }
  return ok(null)
}
