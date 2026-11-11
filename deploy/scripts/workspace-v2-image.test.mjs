// Static checks on deploy/workspace.Dockerfile. Docker is not run here, so these pin what can be read from the files:
// the build refuses anything but the pinned V2 version before any download, the plugin versions match the constants the
// workspace agent expects, the plugins are installed at build time and never at boot, and the image carries the version
// the workspace agent starts on. Run with `node --test deploy/scripts/*.test.mjs`.
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
const imageVersion = read('apps/workspace-agent/src/opencode-generation.ts')
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

/** The `ARG OPENCODE_VERSION` lines of the Dockerfile: only the version gate reads the build argument. */
const opencodeVersionArgs = dockerfile.split('\n').filter(line => /^ARG OPENCODE_VERSION\b/.test(line))

/** The version-gate stage: its `FROM` line to the next `FROM`. */
const gateStage = /^FROM [^\n]* AS version-gate\n[\s\S]*?(?=^FROM )/m.exec(dockerfile)?.[0] ?? ''

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

test('the plugins are installed at build time by the bounded script, with exactly the two pinned specs', () => {
  // #given the RUN that installs them
  const run = /RUN sh \/usr\/local\/lib\/workspace-scripts\/install-opencode-v2-plugins\.sh[^\n]*\n(?:[^\n]*\\\n)*[^\n]*\n/.exec(
    dockerfile,
  )
  assert.ok(run, 'the plugin install RUN is missing')

  // #then
  assert.ok(run[0].includes('"@fro.bot/systematic@${SYSTEMATIC_VERSION}"'))
  assert.ok(run[0].includes('"@fro.bot/opencode-plugin@${FRO_BOT_PLUGIN_VERSION}"'))
})

test('the install runs after the agent account exists and after the binary is installed', () => {
  // #then
  const account = dockerfile.indexOf('adduser -D -H -u 10001')
  const binary = dockerfile.indexOf('opencode --version')
  const plugins = dockerfile.indexOf('RUN sh /usr/local/lib/workspace-scripts/install-opencode-v2-plugins.sh')
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

test('the image carries the version the workspace agent starts on, from the file the gate wrote', () => {
  // #then the gate records the resolved version in the one file every later stage and the entrypoint read
  assert.match(gateStage, /printf '%s' "\$\{resolved\}" > \/usr\/local\/share\/fro-bot\/opencode-version/)
  assert.match(dockerfile, /oc_version="\$\(cat \/usr\/local\/share\/fro-bot\/opencode-version\)"/)
  // and the entrypoint exports it under the name main.ts reads, so no image ENV can disagree with the binary
  const name = /export const IMAGE_OPENCODE_VERSION_ENV = '([^']+)'/.exec(imageVersion)?.[1]
  assert.ok(name, 'opencode-generation.ts has no IMAGE_OPENCODE_VERSION_ENV')
  assert.match(entrypoint, new RegExp(`^export ${name}$`, 'm'))
  assert.match(entrypoint, new RegExp(`${name}="\\$\\(cat /usr/local/share/fro-bot/opencode-version\\)"`))
  assert.doesNotMatch(dockerfile, new RegExp(`^ENV ${name}`, 'm'))
})

test('the image sets no OpenCode flag the V2 child does not receive', () => {
  // #then the child environment is an allowlist that forwards none of them, so an ENV here would only mislead
  assert.doesNotMatch(dockerfile, /OPENCODE_DISABLE_FILEWATCHER/)
  assert.doesNotMatch(dockerfile, /OPENCODE_EXPERIMENTAL_/)
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

test('the V2 managed config is baked to the managed config dir, root-owned and not agent-writable', () => {
  // #then
  assert.match(dockerfile, /^COPY deploy\/managed-config\/opencode-v2\.json \/etc\/opencode\/opencode\.json$/m)
  assert.match(dockerfile, /chown 0:0 \/etc\/opencode\/opencode\.json/)
  assert.match(dockerfile, /chmod 0644 \/etc\/opencode\/opencode\.json/)
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

test('OPENCODE_VERSION is optional: only the gate declares it, with no literal default, and it resolves to the pin', () => {
  // #then a literal default would be a second copy of the pin (packages/runtime/src/shared/opencode-v2-pin.json)
  assert.deepEqual(opencodeVersionArgs, ['ARG OPENCODE_VERSION'])
  assert.ok(gateStage.includes('ARG OPENCODE_VERSION'), 'the gate declares the argument')
  // unset and empty both mean the pin
  assert.match(gateStage, /resolved="\$\{OPENCODE_VERSION:-\$\{pin_version\}\}"/)
  // no later stage reads the raw argument
  assert.doesNotMatch(dockerfile.slice(dockerfile.indexOf('# ── Stage 1: build-deps')), /\$\{OPENCODE_VERSION\}/)
})

test('the compose workspace build reaches the gate: it passes no OPENCODE_VERSION, or the pin', () => {
  // #given the workspace service's build block in compose.yaml
  const compose = read('deploy/compose.yaml')
  const block = /^ {4}build:\n((?: {6,}.*\n|\n)*?)(?= {0,4}\S)/m
  const builds = [...compose.matchAll(new RegExp(block.source, 'gm'))].map(match => match[1])
  const workspaceBuild = builds.find(body => body.includes('deploy/workspace.Dockerfile'))
  assert.ok(workspaceBuild, 'compose.yaml has no workspace build using deploy/workspace.Dockerfile')

  // #then a value there must be the pin (the gate refuses any other), and an absent one defaults to it
  const pin = JSON.parse(read('packages/runtime/src/shared/opencode-v2-pin.json')).version
  const passed = /OPENCODE_VERSION[:=]\s*(\S+)/.exec(workspaceBuild)?.[1]
  if (passed !== undefined) assert.equal(passed.replace(/^["']|["']$/g, ''), pin)
  assert.doesNotMatch(workspaceBuild, /harness/)
})

test('every stage starts from the version gate, so a bad version fails before any download', () => {
  // #given the gate and every other stage's FROM
  const froms = [...dockerfile.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gm)].map(match => ({base: match[1], name: match[2]}))
  const gate = froms.find(from => from.name === 'version-gate')
  assert.ok(gate, 'the Dockerfile has no version-gate stage')

  // #then no stage reaches a registry image except through it
  for (const from of froms.filter(from => from.name !== 'version-gate')) {
    assert.ok(['version-gate', 'build-deps'].includes(from.base), `${from.name} starts from ${from.base}`)
  }
  for (const name of ['build-deps', 'opencode-v2', 'runtime']) {
    assert.equal(froms.find(from => from.name === name)?.base, 'version-gate', `${name} does not start from the gate`)
  }
})

test('the gate refuses a malformed, V1, harness or unpinned version and names the pin file', () => {
  // #then
  assert.doesNotMatch(gateStage, /is required/)
  assert.match(gateStage, /\*\[!0-9A-Za-z\.\+_-\]\*\) echo "OPENCODE_VERSION contains disallowed characters/)
  assert.match(gateStage, /\*harness\*\) echo/)
  assert.match(gateStage, /\[2-9\]\.\*\|\[1-9\]\[0-9\]\*\.\*\) : ;;/)
  assert.match(gateStage, /is not the pinned V2 version/)
  assert.ok(gateStage.includes('packages/runtime/src/shared/opencode-v2-pin.json'))
  // the pin is bind-mounted for the check, not copied into a layer every stage inherits
  assert.match(gateStage, /--mount=type=bind,source=packages\/runtime\/src\/shared\/opencode-v2-pin\.json/)
  assert.doesNotMatch(gateStage, /^COPY /m)
})

test('the retired V1 install paths are gone', () => {
  // #then
  assert.doesNotMatch(dockerfile, /fro-bot\/agent\/releases/)
  assert.doesNotMatch(dockerfile, /no-task-reuse|\/usr\/local\/lib\/fro-bot\/plugins/)
  assert.doesNotMatch(dockerfile, /"autoupdate": false/)
})

test('the entrypoint hands the agent-uid provisioner no secret and no auth.json flag', () => {
  // #then the one provisioning call takes the base, the stale auth.json path and the config path, with stdin closed
  assert.match(
    entrypoint,
    /provision-agent-config\.mjs" "\$BASE_CONFIG_PATH" "\$STALE_AUTH_PATH" "\$CONFIG_DEST" <\/dev\/null/,
  )
  assert.doesNotMatch(entrypoint, /AUTH_RAW|--no-auth-json|OPENCODE_V2/)
  assert.doesNotMatch(entrypoint, /printf '%s' .*\| setpriv/)
})
