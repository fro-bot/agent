import type {Logger} from '../shared/logger.js'
import type {ReferenceFile} from './types.js'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {materializeReferenceFiles} from './reference-files.js'

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  }
}

describe('materializeReferenceFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates files and returns file parts', async () => {
    // #given
    const logger = createMockLogger()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-files-'))
    const referenceFiles: readonly ReferenceFile[] = [
      {filename: 'pr-context.txt', content: 'PR body'},
      {filename: 'diff-summary.txt', content: 'Diff summary'},
    ]

    // #when
    const fileParts = await materializeReferenceFiles(referenceFiles, dir, logger)

    // #then
    expect(fileParts).toHaveLength(2)
    expect(fileParts).toEqual([
      expect.objectContaining({type: 'file', mime: 'text/plain', filename: 'pr-context.txt'}),
      expect.objectContaining({type: 'file', mime: 'text/plain', filename: 'diff-summary.txt'}),
    ])
    expect(fileParts[0]?.url.startsWith('file://')).toBe(true)
    await expect(fs.readFile(path.join(dir, 'pr-context.txt'), 'utf8')).resolves.toBe('PR body')
    await expect(fs.readFile(path.join(dir, 'diff-summary.txt'), 'utf8')).resolves.toBe('Diff summary')
  })

  it('returns empty array for empty input', async () => {
    // #given
    const logger = createMockLogger()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-files-empty-'))

    // #when
    const fileParts = await materializeReferenceFiles([], dir, logger)

    // #then
    expect(fileParts).toEqual([])
  })

  it('logs warning and skips failed writes', async () => {
    // #given
    const logger: Logger = createMockLogger()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-files-fail-'))
    const referenceFiles: readonly ReferenceFile[] = [
      {filename: 'ok.txt', content: 'works'},
      {filename: 'bad.txt', content: 'fails'},
    ]
    const writeReferenceFile = vi.fn(async (filePath: string, content: string) => {
      if (filePath.endsWith('bad.txt')) {
        throw new Error('disk full')
      }

      await fs.writeFile(filePath, content, 'utf8')
    })

    // #when
    const fileParts = await materializeReferenceFiles(referenceFiles, dir, logger, writeReferenceFile)

    // #then
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0]).toEqual(expect.objectContaining({filename: 'ok.txt'}))
    expect(writeReferenceFile).toHaveBeenCalledTimes(2)
    expect(logger.warning).toHaveBeenCalledWith(
      'Failed to materialize reference file',
      expect.objectContaining({filename: 'bad.txt', error: 'disk full'}),
    )
  })
})
