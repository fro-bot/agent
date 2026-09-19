import * as fs from 'node:fs/promises'
import os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {buildAttachmentDir, createAttachmentDirExclusive} from './attachment-dir.js'

describe('buildAttachmentDir', () => {
  it('builds a run-attempt-scoped path under the attachment segment', () => {
    // #given
    const dir = buildAttachmentDir({runnerTemp: '/home/runner/work/_temp', runId: 4242, runAttempt: 3})

    // #then
    expect(dir).toBe('/home/runner/work/_temp/fro-bot-attachments/4242-3')
  })
})

describe('createAttachmentDirExclusive', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    // #given cleanup of every real temp dir this suite created, regardless of outcome
    await Promise.all(tempDirs.splice(0).map(async dir => fs.rm(dir, {recursive: true, force: true})))
  })

  async function createTempRoot(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-dir-'))
    tempDirs.push(dir)
    return dir
  }

  it('creates the directory when nothing exists at the path', async () => {
    // #given a run-attempt-scoped path with no ancestor segment yet
    const root = await createTempRoot()
    const attachmentDir = buildAttachmentDir({runnerTemp: root, runId: 1, runAttempt: 1})

    // #when
    await createAttachmentDirExclusive(attachmentDir)

    // #then a real, plain directory now exists at the exact path
    const stats = await fs.lstat(attachmentDir)
    expect(stats.isDirectory()).toBe(true)
    expect(stats.isSymbolicLink()).toBe(false)
  })

  it('accepts an already-existing real directory at that exact path (idempotent re-entry)', async () => {
    // #given the leaf directory already exists as a plain, real directory
    const root = await createTempRoot()
    const attachmentDir = buildAttachmentDir({runnerTemp: root, runId: 1, runAttempt: 1})
    await fs.mkdir(attachmentDir, {recursive: true})

    // #when / #then -- does not throw
    await expect(createAttachmentDirExclusive(attachmentDir)).resolves.toBeUndefined()
  })

  it('refuses a pre-planted symlink at the attachment path rather than following it (the fix this test pins)', async () => {
    // #given an attacker-controlled real directory elsewhere, and a symlink planted at the
    // exact, predictable run-attempt path this run is about to request
    const root = await createTempRoot()
    const attackerTarget = await createTempRoot()
    const attachmentDir = buildAttachmentDir({runnerTemp: root, runId: 1, runAttempt: 1})
    await fs.mkdir(path.dirname(attachmentDir), {recursive: true})
    await fs.symlink(attackerTarget, attachmentDir, 'dir')

    // #when / #then -- refused, not silently accepted as "the" directory
    await expect(createAttachmentDirExclusive(attachmentDir)).rejects.toThrow(/symlink/)

    // #then the symlink itself is untouched -- it was refused, not unlinked and replaced
    const stats = await fs.lstat(attachmentDir)
    expect(stats.isSymbolicLink()).toBe(true)
  })

  it('refuses a pre-existing non-directory entry (a plain file) at the attachment path', async () => {
    // #given a plain file sitting at the exact leaf path
    const root = await createTempRoot()
    const attachmentDir = buildAttachmentDir({runnerTemp: root, runId: 1, runAttempt: 1})
    await fs.mkdir(path.dirname(attachmentDir), {recursive: true})
    await fs.writeFile(attachmentDir, 'not a directory')

    // #when / #then
    await expect(createAttachmentDirExclusive(attachmentDir)).rejects.toThrow(/non-directory/)
  })

  it('refuses a symlink planted at the PARENT segment directory rather than following it into an attacker target (the bypass this test pins)', async () => {
    // #given an attacker-controlled real directory elsewhere, and a symlink planted at the shared
    // `fro-bot-attachments` segment directory -- one level above the leaf, but still a fixed,
    // predictable path this code names before the leaf is ever touched
    const root = await createTempRoot()
    const attackerTarget = await createTempRoot()
    const attachmentDir = buildAttachmentDir({runnerTemp: root, runId: 1, runAttempt: 1})
    await fs.symlink(attackerTarget, path.dirname(attachmentDir), 'dir')

    // #when / #then -- refused before any leaf creation is attempted through the symlink
    await expect(createAttachmentDirExclusive(attachmentDir)).rejects.toThrow(/symlink/)

    // #then the symlink itself is untouched, and nothing was created inside the attacker's target
    const segmentStats = await fs.lstat(path.dirname(attachmentDir))
    expect(segmentStats.isSymbolicLink()).toBe(true)
    await expect(fs.lstat(path.join(attackerTarget, `${1}-${1}`))).rejects.toThrow(/ENOENT/)
  })

  it('refuses a pre-existing non-directory entry (a plain file) at the PARENT segment directory', async () => {
    // #given a plain file sitting at the shared segment path instead of a directory
    const root = await createTempRoot()
    const attachmentDir = buildAttachmentDir({runnerTemp: root, runId: 1, runAttempt: 1})
    await fs.writeFile(path.dirname(attachmentDir), 'not a directory')

    // #when / #then
    await expect(createAttachmentDirExclusive(attachmentDir)).rejects.toThrow(/non-directory/)
  })
})
