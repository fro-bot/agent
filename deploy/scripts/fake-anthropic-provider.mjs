// fake-anthropic-provider.mjs — a no-network, Anthropic-compatible model endpoint for the V2 workspace smoke test.
// Pure ESM, no dependencies, no build step. Run INSIDE the workspace container (loopback only):
//
//   node fake-anthropic-provider.mjs <port> <expected-key>
//
// What it proves for fro-bot/agent#1992: a model request from the V2 server carries the provisioned provider key. It
// answers 401 unless `x-api-key` equals <expected-key> (the header the Anthropic provider sends, and the one V1 sent),
// so a request with no credential, or with the key in a different header, fails the turn instead of passing.
//
// `GET /__hits` reports what each model request carried, as verdicts only (the key value is never echoed back):
//   {"requests":[{"path":"/v1/messages?beta=true","xApiKey":"match|mismatch|absent","authorization":"present|absent"}]}

import http from 'node:http'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

/** @param {http.ServerResponse} res @param {string} event @param {unknown} data */
function frame(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * @param {{port: number, expectedKey: string, host?: string}} options
 * @returns {Promise<{server: http.Server, port: number, requests: () => {path: string, xApiKey: string, authorization: string}[]}>}
 */
export async function startFakeAnthropicProvider({port, expectedKey, host = '127.0.0.1'}) {
  const requests = []
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.method === 'GET' && req.url === '/__hits') {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({requests}))
      return
    }
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/messages')) {
      res.writeHead(404).end()
      return
    }
    const supplied = req.headers['x-api-key']
    const xApiKey = supplied === undefined ? 'absent' : supplied === expectedKey ? 'match' : 'mismatch'
    requests.push({
      path: req.url ?? '',
      xApiKey,
      authorization: req.headers.authorization === undefined ? 'absent' : 'present',
    })
    if (xApiKey !== 'match') {
      res.writeHead(401, {'content-type': 'application/json'})
      res.end(JSON.stringify({type: 'error', error: {type: 'authentication_error', message: 'invalid x-api-key'}}))
      return
    }
    res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
    frame(res, 'message_start', {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        usage: {input_tokens: 1, output_tokens: 1},
      },
    })
    frame(res, 'content_block_start', {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}})
    frame(res, 'content_block_delta', {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'pong'}})
    frame(res, 'content_block_stop', {type: 'content_block_stop', index: 0})
    frame(res, 'message_delta', {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 1}})
    frame(res, 'message_stop', {type: 'message_stop'})
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return {server, port: server.address().port, requests: () => requests}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , portArg, expectedKey] = process.argv
  const port = Number(portArg)
  if (!Number.isInteger(port) || port <= 0 || expectedKey === undefined || expectedKey === '') {
    process.stderr.write('usage: fake-anthropic-provider.mjs <port> <expected-key>\n')
    process.exit(2)
  }
  await startFakeAnthropicProvider({port, expectedKey})
  process.stdout.write(`fake-anthropic-provider: listening on 127.0.0.1:${port}\n`)
}
