import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../shared/test-helpers.js'

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

describe('post action', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo'
    process.env.GITHUB_REF_NAME = 'main'
    process.env.GITHUB_RUN_ID = '12345'
    process.env.RUNNER_OS = 'Linux'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.GITHUB_REPOSITORY
    delete process.env.GITHUB_REF_NAME
    delete process.env.GITHUB_RUN_ID
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
      // #given artifact upload is enabled and not yet done
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

      // #when runPost executes
      await runPost({logger})

      // #then artifact upload is called
      expect(uploadLogArtifact).toHaveBeenCalledWith(expect.objectContaining({runId: 12345, runAttempt: 1}))
    })

    it('should skip artifact upload when already uploaded by main action', async () => {
      // #given artifact was already uploaded
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

      // #when runPost executes
      await runPost({logger})

      // #then artifact upload is not called
      expect(uploadLogArtifact).not.toHaveBeenCalled()
    })

    it('should skip artifact upload when OPENCODE_PROMPT_ARTIFACT is not set', async () => {
      // #given artifact upload is disabled
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

      // #when runPost executes
      await runPost({logger})

      // #then artifact upload is not called
      expect(uploadLogArtifact).not.toHaveBeenCalled()
    })

    it('should not fail when artifact upload throws in post action', async () => {
      // #given artifact upload throws
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

      // #when runPost executes
      await expect(runPost({logger})).resolves.not.toThrow()

      // #then it logs a warning but doesn't fail
      expect(logger.warning).toHaveBeenCalledWith(
        'Post-action artifact upload failed (non-fatal)',
        expect.objectContaining({error: 'Network timeout'}),
      )
    })
  })
})
