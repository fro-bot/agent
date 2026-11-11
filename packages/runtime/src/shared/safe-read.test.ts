import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {openRegularFileNoFollow, readTextNoFollow} from './safe-read.js'

describe('readTextNoFollow', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-read-')))
  })
  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  const codeOf = async (action: () => Promise<unknown>): Promise<string | undefined> =>
    action().then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error.code,
    )

  it('reads a regular file', async () => {
    // #given a regular file
    const file = path.join(dir, 'response.md')
    fs.writeFileSync(file, 'hello')

    // #when / #then
    expect(await readTextNoFollow(file)).toBe('hello')
  })

  it('keeps ENOENT as ENOENT so existing missing-file handling still works', async () => {
    expect(await codeOf(async () => readTextNoFollow(path.join(dir, 'nope')))).toBe('ENOENT')
  })

  it('refuses a symlink and never reads its target (positive control: a plain read follows it)', async () => {
    // #given a link to a runner-owned sentinel
    const sentinel = path.join(dir, 'sentinel.txt')
    fs.writeFileSync(sentinel, 'runner secret')
    const link = path.join(dir, 'response.md')
    fs.symlinkSync(sentinel, link)

    // #then a plain read follows the link (the control), and the no-follow read refuses it
    expect(fs.readFileSync(link, 'utf8')).toBe('runner secret')
    expect(await codeOf(async () => readTextNoFollow(link))).toBe('ELOOP')
  })

  it('refuses a directory', async () => {
    const target = path.join(dir, 'a-dir')
    fs.mkdirSync(target)
    expect(await codeOf(async () => readTextNoFollow(target))).toBe('ENOTREG')
  })

  it('refuses a FIFO without blocking', async () => {
    // #given a FIFO where the response file belongs (a blocking open would hang the run)
    const fifo = path.join(dir, 'response.md')
    execFileSync('mkfifo', [fifo])

    // #when / #then it is refused promptly
    expect(await codeOf(async () => readTextNoFollow(fifo))).toBe('ENOTREG')
  })

  it('refuses a file over the size bound', async () => {
    const file = path.join(dir, 'big')
    fs.writeFileSync(file, 'x'.repeat(100))
    expect(await codeOf(async () => readTextNoFollow(file, {maxBytes: 10}))).toBe('EFBIG')
  })

  it('refuses a path that reaches the file through a symlinked directory outside the root', async () => {
    // #given a workspace whose subdirectory is a link to a directory elsewhere that holds a same-named file
    const workspace = path.join(dir, 'ws')
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(workspace)
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, 'r.md'), 'outside')
    fs.symlinkSync(elsewhere, path.join(workspace, 'sub'))
    const viaLink = path.join(workspace, 'sub', 'r.md')

    // #then O_NOFOLLOW alone would read it; `within` refuses
    expect(await readTextNoFollow(viaLink)).toBe('outside')
    expect(await codeOf(async () => readTextNoFollow(viaLink, {within: workspace}))).toBe('EOUTSIDE')
  })

  it('closes the handle when it refuses', async () => {
    const target = path.join(dir, 'a-dir')
    fs.mkdirSync(target)
    const before = fs.readdirSync('/dev/fd').length
    await codeOf(async () => openRegularFileNoFollow(target))
    expect(fs.readdirSync('/dev/fd').length).toBeLessThanOrEqual(before + 1)
  })
})
