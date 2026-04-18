import {beforeEach, describe, expect, it, vi} from 'vitest'
import {setActionOutputs} from './config/outputs.js'
import {run} from './run.js'

vi.mock('@actions/core', () => ({
  saveState: vi.fn(),
  setFailed: vi.fn(),
}))

vi.mock('../features/agent/index.js', () => ({}))

vi.mock('../features/observability/index.js', () => ({
  createMetricsCollector: vi.fn(() => ({
    start: vi.fn(),
    end: vi.fn(),
    recordError: vi.fn(),
  })),
}))

vi.mock('../shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  })),
}))

vi.mock('./config/outputs.js', () => ({
  setActionOutputs: vi.fn(),
}))

vi.mock('./config/state-keys.js', () => ({
  STATE_KEYS: {
    SHOULD_SAVE_CACHE: 'should-save-cache',
    CACHE_SAVED: 'cache-saved',
  },
}))

vi.mock('./phases/acknowledge.js', () => ({
  runAcknowledge: vi.fn(),
}))

vi.mock('./phases/bootstrap.js', () => ({
  runBootstrap: vi.fn(),
}))

vi.mock('./phases/cache-restore.js', () => ({
  runCacheRestore: vi.fn(),
}))

vi.mock('./phases/cleanup.js', () => ({
  runCleanup: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./phases/dedup.js', () => ({
  runDedup: vi.fn(),
  saveDedupMarker: vi.fn(),
}))

vi.mock('./phases/execute.js', () => ({
  runExecute: vi.fn(),
}))

vi.mock('./phases/finalize.js', () => ({
  runFinalize: vi.fn(),
}))

vi.mock('./phases/routing.js', () => ({
  runRouting: vi.fn(),
}))

vi.mock('./phases/session-prep.js', () => ({
  runSessionPrep: vi.fn(),
}))

describe('run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emits empty resolved-output-mode when bootstrap fails', async () => {
    const {runBootstrap} = await import('./phases/bootstrap.js')

    vi.mocked(runBootstrap).mockResolvedValue(null)

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
  })

  it('emits empty resolved-output-mode when an unhandled error reaches the catch block', async () => {
    const {runBootstrap} = await import('./phases/bootstrap.js')

    vi.mocked(runBootstrap).mockRejectedValue(new Error('boom'))

    const exitCode = await run()

    expect(exitCode).toBe(1)
    expect(vi.mocked(setActionOutputs)).toHaveBeenCalledWith({
      sessionId: null,
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      duration: expect.any(Number),
    })
  })
})
