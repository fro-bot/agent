import type {ActionOutputs} from '../../shared/types.js'
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
      resolvedOutputMode: 'working-dir',
      cacheStatus: 'hit',
      duration: 1500,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledTimes(4)
    expect(mockSetOutput).toHaveBeenCalledWith('session-id', 'ses_abc123')
    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', 'working-dir')
    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'hit')
    expect(mockSetOutput).toHaveBeenCalledWith('duration', 1500)
  })

  it('handles null session-id', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: null,
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      duration: 500,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('session-id', '')
    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', '')
    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'miss')
    expect(mockSetOutput).toHaveBeenCalledWith('duration', 500)
  })

  it('handles corrupted cache status', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: 'ses_xyz789',
      resolvedOutputMode: 'branch-pr',
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
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      duration: 0,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('duration', 0)
  })

  it('emits resolved-output-mode field when set', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: 'ses_output_mode',
      resolvedOutputMode: 'branch-pr',
      cacheStatus: 'hit',
      duration: 42,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', 'branch-pr')
  })

  it('emits empty string for resolved-output-mode when null', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: 'ses_output_mode',
      resolvedOutputMode: null,
      cacheStatus: 'hit',
      duration: 42,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', '')
  })
})
