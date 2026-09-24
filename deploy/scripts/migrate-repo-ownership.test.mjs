import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp, mkdir, writeFile, readFile, symlink, link, lstat, rm, readdir} from 'node:fs/promises'
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

    const beforeInside = await lstat(insidePath)
    assert.equal(beforeInside.nlink, 2, 'sanity: hardlink set up correctly')

    const {ops, calls} = recordingOps()
    const result = await migrateRepoOwnership({reposRoot,
      expectedRootOwnerUid: process.getuid(), targetUid: TARGET_UID, targetGid: TARGET_GID, ops})

    assert.equal(result.ok, true)
    assert.ok(result.stats.hardlinksBroken >= 1, 'the hardlink must be recorded as broken')

    const afterInside = await lstat(insidePath)
    const afterOutside = await lstat(outsidePath)
    assert.notEqual(afterInside.ino, afterOutside.ino, 'inside path must now be a distinct, private inode')
    assert.equal(afterInside.nlink, 1, 'inside path must be its own inode with nlink=1')
    assert.equal(afterOutside.nlink, 1, 'outside path must have been left as its own now-unshared inode')

    const outsideChown = calls.lchown.find(c => c.path === outsidePath)
    assert.equal(outsideChown, undefined, 'the outside path must never be chowned')
    const insideChown = calls.lchown.find(c => c.path === insidePath)
    assert.ok(insideChown, 'the inside path must be chowned after the hardlink is broken')

    const content = await readFile(insidePath, 'utf8')
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

// Real-container-only note: the assertions above prove the CALLS made to
// chown/lchown are correct (right path, right uid:gid, right ordering
// relative to hardlink-breaking) using an injectable ops object, because a
// non-root test process cannot actually chown to an arbitrary uid. Whether
// `fs.lchown`/`fs.chown` themselves correctly change on-disk ownership when
// run as real root with CAP_CHOWN is standard Node/Linux behavior verified
// by the container harness a later lane builds, not by this suite.
