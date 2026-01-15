import type {CacheAdapter} from './lib/cache.js'
import type {Logger} from './lib/logger.js'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('@actions/core', () => ({
  getState: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

function createMockCacheAdapter(options: {saveFails?: boolean} = {}): CacheAdapter {
  return {
    restoreCache: vi.fn().mockResolvedValue(undefined),
    saveCache:
      options.saveFails === true
        ? vi.fn().mockRejectedValue(new Error('Cache save failed'))
        : vi.fn().mockResolvedValue(1234),
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
      const cacheAdapter = createMockCacheAdapter()

      await runPost({logger, cacheAdapter})

      expect(cacheAdapter.saveCache).not.toHaveBeenCalled()
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
      const cacheAdapter = createMockCacheAdapter()

      await runPost({logger, cacheAdapter})

      expect(cacheAdapter.saveCache).not.toHaveBeenCalled()
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

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()
      const cacheAdapter = createMockCacheAdapter()

      await runPost({logger, cacheAdapter})

      expect(cacheAdapter.saveCache).toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith('Post-action cache saved', expect.any(Object))
    })

    it('should not fail job when cache save fails', async () => {
      const core = await import('@actions/core')
      vi.mocked(core.getState).mockImplementation((key: string) => {
        if (key === 'shouldSaveCache') return 'true'
        if (key === 'cacheSaved') return 'false'
        return ''
      })

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()
      const cacheAdapter = createMockCacheAdapter({saveFails: true})

      await expect(runPost({logger, cacheAdapter})).resolves.not.toThrow()

      expect(logger.warning).toHaveBeenCalledWith(
        'Cache save failed',
        expect.objectContaining({error: expect.any(String) as unknown}),
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

      const {runPost} = await import('./post.js')
      const logger = createMockLogger()
      const cacheAdapter = createMockCacheAdapter()

      await runPost({logger, cacheAdapter})

      expect(logger.info).toHaveBeenCalledWith(
        'Post-action cache saved',
        expect.objectContaining({sessionId: 'ses_abc123'}),
      )
    })
  })
})
