import type {ActionOutputs} from '../../shared/types.js'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import * as core from '@actions/core'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parse} from 'yaml'
import {CACHE_SAVE_STATE_VALUES} from '../../shared/cache-save-result.js'
import {setActionOutputs, setCacheSaveResultOutput} from './outputs.js'

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
      deliveryKind: 'comment',
      resolvedOutputMode: 'working-dir',
      brokeredPushAllowlist: {
        defaultPaths: ['src/'],
        rootFiles: ['README.md'],
        extraPrefixes: [],
      },
      cacheStatus: 'hit',
      duration: 1500,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledTimes(6)
    expect(mockSetOutput).toHaveBeenCalledWith('session-id', 'ses_abc123')
    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', 'working-dir')
    expect(mockSetOutput).toHaveBeenCalledWith('delivery-kind', 'comment')
    expect(mockSetOutput).toHaveBeenCalledWith(
      'brokered-push-allowlist',
      JSON.stringify({defaultPaths: ['src/'], rootFiles: ['README.md'], extraPrefixes: []}),
    )
    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'hit')
    expect(mockSetOutput).toHaveBeenCalledWith('duration', 1500)
  })

  it('handles null session-id', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: null,
      deliveryKind: 'none',
      resolvedOutputMode: null,
      cacheStatus: 'miss',
      duration: 500,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('session-id', '')
    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', '')
    expect(mockSetOutput).toHaveBeenCalledWith('delivery-kind', 'none')
    expect(mockSetOutput).toHaveBeenCalledWith('brokered-push-allowlist', '')
    expect(mockSetOutput).toHaveBeenCalledWith('cache-status', 'miss')
    expect(mockSetOutput).toHaveBeenCalledWith('duration', 500)
  })

  it('handles corrupted cache status', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputs: ActionOutputs = {
      sessionId: 'ses_xyz789',
      deliveryKind: 'none',
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
      deliveryKind: 'none',
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
      deliveryKind: 'none',
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
      deliveryKind: 'none',
      resolvedOutputMode: null,
      cacheStatus: 'hit',
      duration: 42,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', '')
  })

  it('emits the stable machine-readable output-mode migration record when provided', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputModeMigration = {
      requested: 'auto' as const,
      resolved: 'working-dir' as const,
    }
    const outputs: ActionOutputs = {
      sessionId: 'ses_output_mode_migration',
      deliveryKind: 'none',
      resolvedOutputMode: 'working-dir',
      outputModeMigration,
      cacheStatus: 'hit',
      duration: 42,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('output-mode-migration', JSON.stringify(outputModeMigration))
  })

  it('emits an explicit null migration and empty scalar when resolution is unavailable', () => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>
    const outputModeMigration = {
      requested: 'omitted' as const,
      resolved: null,
    }
    const outputs: ActionOutputs = {
      sessionId: null,
      deliveryKind: 'none',
      resolvedOutputMode: null,
      outputModeMigration,
      cacheStatus: 'miss',
      duration: 0,
    }

    setActionOutputs(outputs)

    expect(mockSetOutput).toHaveBeenCalledWith('resolved-output-mode', '')
    expect(mockSetOutput).toHaveBeenCalledWith('output-mode-migration', JSON.stringify(outputModeMigration))
  })
})

describe('setCacheSaveResultOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each(CACHE_SAVE_STATE_VALUES)('sets cache-save-result to %s', value => {
    const mockSetOutput = core.setOutput as ReturnType<typeof vi.fn>

    setCacheSaveResultOutput(value)

    expect(mockSetOutput).toHaveBeenCalledWith('cache-save-result', value)
  })
})

describe('outputs written by this module are declared in action.yaml', () => {
  // A drift here means an output some caller relies on silently stops existing in the
  // metadata GitHub Actions actually reads (or a typo diverges the two), and nothing else
  // catches it: every existing test here mocks core.setOutput and never touches action.yaml.
  it('every core.setOutput key in outputs.ts has a matching action.yaml output', () => {
    const outputsSource = readFileSync(join(import.meta.dirname, 'outputs.ts'), 'utf8')
    const declaredKeys = [...outputsSource.matchAll(/core\.setOutput\(\s*'([^']+)'/g)]
      .map(match => match[1])
      .filter((key): key is string => key != null)
    expect(declaredKeys.length).toBeGreaterThan(0)

    const actionYaml = parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'action.yaml'), 'utf8')) as {
      outputs?: Record<string, unknown>
    }
    expect(actionYaml.outputs).toBeDefined()

    for (const key of new Set(declaredKeys)) {
      expect(actionYaml.outputs).toHaveProperty(key)
    }
  })
})
