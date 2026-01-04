import type {ActionOutputs} from './types.js'
import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import {setActionOutputs} from './outputs.js'

// Mock @actions/core
vi.mock('@actions/core', () => ({
  setOutput: vi.fn(),
}))

describe('setActionOutputs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sets all output values correctly', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: 'ses_abc123',
      cacheStatus: 'hit',
      duration: 1500,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledTimes(3)
    expect(mockSetOutput).toHaveBeenCalledWith('session-id', 'ses_abc123')
    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'hit')
    expect(mockSetOutput).toHaveBeenCalledWith('duration', 1500)
  })

  it('handles null session-id', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: null,
      cacheStatus: 'miss',
      duration: 500,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('session-id', '')
    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'miss')
    expect(mockSetOutput).toHaveBeenCalledWith('duration', 500)
  })

  it('handles corrupted cache status', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: 'ses_xyz789',
      cacheStatus: 'corrupted',
      duration: 2000,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'corrupted')
  })

  it('handles zero duration', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: null,
      cacheStatus: 'miss',
      duration: 0,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('duration', 0)
  })
})
