import assert from 'node:assert/strict'
import {test} from 'node:test'

import {startFakeAnthropicProvider} from './fake-anthropic-provider.mjs'

const KEY = 'sk-test-fixture-key'

async function withProvider(run) {
  const provider = await startFakeAnthropicProvider({port: 0, expectedKey: KEY})
  const base = `http://127.0.0.1:${provider.port}`
  try {
    await run(base, provider)
  } finally {
    provider.server.closeAllConnections()
    await new Promise(resolve => provider.server.close(resolve))
  }
}

test('answers a request that carries the key in x-api-key with a streamed message', async () => {
  await withProvider(async base => {
    const response = await fetch(`${base}/v1/messages?beta=true`, {method: 'POST', headers: {'x-api-key': KEY}, body: '{}'})

    assert.equal(response.status, 200)
    assert.match(await response.text(), /message_stop/)
  })
})

test('answers 401 when the key is absent, wrong, or in the authorization header instead', async () => {
  await withProvider(async base => {
    for (const headers of [{}, {'x-api-key': 'wrong'}, {authorization: `Bearer ${KEY}`}]) {
      const response = await fetch(`${base}/v1/messages`, {method: 'POST', headers, body: '{}'})
      assert.equal(response.status, 401)
    }
  })
})

test('reports verdicts per request and never echoes a key', async () => {
  await withProvider(async base => {
    await fetch(`${base}/v1/messages`, {method: 'POST', headers: {'x-api-key': KEY}, body: '{}'})
    await fetch(`${base}/v1/messages`, {method: 'POST', headers: {authorization: 'Bearer secret-bearer'}, body: '{}'})
    await fetch(`${base}/v1/messages`, {method: 'POST', headers: {'x-api-key': 'secret-wrong'}, body: '{}'})

    const text = await (await fetch(`${base}/__hits`)).text()
    const {requests} = JSON.parse(text)

    assert.deepEqual(
      requests.map(({xApiKey, authorization}) => [xApiKey, authorization]),
      [
        ['match', 'absent'],
        ['absent', 'present'],
        ['mismatch', 'absent'],
      ],
    )
    assert.ok(!text.includes(KEY) && !text.includes('secret-bearer') && !text.includes('secret-wrong'))
  })
})

test('answers 404 for anything that is not the messages route', async () => {
  await withProvider(async base => {
    assert.equal((await fetch(`${base}/v1/models`)).status, 404)
  })
})
