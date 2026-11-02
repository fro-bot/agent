import v2PinFile from './opencode-v2-pin.json'

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

// Value pinned into OPENCODE_CLIENT for the Action's OpenCode server. Upstream offers the
// interactive `question` tool only when the client is `app`, `cli` or `desktop` (or
// OPENCODE_ENABLE_QUESTION_TOOL is set) -- `tool/registry.ts:207` at the pinned base_version --
// and the unset default is `cli`. Nobody can answer a question in CI, so any non-interactive
// value keeps the tool out of the registry entirely. Distinct from `run`/`acp` (other upstream
// clients) so it is attributable in the models.dev user agent and OTLP attributes.
export const NON_INTERACTIVE_OPENCODE_CLIENT = 'fro-bot-action'

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
// DEFAULT_OPENCODE_VERSION is the stock OpenCode V2 pin, read from opencode-v2-pin.json: the one place the
// version and the per-asset sha256 digests are recorded (Renovate bumps it and regenerates the digests; the
// workspace Dockerfile reads the same file). A V2 install succeeds only against those digests. The V1 harness
// build is no longer the default; a consumer can still select it by pinning `opencode-version` to the harness
// build.
export const DEFAULT_OPENCODE_VERSION: string = v2PinFile.version
export const DEFAULT_SYSTEMATIC_VERSION = '3.29.0'

// Systematic for OpenCode V2. 3.27.x loads on both V1 and V2, so the V2 path installs DEFAULT_SYSTEMATIC_VERSION too
// and there is no separate V2 pin. The plugin id is the `id` of the object the package's default export carries
// (`systematicPlugin = {id: "systematic", ...}` in `@fro.bot/systematic` `dist/index.js`); `GET /api/plugin` lists it
// under that id. Dockerfile ARG SYSTEMATIC_VERSION in deploy/workspace.Dockerfile must equal DEFAULT_SYSTEMATIC_VERSION,
// and deploy/scripts/workspace-v2-image.test.mjs keeps them in step.
export const SYSTEMATIC_PACKAGE = '@fro.bot/systematic'
export const SYSTEMATIC_V2_PLUGIN_ID = 'systematic'

// The fro-bot OpenCode V2 plugin (packages/opencode-plugin); the package duplicates the id and a test keeps them equal.
// The version is the one published to npm, installed at image build time. Dockerfile ARG FRO_BOT_PLUGIN_VERSION must
// equal it.
export const FRO_BOT_PLUGIN_PACKAGE = '@fro.bot/opencode-plugin'
export const FRO_BOT_PLUGIN_ID = 'fro-bot.opencode-plugin'
export const FRO_BOT_PLUGIN_VERSION = '0.1.0'

// Retry configuration lives in the Action layer's src/features/agent/retry.ts,
// colocated with the retry logic that consumes the values.

// Cache key components
export const CACHE_PREFIX = 'opencode-storage' as const
// Must not start with CACHE_PREFIX, and CACHE_PREFIX must not start with it: each generation's restore-key
// prefixes then never match the other's entries. Distinct from TOOLS_CACHE_PREFIX ('opencode-tools-v2').
export const CACHE_V2_PREFIX = 'opencode-v2-storage' as const
export const DEFAULT_S3_PREFIX = 'fro-bot-state' as const
export const TOOLS_CACHE_PREFIX = 'opencode-tools-v2' as const

// Dedup execution defaults
export const DEFAULT_DEDUP_WINDOW_MS = 600_000 // 10 minutes
export const DEDUP_CACHE_PREFIX = 'fro-bot-dedup-v1' as const

// Storage version (increment on breaking changes)
export const STORAGE_VERSION = 1
