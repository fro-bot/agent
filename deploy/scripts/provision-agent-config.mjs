// provision-agent-config.mjs — Writes OpenCode's auth.json and merged
// opencode.json AS THE AGENT UID. Pure ESM, no build step. Used by
// workspace-entrypoint.sh, invoked via `setpriv --reuid=10001 --regid=10001
// --clear-groups` (never as root).
//
// Why this runs as the agent and not root: both destination files live under
// /home/opencode, which the agent uid owns and can write to freely. If ROOT
// wrote there instead, a symlink the agent planted at either destination path
// (or at merge-config's old write-then-rename temp path) would turn a
// privileged root write into an arbitrary-path write — a classic
// TOCTOU/symlink privilege-escalation. Running the write as 10001 closes that
// class entirely: the agent can only ever redirect a write into somewhere it
// could already write as itself.
//
// The auth secret (bearer credential) is read from stdin, never argv — argv
// is visible to every user on the host via /proc/<pid>/cmdline equivalents
// and process listings; stdin is not. WORKSPACE_OPENCODE_CONFIG /
// WORKSPACE_OPENCODE_MODEL are non-secret operator config (see
// deploy/compose.yaml) and are read from the inherited environment as before.

import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import process from 'node:process'

import {mergeConfig} from './merge-config.mjs'
import {validateAuth} from './validate-auth.mjs'

/**
 * @param {object} opts
 * @param {string} opts.baseConfigPath - world-readable baked base config
 * @param {string} opts.authDestPath - destination for auth.json (0600)
 * @param {string} opts.configDestPath - destination for opencode.json
 * @param {string} opts.authRaw - compact auth JSON, or '' if none provisioned
 * @param {string} opts.overlayRaw - WORKSPACE_OPENCODE_CONFIG value
 * @param {string} opts.modelRaw - WORKSPACE_OPENCODE_MODEL value
 * @returns {Promise<{ok: true, authProvisioned: boolean, warnings: string[]} | {ok: false, error: string}>}
 */
export async function provisionAgentConfig(opts) {
  const {baseConfigPath, authDestPath, configDestPath, authRaw, overlayRaw, modelRaw} = opts

  let authProvisioned = false
  if (authRaw !== '') {
    const authCheck = validateAuth(authRaw)
    if (authCheck.ok === false) {
      return {ok: false, error: `auth secret is present but invalid: ${authCheck.error}`}
    }
    await mkdir(dirname(authDestPath), {recursive: true, mode: 0o700})
    await writeFile(authDestPath, authRaw, {mode: 0o600})
    authProvisioned = true
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

  return {ok: true, authProvisioned, warnings: merged.warnings}
}

// CLI main guard:
//   node provision-agent-config.mjs <baseConfigPath> <authDestPath> <configDestPath>
// Reads the auth secret (compact JSON, or empty) from stdin.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , baseConfigPath, authDestPath, configDestPath] = process.argv
  if (!baseConfigPath || !authDestPath || !configDestPath) {
    process.stderr.write(
      'usage: provision-agent-config.mjs <baseConfigPath> <authDestPath> <configDestPath> (auth secret on stdin)\n',
    )
    process.exit(2)
  }

  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const authRaw = Buffer.concat(chunks).toString('utf8').trim()

  const modelRaw = process.env.WORKSPACE_OPENCODE_MODEL ?? ''
  const overlayRaw = process.env.WORKSPACE_OPENCODE_CONFIG ?? ''

  const result = await provisionAgentConfig({
    baseConfigPath,
    authDestPath,
    configDestPath,
    authRaw,
    overlayRaw,
    modelRaw,
  })

  if (result.ok === false) {
    process.stderr.write(`${result.error}\n`)
    process.exit(2)
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`)
  }
  // Wording mirrors the pre-uid-isolation entrypoint's log lines so existing
  // log-grepping (CI smoke tests, operator dashboards) keeps working.
  if (result.authProvisioned) {
    process.stderr.write('workspace-entrypoint: auth: provisioned\n')
  }
  process.stderr.write(
    `workspace-entrypoint: opencode config: model=${modelRaw.trim() !== '' ? 'set' : 'default'}, ` +
      `provider-overlay=${overlayRaw.trim() !== '' ? 'applied' : 'none'}\n`,
  )
  process.exit(0)
}
