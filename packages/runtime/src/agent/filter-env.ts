// Deny-by-default env filter for the OpenCode agent child process.
//
// A key is retained iff it matches the exact-key allowlist OR an allowed
// operational prefix, AND it does not match the defense-in-depth deny-set.
// The deny-set is a backstop, not the primary guard — the allowlist is.

const EXACT_ALLOW_KEYS: ReadonlySet<string> = new Set([
  // GitHub Actions context — enumerated exactly (no broad GITHUB_ prefix,
  // which would re-admit GITHUB_TOKEN / GITHUB_APP_PRIVATE_KEY).
  'GITHUB_REPOSITORY',
  'GITHUB_WORKSPACE',
  'GITHUB_REF',
  'GITHUB_REF_NAME',
  'GITHUB_REF_TYPE',
  'GITHUB_SHA',
  'GITHUB_EVENT_NAME',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_NUMBER',
  'GITHUB_ACTOR',
  'GITHUB_SERVER_URL',
  'GITHUB_API_URL',
  'GITHUB_GRAPHQL_URL',
  'GITHUB_WORKFLOW',
  'GITHUB_JOB',
  'GITHUB_ACTION',
  'GITHUB_EVENT_PATH',
  // Standard process/shell environment.
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'PWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'LANG',
  'TERM',
  'GH_CONFIG_DIR',
  'TZ',
  // Proxy/CA-bundle vars: operational config the child needs for egress/TLS on
  // self-hosted runners behind a proxy or enterprise-CA git. Proxy URLs CAN embed
  // credentials (`user:pass@host`) — this is a known no-regression-from-baseline
  // tradeoff; full isolation is deferred to the credential broker (#1147 hardening).
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'GIT_SSL_CAINFO',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
])

const ALLOW_PREFIXES: readonly string[] = ['OPENCODE_', 'RUNNER_', 'XDG_', 'LC_', 'NODE_']

const DENY_SUFFIXES: readonly string[] = [
  '_TOKEN',
  '_API_KEY',
  '_APIKEY',
  '_SECRET',
  '_PASSWORD',
  '_PASSWD',
  '_PRIVATE_KEY',
  '_KEY',
  '_CREDENTIALS',
  '_CREDENTIAL',
]

const DENY_EXACT_KEYS: ReadonlySet<string> = new Set(['GITHUB_TOKEN', 'GH_TOKEN'])

const DENY_PREFIXES: readonly string[] = ['AWS_', 'INPUT_']

function isDenied(key: string): boolean {
  if (DENY_EXACT_KEYS.has(key)) {
    return true
  }

  if (DENY_PREFIXES.some(prefix => key.startsWith(prefix))) {
    return true
  }

  return DENY_SUFFIXES.some(suffix => key.endsWith(suffix))
}

function isAllowed(key: string): boolean {
  return EXACT_ALLOW_KEYS.has(key) || ALLOW_PREFIXES.some(prefix => key.startsWith(prefix))
}

/**
 * Returns a new environment record containing only allowlisted, non-secret
 * keys. Deny-by-default: unrecognized keys are dropped. Does not mutate
 * the input.
 */
export function filterAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue
    }

    if (isAllowed(key) && !isDenied(key)) {
      filtered[key] = value
    }
  }

  return filtered
}
