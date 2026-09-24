/**
 * Shared git invocation-safety primitives for running git against an EXISTING checkout as the
 * unprivileged AGENT_UID/AGENT_GID identity — never as the root-owned service, and never with
 * credentials.
 *
 * Originally lived only in inspect.ts (the read-only `/inspect` handler). clone.ts's
 * `repo-exists` idempotency check and its post-rename race-check validation both run git
 * against a checkout the AGENT_UID identity already owns (or is about to), so they reuse the
 * exact same neutralized invocation shape rather than a hand-duplicated approximation of it —
 * see clone.ts for how it's wired through the shared `runGit` runner (inspect.ts).
 */

import process from 'node:process'

import {AGENT_HOME} from './identity.js'

/**
 * Global git safety flags applied to every neutralized invocation. Byte-identical to the set
 * inspect.ts originally defined for itself, so moving a caller onto this shared list changes
 * nothing about what it already ran with.
 *
 * - `--no-optional-locks`: makes `git status` skip the opportunistic write of the refreshed
 *   stat-cache back to `.git/index` (the specific mechanism that keeps `status` read-only). A
 *   no-op for the rev-parse-only calls clone.ts makes, kept here anyway so this list stays one
 *   copy shared by every caller instead of two lists that quietly drift apart.
 * - `--no-pager`: git never spawns `core.pager` for our non-interactive output.
 * - `-c core.fsmonitor=false`: neutralizes an agent-writable `.git/config` that could otherwise
 *   configure `core.fsmonitor` to execute an arbitrary command.
 * - `-c core.hooksPath=/dev/null`: points hook lookup at a location that can never contain
 *   executable hook scripts, defense-in-depth against a config-injected hooks path.
 * - `-c core.pager=cat`: defense-in-depth alongside `--no-pager`.
 * - `-c credential.helper=`: disables any operator-side credential helper; these invocations
 *   never need credentials and must never be handed any.
 */
export const GIT_SAFETY_ARGS: readonly string[] = [
  '--no-optional-locks',
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
  '-c',
  'credential.helper=',
]

/**
 * `-c safe.directory=` followed by `-c safe.directory=<canonicalPath>`: the FIRST entry resets
 * any `safe.directory` exceptions a repo's own (agent-writable) config might otherwise
 * contribute (confirmed against real git 2.55.0 that an empty `safe.directory` value clears
 * prior entries rather than adding one), and the SECOND grants exactly the canonical checkout
 * path, never `*` (which would trust every path) and never a parent path (which would also trust
 * sibling checkouts). Command-line `-c` config is honored for `safe.directory`; a repo's own
 * `.git/config` is NOT (confirmed against real git 2.55.0), which is exactly why this must be
 * passed as `-c` here rather than relying on anything committed inside the checkout. Required
 * once the checkout is owned by AGENT_UID and git also runs as AGENT_UID; kept unconditionally
 * (including for a same-uid caller) because a migration period can leave a checkout still owned
 * by the service uid while git already runs as AGENT_UID, or vice versa.
 */
export function safeDirectoryArgs(canonicalPath: string): readonly string[] {
  return ['-c', 'safe.directory=', '-c', `safe.directory=${canonicalPath}`]
}

/** Builds a full, safety-neutralized git invocation: `-C cwd` + safety flags + safe.directory + subArgs. */
export function gitInvocation(cwd: string, canonicalPath: string, subArgs: readonly string[]): readonly string[] {
  return ['-C', cwd, ...GIT_SAFETY_ARGS, ...safeDirectoryArgs(canonicalPath), ...subArgs]
}

/**
 * Minimal, credential-free git subprocess environment for a neutralized invocation. Deliberately
 * does NOT include GITHUB_TOKEN or proxy variables — these invocations are local-only and need
 * no network access.
 *
 * GIT_CONFIG_NOSYSTEM and GIT_CONFIG_GLOBAL=/dev/null disable the system and global config
 * levels entirely (HOME is fixed to AGENT_HOME rather than inherited from the calling process,
 * since the global config lookup git would otherwise perform there is disabled anyway, and the
 * caller may still be the root-owned service during a migration period).
 */
export function buildNeutralGitEnv(): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_TRACE: '0',
    GIT_TRACE_PACKET: '0',
    GIT_TRACE_PERFORMANCE: '0',
    GIT_CURL_VERBOSE: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: AGENT_HOME,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
  }
}
