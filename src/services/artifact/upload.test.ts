import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'

const {mockUploadArtifact} = vi.hoisted(() => ({
  mockUploadArtifact: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readdir: vi.fn(),
}))

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: class MockArtifactClient {
    uploadArtifact = mockUploadArtifact
  },
}))

describe('uploadLogArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns false when log directory does not exist', async () => {
    // #given the log directory does not exist
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'))

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted
    const result = await uploadLogArtifact({
      logPath: '/nonexistent/path',
      runId: 12345,
      runAttempt: 1,
      logger,
    })

    // #then it returns false and logs info
    expect(result).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(
      'Log directory does not exist, skipping artifact upload',
      expect.objectContaining({logPath: '/nonexistent/path'}),
    )
  })

  it('returns false when log directory is empty', async () => {
    // #given the log directory exists but contains no files
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.readdir).mockResolvedValue([] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted
    const result = await uploadLogArtifact({
      logPath: '/empty/log',
      runId: 12345,
      runAttempt: 1,
      logger,
    })

    // #then it returns false and logs info
    expect(result).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(
      'No log files found, skipping artifact upload',
      expect.objectContaining({logPath: '/empty/log'}),
    )
  })

  it('uploads artifact and returns true on success', async () => {
    // #given the log directory has files and upload succeeds
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'prompt.txt', parentPath: '/logs', isFile: () => true, isDirectory: () => false},
      {name: 'session.log', parentPath: '/logs', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    mockUploadArtifact.mockResolvedValue({size: 1024, id: 42})

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted
    const result = await uploadLogArtifact({
      logPath: '/logs',
      runId: 99,
      runAttempt: 2,
      logger,
    })

    // #then it returns true, calls the client correctly, and logs success
    expect(result).toBe(true)
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      'opencode-logs-99-2',
      expect.arrayContaining(['/logs/prompt.txt', '/logs/session.log']),
      '/logs',
      expect.objectContaining({retentionDays: 7, compressionLevel: 9}),
    )
    expect(logger.info).toHaveBeenCalledWith(
      'Artifact uploaded',
      expect.objectContaining({name: 'opencode-logs-99-2', fileCount: 2}),
    )
  })

  it('returns false and logs warning when upload throws', async () => {
    // #given the log directory has files but upload fails
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'file.log', parentPath: '/logs', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    mockUploadArtifact.mockRejectedValue(new Error('Upload quota exceeded'))

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted
    const result = await uploadLogArtifact({
      logPath: '/logs',
      runId: 12345,
      runAttempt: 1,
      logger,
    })

    // #then it returns false and logs a non-fatal warning
    expect(result).toBe(false)
    expect(logger.warning).toHaveBeenCalledWith(
      'Artifact upload failed (non-fatal)',
      expect.objectContaining({error: 'Upload quota exceeded', name: 'opencode-logs-12345-1'}),
    )
  })

  it('respects custom retention and compression options', async () => {
    // #given custom options are provided
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'file.log', parentPath: '/logs', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    mockUploadArtifact.mockResolvedValue({size: 512, id: 1})

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted with custom options
    await uploadLogArtifact({
      logPath: '/logs',
      runId: 1,
      runAttempt: 1,
      retentionDays: 30,
      compressionLevel: 0,
      logger,
    })

    // #then the custom options are passed through
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      '/logs',
      expect.objectContaining({retentionDays: 30, compressionLevel: 0}),
    )
  })

  it('skips directory entries during file collection', async () => {
    // #given readdir returns a mix of files and directories
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'subdir', parentPath: '/logs', isFile: () => false, isDirectory: () => true},
      {name: 'nested.log', parentPath: '/logs/subdir', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

    mockUploadArtifact.mockResolvedValue({size: 256, id: 7})

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted
    await uploadLogArtifact({logPath: '/logs', runId: 1, runAttempt: 1, logger})

    // #then only files are included, not directories
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      expect.any(String),
      ['/logs/subdir/nested.log'],
      '/logs',
      expect.any(Object),
    )
  })
})
