import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, mkdir, writeFile, readFile, symlink, link, lstat, open, rm, readdir, utimes} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {defaultOps, migrateRepoOwnership, DEFAULT_DEADLINE_MS} from './migrate-repo-ownership.mjs'

const TARGET_UID = 10001
const TARGET_GID = 10001

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), 'migrate-repo-ownership-test-'))
}

/**
 * A non-root test process cannot really chown to an arbitrary uid, so the
 * chown/lchown calls are recorded instead of executed, and every other
 * operation runs for real against the temp directory the test process owns.
 */
function recordingOps() {
  const real = defaultOps()
  const calls = {chown: [], lchown: []}
  return {
    ops: {
      ...real,
      chown: async (path, uid, gid) => {
        calls.chown.push({path, uid, gid})
      },
      lchown: async (path, uid, gid) => {
        calls.lchown.push({path, uid, gid})
      },
    },
    calls,
  }
}

async function buildRepoTree(root) {
  const reposRoot = join(root, 'repos')
  await mkdir(reposRoot, {mode: 0o755})
  const ownerDir = join(reposRoot, 'acme')
  await mkdir(ownerDir, {mode: 0o755})
  const repoDir = join(ownerDir, 'widgets')
  await mkdir(repoDir, {mode: 0o755, recursive: true})
  await mkdir(join(repoDir, 'src'), {mode: 0o755})
  await writeFile(join(repoDir, 'src', 'index.js'), 'console.log(1)\n', {mode: 0o644})
  const scriptPath = join(repoDir, 'run.sh')
  await writeFile(scriptPath, '#!/bin/sh\necho hi\n', {mode: 0o755})
  return {reposRoot, ownerDir, repoDir}
}

test('nested directories and an executable file are walked and chowned', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)
    const {ops, calls} = recordingOps()

    const result = await migrateRepoOwnership({
      reposRoot,
      expectedRootOwnerUid: process.getuid(),
      targetUid: TARGET_UID,
      targetGid: TARGET_GID,
      ops,
    })

    assert.equal(result.ok, true)
    assert.equal(result.timedOut, false)
    assert.deepEqual(result.completed, ['acme/widgets'])
    assert.ok(result.stats.dirs >= 2, 'expected at least repo dir + src dir chowned')
    assert.ok(result.stats.files >= 2, 'expected index.js + run.sh chowned')

    const scriptPath = join(repoDir, 'run.sh')
    const scriptCall = calls.lchown.find(c => c.path === scriptPath)
    assert.ok(scriptCall, 'run.sh must be chowned')
    assert.equal(scriptCall.uid, TARGET_UID)
    assert.equal(scriptCall.gid, TARGET_GID)

    // Executable bit preserved.
    const st = await lstat(scriptPath)
    assert.equal((st.mode & 0o100) !== 0, true, 'owner-exec bit must be preserved')

    // Owner directory itself and the volume root must NEVER be chowned.
    const ownerCall = calls.lchown.find(c => c.path === join(reposRoot, 'acme'))
    assert.equal(ownerCall, undefined, 'owner directory must stay root-owned')
    const rootCall = calls.lchown.find(c => c.path === reposRoot)
    assert.equal(rootCall, undefined, 'repos volume root must stay root-owned')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('a symlink pointing outside the tree is lchown-ed but its target is never touched', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)
    const outsideFile = join(root, 'outside-secret.txt')
    await writeFile(outsideFile, 'do not touch\n', {mode: 0o600})
    const linkPath = join(repoDir, 'link-to-outside')
    await symlink(outsideFile, linkPath)

    const {ops, calls} = recordingOps()
    const result = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops})

    assert.equal(result.ok, true)
    const linkCall = calls.lchown.find(c => c.path === linkPath)
    assert.ok(linkCall, 'the symlink itself must be lchown-ed')

    const outsideCall = calls.lchown.find(c => c.path === outsideFile)
    assert.equal(outsideCall, undefined, 'the symlink target outside the tree must never be chowned')

    const targetContent = await readFile(outsideFile, 'utf8')
    assert.equal(targetContent, 'do not touch\n', 'target content must be unchanged')
    const targetSt = await lstat(outsideFile)
    assert.equal(targetSt.uid, process.getuid(), 'target owner must be unchanged (still the test process)')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('a hardlink shared with a file outside the tree is broken before chown (private inode)', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)
    const insidePath = join(repoDir, 'shared.dat')
    await writeFile(insidePath, 'shared bytes\n', {mode: 0o644})
    const outsidePath = join(root, 'shared-outside.dat')
    await link(insidePath, outsidePath)

    // Checked through the outside path: both names share one inode, so its nlink
    // proves the hardlink, and insidePath is never stat'd by path before the
    // single open() below (CodeQL js/file-system-race).
    const beforeOutside = await lstat(outsidePath)
    assert.equal(beforeOutside.nlink, 2, 'sanity: hardlink set up correctly')

    const {ops, calls} = recordingOps()
    const result = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops})

    assert.equal(result.ok, true)
    assert.ok(result.stats.hardlinksBroken >= 1, 'the hardlink must be recorded as broken')

    // Open insidePath once and take both the stat and the content from the
    // same FileHandle (fstat under the hood) — a separate lstat() followed by
    // a separate readFile() on the same path is a TOCTOU race (CodeQL
    // js/file-system-race): the path could be replaced between the two calls.
    // insidePath is a real regular file (not a symlink) here, so fstat via an
    // open FileHandle reports exactly what lstat would have reported on the
    // same path (no symlink-following semantics differ for a regular file).
    const insideHandle = await open(insidePath, 'r')
    let content
    try {
      const afterInside = await insideHandle.stat()
      const afterOutside = await lstat(outsidePath)
      assert.notEqual(afterInside.ino, afterOutside.ino, 'inside path must now be a distinct, private inode')
      assert.equal(afterInside.nlink, 1, 'inside path must be its own inode with nlink=1')
      assert.equal(afterOutside.nlink, 1, 'outside path must have been left as its own now-unshared inode')

      const outsideChown = calls.lchown.find(c => c.path === outsidePath)
      assert.equal(outsideChown, undefined, 'the outside path must never be chowned')
      const insideChown = calls.lchown.find(c => c.path === insidePath)
      assert.ok(insideChown, 'the inside path must be chowned after the hardlink is broken')

      content = await insideHandle.readFile('utf8')
    } finally {
      await insideHandle.close()
    }
    assert.equal(content, 'shared bytes\n', 'file content must be preserved across the hardlink break')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('.workspace-agent state dir and .tmp-* staging dirs are skipped', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, ownerDir} = await buildRepoTree(root)
    await mkdir(join(reposRoot, '.workspace-agent'), {mode: 0o700})
    await writeFile(join(reposRoot, '.workspace-agent', 'sentinel'), 'x')
    const stagingDir = join(ownerDir, '.tmp-clone-abc123')
    await mkdir(stagingDir, {mode: 0o755})
    await writeFile(join(stagingDir, 'partial-file'), 'x')

    const {ops, calls} = recordingOps()
    const result = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops})

    assert.equal(result.ok, true)
    const stateDirCall = calls.lchown.find(c => c.path.includes('.workspace-agent'))
    assert.equal(stateDirCall, undefined, '.workspace-agent must never be chowned by the checkout walk')
    const stagingCall = calls.lchown.find(c => c.path.startsWith(stagingDir))
    assert.equal(stagingCall, undefined, '.tmp-* staging directories must be skipped entirely')
    assert.ok(result.stats.skippedStaging >= 1)
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('a checkout root already owned by the target uid:gid is skipped entirely, no marker required', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)

    // A hardlink inside the checkout: if the walk ran despite the skip, its
    // breakHardlink step would read the file's full content and rewrite it.
    const insidePath = join(repoDir, 'shared.dat')
    await writeFile(insidePath, 'shared bytes\n', {mode: 0o644})
    const outsidePath = join(root, 'shared-outside.dat')
    await link(insidePath, outsidePath)

    // A non-root test process cannot really chown to an arbitrary uid, so
    // the "target uid:gid" for this test IS the test process's own uid:gid
    // — the checkout tree buildRepoTree() just created is already owned by
    // it, with no chown needed to make the skip condition true for real.
    const uid = process.getuid()
    const gid = process.getgid()

    const {ops, calls} = recordingOps()
    const readFileCalls = []
    const readdirCalls = []
    ops.readFile = async (...args) => {
      readFileCalls.push(args[0])
      return readFile(...args)
    }
    ops.readdir = async (...args) => {
      readdirCalls.push(args[0])
      return readdir(...args)
    }

    const result = await migrateRepoOwnership({
      reposRoot,
      expectedRootOwnerUid: uid,
      targetUid: uid,
      targetGid: gid,
      ops,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.completed, [], 'an agent-owned checkout is not "completed" this run — it was already done')
    assert.deepEqual(result.skippedAgentOwned, ['acme/widgets'])
    assert.deepEqual(result.skippedAlreadyDone, [])
    assert.equal(calls.lchown.length, 0, 'no lchown calls anywhere under the checkout')
    assert.equal(
      calls.chown.filter(c => c.path.startsWith(repoDir)).length,
      0,
      'no chown calls under the checkout (chown is otherwise only used for state-dir setup)',
    )

    const readsUnderCheckout = readFileCalls.filter(p => p.startsWith(repoDir))
    assert.deepEqual(readsUnderCheckout, [], 'no file content, including the hardlink, may be read')
    const listsUnderCheckout = readdirCalls.filter(p => p.startsWith(repoDir))
    assert.deepEqual(listsUnderCheckout, [], 'the checkout tree must never be listed')

    // The hardlink must remain exactly as built: shared, untouched.
    const insideSt = await lstat(insidePath)
    const outsideSt = await lstat(outsidePath)
    assert.equal(insideSt.ino, outsideSt.ino, 'the hardlink must still be shared — never broken')
    assert.equal(insideSt.nlink, 2, 'nlink must be unchanged')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('a checkout root NOT owned by the target uid:gid is still walked', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)
    const {ops, calls} = recordingOps()

    // targetUid/targetGid (10001/10001) intentionally differ from the real
    // owner (the test process) — real chowns to 10001 are faked/recorded,
    // so the checkout root's real owner never becomes the target.
    const result = await migrateRepoOwnership({
      reposRoot,
      expectedRootOwnerUid: process.getuid(),
      targetUid: TARGET_UID,
      targetGid: TARGET_GID,
      ops,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.skippedAgentOwned, [], 'root-owned checkout must not be skipped')
    assert.deepEqual(result.completed, ['acme/widgets'])
    const scriptCall = calls.lchown.find(c => c.path === join(repoDir, 'run.sh'))
    assert.ok(scriptCall, 'a root-owned checkout must actually be walked and chowned')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('idempotency: running twice performs zero additional chowns on the second run', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)

    const first = recordingOps()
    const r1 = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops: first.ops})
    assert.equal(r1.ok, true)
    assert.deepEqual(r1.completed, ['acme/widgets'])
    assert.equal(first.calls.lchown.length > 0, true)

    const second = recordingOps()
    const r2 = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops: second.ops})
    assert.equal(r2.ok, true)
    assert.deepEqual(r2.completed, [], 'nothing new to complete')
    assert.deepEqual(r2.skippedAlreadyDone, ['acme/widgets'])
    assert.equal(second.calls.lchown.length, 0, 'second run must not touch the filesystem at all for a done checkout')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('resuming a partial run: a checkout without a marker is walked again from scratch', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)

    // Simulate a prior run that died mid-checkout: chown some files "by hand"
    // (recorded ops, so nothing really changes) but never write the marker.
    const {ops: partialOps} = recordingOps()
    // Run with a deadline that expires immediately, so nothing completes and
    // no marker is written — mirrors a crash/timeout mid-checkout.
    const partial = await migrateRepoOwnership({
      reposRoot,
      expectedRootOwnerUid: process.getuid(),
      targetUid: TARGET_UID,
      targetGid: TARGET_GID,
      ops: partialOps,
      deadlineMs: -1,
    })
    assert.equal(partial.timedOut, true)
    assert.deepEqual(partial.completed, [])

    const markerPath = join(reposRoot, '.workspace-agent', 'completed', 'acme__widgets.json')
    assert.equal(
      await lstat(markerPath).then(
        () => true,
        () => false,
      ),
      false,
      'no marker may exist after a timed-out run',
    )

    // Second, unbounded run must pick the checkout back up and complete it.
    const {ops: resumeOps, calls} = recordingOps()
    const resumed = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops: resumeOps})
    assert.equal(resumed.ok, true)
    assert.deepEqual(resumed.completed, ['acme/widgets'])
    const scriptCall = calls.lchown.find(c => c.path === join(repoDir, 'run.sh'))
    assert.ok(scriptCall, 'the resumed run must actually chown files from the previously-incomplete checkout')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('deadline expiry: fails loudly, reports timeout, and marks nothing complete', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)
    const {ops} = recordingOps()

    const result = await migrateRepoOwnership({
      reposRoot,
      expectedRootOwnerUid: process.getuid(),
      targetUid: TARGET_UID,
      targetGid: TARGET_GID,
      ops,
      deadlineMs: -1, // already expired before the first entry is processed
    })

    assert.equal(result.ok, true)
    assert.equal(result.timedOut, true)
    assert.deepEqual(result.completed, [], 'nothing may be marked complete on timeout')

    const entries = await readdir(join(reposRoot, '.workspace-agent', 'completed')).catch(() => [])
    assert.deepEqual(entries, [], 'no completion markers may exist after a timeout')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('default deadline is 5 minutes', () => {
  assert.equal(DEFAULT_DEADLINE_MS, 5 * 60 * 1000)
})

test('fails loudly (rejects) when the repos volume root is a symlink', async () => {
  const root = await makeTempRoot()
  try {
    const realDir = join(root, 'real-repos')
    await mkdir(realDir, {mode: 0o755})
    const linkedRoot = join(root, 'repos-link')
    await symlink(realDir, linkedRoot)
    const {ops} = recordingOps()

    await assert.rejects(
      migrateRepoOwnership({reposRoot: linkedRoot, targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      /symlink/,
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test("breaking a hardlink preserves the original file's atime/mtime", async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)
    const insidePath = join(repoDir, 'shared-mtime.dat')
    await writeFile(insidePath, 'shared bytes\n', {mode: 0o644})
    const outsidePath = join(root, 'shared-mtime-outside.dat')
    await link(insidePath, outsidePath)

    const fixedPast = new Date('2020-01-01T00:00:00.000Z')
    await utimes(insidePath, fixedPast, fixedPast)

    const {ops} = recordingOps()
    const result = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops})

    assert.equal(result.ok, true)
    const afterSt = await lstat(insidePath)
    assert.equal(
      afterSt.mtime.getTime(),
      fixedPast.getTime(),
      'mtime must be restored to the pre-break value after breaking the hardlink',
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

// --- Fail-the-boot-on-any-skip policy -------------------------------------
//
// A non-root test process cannot chown, and cannot create a directory owned
// by an arbitrary different uid either — so "not root-owned" and "cannot be
// listed" are simulated by wrapping the real `lstat`/`readdir` ops for one
// specific path, delegating to the real filesystem for everything else
// (same technique `recordingOps` already uses for chown/lchown).

function withLstatUidOverride(overridePath, fakeUid) {
  const {ops: real} = recordingOps()
  return {
    ...real,
    lstat: async path => {
      const st = await real.lstat(path)
      if (path === overridePath) st.uid = fakeUid
      return st
    },
  }
}

function withReaddirFailure(overridePath) {
  const {ops: real} = recordingOps()
  return {
    ...real,
    readdir: async path => {
      if (path === overridePath) throw new Error('EACCES: permission denied (simulated)')
      return real.readdir(path)
    },
  }
}

test('an owner directory that is a symlink fails the run and names the path', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)
    const realDir = join(root, 'real-owner')
    await mkdir(realDir, {mode: 0o755})
    const symlinkOwner = join(reposRoot, 'evil-owner')
    await symlink(realDir, symlinkOwner)

    const {ops} = recordingOps()
    await assert.rejects(
      migrateRepoOwnership({reposRoot, expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      error => {
        assert.match(error.message, /evil-owner/)
        assert.match(error.message, /symlink/)
        return true
      },
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('an owner directory that is a regular file fails the run and names the path', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)
    const fileOwner = join(reposRoot, 'not-a-dir-owner')
    await writeFile(fileOwner, 'oops\n')

    const {ops} = recordingOps()
    await assert.rejects(
      migrateRepoOwnership({reposRoot, expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      error => {
        assert.match(error.message, /not-a-dir-owner/)
        assert.match(error.message, /not a directory/)
        return true
      },
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('an owner directory not owned by the expected root uid fails the run and names the path', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)
    const mismatchOwner = join(reposRoot, 'wrong-uid-owner')
    await mkdir(mismatchOwner, {mode: 0o755})

    const ops = withLstatUidOverride(mismatchOwner, process.getuid() + 999)
    await assert.rejects(
      migrateRepoOwnership({reposRoot, expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      error => {
        assert.match(error.message, /wrong-uid-owner/)
        assert.match(error.message, /owned by uid/)
        return true
      },
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('an owner directory that cannot be listed fails the run and names the path', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)
    const unreadableOwner = join(reposRoot, 'unreadable-owner')
    await mkdir(unreadableOwner, {mode: 0o755})

    const ops = withReaddirFailure(unreadableOwner)
    await assert.rejects(
      migrateRepoOwnership({reposRoot, expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      error => {
        assert.match(error.message, /unreadable-owner/)
        assert.match(error.message, /cannot be listed/)
        return true
      },
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('two problems in one run are both named in the failure output', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot} = await buildRepoTree(root)
    const fileOwner = join(reposRoot, 'not-a-dir-owner')
    await writeFile(fileOwner, 'oops\n')
    const unreadableOwner = join(reposRoot, 'unreadable-owner')
    await mkdir(unreadableOwner, {mode: 0o755})

    const ops = withReaddirFailure(unreadableOwner)
    await assert.rejects(
      migrateRepoOwnership({reposRoot, expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      error => {
        assert.match(error.message, /not-a-dir-owner/)
        assert.match(error.message, /unreadable-owner/)
        return true
      },
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('a checkout containing a nested foreign-filesystem mount fails the run and writes no marker for that checkout', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, repoDir} = await buildRepoTree(root)
    const nestedMountPath = join(repoDir, 'src', 'index.js')

    const {ops: real} = recordingOps()
    const ops = {
      ...real,
      lstat: async path => {
        const st = await real.lstat(path)
        if (path === nestedMountPath) st.dev = st.dev + 1
        return st
      },
    }

    await assert.rejects(
      migrateRepoOwnership({reposRoot, expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops}),
      error => {
        assert.match(error.message, /index\.js/)
        assert.match(error.message, /mount from another filesystem/)
        return true
      },
    )

    const markerPath = join(reposRoot, '.workspace-agent', 'completed', 'acme__widgets.json')
    assert.equal(
      await lstat(markerPath).then(
        () => true,
        () => false,
      ),
      false,
      'no marker may exist for a checkout with a skipped nested-mount entry',
    )
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

test('a leftover .tmp-* staging directory logs a warning naming it and is left untouched', async () => {
  const root = await makeTempRoot()
  try {
    const {reposRoot, ownerDir} = await buildRepoTree(root)
    const stagingDir = join(ownerDir, '.tmp-clone-abc123')
    await mkdir(stagingDir, {mode: 0o755})
    await writeFile(join(stagingDir, 'partial-file'), 'x')

    const {ops} = recordingOps()
    const logs = []
    const result = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops, log: msg => logs.push(msg)})

    assert.equal(result.ok, true)
    const warning = logs.find(m => m.includes('WARNING') && m.includes(stagingDir))
    assert.ok(warning, 'a warning naming the leftover staging dir path must be logged')

    const content = await readFile(join(stagingDir, 'partial-file'), 'utf8')
    assert.equal(content, 'x', 'leftover staging dir contents must be untouched')
  } finally {
    await rm(root, {recursive: true, force: true})
  }
})

// Real-container-only note: the assertions above prove the CALLS made to
// chown/lchown are correct (right path, right uid:gid, right ordering
// relative to hardlink-breaking) using an injectable ops object, because a
// non-root test process cannot actually chown to an arbitrary uid. Whether
// `fs.lchown`/`fs.chown` themselves correctly change on-disk ownership when
// run as real root with CAP_CHOWN is standard Node/Linux behavior verified
// by the container harness a later lane builds, not by this suite.
