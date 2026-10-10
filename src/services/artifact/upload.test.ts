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
      invocationIdentity: null,
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
    vi.mocked(fs.readdir).mockResolvedValue([])

    const {uploadLogArtifact} = await import('./upload.js')
    const logger = createMockLogger()

    // #when upload is attempted
    const result = await uploadLogArtifact({
      logPath: '/empty/log',
      runId: 12345,
      runAttempt: 1,
      invocationIdentity: null,
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
      invocationIdentity: null,
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
      invocationIdentity: null,
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
      invocationIdentity: null,
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
    await uploadLogArtifact({logPath: '/logs', runId: 1, runAttempt: 1, invocationIdentity: null, logger})

    // #then only files are included, not directories
    expect(mockUploadArtifact).toHaveBeenCalledWith(
      expect.any(String),
      ['/logs/subdir/nested.log'],
      '/logs',
      expect.any(Object),
    )
  })

  it('names the artifact per job so two jobs of one run do not upload under the same name', async () => {
    // #given Remediate then Observe in one run and attempt, each with files and a succeeding upload
    const fs = await import('node:fs/promises')
    vi.mocked(fs.access).mockResolvedValue(undefined)
    vi.mocked(fs.readdir).mockResolvedValue([
      {name: 'opencode.log', parentPath: '/logs', isFile: () => true, isDirectory: () => false},
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)
    mockUploadArtifact.mockResolvedValue({size: 1, id: 1})
    const {uploadLogArtifact} = await import('./upload.js')

    // #when each job uploads
    for (const invocationIdentity of ['fro-bot-remediate', 'fro-bot-observe']) {
      await uploadLogArtifact({
        logPath: '/logs',
        runId: 38026680860,
        runAttempt: 1,
        invocationIdentity,
        logger: createMockLogger(),
      })
    }

    // #then the names differ and keep run ID / attempt before the job
    const names = mockUploadArtifact.mock.calls.map(call => String(call[0]))
    expect(names).toEqual([
      'opencode-logs-38026680860-1-fro-bot-remediate',
      'opencode-logs-38026680860-1-fro-bot-observe',
    ])
  })

  it('re-run attempt 2 of the same job uploads under a distinct name from attempt 1', async () => {
    // #given the same job's attempt 1 and re-run attempt 2
    const {buildLogArtifactName} = await import('./upload.js')

    // #when naming both
    const attempt1 = buildLogArtifactName(38026680860, 1, 'fro-bot-observe')
    const attempt2 = buildLogArtifactName(38026680860, 2, 'fro-bot-observe')

    // #then distinct, and a null identity (outside a runner) keeps the legacy shape
    expect(attempt1).toBe('opencode-logs-38026680860-1-fro-bot-observe')
    expect(attempt2).toBe('opencode-logs-38026680860-2-fro-bot-observe')
    expect(buildLogArtifactName(99, 2, null)).toBe('opencode-logs-99-2')
  })
})
