import {Buffer} from 'node:buffer'
import * as exec from '@actions/exec'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger} from '../../shared/test-helpers.js'
import {runtimeSetupAdapter} from './runtime-setup-adapter.js'

vi.mock('@actions/exec', () => ({exec: vi.fn()}))
vi.mock('@actions/core', () => ({addPath: vi.fn()}))
vi.mock('./setup.js', () => ({runSetup: vi.fn()}))

function stubVersionOutput(output: string): void {
  vi.mocked(exec.exec).mockImplementation(async (_cmd, _args, options) => {
    options?.listeners?.stdout?.(Buffer.from(output))
    return 0
  })
}

describe('runtimeSetupAdapter.verifyOpenCodeAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports the full harness version token so the caller can compare it with the pin', async () => {
    // #given a harness binary that self-reports its integration commit
    stubVersionOutput('1.18.34+harness.6546eb64\n')

    // #when
    const result = await runtimeSetupAdapter.verifyOpenCodeAvailable('/opt/opencode', createMockLogger())

    // #then the suffix is kept
    expect(exec.exec).toHaveBeenCalledWith('/opt/opencode', ['--version'], expect.any(Object))
    expect(result).toEqual({available: true, version: '1.18.34+harness.6546eb64'})
  })

  it('reports a stock version without a suffix', async () => {
    // #given stock opencode
    stubVersionOutput('1.18.34\n')

    // #when
    const result = await runtimeSetupAdapter.verifyOpenCodeAvailable(null, createMockLogger())

    // #then
    expect(result).toEqual({available: true, version: '1.18.34'})
  })

  it.each([
    ['opencode version 1.18.34+harness.6546eb64\n', '1.18.34+harness.6546eb64'],
    ['1.2.3-rc.1\n', '1.2.3-rc.1'],
    ['opencode version 1.2.3\n', '1.2.3'],
  ])('reports the full version token, ignoring a text prefix, for %j', async (output, expected) => {
    // #given
    stubVersionOutput(output)

    // #when
    const result = await runtimeSetupAdapter.verifyOpenCodeAvailable(null, createMockLogger())

    // #then the caller can compare it for exact equality with a pinned version
    expect(result).toEqual({available: true, version: expected})
  })

  it('reports version=null for unparseable output', async () => {
    // #given
    stubVersionOutput('unknown output')

    // #when
    const result = await runtimeSetupAdapter.verifyOpenCodeAvailable(null, createMockLogger())

    // #then
    expect(result).toEqual({available: true, version: null})
  })

  it('reports unavailable when the command fails', async () => {
    // #given
    vi.mocked(exec.exec).mockRejectedValue(new Error('spawn opencode ENOENT'))

    // #when
    const result = await runtimeSetupAdapter.verifyOpenCodeAvailable(null, createMockLogger())

    // #then
    expect(result).toEqual({available: false, version: null})
  })
})
