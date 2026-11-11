// provision-agent-config.mjs — Writes OpenCode's merged opencode.json and removes a stale auth.json, AS THE AGENT
// UID. Pure ESM, no build step. Used by workspace-entrypoint.sh, invoked via
// `setpriv --reuid=10001 --regid=10001 --clear-groups` (never as root).
//
// Why this runs as the agent and not root: both paths live under /home/opencode, which the agent uid owns and can
// write to freely. If ROOT wrote there instead, a symlink the agent planted at either path (or at merge-config's
// old write-then-rename temp path) would turn a privileged root write into an arbitrary-path write — a classic
// TOCTOU/symlink privilege-escalation. Running the write as 10001 closes that class entirely: the agent can only
// ever redirect a write into somewhere it could already write as itself.
//
// OpenCode V2 never reads auth.json: each spawn starts on a fresh database, and the workspace agent's supervisor (root)
// provisions the provider keys from the root-only secret over loopback. So nothing here receives or writes the
// credential. WORKSPACE_OPENCODE_CONFIG / WORKSPACE_OPENCODE_MODEL are non-secret operator config (see
// deploy/compose.yaml) and are read from the inherited environment.

import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

import {mergeConfig} from './merge-config.mjs'

/**
 * @param {object} opts
 * @param {string} opts.baseConfigPath - world-readable baked base config
 * @param {string} opts.staleAuthPath - a plaintext auth.json an earlier run may have left under the agent home; removed
 * @param {string} opts.configDestPath - destination for opencode.json
 * @param {string} opts.overlayRaw - WORKSPACE_OPENCODE_CONFIG value
 * @param {string} opts.modelRaw - WORKSPACE_OPENCODE_MODEL value
 * @returns {Promise<{ok: true, warnings: string[]} | {ok: false, error: string}>}
 */
export async function provisionAgentConfig(opts) {
  const {baseConfigPath, staleAuthPath, configDestPath, overlayRaw, modelRaw} = opts

  // A copy left by an earlier run is a second plaintext key at rest, so it goes.
  try {
    await rm(staleAuthPath, {force: true})
  } catch (error) {
    return {ok: false, error: `cannot remove stale auth.json: ${error.message}`}
  }

  let base
  try {
    base = JSON.parse(await readFile(baseConfigPath, 'utf8'))
  } catch (error) {
    return {ok: false, error: `cannot read base opencode config: ${error.message}`}
  }

  const merged = mergeConfig(base, overlayRaw, modelRaw)
  if (merged.ok === false) {
    return {ok: false, error: merged.error}
  }

  await mkdir(dirname(configDestPath), {recursive: true, mode: 0o700})
  await writeFile(configDestPath, `${JSON.stringify(merged.config, null, 2)}\n`, {mode: 0o644})

  return {ok: true, warnings: merged.warnings}
}

// CLI main guard:
//   node provision-agent-config.mjs <baseConfigPath> <staleAuthPath> <configDestPath>
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , baseConfigPath, staleAuthPath, configDestPath, ...extra] = process.argv
  if (!baseConfigPath || !staleAuthPath || !configDestPath || extra.length > 0) {
    process.stderr.write('usage: provision-agent-config.mjs <baseConfigPath> <staleAuthPath> <configDestPath>\n')
    process.exit(2)
  }

  const modelRaw = process.env.WORKSPACE_OPENCODE_MODEL ?? ''
  const overlayRaw = process.env.WORKSPACE_OPENCODE_CONFIG ?? ''

  const result = await provisionAgentConfig({baseConfigPath, staleAuthPath, configDestPath, overlayRaw, modelRaw})

  if (result.ok === false) {
    process.stderr.write(`${result.error}\n`)
    process.exit(2)
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`)
  }
  // What this checked: WORKSPACE_OPENCODE_CONFIG was a non-empty string and was merged into the on-disk opencode.json.
  // It says nothing about whether the server loaded a provider from it or holds a credential for it (fro-bot/agent#1992
  // went unnoticed behind the old wording, `applied`). The credential gate in the supervisor answers that.
  process.stderr.write(
    `workspace-entrypoint: opencode config: model=${modelRaw.trim() !== '' ? 'set' : 'default'}, ` +
      `provider-overlay=${overlayRaw.trim() !== '' ? 'merged-into-config-file' : 'none'}\n`,
  )
  process.exit(0)
}
