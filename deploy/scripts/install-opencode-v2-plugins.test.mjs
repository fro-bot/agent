// Tests for deploy/scripts/install-opencode-v2-plugins.sh, the image-build step that puts the V2 plugins in the
// agent's cache so nothing installs at boot. Run with `node --test deploy/scripts/*.test.mjs`.
//
// The real `opencode` and `setpriv` are not available here, so the script's seams are used: OPENCODE_BIN points at a
// recording stand-in, DROP_PRIVILEGES is empty, and a `timeout` shim on PATH records the bound it was given and then
// runs the command. What is pinned is the script's own contract: exact specs only, the bound, a scrubbed environment,
// fail-closed on any failure, and a cache that must exist afterwards.

import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

const SCRIPT = fileURLToPath(new URL('./install-opencode-v2-plugins.sh', import.meta.url))
const SYSTEMATIC = '@fro.bot/systematic@3.27.1'
const FRO_BOT = '@fro.bot/opencode-plugin@0.1.0'

/**
 * Builds a sandbox: a fake agent home, a fake `opencode` that records its call and (unless told to fail) installs the
 * spec into the cache the way the real one does, and a `timeout` shim.
 */
function sandbox({failOn, skipInstall} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-plugins-'))
  const home = path.join(root, 'home')
  const bin = path.join(root, 'bin')
  fs.mkdirSync(path.join(home, '.config', 'opencode'), {recursive: true})
  fs.mkdirSync(bin)
  const log = path.join(root, 'calls.log')

  const fakeOpencode = path.join(bin, 'opencode')
  fs.writeFileSync(
    fakeOpencode,
    `#!/bin/sh
{
  echo "args: $*"
  echo "env: HOME=$HOME XDG_CACHE_HOME=$XDG_CACHE_HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME"
  echo "leaked: \${LEAKED_SECRET:-none}"
} >> "${log}"
[ "$1" = plugin ] && [ "$2" = add ] || exit 64
spec="$3"
if [ "$spec" = "${failOn ?? ''}" ]; then echo "install failed" >&2; exit 1; fi
${skipInstall === true ? ': # a command that exits 0 without installing anything' : `mkdir -p "$XDG_CACHE_HOME/opencode/npm/$spec/1700000000000/node_modules"`}
printf '{"plugins":["%s"]}' "$spec" > "$XDG_CONFIG_HOME/opencode/opencode.json"
`,
    {mode: 0o755},
  )

  fs.writeFileSync(
    path.join(bin, 'timeout'),
    `#!/bin/sh
echo "timeout: $1 $2 $3" >> "${log}"
shift 3
exec "$@"
`,
    {mode: 0o755},
  )

  return {
    root,
    home,
    log,
    fakeOpencode,
    run(args, env = {}) {
      return spawnSync('/bin/sh', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          INSTALL_PATH: `${bin}:${process.env.PATH}`,
          OPENCODE_BIN: fakeOpencode,
          AGENT_HOME: home,
          DROP_PRIVILEGES: '',
          LEAKED_SECRET: 'must-not-reach-the-install',
          ...env,
        },
      })
    },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''),
  }
}

test('installs each pinned spec with `plugin add`, in the order given, under a bound', () => {
  // #given
  const box = sandbox()

  // #when
  const result = box.run([SYSTEMATIC, FRO_BOT])

  // #then
  assert.equal(result.status, 0, result.stderr)
  const calls = box.calls()
  assert.ok(calls.indexOf(`args: plugin add ${SYSTEMATIC}`) < calls.indexOf(`args: plugin add ${FRO_BOT}`))
  assert.equal([...calls.matchAll(/^timeout: -s KILL 300$/gm)].length, 2, 'every install runs under `timeout -s KILL 300`')
})

test('runs the install with a scrubbed environment rooted at the agent home', () => {
  // #given a build environment holding something that must not reach the install
  const box = sandbox()

  // #when
  const result = box.run([SYSTEMATIC])

  // #then HOME and the XDG roots are the agent's, and nothing else from the caller came along
  assert.equal(result.status, 0, result.stderr)
  const calls = box.calls()
  assert.match(calls, new RegExp(`HOME=${box.home.replaceAll('/', '\\/')} `))
  assert.match(calls, new RegExp(`XDG_CACHE_HOME=${box.home.replaceAll('/', '\\/')}/\\.cache`))
  assert.match(calls, /leaked: none/)
})

test('honours a different bound', () => {
  // #given
  const box = sandbox()

  // #when
  const result = box.run([SYSTEMATIC], {INSTALL_TIMEOUT_SECONDS: '45'})

  // #then
  assert.equal(result.status, 0, result.stderr)
  assert.match(box.calls(), /^timeout: -s KILL 45$/m)
})

test('refuses a bound that is not a number, before anything is installed', () => {
  // #given
  const box = sandbox()

  // #when
  const result = box.run([SYSTEMATIC], {INSTALL_TIMEOUT_SECONDS: '5; rm -rf /'})

  // #then
  assert.notEqual(result.status, 0)
  assert.equal(box.calls(), '')
})

for (const spec of [
  '@fro.bot/systematic@latest',
  '@fro.bot/systematic@^3.27.1',
  '@fro.bot/systematic@3',
  '@fro.bot/systematic',
  '@fro.bot/opencode-plugin@>=0.1.0',
  '@evil/plugin@1.0.0',
  'git+https://example.com/x.git',
  '/tmp/local-plugin',
  '@fro.bot/systematic@3.27.1; touch /tmp/pwned',
]) {
  test(`refuses ${JSON.stringify(spec)}: only the two fro.bot packages at an exact version`, () => {
    // #given
    const box = sandbox()

    // #when
    const result = box.run([spec])

    // #then nothing ran
    assert.notEqual(result.status, 0)
    assert.equal(box.calls(), '')
  })
}

test('refuses to run with no specs', () => {
  // #then an empty invocation must not look like a successful install
  const box = sandbox()
  assert.notEqual(box.run([]).status, 0)
})

test('stops at the first failed install and fails the build', () => {
  // #given the first install fails
  const box = sandbox({failOn: SYSTEMATIC})

  // #when
  const result = box.run([SYSTEMATIC, FRO_BOT])

  // #then the second install never started, and the build fails
  assert.notEqual(result.status, 0)
  assert.doesNotMatch(box.calls(), new RegExp(`plugin add ${FRO_BOT.replaceAll('/', '\\/')}`))
})

test('fails when an install exits 0 but the cache holds nothing for the spec', () => {
  // #given an install that claims success and installs nothing
  const box = sandbox({skipInstall: true})

  // #when
  const result = box.run([SYSTEMATIC])

  // #then a silent no-op would ship an image that installs at boot, so it fails the build
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not in the cache/)
})

test('removes the global config that `plugin add` wrote, so the entrypoint owns that file', () => {
  // #given
  const box = sandbox()

  // #when
  const result = box.run([SYSTEMATIC, FRO_BOT])

  // #then plugins load from the config content, and the entrypoint writes the only global config
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.existsSync(path.join(box.home, '.config', 'opencode', 'opencode.json')), false)
})

test('uses setpriv to drop to the agent uid and gid by default', () => {
  // #given the script text, because setpriv is not available to run here
  const source = fs.readFileSync(SCRIPT, 'utf8')

  // #then the default privilege drop is the numeric agent identity, with supplementary groups cleared
  assert.match(source, /setpriv --reuid=10001 --regid=10001 --clear-groups/)
})
