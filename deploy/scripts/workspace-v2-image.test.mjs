// Static checks on the V2 branch of deploy/workspace.Dockerfile. Docker is not run here, so these pin what can be
// read from the files: the plugin versions match the constants the workspace agent expects, the plugins are
// installed at build time and never at boot, the V1 outputs are the ones V1 had, and the image carries the version the
// workspace agent selects on. Run with `node --test deploy/scripts/*.test.mjs`.
//
// What these cannot show, and the V2 image smoke test (deploy/scripts/v2-image-smoke.mjs) must: that the built image
// starts as uid 10001 with no network, loads both plugins, and passes the permission gate.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {test} from 'node:test'

const REPO = new URL('../../', import.meta.url)
const read = path => fs.readFileSync(new URL(path, REPO), 'utf8')

const dockerfile = read('deploy/workspace.Dockerfile')
const constants = read('packages/runtime/src/shared/constants.ts')
const generation = read('apps/workspace-agent/src/opencode-generation.ts')
const entrypoint = read('deploy/workspace-entrypoint.sh')
const managedV2 = JSON.parse(read('deploy/managed-config/opencode-v2.json'))

/** The value of `export const NAME = '<value>'` in constants.ts. */
function constant(name) {
  const match = new RegExp(`export const ${name} = '([^']+)'`).exec(constants)
  assert.ok(match, `constants.ts has no ${name}`)
  return match[1]
}

/** The default of `ARG NAME=<value>` in the Dockerfile. */
function argDefault(name) {
  const match = new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(dockerfile)
  assert.ok(match, `Dockerfile has no ARG ${name}`)
  return match[1]
}

const V2_VERSION_ARM = '[2-9].*|[1-9][0-9]*.*)'

test('the plugin versions the image installs are the ones the workspace agent expects', () => {
  // #then the build-time ARG defaults equal the runtime constants, so the specs the server is told to load are the
  // specs that were cached
  assert.equal(argDefault('SYSTEMATIC_VERSION'), constant('DEFAULT_SYSTEMATIC_VERSION'))
  assert.equal(argDefault('FRO_BOT_PLUGIN_VERSION'), constant('FRO_BOT_PLUGIN_VERSION'))
})

test('the plugin pins are exact versions, and V2 has no Systematic pin of its own', () => {
  // #then V1 and V2 share the one Systematic pin that Renovate manages
  assert.match(constant('DEFAULT_SYSTEMATIC_VERSION'), /^\d+\.\d+\.\d+$/)
  assert.match(constant('FRO_BOT_PLUGIN_VERSION'), /^\d+\.\d+\.\d+$/)
  assert.doesNotMatch(constants, /SYSTEMATIC_V2_VERSION/)
  assert.doesNotMatch(dockerfile, /SYSTEMATIC_V2_VERSION/)
})

test('the plugins are installed at build time by the bounded script, behind the V2 version test', () => {
  // #given the RUN that installs them
  const run = /RUN set -euo pipefail[^\n]*\n(?:[^\n]*\\\n)*?[^\n]*install-opencode-v2-plugins\.sh[^\n]*\n(?:[^\n]*\\\n)*[^\n]*\n/.exec(
    dockerfile,
  )
  assert.ok(run, 'the plugin install RUN is missing')

  // #then it is skipped for harness and V1 builds, and passes exactly the two pinned specs
  assert.match(run[0], /\*harness\*\) exit 0/)
  assert.ok(run[0].includes(V2_VERSION_ARM))
  assert.ok(run[0].includes('"@fro.bot/systematic@${SYSTEMATIC_VERSION}"'))
  assert.ok(run[0].includes('"@fro.bot/opencode-plugin@${FRO_BOT_PLUGIN_VERSION}"'))
})

test('the install runs after the agent account exists and after the binary is installed', () => {
  // #then
  const account = dockerfile.indexOf('adduser -D -H -u 10001')
  const binary = dockerfile.indexOf('opencode --version')
  const plugins = dockerfile.indexOf('&& sh /usr/local/lib/workspace-scripts/install-opencode-v2-plugins.sh')
  assert.ok(account > 0 && binary > 0 && plugins > 0)
  assert.ok(account < plugins, 'plugins install before the agent account exists')
  assert.ok(binary < plugins, 'plugins install before the binary')
})

test('nothing installs a plugin at boot', () => {
  // #then the entrypoint and the workspace agent never run `plugin add` or an npm install
  assert.doesNotMatch(entrypoint, /plugin add|npm install|bun add/)
  const supervisor = read('apps/workspace-agent/src/opencode-server-v2.ts')
  assert.doesNotMatch(supervisor, /plugin add|'install'|"install"/)
})

test('the image carries the version the workspace agent selects on, from the same build argument as the binary', () => {
  // #then the ENV name is the one main.ts reads, and its value is the OPENCODE_VERSION that chose the binary
  const name = /export const IMAGE_OPENCODE_VERSION_ENV = '([^']+)'/.exec(generation)?.[1]
  assert.ok(name, 'opencode-generation.ts has no IMAGE_OPENCODE_VERSION_ENV')
  assert.match(dockerfile, new RegExp(`^ENV ${name}=\\$\\{OPENCODE_VERSION\\}$`, 'm'))
})

test('the image leaves the V2 file watcher at its default and keeps the V1 flags the V1 child still gets', () => {
  // #then
  assert.doesNotMatch(dockerfile, /OPENCODE_DISABLE_FILEWATCHER/)
  assert.match(dockerfile, /^ENV OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true$/m)
  assert.match(dockerfile, /^ENV OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true$/m)
})

test('the V1 base config is still written exactly as before for V1 and harness builds', () => {
  // #then the V1 printf, with the V1 key and the V1 Systematic version, is the non-V2 arm
  assert.ok(
    dockerfile.includes(
      `printf '{\\n  "$schema": "https://opencode.ai/config.json",\\n  "autoupdate": false,\\n  "plugin": ["@fro.bot/systematic@%s"]\\n}\\n' "\${SYSTEMATIC_VERSION}"`,
    ),
  )
})

test('the V2 base and managed configs carry no plugin entry: the plugins load from the config content', () => {
  // #then V2's plugin key is `plugins` and lives in the content; neither root-owned file lists one
  assert.deepEqual(Object.keys(managedV2).sort(), ['$schema', 'update'])
  assert.equal(managedV2.update, 'disable')
  assert.ok(
    dockerfile.includes(
      `printf '{\\n  "$schema": "https://opencode.ai/config.json",\\n  "update": "disable"\\n}\\n'`,
    ),
  )
})

test('the V2 managed config is selected only for V2 and is root-owned and not agent-writable', () => {
  // #then
  assert.match(dockerfile, /COPY deploy\/managed-config\/opencode-v2\.json \/usr\/local\/share\/fro-bot\/opencode-managed\.v2\.json/)
  assert.match(dockerfile, /cp \/usr\/local\/share\/fro-bot\/opencode-managed\.v2\.json \/etc\/opencode\/opencode\.json/)
  assert.match(
    dockerfile,
    /chown 0:0 \/usr\/local\/share\/fro-bot\/opencode-managed\.v2\.json \/etc\/opencode\/opencode\.json/,
  )
  assert.match(
    dockerfile,
    /chmod 0644 \/usr\/local\/share\/fro-bot\/opencode-managed\.v2\.json \/etc\/opencode\/opencode\.json/,
  )
})

test('every version test in the runtime stage and the V2 stage uses the same V2 arm', () => {
  // #then a drifted pattern would send one step down the V1 path and another down the V2 path
  const arms = dockerfile.split(V2_VERSION_ARM).length - 1
  assert.ok(arms >= 5, `expected the V2 arm in at least five version tests, found ${arms}`)
})

test('the build stage has the runtime source the V2 runner is bundled from', () => {
  // #then
  assert.match(dockerfile, /^COPY packages\/runtime\/ packages\/runtime\/$/m)
})

test('the workspace agent expects the same plugin ids the V2 image is smoke-tested for', () => {
  // #then
  assert.equal(constant('SYSTEMATIC_V2_PLUGIN_ID'), 'systematic')
  assert.equal(constant('FRO_BOT_PLUGIN_ID'), 'fro-bot.opencode-plugin')
})
