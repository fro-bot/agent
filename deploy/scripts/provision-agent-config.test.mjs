import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, writeFile, readFile, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {provisionAgentConfig} from './provision-agent-config.mjs'

const BASE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  autoupdate: false,
  plugin: ['@fro.bot/systematic@3.20.0'],
}

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), 'provision-agent-config-test-'))
}

test('writes auth.json with 0600 when a valid auth blob is provided', async () => {
  const root = await makeTempRoot()
  try {
    const baseConfigPath = join(root, 'base.json')
    await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
    const authDestPath = join(root, 'home', '.local', 'share', 'opencode', 'auth.json')
    const configDestPath = join(root, 'home', '.config', 'opencode', 'opencode.json')
    const authRaw = JSON.stringify({anthropic: {type: 'api', key: 'sk-test'}})

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw,
      overlayRaw: '',
      modelRaw: '',
    })

    assert.equal(result.ok, true)
    assert.equal(result.authProvisioned, true)
    const st = await stat(authDestPath)
    assert.equal(st.mode & 0o777, 0o600)
    const written = await readFile(authDestPath, 'utf8')
    assert.equal(written, authRaw)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('skips auth.json entirely when authRaw is empty', async () => {
  const root = await makeTempRoot()
  try {
    const baseConfigPath = join(root, 'base.json')
    await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
    const authDestPath = join(root, 'home', '.local', 'share', 'opencode', 'auth.json')
    const configDestPath = join(root, 'home', '.config', 'opencode', 'opencode.json')

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: '',
      overlayRaw: '',
      modelRaw: '',
    })

    assert.equal(result.ok, true)
    assert.equal(result.authProvisioned, false)
    await assert.rejects(stat(authDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('rejects an invalid auth blob and writes nothing', async () => {
  const root = await makeTempRoot()
  try {
    const baseConfigPath = join(root, 'base.json')
    await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
    const authDestPath = join(root, 'home', '.local', 'share', 'opencode', 'auth.json')
    const configDestPath = join(root, 'home', '.config', 'opencode', 'opencode.json')

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: JSON.stringify({anthropic: {type: 'oauth'}}),
      overlayRaw: '',
      modelRaw: '',
    })

    assert.equal(result.ok, false)
    assert.ok(result.error.includes('invalid'), `got: ${result.error}`)
    await assert.rejects(stat(authDestPath))
    await assert.rejects(stat(configDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('writes the merged opencode.json, preserving the baked plugin', async () => {
  const root = await makeTempRoot()
  try {
    const baseConfigPath = join(root, 'base.json')
    await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
    const authDestPath = join(root, 'home', '.local', 'share', 'opencode', 'auth.json')
    const configDestPath = join(root, 'home', '.config', 'opencode', 'opencode.json')

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: '',
      overlayRaw: JSON.stringify({provider: {anthropic: {options: {baseURL: 'https://cliproxy.fro.bot/v1'}}}}),
      modelRaw: 'anthropic/claude-sonnet-4-6',
    })

    assert.equal(result.ok, true)
    const written = JSON.parse(await readFile(configDestPath, 'utf8'))
    assert.equal(written.model, 'anthropic/claude-sonnet-4-6')
    assert.deepEqual(written.plugin, ['@fro.bot/systematic@3.20.0'])
    assert.equal(written.provider.anthropic.options.baseURL, 'https://cliproxy.fro.bot/v1')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('rejects a malformed overlay and writes nothing', async () => {
  const root = await makeTempRoot()
  try {
    const baseConfigPath = join(root, 'base.json')
    await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
    const authDestPath = join(root, 'home', '.local', 'share', 'opencode', 'auth.json')
    const configDestPath = join(root, 'home', '.config', 'opencode', 'opencode.json')

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: '',
      overlayRaw: '{not valid json',
      modelRaw: '',
    })

    assert.equal(result.ok, false)
    await assert.rejects(stat(configDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
