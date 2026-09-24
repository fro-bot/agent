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

// --- --nested: mount-managed children (secrets/, mitmproxy/) -------------
//
// These reuse the injection approach above: the test process is never root,
// so "strict parent" here means "owned by the current process uid:gid",
// passed in as the uid/gid arguments — in production those arguments are
// always 0:0, so the effective production check is unchanged.

async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr)
  let captured = ''
  process.stderr.write = chunk => {
    captured += chunk
    return true
  }
  try {
    const result = await fn()
    return {result, captured}
  } finally {
    process.stderr.write = original
  }
}

test('nested: creates a missing child with strict mode when the parent is strict', async () => {
  const root = await makeTempRoot()
  try {
    const uid = process.getuid()
    const gid = process.getgid()
    const parent = join(root, 'parent')
    await mkdir(parent, {mode: 0o700})
    await chmod(parent, 0o700)
    const child = join(parent, 'secrets')
    const result = ensureProtectedDir(child, uid, gid, 0o700, true)
    assert.deepEqual(result, {ok: true, created: true})
    const st = await lstat(child)
    assert.equal(st.isDirectory(), true)
    assert.equal(st.mode & 0o777, 0o700)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('nested: accepts a present child with a relaxed mode and logs the observed owner/mode', async () => {
  const root = await makeTempRoot()
  try {
    const uid = process.getuid()
    const gid = process.getgid()
    const parent = join(root, 'parent')
    await mkdir(parent, {mode: 0o700})
    await chmod(parent, 0o700)
    const child = join(parent, 'secrets')
    await mkdir(child, {mode: 0o755})
    await chmod(child, 0o755)
    const {result, captured} = await captureStderr(() => ensureProtectedDir(child, uid, gid, 0o700, true))
    assert.deepEqual(result, {ok: true, created: false})
    assert.ok(captured.includes(`${uid}:${gid}`), `log should name the observed owner, got: ${captured}`)
    assert.ok(captured.includes('755'), `log should name the observed mode, got: ${captured}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('nested: refuses a child that is a symlink', async () => {
  const root = await makeTempRoot()
  try {
    const uid = process.getuid()
    const gid = process.getgid()
    const parent = join(root, 'parent')
    await mkdir(parent, {mode: 0o700})
    await chmod(parent, 0o700)
    const realDir = join(root, 'real')
    await mkdir(realDir, {mode: 0o755})
    const child = join(parent, 'secrets')
    await symlink(realDir, child)
    const result = ensureProtectedDir(child, uid, gid, 0o700, true)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('symlink'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('nested: refuses a child that is a regular file', async () => {
  const root = await makeTempRoot()
  try {
    const {writeFile} = await import('node:fs/promises')
    const uid = process.getuid()
    const gid = process.getgid()
    const parent = join(root, 'parent')
    await mkdir(parent, {mode: 0o700})
    await chmod(parent, 0o700)
    const child = join(parent, 'secrets')
    await writeFile(child, 'x')
    const result = ensureProtectedDir(child, uid, gid, 0o700, true)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('not a directory'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('nested: refuses when the parent has the wrong mode, even though the child is fine', async () => {
  const root = await makeTempRoot()
  try {
    const uid = process.getuid()
    const gid = process.getgid()
    const parent = join(root, 'parent')
    await mkdir(parent, {mode: 0o755})
    await chmod(parent, 0o755)
    const child = join(parent, 'secrets')
    await mkdir(child, {mode: 0o700})
    await chmod(child, 0o700)
    const result = ensureProtectedDir(child, uid, gid, 0o700, true)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('parent'), `got: ${result.error}`)
    assert.ok(result.error.includes('mode'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('nested: refuses when the parent has the wrong owner, even though the child is fine', async () => {
  const root = await makeTempRoot()
  try {
    const uid = process.getuid()
    const gid = process.getgid()
    const parent = join(root, 'parent')
    await mkdir(parent, {mode: 0o700})
    await chmod(parent, 0o700)
    const child = join(parent, 'secrets')
    await mkdir(child, {mode: 0o700})
    await chmod(child, 0o700)
    // Use an owner that is (almost certainly) not the current process uid, so
    // the parent (actually owned by the current uid) fails the expected-owner check.
    const bogusUid = uid + 12345
    const result = ensureProtectedDir(child, bogusUid, gid, 0o700, true)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('parent'), `got: ${result.error}`)
    assert.ok(result.error.includes('owned by'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('nested: refuses when the parent is a symlink, even though the child is fine', async () => {
  const root = await makeTempRoot()
  try {
    const uid = process.getuid()
    const gid = process.getgid()
    const realParent = join(root, 'real-parent')
    await mkdir(realParent, {mode: 0o700})
    await chmod(realParent, 0o700)
    const child = join(realParent, 'secrets')
    await mkdir(child, {mode: 0o700})
    await chmod(child, 0o700)
    const parentLink = join(root, 'parent')
    await symlink(realParent, parentLink)
    const childViaLink = join(parentLink, 'secrets')
    const result = ensureProtectedDir(childViaLink, uid, gid, 0o700, true)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('parent'), `got: ${result.error}`)
    assert.ok(result.error.includes('symlink'), `got: ${result.error}`)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('strict mode is unchanged: a wrong mode is still refused when nested is not requested', async () => {
  const root = await makeTempRoot()
  try {
    const target = join(root, 'strict-wrongmode')
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
