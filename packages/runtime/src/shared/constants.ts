// Storage paths
export const OPENCODE_STORAGE_PATH = '~/.local/share/opencode/storage' as const
export const OPENCODE_AUTH_PATH = '~/.local/share/opencode/auth.json' as const

// Files to exclude from cache (security-sensitive)
export const CACHE_EXCLUSIONS = ['auth.json', '.env', '*.key', '*.pem'] as const

// Default configuration - per RFC-001
export const DEFAULT_SESSION_RETENTION = 50
export const DEFAULT_MAX_AGE_DAYS = 30

// SDK execution defaults - per RFC-013
export const DEFAULT_TIMEOUT_MS = 1800000 // 30 minutes

// OpenCode server bootstrap budget - mirrors the @opencode-ai/sdk createOpencode
// default (server.js does Object.assign({..., timeout: 5000}, options)). Passing
// this explicitly rather than omitting `timeout` keeps the unset-input behavior
// byte-for-byte identical to today while making the budget observable/adjustable.
export const DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS = 5000

// Bound on bootstrapOpenCodeServer's instance-scoped readiness probe -- time-to-first-
// answer, distinct from DEFAULT_SERVER_BOOTSTRAP_TIMEOUT_MS's time-to-listen budget above.
// Not operator-tunable via an action input.
export const DEFAULT_SERVER_READINESS_TIMEOUT_MS = 60_000

// Bound on how long shutdown() waits for the OpenCode child to actually go away before
// returning control to the caller (src/harness/phases/cleanup.ts, immediately ahead of
// the SQLite checkpoint). The SDK (@opencode-ai/sdk dist/server.js) exposes only
// {url, close()} -- no pid, no child-process handle, no exit event -- so the harness
// cannot await the real process. This polls the server's own listening port instead:
// once connection attempts start failing, the OS has reclaimed the port, which only
// happens when the process that held it has actually exited. The pinned upstream clone's
// serve command (cli/cmd/serve.ts) registers no SIGTERM handler, so default signal
// disposition terminates it near-instantly under normal conditions; 5s covers slow signal
// delivery on a loaded runner without materially extending cleanup, which -- unlike the
// server-bootstrap budget above -- is not on the critical path any run is timed against.
export const DEFAULT_SHUTDOWN_QUIESCE_TIMEOUT_MS = 5000
export const DEFAULT_SHUTDOWN_QUIESCE_POLL_INTERVAL_MS = 100

// Default model for OpenCode Zen - ensures inference starts
export const DEFAULT_MODEL = {
  providerID: 'opencode',
  modelID: 'big-pickle',
} as const

// Setup consolidation defaults
// DEFAULT_OPENCODE_VERSION is the harness build: a fro-bot/agent release that bundles
// the stock OpenCode binary with verified SHA256SUMS. Downloaded from fro-bot/agent
// releases, checksum-verified, and fail-closed on mismatch — no silent stock fallback.
// FALLBACK_VERSION (in opencode.ts) is the plain stock base used when latest-fetch fails.
export const DEFAULT_OPENCODE_VERSION = '1.18.29+harness.88b6b5fb'
export const DEFAULT_BUN_VERSION = '1.3.14'
export const DEFAULT_OMO_VERSION = '4.19.4'
// OMO Slim (oh-my-opencode-slim) pinned version. Stable line only — the 2.0.0-beta
// channel is not the default. Renovate tracks this via .github/renovate.json5.
export const DEFAULT_OMO_SLIM_VERSION = '2.2.17'
export const DEFAULT_OMO_PROVIDERS = ''
export const DEFAULT_SYSTEMATIC_VERSION = '3.16.0'

// All-'no' OmoProviders sentinel for disabled oMo mode
export const OMO_PROVIDERS_DISABLED = {
  claude: 'no',
  copilot: 'no',
  gemini: 'no',
  openai: 'no',
  opencodeZen: 'no',
  zaiCodingPlan: 'no',
  kimiForCoding: 'no',
} as const

// Retry configuration lives in the Action layer's src/features/agent/retry.ts,
// colocated with the retry logic that consumes the values.

// Cache key components
export const CACHE_PREFIX = 'opencode-storage' as const
export const DEFAULT_S3_PREFIX = 'fro-bot-state' as const
export const TOOLS_CACHE_PREFIX = 'opencode-tools-v2' as const

// Dedup execution defaults
export const DEFAULT_DEDUP_WINDOW_MS = 600_000 // 10 minutes
export const DEDUP_CACHE_PREFIX = 'fro-bot-dedup-v1' as const

// Storage version (increment on breaking changes)
export const STORAGE_VERSION = 1
