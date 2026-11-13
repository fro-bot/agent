// Tests for the pure part of deploy/scripts/v2-image-smoke.mjs. The rest of that script needs the built image.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {fileURLToPath} from 'node:url'

import {EXPECTED_PLUGIN_IDS, findInactivePlugins} from './v2-image-smoke.mjs'

const active = id => ({id, source: {type: 'package'}, state: {status: 'active'}})

test('reports nothing when every expected plugin is active', () => {
  assert.deepEqual(findInactivePlugins({data: EXPECTED_PLUGIN_IDS.map(active)}, EXPECTED_PLUGIN_IDS), [])
})

test('names a plugin that is listed failed, and one that is not listed at all', () => {
  const body = {data: [active('systematic'), {id: 'fro-bot.opencode-plugin', state: {status: 'failed', error: 'x'}}]}
  assert.deepEqual(findInactivePlugins(body, EXPECTED_PLUGIN_IDS), ['fro-bot.opencode-plugin'])
  assert.deepEqual(findInactivePlugins({data: [active('systematic')]}, EXPECTED_PLUGIN_IDS), ['fro-bot.opencode-plugin'])
})

test('does not count an entry without an id, or another plugin being active', () => {
  const body = {data: [{state: {status: 'active'}}, active('opencode.agent')]}
  assert.deepEqual(findInactivePlugins(body, EXPECTED_PLUGIN_IDS), EXPECTED_PLUGIN_IDS)
})

test('treats an unreadable body as nothing active', () => {
  assert.deepEqual(findInactivePlugins(undefined, EXPECTED_PLUGIN_IDS), EXPECTED_PLUGIN_IDS)
  assert.deepEqual(findInactivePlugins({data: 'nope'}, EXPECTED_PLUGIN_IDS), EXPECTED_PLUGIN_IDS)
})

test('expects the same ids the workspace agent gates on', () => {
  // #then the smoke test and the supervisor cannot drift apart
  const constants = fs.readFileSync(new URL('../../packages/runtime/src/shared/constants.ts', import.meta.url), 'utf8')
  const id = name => new RegExp(`export const ${name} = '([^']+)'`).exec(constants)?.[1]
  assert.deepEqual(EXPECTED_PLUGIN_IDS, [id('SYSTEMATIC_V2_PLUGIN_ID'), id('FRO_BOT_PLUGIN_ID')])
})

// A stand-in for `opencode serve --stdio` (the script's OPENCODE_BIN seam). It models V2.2.7: `/api/agent` answers 200 at
// once, and `/api/plugin` lists `data: []` until PLUGIN_DELAY_MS after the listen, then both expected plugins, active.
const FAKE_OPENCODE = String.raw`#!/usr/bin/env node
const http = require('node:http')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
// The script hands its child a fixed environment, so the delay travels in a file beside the binary.
const delay = Number(require('node:fs').readFileSync(__dirname + '/plugin-delay-ms', 'utf8'))
const startedAt = Date.now()
const ids = ['systematic', 'fro-bot.opencode-plugin']
const server = http.createServer((req, res) => {
  const body = req.url === '/api/plugin'
    ? {data: Date.now() - startedAt < delay ? [] : ids.map(id => ({id, state: {status: 'active'}}))}
    : {data: []}
  res.writeHead(200, {'content-type': 'application/json'})
  res.end(JSON.stringify(body))
})
server.listen(port, '127.0.0.1')
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
`

const scriptPath = fileURLToPath(new URL('./v2-image-smoke.mjs', import.meta.url))

async function runSmoke({pluginDelayMs, boundMs}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-image-smoke-'))
  try {
    const binary = path.join(dir, 'opencode')
    fs.writeFileSync(binary, FAKE_OPENCODE, {mode: 0o755})
    fs.writeFileSync(path.join(dir, 'plugin-delay-ms'), String(pluginDelayMs))
    const child = spawn(process.execPath, [scriptPath, 'a@1.0.0', 'b@1.0.0'], {
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        OPENCODE_BIN: binary,
        SMOKE_EXPECT_UID: String(process.getuid()),
        SMOKE_PORT: String(40_000 + Math.floor(Math.random() * 20_000)),
        SMOKE_BOUND_MS: String(boundMs),
      },
    })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    const code = await new Promise(resolve => child.once('exit', resolve))
    return {code, output}
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
}

test('waits for the plugin list to fill after /api/agent answers 200 (OpenCode 2.2.7 does not wait for plugins)', async () => {
  // #given /api/agent answers 200 at once and /api/plugin lists nothing for the first 1500 ms
  // #when
  const result = await runSmoke({pluginDelayMs: 1500, boundMs: 20_000})

  // #then the script polls until both ids are active instead of failing on the first, empty read
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /plugins active: systematic, fro-bot\.opencode-plugin/)
})

test('still fails, naming the plugins, when they are not active within the bound', async () => {
  // #given plugins that never show up within a 1500 ms bound
  // #when
  const result = await runSmoke({pluginDelayMs: 60_000, boundMs: 1500})

  // #then
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /plugins not active: systematic, fro-bot\.opencode-plugin/)
})
