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
export const DEFAULT_OPENCODE_VERSION = '1.18.4+harness.1ff4b323'
export const DEFAULT_BUN_VERSION = '1.3.14'
export const DEFAULT_OMO_VERSION = '3.17.15'
// OMO Slim (oh-my-opencode-slim) pinned version. Stable line only — the 2.0.0-beta
// channel is not the default. Renovate tracks this via .github/renovate.json5.
export const DEFAULT_OMO_SLIM_VERSION = '1.1.2'
export const DEFAULT_OMO_PROVIDERS = ''
export const DEFAULT_SYSTEMATIC_VERSION = '3.2.2'

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

// Retry configuration lives in agent/retry.ts (RETRY_DELAYS_MS, MAX_LLM_RETRIES)
// to colocate with the retry logic that consumes the values.

// Cache key components
export const CACHE_PREFIX = 'opencode-storage' as const
export const DEFAULT_S3_PREFIX = 'fro-bot-state' as const
export const TOOLS_CACHE_PREFIX = 'opencode-tools' as const

// Dedup execution defaults
export const DEFAULT_DEDUP_WINDOW_MS = 600_000 // 10 minutes
export const DEDUP_CACHE_PREFIX = 'fro-bot-dedup-v1' as const

// Storage version (increment on breaking changes)
export const STORAGE_VERSION = 1
