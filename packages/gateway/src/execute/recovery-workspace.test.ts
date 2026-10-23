import type {RecoveryWorkspaceCalls} from './recovery-workspace.js'

import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createRecoveryWorkspaceCalls} from './recovery-workspace.js'

function makeCalls(mintResult: Awaited<ReturnType<Parameters<typeof createRecoveryWorkspaceCalls>[0]['mintToken']>>) {
  const mintToken = vi.fn().mockResolvedValue(mintResult)
  const workspaceClient = {
    previewRecovery: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
    recover: vi.fn().mockResolvedValue(ok({kind: 'no-checkout'})),
  }
  const calls: RecoveryWorkspaceCalls = createRecoveryWorkspaceCalls({
    workspaceClient,
    mintToken,
  })
  return {calls, mintToken, workspaceClient}
}

describe('createRecoveryWorkspaceCalls', () => {
  it('previewRecovery sends {owner, repo} and never mints an installation token', async () => {
    // #given
    const {calls, mintToken, workspaceClient} = makeCalls(ok('ghs_unused'))

    // #when
    const result = await calls.previewRecovery('acme', 'widget')

    // #then the preview request has no token field, so minting one would be a wasted GitHub round trip
    expect(mintToken).not.toHaveBeenCalled()
    expect(workspaceClient.previewRecovery).toHaveBeenCalledExactlyOnceWith({owner: 'acme', repo: 'widget'})
    expect(result).toEqual(ok({kind: 'no-checkout'}))
  })

  it('previewRecovery still works when a token mint would have failed (a GitHub outage is not a preview failure)', async () => {
    // #given
    const {calls, workspaceClient} = makeCalls(err({kind: 'network-error'}))

    // #when
    const result = await calls.previewRecovery('acme', 'widget')

    // #then
    expect(result).toEqual(ok({kind: 'no-checkout'}))
    expect(workspaceClient.previewRecovery).toHaveBeenCalledOnce()
  })

  it('recover mints a token for the repo and sends it with the fingerprint and run id', async () => {
    // #given
    const {calls, mintToken, workspaceClient} = makeCalls(ok('ghs_minted'))

    // #when
    await calls.recover('acme', 'widget', {fingerprint: 'fp-1', runId: 'run-1'})

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

  it('recover returns the mint failure unchanged and never calls the workspace', async () => {
    // #given
    const failure = err({kind: 'http-error' as const, status: 401 as const})
    const {calls, workspaceClient} = makeCalls(failure)

    // #when
    const result = await calls.recover('acme', 'widget', {fingerprint: 'fp-1', runId: 'run-1'})

    // #then
    expect(result).toEqual(failure)
    expect(workspaceClient.recover).not.toHaveBeenCalled()
  })
})
