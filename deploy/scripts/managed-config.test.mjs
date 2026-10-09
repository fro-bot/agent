// Tests for the root-owned managed OpenCode config layer that loads the reuse-guard plugin
// (deploy/managed-config/opencode.json + deploy/workspace.Dockerfile). Run with
// `node --test deploy/scripts/*.test.mjs`.
//
// The agent uid can edit its own merged config (/home/opencode/.config/opencode/opencode.json, written by
// merge-config.mjs), so the guard is NOT enforced there. OpenCode loads /etc/opencode/opencode.json (Linux
// managed config dir) LAST and concatenates plugin arrays, so a root-owned file at that path is a layer the agent
// can add to but never remove from.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const REPO = new URL('../../', import.meta.url)
const MANAGED_CONFIG_SRC = 'deploy/managed-config/opencode.json'
const PLUGIN_SRC = 'deploy/plugins/no-task-reuse.mjs'
/** OpenCode's Linux managed config dir (packages/opencode/src/config/managed.ts: systemManagedConfigDir). */
const MANAGED_CONFIG_DEST = '/etc/opencode/opencode.json'

const dockerfile = fs.readFileSync(new URL('deploy/workspace.Dockerfile', REPO), 'utf8')
const managed = JSON.parse(fs.readFileSync(new URL(MANAGED_CONFIG_SRC, REPO), 'utf8'))

/** Destination of `COPY <src> <dest>` in the Dockerfile, or null. */
function copyDestination(src) {
  const match = new RegExp(`^COPY\\s+${src.replaceAll('.', '\\.')}\\s+(\\S+)\\s*$`, 'm').exec(dockerfile)
  return match?.[1] ?? null
}

test('the managed config declares exactly the reuse-guard plugin', () => {
  // #given the managed config the image bakes
  // #then its only functional key is a one-entry plugin array of file:// URLs
  assert.deepEqual(Object.keys(managed).sort(), ['$schema', 'plugin'])
  assert.equal(managed.plugin.length, 1)
  assert.ok(managed.plugin[0].startsWith('file:///'), 'plugin must be an absolute file:// URL')
})

test('the plugin path in the managed config is the file the Dockerfile bakes', () => {
  // #given the plugin source and its COPY destination
  const dest = copyDestination(PLUGIN_SRC)
  assert.ok(dest, `Dockerfile has no COPY for ${PLUGIN_SRC}`)

  // #then the managed config points at exactly that path
  assert.equal(fileURLToPath(managed.plugin[0]), dest)
  assert.ok(fs.existsSync(new URL(PLUGIN_SRC, REPO)), 'plugin source missing')
})

test('the managed config is baked to the managed config dir OpenCode reads last', () => {
  // #then the Dockerfile copies it to /etc/opencode/opencode.json
  assert.equal(copyDestination(MANAGED_CONFIG_SRC), MANAGED_CONFIG_DEST)
})

test('the plugin, the managed config, and their directories are root-owned and not agent-writable', () => {
  const dest = copyDestination(PLUGIN_SRC)
  assert.ok(dest)

  // #then neither baked file lives under the agent's home
  for (const path of [dest, MANAGED_CONFIG_DEST]) {
    assert.ok(!path.startsWith('/home/opencode'), `${path} is under the agent home`)
  }

  // #then every file is chowned to 0:0 and chmodded 0644, every directory to 0:0 and 0755 — with no agent uid
  assert.match(
    dockerfile,
    new RegExp(`chown 0:0 ${dest.replaceAll('.', '\\.')} ${MANAGED_CONFIG_DEST.replaceAll('.', '\\.')}`),
  )
  assert.match(
    dockerfile,
    new RegExp(`chmod 0644 ${dest.replaceAll('.', '\\.')} ${MANAGED_CONFIG_DEST.replaceAll('.', '\\.')}`),
  )
  assert.match(dockerfile, /chown 0:0 \/usr\/local\/lib\/fro-bot \/usr\/local\/lib\/fro-bot\/plugins \/etc\/opencode/)
  assert.match(dockerfile, /chmod 0755 \/usr\/local\/lib\/fro-bot \/usr\/local\/lib\/fro-bot\/plugins \/etc\/opencode/)
})
