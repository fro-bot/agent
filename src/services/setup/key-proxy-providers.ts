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

const REFERENCE_OPENING = /^\{(?:env|file):/
const CREDENTIAL_HEADER_NAME = /auth|api[-_]?key|token|secret|cookie|credential/i

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

function hasCredentialHeader(headers: unknown): boolean {
  return isRecord(headers) && Object.keys(headers).some(name => CREDENTIAL_HEADER_NAME.test(name))
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/** A model's own base URL or endpoint, in any of the shapes the server reads. */
function modelRedirects(model: Bag): boolean {
  if (isPresent(model.baseURL) || isPresent(model.endpoint) || isPresent(model.api)) return true
  if (isRecord(model.provider) && (isPresent(model.provider.api) || isPresent(model.provider.baseURL))) return true
  return bagsOf(model).some(bag => isPresent(bag.baseURL) || isPresent(bag.endpoint) || isPresent(bag.api))
}

function modelHasCredentialHeader(model: Bag): boolean {
  return hasCredentialHeader(model.headers) || bagsOf(model).some(bag => hasCredentialHeader(bag.headers))
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
      if (isPresent(bag.endpoint)) {
        return refuse(
          'bypass-field',
          providerId,
          'sets `endpoint`, which sends requests around the key proxy',
          `remove \`endpoint\` from the provider options and use \`baseURL\` (an https URL) instead`,
        )
      }
      if (isPresent(bag.baseURL)) baseUrls.push(bag.baseURL)
      if (isPresent(bag.apiKey) && !(typeof bag.apiKey === 'string' && REFERENCE_OPENING.test(bag.apiKey))) {
        return refuse(
          'bypass-field',
          providerId,
          'sets a literal `apiKey` in opencode-config, which the sandbox could read',
          'put the key in the auth-json input and remove `apiKey` from the provider options',
        )
      }
      if (isPresent(bag.authToken) || isPresent(bag.accessToken) || isPresent(bag.token)) {
        return refuse(
          'bypass-field',
          providerId,
          'sets an `authToken` or `accessToken` in opencode-config, which the sandbox could read',
          'put the key in the auth-json input and remove the token from the provider options',
        )
      }
      if (hasCredentialHeader(bag.headers)) {
        return refuse(
          'bypass-field',
          providerId,
          'sets a credential-bearing entry in `headers`, which the key proxy does not carry',
          'remove the Authorization or API-key header and put the key in the auth-json input',
        )
      }
    }
    for (const model of modelsOf(block)) {
      if (modelRedirects(model)) {
        return refuse(
          'bypass-field',
          providerId,
          'sets a model-level base URL or endpoint, which sends requests around the key proxy',
          'remove it from the model and set one provider-level `baseURL`',
        )
      }
      if (modelHasCredentialHeader(model)) {
        return refuse(
          'bypass-field',
          providerId,
          'sets a credential-bearing entry in a model `headers`, which the key proxy does not carry',
          'remove the Authorization or API-key header and put the key in the auth-json input',
        )
      }
    }
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
  return ok({providerId, baseUrl, protocols: ordered})
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
