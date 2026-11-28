/**
 * Test support for the MCP credential broker's real-binary and real-runner rows (`execute-v2.integration.test.ts`,
 * `v2-server.sandbox.integration.test.ts`). Nothing here is product code.
 *
 * A recording stateful MCP upstream that speaks the 2025 Streamable HTTP the pinned OpenCode 2.4.2 client uses (a
 * `server/discover` probe that is answered with the missing-session 400, then `initialize`, `tools/list`, a kept GET stream and
 * SSE tool results), and the pass-through that lets the model's own requests share the same HTTPS upstream.
 */

import type {UpstreamHandler} from '../../../packages/runtime/src/agent/key-proxy-test-kit.js'
import http from 'node:http'

/** The words of a real upstream that no longer knows the session; the client reconnects on them. */
export const MCP_SESSION_EXPIRED = 'Bad Request: Server not initialized'

export interface McpUpstreamState {
  initializes: number
  /** Requests that did not carry the configured credential (answered 401). */
  unauthorized: number
  toolLists: number
  /** `tools/call` requests that were served. */
  executed: number
  /** Requests answered with the expired-session 400. */
  expiredAnswers: number
}

/**
 * A recording stateful MCP upstream. Every request must carry the configured credential: one that does not is counted and
 * refused, so a broker that drops the header shows as a failed tool, never as a quiet pass. `expireAfterCalls` forgets every
 * session once that many calls were served, so the next request on an old session gets the expired-session 400 exactly once.
 */
export function createMcpUpstream(options: {
  /** The exact `Authorization` header every request must carry. */
  readonly authorization: string
  readonly expireAfterCalls?: number
}): {
  readonly state: McpUpstreamState
  readonly handler: UpstreamHandler
} {
  const state: McpUpstreamState = {initializes: 0, unauthorized: 0, toolLists: 0, executed: 0, expiredAnswers: 0}
  const sessions = new Set<string>()
  const json = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    res.writeHead(status, {'content-type': 'application/json', ...headers})
    res.end(JSON.stringify({jsonrpc: '2.0', ...(body as object)}))
  }
  const handler: UpstreamHandler = (request, res) => {
    if (request.headers.authorization !== options.authorization) {
      state.unauthorized += 1
      json(res, 401, {id: null, error: {code: -32001, message: 'Unauthorized'}})
      return
    }
    const sessionId = request.headers['mcp-session-id']
    const known = typeof sessionId === 'string' && sessions.has(sessionId)
    if (request.method === 'DELETE') {
      if (typeof sessionId === 'string') sessions.delete(sessionId)
      res.writeHead(200).end()
      return
    }
    if (request.method === 'GET') {
      if (!known) {
        state.expiredAnswers += 1
        json(res, 400, {id: null, error: {code: -32000, message: MCP_SESSION_EXPIRED}})
        return
      }
      // The server-to-client stream: opened once and kept, as the client expects.
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      res.write(': stream open\n\n')
      return
    }
    let body: {id?: number | string; method?: string; params?: {arguments?: {text?: string}}} = {}
    try {
      body = JSON.parse(request.body.toString('utf8')) as typeof body
    } catch {
      json(res, 400, {id: null, error: {code: -32700, message: 'Parse error'}})
      return
    }
    if (body.method === 'initialize') {
      state.initializes += 1
      const id = `sess-${state.initializes}`
      sessions.add(id)
      json(
        res,
        200,
        {
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: {tools: {listChanged: false}},
            serverInfo: {name: 'fake-mcp', version: '1'},
          },
        },
        {'mcp-session-id': id},
      )
      return
    }
    if (sessionId === undefined) {
      // The client's `server/discover` probe lands here, and falls back to `initialize` on this answer.
      json(res, 400, {id: null, error: {code: -32000, message: 'Bad Request: Mcp-Session-Id header is required'}})
      return
    }
    if (!known) {
      state.expiredAnswers += 1
      json(res, 400, {id: null, error: {code: -32000, message: MCP_SESSION_EXPIRED}})
      return
    }
    if (body.id === undefined) {
      res.writeHead(202).end()
      return
    }
    if (body.method === 'tools/list') {
      state.toolLists += 1
      json(res, 200, {
        id: body.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo the text back',
              inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']},
            },
          ],
        },
      })
      return
    }
    if (body.method === 'tools/call') {
      state.executed += 1
      const reply = {
        jsonrpc: '2.0',
        id: body.id,
        result: {content: [{type: 'text', text: `echo:${body.params?.arguments?.text ?? ''}`}]},
      }
      res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache'})
      res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      if (state.executed === options.expireAfterCalls) sessions.clear()
      return
    }
    json(res, 200, {id: body.id, result: {}})
  }
  return {state, handler}
}

/** Passes a model request that came through the child to the scripted model's plain-HTTP port, and its answer back. */
export function forwardToModel(port: number): UpstreamHandler {
  return (request, res) => {
    const outbound = http.request(
      {
        host: '127.0.0.1',
        port,
        method: request.method,
        path: request.url,
        headers: {
          'content-type': String(request.headers['content-type'] ?? 'application/json'),
          'content-length': request.body.length,
        },
      },
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )
    outbound.on('error', () => {
      if (res.headersSent) res.destroy()
      else res.writeHead(502).end()
    })
    outbound.end(request.body)
  }
}
