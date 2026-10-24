import {err, ok} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {AppNotInstalledError, AuthError, AuthTimeoutError, InsufficientPermissionsError} from '../github/app-client.js'
import {createInstallationTokenMint} from './workspace-token.js'

const INSTALL_URL = 'https://github.com/apps/fro-bot-agent/installations/new'

function mintWith(authForRepo: ReturnType<typeof vi.fn>) {
  return createInstallationTokenMint({authForRepo: authForRepo as never})
}

describe('createInstallationTokenMint', () => {
  it('returns the token of a successful authForRepo, minted for the repo asked', async () => {
    const authForRepo = vi.fn().mockResolvedValue(ok({token: 'ghs_minted'}))

    expect(await mintWith(authForRepo)('acme', 'widget')).toEqual(ok('ghs_minted'))
    expect(authForRepo).toHaveBeenCalledExactlyOnceWith('acme', 'widget')
  })

  it.each([
    ['AppNotInstalledError', new AppNotInstalledError('acme', 'widget', INSTALL_URL)],
    ['InsufficientPermissionsError', new InsufficientPermissionsError(['contents'], INSTALL_URL)],
  ])('%s is the permanent 401 and keeps its class as the cause', async (cause, error) => {
    expect(await mintWith(vi.fn().mockResolvedValue(err(error)))('acme', 'widget')).toEqual(
      err({kind: 'http-error', status: 401, cause}),
    )
  })

  it('any other authForRepo failure is the retryable network-error with its class as the cause, never its message', async () => {
    const result = await mintWith(vi.fn().mockResolvedValue(err(new AuthError('GitHub returned 503: secret detail'))))(
      'acme',
      'widget',
    )

    expect(result).toEqual(err({kind: 'network-error', cause: 'AuthError'}))
    expect(JSON.stringify(result)).not.toContain('secret detail')
  })

  it('an authForRepo deadline (AuthTimeoutError) is the retryable network-error with the cause "timeout"', async () => {
    expect(await mintWith(vi.fn().mockResolvedValue(err(new AuthTimeoutError())))('acme', 'widget')).toEqual(
      err({kind: 'network-error', cause: 'timeout'}),
    )
  })

  it('a rejected authForRepo is handled as a retryable failure with the error class, never the message', async () => {
    const result = await mintWith(vi.fn().mockRejectedValue(new TypeError('ghs_secret_in_message')))('acme', 'widget')

    expect(result).toEqual(err({kind: 'network-error', cause: 'TypeError'}))
    expect(JSON.stringify(result)).not.toContain('ghs_secret_in_message')
  })

  it('a non-async authForRepo that throws synchronously is handled the same way', async () => {
    const authForRepo = vi.fn().mockImplementation(() => {
      throw new RangeError('sync boom')
    })

    expect(await mintWith(authForRepo)('acme', 'widget')).toEqual(err({kind: 'network-error', cause: 'RangeError'}))
  })

  it('a thrown non-Error is reported as "threw"', async () => {
    expect(await mintWith(vi.fn().mockRejectedValue('just a string'))('acme', 'widget')).toEqual(
      err({kind: 'network-error', cause: 'threw'}),
    )
  })
})
