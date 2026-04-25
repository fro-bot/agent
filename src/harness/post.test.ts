import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../shared/test-helpers.js'
import {ok} from '../shared/types.js'

vi.mock('@actions/core', () => ({
  getState: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../services/cache/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../services/cache/index.js')>()
  return {
    ...original,
    saveCache: vi.fn(),
  }
})

vi.mock('../services/artifact/index.js', () => ({
  uploadLogArtifact: vi.fn(),
}))

vi.mock('@fro-bot/runtime', async importOriginal => {
  const original = await importOriginal<typeof import('@fro-bot/runtime')>()
  return {
    ...original,
    createS3Adapter: vi.fn(),
    syncArtifactsToStore: vi.fn(async () => ({uploaded: 0, failed: 0})),
    syncMetadataToStore: vi.fn(async () => ({success: true})),
  }
})

describe('post action', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.GITHUB_RUN_ID = '12345'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    process.env.RUNNER_OS = 'Linux'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_REF_NAME
    delete process.env.GITHUB_RUN_ID
    delete process.env.GITHUB_RUN_ATTEMPT
    delete process.env.RUNNER_OS
  })

  describe('runPost', () => {
    it('should skip cache save when shouldSaveCache is false', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'false'
        return ''
      })

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      const {saveCache} = await import('../services/cache/index.js')
      expect(saveCache).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith('Skipping post-action: event was not processed', expect.any(Object))
    })

    it('should skip cache save when cache was already saved', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'true'
        return ''
      })

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      const {saveCache} = await import('../services/cache/index.js')
      expect(saveCache).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        'Skipping post-action: cache already saved by main action',
        expect.any(Object),
      )
    })

    it('should save cache when shouldSaveCache is true and cacheSaved is false', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        if (key === 'sessionId') return 'ses_123'
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockResolvedValue(true)

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(saveCache).toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
    })

    it('reconstructs storeConfig from state and passes it to saveCache', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        if (key === 'storeConfig.enabled') return 'true'
        if (key === 'storeConfig.bucket') return 'test-bucket'
        if (key === 'storeConfig.region') return 'us-east-1'
        if (key === 'storeConfig.prefix') return 'fro-bot-state'
        if (key === 'storeConfig.endpoint') return 'https://example.r2.cloudflarestorage.com'
        if (key === 'storeConfig.expectedBucketOwner') return '123456789012'
        if (key === 'storeConfig.allowInsecureEndpoint') return 'false'
        if (key === 'storeConfig.sseEncryption') return 'AES256'
        if (key === 'storeConfig.sseKmsKeyId') return 'kms-key-1'
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockResolvedValue(true)

      const {runPost} = await import('./post.js')
      await runPost({logger: createMockLogger()})

      expect(saveCache).toHaveBeenCalledWith(
        expect.objectContaining({
          storeConfig: {
            enabled: true,
            bucket: 'test-bucket',
            region: 'us-east-1',
            prefix: 'fro-bot-state',
            endpoint: 'https://example.r2.cloudflarestorage.com',
            expectedBucketOwner: '123456789012',
            allowInsecureEndpoint: false,
            sseEncryption: 'AES256',
            sseKmsKeyId: 'kms-key-1',
          },
        }),
      )
    })

    it('skips storeConfig reconstruction when state keys are missing', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        if (key === 'storeConfig.enabled') return ''
        if (key === 'storeConfig.bucket') return ''
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockResolvedValue(true)

      const {runPost} = await import('./post.js')
      await runPost({logger: createMockLogger()})

      const firstCall = vi.mocked(saveCache).mock.calls[0]
      expect(firstCall).toBeDefined()
      expect(firstCall?.[0]).not.toHaveProperty('storeConfig')
    })

    it('should log no content message when saveCache returns false', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        if (key === 'sessionId') return 'ses_123'
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockResolvedValue(false)

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(saveCache).toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        'Post-action: no cache content to save',
        expect.objectContaining({sessionId: 'ses_123'}),
      )
    })

    it('should not fail job when cache save throws', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockRejectedValue(new Error('Cache save failed'))

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await expect(runPost({logger})).resolves.not.toThrow()

      expect(logger.warning).toHaveBeenCalledWith(
        'Post-action cache save failed (non-fatal)',
        expect.objectContaining({error: 'Cache save failed'}),
      )
    })

    it('should log sessionId when available', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        if (key === 'sessionId') return 'ses_abc123'
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockResolvedValue(true)

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(logger.info).toHaveBeenCalledWith(
        'Post-action cache saved',
        expect.objectContaining({sessionId: 'ses_abc123'}),
      )
    })

    it('should upload artifact when OPENCODE_PROMPT_ARTIFACT is enabled and not yet uploaded', async () => {
      process.env.OPENCODE_PROMPT_ARTIFACT = 'true'
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'true'
        if (key === 'artifactUploaded') return ''
        return ''
      })

      const {uploadLogArtifact} = await import('../services/artifact/index.js')
      vi.mocked(uploadLogArtifact).mockResolvedValue(true)

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(uploadLogArtifact).toHaveBeenCalledWith(expect.objectContaining({runId: 12345, runAttempt: 1}))
    })

    it('should skip artifact upload when already uploaded by main action', async () => {
      process.env.OPENCODE_PROMPT_ARTIFACT = 'true'
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'true'
        if (key === 'artifactUploaded') return 'true'
        return ''
      })

      const {uploadLogArtifact} = await import('../services/artifact/index.js')

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(uploadLogArtifact).not.toHaveBeenCalled()
    })

    it('should skip artifact upload when OPENCODE_PROMPT_ARTIFACT is not set', async () => {
      delete process.env.OPENCODE_PROMPT_ARTIFACT
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'true'
        return ''
      })

      const {uploadLogArtifact} = await import('../services/artifact/index.js')

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(uploadLogArtifact).not.toHaveBeenCalled()
    })

    it('should not fail when artifact upload throws in post action', async () => {
      process.env.OPENCODE_PROMPT_ARTIFACT = 'true'
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'true'
        if (key === 'artifactUploaded') return ''
        return ''
      })

      const {uploadLogArtifact} = await import('../services/artifact/index.js')
      vi.mocked(uploadLogArtifact).mockRejectedValue(new Error('Network timeout'))

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await expect(runPost({logger})).resolves.not.toThrow()

      expect(logger.warning).toHaveBeenCalledWith(
        'Post-action artifact upload failed (non-fatal)',
        expect.objectContaining({error: 'Network timeout'}),
      )
    })

    it('uploads minimal metadata when cleanup was skipped and storeConfig exists', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        if (key === 'storeConfig.enabled') return 'true'
        if (key === 'storeConfig.bucket') return 'test-bucket'
        if (key === 'storeConfig.region') return 'us-east-1'
        if (key === 'storeConfig.prefix') return 'fro-bot-state'
        return ''
      })

      const {saveCache} = await import('../services/cache/index.js')
      vi.mocked(saveCache).mockResolvedValue(true)

      const {createS3Adapter, syncArtifactsToStore, syncMetadataToStore} = await import('@fro-bot/runtime')
      vi.mocked(createS3Adapter).mockReturnValue({
        upload: async () => ok(undefined),
        download: async () => ok(undefined),
        list: async () => ok([]),
      })

      const {runPost} = await import('./post.js')
      await runPost({logger: createMockLogger()})

      expect(syncMetadataToStore).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({enabled: true}),
        'github',
        'test-owner/test-repo',
        '12345',
        expect.objectContaining({runId: '12345', cleanupSkipped: true, runAttempt: 1}),
        expect.any(Object),
      )
      expect(syncArtifactsToStore).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({enabled: true}),
        'github',
        'test-owner/test-repo',
        '12345',
        expect.any(String),
        expect.any(Object),
      )
    })
  })
})
