import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, mkdir, symlink, rm, lstat, chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {ensureProtectedDir} from './ensure-protected-dir.mjs'

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), 'ensure-protected-dir-test-'))
}

test('creates a missing directory with the requested owner and mode', async () => {
  const root = await makeTempRoot()
  try {
    const target = join(root, 'newdir')
    const uid = process.getuid()
    const gid = process.getgid()
    const result = ensureProtectedDir(target, uid, gid, 0o700)
    assert.deepEqual(result, {ok: true, created: true})
    const st = await lstat(target)
    assert.equal(st.isDirectory(), true)
    assert.equal(st.mode & 0o777, 0o700)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('accepts a pre-existing directory with matching owner and mode', async () => {
  const root = await makeTempRoot()
  try {
    const target = join(root, 'existing')
    await mkdir(target, {mode: 0o700})
    const uid = process.getuid()
    const gid = process.getgid()
    const result = ensureProtectedDir(target, uid, gid, 0o700)
    assert.deepEqual(result, {ok: true, created: false})
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('refuses a symlink at the target path (never follows it)', async () => {
  const root = await makeTempRoot()
  try {
    const realDir = join(root, 'real')
    await mkdir(realDir, {mode: 0o700})
    const linkPath = join(root, 'link')
    await symlink(realDir, linkPath)
    const uid = process.getuid()
    const gid = process.getgid()
    const result = ensureProtectedDir(linkPath, uid, gid, 0o700)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('symlink'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('refuses a pre-existing path that is not a directory', async () => {
  const root = await makeTempRoot()
  try {
    const {writeFile} = await import('node:fs/promises')
    const target = join(root, 'a-file')
    await writeFile(target, 'x')
    const uid = process.getuid()
    const gid = process.getgid()
    const result = ensureProtectedDir(target, uid, gid, 0o700)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('not a directory'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('refuses a pre-existing directory with the wrong mode', async () => {
  const root = await makeTempRoot()
  try {
    const target = join(root, 'wrongmode')
    await mkdir(target, {mode: 0o755})
    await chmod(target, 0o755)
    const uid = process.getuid()
    const gid = process.getgid()
    const result = ensureProtectedDir(target, uid, gid, 0o700)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('mode'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('refuses a pre-existing directory with the wrong owner', async () => {
  const root = await makeTempRoot()
  try {
    const target = join(root, 'wrongowner')
    await mkdir(target, {mode: 0o700})
    const uid = process.getuid()
    const gid = process.getgid()
    // Use an owner that is (almost certainly) not the current process uid.
    const bogusUid = uid + 12345
    const result = ensureProtectedDir(target, bogusUid, gid, 0o700)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('owned by'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})
