import assert from 'node:assert/strict'
import {test} from 'node:test'
import {lstat, mkdir, mkdtemp, writeFile, readFile, rm, stat, symlink, open} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

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
    // Open authDestPath once and take both the mode and the content from the
    // same FileHandle (fstat under the hood) — a separate stat() followed by
    // a separate readFile() on the same path is a TOCTOU race (CodeQL
    // js/file-system-race): the path could be replaced between the two calls.
    const authHandle = await open(authDestPath, 'r')
    let written
    try {
      const st = await authHandle.stat()
      assert.equal(st.mode & 0o777, 0o600)
      written = await authHandle.readFile('utf8')
    } finally {
      await authHandle.close()
    }
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

const SCRIPT = fileURLToPath(new URL('./provision-agent-config.mjs', import.meta.url))

async function runCli({overlay, model}) {
  const root = await makeTempRoot()
  try {
    const baseConfigPath = join(root, 'base.json')
    await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
    const result = spawnSync(
      process.execPath,
      [SCRIPT, baseConfigPath, join(root, 'auth.json'), join(root, 'opencode.json')],
      {
        input: '',
        encoding: 'utf8',
        env: {PATH: process.env.PATH, WORKSPACE_OPENCODE_CONFIG: overlay, WORKSPACE_OPENCODE_MODEL: model},
      },
    )
    return {status: result.status, stderr: result.stderr}
  } finally {
    await rm(root, {recursive: true, force: true})
  }
}

test('the startup marker says the overlay was merged into the config file, not that a provider loaded', async () => {
  const {status, stderr} = await runCli({
    overlay: JSON.stringify({provider: {anthropic: {options: {baseURL: 'https://cliproxy.fro.bot/v1'}}}}),
    model: 'anthropic/claude-sonnet-4-6',
  })

  assert.equal(status, 0)
  assert.match(stderr, /provider-overlay=merged-into-config-file/)
  assert.doesNotMatch(stderr, /provider-overlay=applied/)
})

test('the startup marker reports none when no overlay is set', async () => {
  const {status, stderr} = await runCli({overlay: '', model: ''})

  assert.equal(status, 0)
  assert.match(stderr, /provider-overlay=none/)
})

const AUTH_BLOB = JSON.stringify({anthropic: {type: 'api', key: 'sk-test'}})

async function makeProvisionRoot() {
  const root = await makeTempRoot()
  const baseConfigPath = join(root, 'base.json')
  await writeFile(baseConfigPath, JSON.stringify(BASE_CONFIG))
  return {
    root,
    baseConfigPath,
    authDestPath: join(root, 'home', '.local', 'share', 'opencode', 'auth.json'),
    configDestPath: join(root, 'home', '.config', 'opencode', 'opencode.json'),
  }
}

test('V2 (writeAuthJson: false) writes no auth.json even when a blob is passed, and still writes the config', async () => {
  const {root, baseConfigPath, authDestPath, configDestPath} = await makeProvisionRoot()
  try {
    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: AUTH_BLOB,
      overlayRaw: '',
      modelRaw: '',
      writeAuthJson: false,
    })

    assert.equal(result.ok, true)
    assert.equal(result.authProvisioned, false)
    await assert.rejects(stat(authDestPath))
    assert.equal(JSON.parse(await readFile(configDestPath, 'utf8')).autoupdate, false)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('V2 removes a stale auth.json left by an earlier V1 run', async () => {
  const {root, baseConfigPath, authDestPath, configDestPath} = await makeProvisionRoot()
  try {
    await mkdir(join(authDestPath, '..'), {recursive: true})
    await writeFile(authDestPath, AUTH_BLOB, {mode: 0o600})

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: '',
      overlayRaw: '',
      modelRaw: '',
      writeAuthJson: false,
    })

    assert.equal(result.ok, true)
    await assert.rejects(stat(authDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('V2 removes a stale auth.json that is a symlink without touching its target', async () => {
  const {root, baseConfigPath, authDestPath, configDestPath} = await makeProvisionRoot()
  try {
    const target = join(root, 'elsewhere.txt')
    await writeFile(target, 'keep me')
    await mkdir(join(authDestPath, '..'), {recursive: true})
    await symlink(target, authDestPath)

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: '',
      overlayRaw: '',
      modelRaw: '',
      writeAuthJson: false,
    })

    assert.equal(result.ok, true)
    await assert.rejects(lstat(authDestPath))
    assert.equal(await readFile(target, 'utf8'), 'keep me')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('V1 (writeAuthJson omitted) still writes auth.json with 0600 and overwrites a previous one', async () => {
  const {root, baseConfigPath, authDestPath, configDestPath} = await makeProvisionRoot()
  try {
    await mkdir(join(authDestPath, '..'), {recursive: true})
    await writeFile(authDestPath, '{"old":true}', {mode: 0o600})

    const result = await provisionAgentConfig({
      baseConfigPath,
      authDestPath,
      configDestPath,
      authRaw: AUTH_BLOB,
      overlayRaw: '',
      modelRaw: '',
    })

    assert.equal(result.ok, true)
    assert.equal(result.authProvisioned, true)
    assert.equal((await stat(authDestPath)).mode & 0o777, 0o600)
    assert.equal(await readFile(authDestPath, 'utf8'), AUTH_BLOB)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

function runCliWithAuth({args, input, authDestPath, baseConfigPath, configDestPath}) {
  return spawnSync(process.execPath, [SCRIPT, baseConfigPath, authDestPath, configDestPath, ...args], {
    input,
    encoding: 'utf8',
    env: {PATH: process.env.PATH},
  })
}

test('the CLI writes auth.json by default and drops it with --no-auth-json', async () => {
  const {root, baseConfigPath, authDestPath, configDestPath} = await makeProvisionRoot()
  try {
    const v1 = runCliWithAuth({args: [], input: AUTH_BLOB, authDestPath, baseConfigPath, configDestPath})
    assert.equal(v1.status, 0, v1.stderr)
    assert.match(v1.stderr, /auth: provisioned/)
    assert.equal((await stat(authDestPath)).mode & 0o777, 0o600)

    const v2 = runCliWithAuth({args: ['--no-auth-json'], input: '', authDestPath, baseConfigPath, configDestPath})
    assert.equal(v2.status, 0, v2.stderr)
    assert.doesNotMatch(v2.stderr, /auth: provisioned/)
    await assert.rejects(stat(authDestPath))
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('the CLI rejects a flag it does not know', async () => {
  const {root, baseConfigPath, authDestPath, configDestPath} = await makeProvisionRoot()
  try {
    const result = runCliWithAuth({args: ['--no-auth'], input: '', authDestPath, baseConfigPath, configDestPath})
    assert.equal(result.status, 2)
    assert.match(result.stderr, /usage:/)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
