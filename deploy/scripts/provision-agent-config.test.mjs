import assert from 'node:assert/strict'
import {test} from 'node:test'
import {lstat, mkdir, mkdtemp, writeFile, readFile, rm, stat, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

import {provisionAgentConfig} from './provision-agent-config.mjs'

// The base config the image bakes (deploy/workspace.Dockerfile): updates off, no plugin entry.
const BASE_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  update: 'disable',
}

const AUTH_BLOB = JSON.stringify({anthropic: {type: 'api', key: 'sk-test'}})

async function makeProvisionRoot() {
  const root = await mkdtemp(join(tmpdir(), 'provision-agent-config-test-'))
  const baseConfigPath = join(root, 'base.json')
  await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
  return {
    root,
    baseConfigPath,
    staleAuthPath: join(root, 'home', '.local', 'share', 'opencode', 'auth.json'),
    configDestPath: join(root, 'home', '.config', 'opencode', 'opencode.json'),
  }
}

test('writes the merged opencode.json from the base, the overlay and the model', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    const result = await provisionAgentConfig({
      baseConfigPath,
      staleAuthPath,
      configDestPath,
      overlayRaw: JSON.stringify({provider: {anthropic: {options: {baseURL: 'https://cliproxy.fro.bot/v1'}}}}),
      modelRaw: 'anthropic/claude-sonnet-4-6',
    })

    assert.equal(result.ok, true)
    const written = JSON.parse(await readFile(configDestPath, 'utf8'))
    assert.equal(written.model, 'anthropic/claude-sonnet-4-6')
    assert.equal(written.update, 'disable')
    assert.equal(written.provider.anthropic.options.baseURL, 'https://cliproxy.fro.bot/v1')
    assert.equal((await stat(configDestPath)).mode & 0o777, 0o644)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('rejects a malformed overlay and writes nothing', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    const result = await provisionAgentConfig({
      baseConfigPath,
      staleAuthPath,
      configDestPath,
      overlayRaw: '{not valid json',
      modelRaw: '',
    })

    assert.equal(result.ok, false)
    await assert.rejects(stat(configDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('never writes an auth.json, and removes a stale one left by an earlier run', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    await mkdir(join(staleAuthPath, '..'), {recursive: true})
    await writeFile(staleAuthPath, AUTH_BLOB, {mode: 0o600})

    const result = await provisionAgentConfig({baseConfigPath, staleAuthPath, configDestPath, overlayRaw: '', modelRaw: ''})

    assert.equal(result.ok, true)
    await assert.rejects(stat(staleAuthPath))
    assert.equal(JSON.parse(await readFile(configDestPath, 'utf8')).update, 'disable')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('succeeds when there is no stale auth.json to remove', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    const result = await provisionAgentConfig({baseConfigPath, staleAuthPath, configDestPath, overlayRaw: '', modelRaw: ''})

    assert.equal(result.ok, true)
    await assert.rejects(stat(staleAuthPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('removes a stale auth.json that is a symlink without touching its target', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    const target = join(root, 'elsewhere.txt')
    await writeFile(target, 'keep me')
    await mkdir(join(staleAuthPath, '..'), {recursive: true})
    await symlink(target, staleAuthPath)

    const result = await provisionAgentConfig({baseConfigPath, staleAuthPath, configDestPath, overlayRaw: '', modelRaw: ''})

    assert.equal(result.ok, true)
    await assert.rejects(lstat(staleAuthPath))
    assert.equal(await readFile(target, 'utf8'), 'keep me')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('fails closed when a stale auth.json cannot be removed', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    // A non-empty directory at the path: `rm` without `recursive` refuses it.
    await mkdir(staleAuthPath, {recursive: true})
    await writeFile(join(staleAuthPath, 'inside'), 'x')

    const result = await provisionAgentConfig({baseConfigPath, staleAuthPath, configDestPath, overlayRaw: '', modelRaw: ''})

    assert.equal(result.ok, false)
    assert.match(result.error, /cannot remove stale auth\.json/)
    await assert.rejects(stat(configDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

const SCRIPT = fileURLToPath(new URL('./provision-agent-config.mjs', import.meta.url))

function runCli({args, overlay = '', model = '', input = ''}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    env: {PATH: process.env.PATH, WORKSPACE_OPENCODE_CONFIG: overlay, WORKSPACE_OPENCODE_MODEL: model},
  })
}

test('the startup marker says the overlay was merged into the config file, not that a provider loaded', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    const {status, stderr} = runCli({
      args: [baseConfigPath, staleAuthPath, configDestPath],
      overlay: JSON.stringify({provider: {anthropic: {options: {baseURL: 'https://cliproxy.fro.bot/v1'}}}}),
      model: 'anthropic/claude-sonnet-4-6',
    })

    assert.equal(status, 0)
    assert.match(stderr, /provider-overlay=merged-into-config-file/)
    assert.doesNotMatch(stderr, /provider-overlay=applied/)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('the startup marker reports none when no overlay is set', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    const {status, stderr} = runCli({args: [baseConfigPath, staleAuthPath, configDestPath]})

    assert.equal(status, 0)
    assert.match(stderr, /provider-overlay=none/)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('the CLI ignores anything on stdin: no credential is written, and a stale auth.json goes', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    await mkdir(join(staleAuthPath, '..'), {recursive: true})
    await writeFile(staleAuthPath, AUTH_BLOB, {mode: 0o600})

    const result = runCli({args: [baseConfigPath, staleAuthPath, configDestPath], input: AUTH_BLOB})

    assert.equal(result.status, 0, result.stderr)
    assert.doesNotMatch(result.stderr, /auth: provisioned/)
    await assert.rejects(stat(staleAuthPath))
    assert.doesNotMatch(await readFile(configDestPath, 'utf8'), /sk-test/)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('the CLI rejects a missing argument or a flag it does not know', async () => {
  const {root, baseConfigPath, staleAuthPath, configDestPath} = await makeProvisionRoot()
  try {
    for (const args of [[baseConfigPath, staleAuthPath], [baseConfigPath, staleAuthPath, configDestPath, '--no-auth-json']]) {
      const result = runCli({args})
      assert.equal(result.status, 2)
      assert.match(result.stderr, /usage:/)
    }
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
