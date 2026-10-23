import type {RecoveryWorkspaceCalls} from './recovery-workspace.js'
import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {createRecoveryWorkspaceCalls} from './recovery-workspace.js'
import {INSTALLATION_TOKEN_MINT_TIMEOUT_MS} from './workspace-token.js'

type MintResult = Awaited<ReturnType<MintWorkspaceToken>>

function makeCalls(mintToken: ReturnType<typeof vi.fn>, mintTimeoutMs?: number) {
  const workspaceClient = {
    previewRecovery: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
    recover: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
  }
  const calls: RecoveryWorkspaceCalls = createRecoveryWorkspaceCalls({
    workspaceClient,
    mintToken: mintToken as unknown as MintWorkspaceToken,
    ...(mintTimeoutMs === undefined ? {} : {mintTimeoutMs}),
  })
  return {calls, mintToken, workspaceClient}
}

function makeCallsWithMint(mintResult: MintResult) {
  return makeCalls(vi.fn().mockResolvedValue(mintResult))
}

const NETWORK = (cause: string) => err({kind: 'network-error' as const, cause})
const RECOVER_OPTIONS = {fingerprint: 'fp-1', runId: 'run-1'}

describe('createRecoveryWorkspaceCalls', () => {
  it('previewRecovery sends {owner, repo} and never mints an installation token', async () => {
    // #given
    const {calls, mintToken, workspaceClient} = makeCallsWithMint(ok('ghs_unused'))

    // #when
    const result = await calls.previewRecovery('acme', 'widget')

    // #then the preview request has no token field, so minting one would be a wasted GitHub round trip
    expect(mintToken).not.toHaveBeenCalled()
    expect(workspaceClient.previewRecovery).toHaveBeenCalledExactlyOnceWith({owner: 'acme', repo: 'widget'})
    expect(result).toEqual(ok({kind: 'no-checkout'}))
  })

  it('previewRecovery still works when a token mint would have failed (a GitHub outage is not a preview failure)', async () => {
    // #given
    const {calls, workspaceClient} = makeCallsWithMint(NETWORK('AuthError'))

    // #when
    const result = await calls.previewRecovery('acme', 'widget')

    // #then
    expect(result).toEqual(ok({kind: 'no-checkout'}))
    expect(workspaceClient.previewRecovery).toHaveBeenCalledOnce()
  })

  it('recover mints a token for the repo and sends it with the fingerprint and run id', async () => {
    // #given
    const {calls, mintToken, workspaceClient} = makeCallsWithMint(ok('ghs_minted'))

    // #when
    await calls.recover('acme', 'widget', RECOVER_OPTIONS)

    // #then
    expect(mintToken).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
    expect(workspaceClient.recover).toHaveBeenCalledExactlyOnceWith({
      owner: 'acme',
      repo: 'widget',
      token: 'ghs_minted',
      fingerprint: 'fp-1',
      runId: 'run-1',
    })
  })
})

describe('createRecoveryWorkspaceCalls: the token mint is bounded', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [
      'a permanent installation failure',
      err({kind: 'http-error' as const, status: 401 as const, cause: 'AppNotInstalledError'}),
      'AppNotInstalledError',
    ],
    ['a retryable mint failure', NETWORK('AuthError'), 'AuthError'],
  ])('%s returns token-unavailable carrying its cause and never sends /recover', async (_label, failure, cause) => {
    // #given
    const {calls, workspaceClient} = makeCallsWithMint(failure)

    // #when
    const result = await calls.recover('acme', 'widget', RECOVER_OPTIONS)

    // #then nothing was sent, so the caller must be able to tell it apart from a transport error
    expect(result).toEqual(err({kind: 'token-unavailable', cause}))
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('a mint that never settles gives up at the ceiling (not before) without sending /recover', async () => {
    // #given a GitHub call that hangs forever
    vi.useFakeTimers()
    const {calls, workspaceClient} = makeCalls(vi.fn().mockReturnValue(new Promise(() => {})))

    // #when
    const pending = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    let settled = false
    const tracked = pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(INSTALLATION_TOKEN_MINT_TIMEOUT_MS - 1)
    const settledEarly = settled
    await vi.advanceTimersByTimeAsync(1)

    // #then
    expect(settledEarly).toBe(false)
    expect(await pending).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
    await tracked
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('honours a configured mint ceiling', async () => {
    // #given
    vi.useFakeTimers()
    const {calls, workspaceClient} = makeCalls(vi.fn().mockReturnValue(new Promise(() => {})), 20)

    // #when
    const pending = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await vi.advanceTimersByTimeAsync(20)

    // #then the reviewer's probe: a 20 ms ceiling must settle by 20 ms, not stay pending
    expect(await pending).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('a mint that succeeds only AFTER the ceiling does not start the recovery', async () => {
    // #given a mint that resolves late, once the ceiling has already expired
    vi.useFakeTimers()
    let resolveMint: (value: MintResult) => void = () => {}
    const mintToken = vi.fn().mockReturnValue(
      new Promise<MintResult>(resolve => {
        resolveMint = resolve
      }),
    )
    const {calls, workspaceClient} = makeCalls(mintToken, 50)

    // #when the ceiling expires, then the late token arrives
    const pending = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    resolveMint(ok('ghs_late'))
    await vi.advanceTimersByTimeAsync(1_000)

    // #then
    expect(result).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('a mint that rejects after the ceiling changes nothing', async () => {
    // #given
    vi.useFakeTimers()
    let rejectMint: (reason: Error) => void = () => {}
    const mintToken = vi.fn().mockReturnValue(
      new Promise<MintResult>((_resolve, reject) => {
        rejectMint = reject
      }),
    )
    const {calls} = makeCalls(mintToken, 50)
    // #when
    const pending = calls.recover('acme', 'widget', RECOVER_OPTIONS)
    await vi.advanceTimersByTimeAsync(50)
    const result = await pending
    rejectMint(new Error('late boom'))
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()

    // #then the rejection arrived after the result was settled, so it changes nothing
    expect(result).toEqual(err({kind: 'token-unavailable', cause: 'timeout'}))
  })

  it('a mint that throws returns token-unavailable and never sends /recover', async () => {
    // #given
    const {calls, workspaceClient} = makeCalls(vi.fn().mockRejectedValue(new Error('boom')))

    // #when
    const result = await calls.recover('acme', 'widget', RECOVER_OPTIONS)

    // #then
    expect(result).toEqual(err({kind: 'token-unavailable', cause: 'Error'}))
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })

  it('a mint that answers in time clears its timer', async () => {
    // #given
    vi.useFakeTimers()
    const {calls} = makeCallsWithMint(ok('ghs_minted'))

    // #when
    await calls.recover('acme', 'widget', RECOVER_OPTIONS)

    // #then
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the default ceiling is the 30 s source deadline, pinned to the literal', () => {
    expect(INSTALLATION_TOKEN_MINT_TIMEOUT_MS).toBe(30_000)
  })
})
