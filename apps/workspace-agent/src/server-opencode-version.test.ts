/**
 * The control API reports the OpenCode version the image runs, so the gateway chooses its run loop from the
 * workspace it attaches to (choice A). The field is optional and additive: a workspace without it answers exactly
 * as before.
 */

import {describe, expect, it} from 'vitest'

import {createApp} from './server.js'

async function get(path: string, deps: Parameters<typeof createApp>[0]): Promise<{status: number; body: unknown}> {
  const app = createApp(deps)
  const response = await app.request(path)
  return {status: response.status, body: await response.json()}
}

describe('OpenCode version on the control API', () => {
  it('reports the version on /readyz when ready', async () => {
    // #given a ready V2 workspace
    const result = await get('/readyz', {
      auth: {kind: 'disabled-for-tests'},
      opencodeStatus: {status: 'ready'},
      proxyListening: {listening: true},
      opencodeVersion: '2.2.0',
    })

    // #then the gateway can read the generation from the same response that tells it the workspace is ready
    expect(result).toEqual({status: 200, body: {ready: true, opencode: 'ready', opencodeVersion: '2.2.0'}})
  })

  it('reports the version on /readyz while not ready, so the gateway can pick a loop before it is', async () => {
    // #given a V2 workspace that is still starting
    const result = await get('/readyz', {
      auth: {kind: 'disabled-for-tests'},
      opencodeStatus: {status: 'starting'},
      proxyListening: {listening: true},
      opencodeVersion: '2.2.0',
    })

    // #then
    expect(result).toEqual({status: 503, body: {ready: false, opencode: 'starting', opencodeVersion: '2.2.0'}})
  })

  it('reports the version on /healthz, which needs no auth', async () => {
    // #given
    const result = await get('/healthz', {
      auth: {kind: 'bearer', token: 'tok'},
      opencodeStatus: {status: 'ready'},
      opencodeVersion: '2.2.0',
    })

    // #then
    expect(result).toEqual({status: 200, body: {ok: true, opencode: 'ready', opencodeVersion: '2.2.0'}})
  })

  it('leaves the wire shape unchanged when the image reports no version', async () => {
    // #given a workspace from an image that predates the variable
    const ready = await get('/readyz', {
      auth: {kind: 'disabled-for-tests'},
      opencodeStatus: {status: 'ready'},
      proxyListening: {listening: true},
    })
    const health = await get('/healthz', {auth: {kind: 'disabled-for-tests'}, opencodeStatus: {status: 'ready'}})

    // #then no new key appears, not even as undefined
    expect(ready.body).toEqual({ready: true, opencode: 'ready'})
    expect(Object.keys(ready.body as object)).toEqual(['ready', 'opencode'])
    expect(health.body).toEqual({ok: true, opencode: 'ready'})
  })
})
