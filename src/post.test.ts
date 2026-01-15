import type {Logger} from './lib/logger.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@actions/core', () => ({
  getState: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('./lib/cache.js', async importOriginal => {
  const original = await importOriginal<typeof import('./lib/cache.js')>()
  return {
    ...original,
    saveCache: vi.fn(),
  }
})

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

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

      const {saveCache} = await import('./lib/cache.js')
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

      const {saveCache} = await import('./lib/cache.js')
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

      const {saveCache} = await import('./lib/cache.js')
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

      const {saveCache} = await import('./lib/cache.js')
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

      const {saveCache} = await import('./lib/cache.js')
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

      const {saveCache} = await import('./lib/cache.js')
      vi.mocked(saveCache).mockResolvedValue(true)

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()

      await runPost({logger})

      expect(logger.info).toHaveBeenCalledWith(
        'Post-action cache saved',
        expect.objectContaining({sessionId: 'ses_abc123'}),
      )
    })
  })
})
