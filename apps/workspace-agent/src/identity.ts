/**
 * Shared identity constants for the OpenCode / existing-checkout-git process boundary.
 *
 * The workspace-agent SERVICE (this Hono process, main.ts) keeps running as root (uid 0) with
 * reduced capabilities — the deploy image handles capability-dropping. Everything that runs
 * agent-supplied code or touches an agent-owned checkout — OpenCode itself, and git invoked
 * against an existing checkout (inspect.ts) — runs as the unprivileged identity below instead,
 * so the agent can never read the service's HOME, write its global git config, or read
 * /proc/<pid>/environ of a process holding a GitHub installation token.
 *
 * These values are shared with the deploy image (deploy/workspace.Dockerfile creates the
 * `opencode` user/group and the home/XDG directory tree with these exact uid/gid/paths) and
 * with deploy/compose wiring for the SERVICE home. Changing a value here without updating the
 * image breaks the container at runtime — this module is the single source of truth so nothing
 * hardcodes them twice.
 */

/** Unprivileged uid the OpenCode process and existing-checkout git run as. */
export const AGENT_UID = 10_001

/** Unprivileged gid the OpenCode process and existing-checkout git run as. */
export const AGENT_GID = 10_001

/** Username set as USER/LOGNAME in the OpenCode child environment. */
export const AGENT_USERNAME = 'opencode'

/** Home directory for the unprivileged agent identity. Never shared with the service's HOME. */
export const AGENT_HOME = '/home/opencode'

/** XDG data root under the agent home (OpenCode config/state/plugins live here). */
export const AGENT_XDG_DATA_HOME = `${AGENT_HOME}/.local/share`

/** XDG config root under the agent home. */
export const AGENT_XDG_CONFIG_HOME = `${AGENT_HOME}/.config`

/** XDG cache root under the agent home. */
export const AGENT_XDG_CACHE_HOME = `${AGENT_HOME}/.cache`

/** XDG state root under the agent home. */
export const AGENT_XDG_STATE_HOME = `${AGENT_HOME}/.local/state`

/**
 * Agent-owned scratch directory. Deliberately under the agent's own XDG cache root — never the
 * service's shared /tmp — so a temp file OpenCode writes is never readable by the root-owned
 * service process.
 */
export const AGENT_TMPDIR = `${AGENT_XDG_CACHE_HOME}/tmp`

/**
 * Home directory for the root-owned workspace-agent SERVICE identity. Deliberately outside
 * `/root` and outside the agent's home tree so neither identity can read the other's dotfiles
 * or cached credentials.
 */
export const SERVICE_HOME = '/var/lib/workspace-agent/home'

/**
 * Absolute path to the baked OpenCode executable inside the workspace image.
 * deploy/workspace.Dockerfile installs the release tarball via
 * `tar -xz -C /usr/local/bin -f "/tmp/${oc_asset}.tar.gz"`, so the binary always lands at
 * /usr/local/bin/opencode. Always used as an absolute path — never resolved through PATH — so a
 * PATH manipulation in the constructed child environment can never substitute a different binary
 * for the one actually spawned.
 */
export const OPENCODE_EXECUTABLE_PATH = '/usr/local/bin/opencode'
