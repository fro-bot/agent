import type {RecoveryWorkspaceCalls} from './recovery-workspace.js'
import type {MintWorkspaceToken} from './workspace-token.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createRecoveryWorkspaceCalls} from './recovery-workspace.js'

type MintResult = Awaited<ReturnType<MintWorkspaceToken>>

function makeCalls(mintToken: ReturnType<typeof vi.fn>) {
  const workspaceClient = {
    previewRecovery: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
    recover: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
  }
  const calls: RecoveryWorkspaceCalls = createRecoveryWorkspaceCalls({
    workspaceClient,
    mintToken: mintToken as unknown as MintWorkspaceToken,
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

describe('createRecoveryWorkspaceCalls: a failed mint sends nothing', () => {
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
})
