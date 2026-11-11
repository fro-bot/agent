// Tests for the root-owned managed OpenCode config baked into the workspace image
// (deploy/managed-config/opencode-v2.json + deploy/workspace.Dockerfile). Run with
// `node --test deploy/scripts/*.test.mjs`.
//
// The agent uid can edit its own merged config (/home/opencode/.config/opencode/opencode.json, written by
// merge-config.mjs), so nothing is enforced there. OpenCode loads /etc/opencode/opencode.json (the Linux managed
// config dir) LAST, so a root-owned file at that path is a layer the agent can add to but never remove from.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {test} from 'node:test'

const REPO = new URL('../../', import.meta.url)
const MANAGED_CONFIG_SRC = 'deploy/managed-config/opencode-v2.json'
/** OpenCode's Linux managed config dir (packages/opencode/src/config/managed.ts: systemManagedConfigDir). */
const MANAGED_CONFIG_DEST = '/etc/opencode/opencode.json'
const MANAGED_CONFIG_DIR = '/etc/opencode'

const dockerfile = fs.readFileSync(new URL('deploy/workspace.Dockerfile', REPO), 'utf8')
const managed = JSON.parse(fs.readFileSync(new URL(MANAGED_CONFIG_SRC, REPO), 'utf8'))

/** Destination of `COPY <src> <dest>` in the Dockerfile, or null. */
function copyDestination(src) {
  const match = new RegExp(`^COPY\\s+${src.replaceAll('.', '\\.')}\\s+(\\S+)\\s*$`, 'm').exec(dockerfile)
  return match?.[1] ?? null
}

test('the managed config only disables updates', () => {
  // #then it carries no plugin: the plugins load from the config content the workspace agent passes at spawn
  assert.deepEqual(Object.keys(managed).sort(), ['$schema', 'update'])
  assert.equal(managed.update, 'disable')
})

test('the managed config is baked to the managed config dir OpenCode reads last', () => {
  // #then the Dockerfile copies it to /etc/opencode/opencode.json
  assert.equal(copyDestination(MANAGED_CONFIG_SRC), MANAGED_CONFIG_DEST)
})

test('the managed config and its directory are root-owned and not agent-writable', () => {
  // #then the baked file does not live under the agent's home
  assert.ok(!MANAGED_CONFIG_DEST.startsWith('/home/opencode'), `${MANAGED_CONFIG_DEST} is under the agent home`)

  // #then the file is chowned to 0:0 and chmodded 0644, the directory to 0:0 and 0755 — with no agent uid
  assert.match(dockerfile, new RegExp(`chown 0:0 ${MANAGED_CONFIG_DEST.replaceAll('.', '\\.')}`))
  assert.match(dockerfile, new RegExp(`chmod 0644 ${MANAGED_CONFIG_DEST.replaceAll('.', '\\.')}`))
  assert.match(dockerfile, new RegExp(`chown 0:0 ${MANAGED_CONFIG_DIR}\\b`))
  assert.match(dockerfile, new RegExp(`chmod 0755 ${MANAGED_CONFIG_DIR}\\b`))
})
