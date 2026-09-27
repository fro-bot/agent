import {afterEach, describe, expect, it, vi} from 'vitest'

const dispatchArgv = vi.fn<() => Promise<void>>()

vi.mock('./main-dispatch.js', () => ({dispatchArgv}))

describe('main entrypoint dispatch failure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('does not write secret-bearing rejection details to stderr and exits nonzero', async () => {
    // #given — dispatch rejects with a fabricated credential-bearing error
    const fabricatedSecret = 'FABRICATED_TOKEN_DO_NOT_LOG'
    dispatchArgv.mockRejectedValueOnce(new Error(`request failed with token=${fabricatedSecret}`))
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    // #when — load the actual executable entrypoint (its dispatcher is isolated)
    await import('./main.js')
    await Promise.resolve()

    // #then — retain the useful fixed diagnostic, but never emit the rejection text
    expect(stderr).toHaveBeenCalledExactlyOnceWith(JSON.stringify({level: 'error', msg: 'dispatch failed'}))
    expect(stderr.mock.calls.flat().join(' ')).not.toContain(fabricatedSecret)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})
