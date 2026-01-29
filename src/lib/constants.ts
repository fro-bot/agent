// Storage paths
export const OPENCODE_STORAGE_PATH = '~/.local/share/opencode/storage' as const
export const OPENCODE_AUTH_PATH = '~/.local/share/opencode/auth.json' as const

// Files to exclude from cache (security-sensitive)
export const CACHE_EXCLUSIONS = ['auth.json', '.env', '*.key', '*.pem'] as const

// Default configuration - per RFC-001
export const DEFAULT_SESSION_RETENTION = 50
export const DEFAULT_MAX_AGE_DAYS = 30

// SDK execution defaults - per RFC-013
export const DEFAULT_AGENT = 'Sisyphus'
export const DEFAULT_TIMEOUT_MS = 1800000 // 30 minutes

// Default model for OpenCode Zen - ensures inference starts
export const DEFAULT_MODEL = {
  providerID: 'opencode',
  modelID: 'glm-4.7-free',
} as const

// Setup consolidation defaults
export const DEFAULT_OPENCODE_VERSION = 'latest'
export const DEFAULT_OMO_PROVIDERS = 'opencode-zen'

// Retry configuration
export const RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const
export const LLM_RETRY_DELAY_MS = 10_000

// Cache key components
export const CACHE_PREFIX = 'opencode-storage' as const

// Storage version (increment on breaking changes)
export const STORAGE_VERSION = 1
