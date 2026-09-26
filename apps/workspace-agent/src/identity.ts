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
 * Name of the workspace-agent's own root-owned state directory, directly under the repos root
 * (e.g. `/workspace/repos/.workspace-agent`). Created by the entrypoint
 * (`deploy/scripts/ensure-protected-dir.mjs`) as `0:0` `0700` before the service becomes
 * reachable — never agent-writable, never agent-traversable. Shared by name with
 * `deploy/scripts/migrate-repo-ownership.mjs` (`STATE_DIR_NAME`); kept here too so clone.ts's
 * staging path and the deploy image's directory never drift apart.
 */
export const WORKSPACE_STATE_DIR_NAME = '.workspace-agent'

/**
 * Name of the clone-staging subdirectory under the state dir
 * (`/workspace/repos/.workspace-agent/staging`). A fresh clone lands here first — still
 * root-owned, on the same volume as the final destination so the publishing `rename` is atomic
 * — and is handed to AGENT_UID/AGENT_GID only after HEAD is resolved and validated, never
 * before. clone.ts creates it (mode `0700`) beneath the state dir if missing.
 */
export const CLONE_STAGING_DIR_NAME = 'staging'

/**
 * Name of the protected bare-repo "fetch store" subdirectory under the state dir
 * (`/workspace/repos/.workspace-agent/fetch`). Each repository's root-owned bare mirror lives at
 * `<fetch dir>/<owner>__<repo>.git` (checkout-update-recovery plan, Key Technical Decisions:
 * "Credentials only in a protected bare repository"). Created lazily on first update, root-owned,
 * never agent-traversable — credentials only ever touch a fetch running against this tree.
 */
export const FETCH_STORE_DIR_NAME = 'fetch'

/**
 * Name of the journal-store subdirectory under the state dir
 * (`/workspace/repos/.workspace-agent/journals`). Holds one journal file per repository with an
 * in-flight update or recovery mutation (journal.ts), written temp-file-and-rename. Root-owned
 * and never inside the checkout's own `.git/`, where the agent could forge one — see the plan's
 * "Journals live under .workspace-agent/journals/" decision.
 */
export const JOURNAL_DIR_NAME = 'journals'

/**
 * Name of the recovery-quarantine subdirectory under the state dir
 * (`/workspace/repos/.workspace-agent/quarantine`). A preserved checkout lands at
 * `<quarantine dir>/<owner>__<repo>/<recovery-id>/` (checkout-update-recovery plan, Key Technical
 * Decisions: "Recovery preserves the whole directory by rename"). Root-owned; only a completed
 * recovery's `installing` phase ever moves content out of it into an agent-owned checkout path.
 */
export const QUARANTINE_DIR_NAME = 'quarantine'

/**
 * Absolute path to the baked OpenCode executable inside the workspace image.
 * deploy/workspace.Dockerfile installs the release tarball via
 * `tar -xz -C /usr/local/bin -f "/tmp/${oc_asset}.tar.gz"`, so the binary always lands at
 * /usr/local/bin/opencode. Always used as an absolute path — never resolved through PATH — so a
 * PATH manipulation in the constructed child environment can never substitute a different binary
 * for the one actually spawned.
 */
export const OPENCODE_EXECUTABLE_PATH = '/usr/local/bin/opencode'
