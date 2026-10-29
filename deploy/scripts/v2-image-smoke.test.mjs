// Tests for the pure part of deploy/scripts/v2-image-smoke.mjs. The rest of that script needs the built image.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {test} from 'node:test'

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
