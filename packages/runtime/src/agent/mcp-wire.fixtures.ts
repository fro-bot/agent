/**
 * Exchanges recorded in the Unit 2 spike: the pinned stock OpenCode 2.4.2 binary (sha256 checked against
 * `opencode-v2-pin.json`) running a scripted model against two recording fake MCP servers, one speaking the 2025
 * stateful Streamable HTTP (session, GET stream, DELETE) and one the 2026-07-28 stateless revision. Every value is
 * synthetic. The client config was the Action's shape: `type: remote`, `oauth: false`, no `headers`, no credential.
 *
 * What the recording established (the replay tests depend on these):
 * - The default protocol mode is `auto`: the client opens with a POST `server/discover` probe and, on a 400 that is not a
 *   modern JSON-RPC error, falls back to `initialize` (the 2025 flow). `protocol: "legacy"` skips the probe.
 * - 2025: POST `initialize`, POST `notifications/initialized` (202), GET (SSE, opened once and kept), POST
 *   `tools/list` (JSON), POST `tools/call` (SSE), DELETE on close. Every request after `initialize` carries
 *   `mcp-session-id` and `mcp-protocol-version`.
 * - 2026: POST only, with `mcp-method`, `mcp-protocol-version`, `mcp-name` and `mcp-param-*`; no GET, no DELETE, no session.
 * - A session-bearing 400 whose body contains `Bad Request: Server not initialized` makes the client drop the connection and
 *   run the whole flow again, then retry the call.
 * - A GET stream the server ends is reopened about a second later with `last-event-id` and the same session.
 */

export interface RecordedMcpExchange {
  readonly label: string
  readonly request: {
    readonly method: string
    readonly target: string
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }
  readonly response: {
    readonly status: number
    readonly headers: Readonly<Record<string, string>>
    readonly body: string
  }
}

/** The client's own words for an expired session; `failure` in OpenCode's `mcp/client.ts` matches this substring. */
export const MCP_SESSION_EXPIRED_SENTINEL = 'Bad Request: Server not initialized'

/** The 2025 stateful flow, then a session that expires (the 400) and the full reconnect. */
export const MCP_2025_STATEFUL_EXCHANGES: readonly RecordedMcpExchange[] = [
  {
    label: 'POST server/discover',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"opencode","version":"2.4.2"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}}}}}',
    },
    response: {
      status: 400,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"}}',
    },
  },
  {
    label: 'POST initialize',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}},"clientInfo":{"name":"opencode","version":"2.4.2"}},"jsonrpc":"2.0","id":0}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-spike-1',
      },
      body: '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"fake2025","version":"1"}}}',
    },
  },
  {
    label: 'POST notifications/initialized',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-1',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    },
    response: {
      status: 202,
      headers: {},
      body: '',
    },
  },
  {
    label: 'GET',
    request: {
      method: 'GET',
      target: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-1',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: ': stream open\n\n',
    },
  },
  {
    label: 'POST tools/list',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-1',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/list","jsonrpc":"2.0","id":1}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}}',
    },
  },
  {
    label: 'POST tools/call',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-1',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi1"},"_meta":{"ai.opencode/sessionID":"ses_de0f1aeb6ffeXepaBI9bGHfjuS","progressToken":2}},"jsonrpc":"2.0","id":2}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: 'id: e1a\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\nid: e1b\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"echo:hi1"}]}}\n\n',
    },
  },
  {
    label: 'POST tools/call',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-1',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi2"},"_meta":{"ai.opencode/sessionID":"ses_de0f1aeb6ffeXepaBI9bGHfjuS","progressToken":3}},"jsonrpc":"2.0","id":3}',
    },
    response: {
      status: 400,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Server not initialized"}}',
    },
  },
  {
    label: 'POST server/discover',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"opencode","version":"2.4.2"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}}}}}',
    },
    response: {
      status: 400,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"}}',
    },
  },
  {
    label: 'POST initialize',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}},"clientInfo":{"name":"opencode","version":"2.4.2"}},"jsonrpc":"2.0","id":0}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-spike-2',
      },
      body: '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"fake2025","version":"1"}}}',
    },
  },
  {
    label: 'POST notifications/initialized',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-2',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    },
    response: {
      status: 202,
      headers: {},
      body: '',
    },
  },
  {
    label: 'GET',
    request: {
      method: 'GET',
      target: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-2',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: ': stream open\n\nid: g1\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}\n\n',
    },
  },
  {
    label: 'POST tools/list',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-2',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/list","jsonrpc":"2.0","id":1}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}}',
    },
  },
  {
    label: 'POST tools/call',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-2',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi2"},"_meta":{"ai.opencode/sessionID":"ses_de0f1aeb6ffeXepaBI9bGHfjuS","progressToken":2}},"jsonrpc":"2.0","id":2}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: 'id: e2a\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\nid: e2b\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"echo:hi2"}]}}\n\n',
    },
  },
  {
    label: 'GET',
    request: {
      method: 'GET',
      target: '/mcp',
      headers: {
        accept: 'text/event-stream',
        'last-event-id': 'g1',
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-2',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: ': stream open\n\n',
    },
  },
  {
    label: 'DELETE',
    request: {
      method: 'DELETE',
      target: '/mcp',
      headers: {
        'mcp-protocol-version': '2025-06-18',
        'mcp-session-id': 'sess-spike-2',
        'user-agent': 'opencode/latest/2.4.2/cli',
        accept: '*/*',
      },
      body: '',
    },
    response: {
      status: 200,
      headers: {},
      body: '',
    },
  },
]

/** The 2026-07-28 stateless flow: POST only. */
export const MCP_2026_STATELESS_EXCHANGES: readonly RecordedMcpExchange[] = [
  {
    label: 'POST server/discover',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"opencode","version":"2.4.2"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}}}}}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"supportedVersions":["2026-07-28"],"capabilities":{"tools":{}},"serverInfo":{"name":"fake2026","version":"1"}}}',
    },
  },
  {
    label: 'POST tools/list',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-method': 'tools/list',
        'mcp-protocol-version': '2026-07-28',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/list","jsonrpc":"2.0","id":0,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"opencode","version":"2.4.2"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}}}}}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"jsonrpc":"2.0","id":0,"result":{"resultType":"complete","ttlMs":60000,"cacheScope":"public","tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string","x-mcp-header":"Text"}},"required":["text"]}}]}}',
    },
  },
  {
    label: 'POST tools/call',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-param-text': 'hi1',
        'mcp-method': 'tools/call',
        'mcp-name': 'echo',
        'mcp-protocol-version': '2026-07-28',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi1"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"opencode","version":"2.4.2"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}},"ai.opencode/sessionID":"ses_de0f193cbffeSvOIKu1spbAa6K","progressToken":1}},"jsonrpc":"2.0","id":1}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: ': open\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","content":[{"type":"text","text":"echo:hi1"}]}}\n\n',
    },
  },
  {
    label: 'POST tools/call',
    request: {
      method: 'POST',
      target: '/mcp',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-param-text': 'hi2',
        'mcp-method': 'tools/call',
        'mcp-name': 'echo',
        'mcp-protocol-version': '2026-07-28',
        'user-agent': 'opencode/latest/2.4.2/cli',
      },
      body: '{"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi2"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"opencode","version":"2.4.2"},"io.modelcontextprotocol/clientCapabilities":{"elicitation":{"form":{},"url":{}},"roots":{},"extensions":{"io.modelcontextprotocol/events":{}}},"ai.opencode/sessionID":"ses_de0f193cbffeSvOIKu1spbAa6K","progressToken":2}},"jsonrpc":"2.0","id":2}',
    },
    response: {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
      body: ': open\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"resultType":"complete","content":[{"type":"text","text":"echo:hi2"}]}}\n\n',
    },
  },
]
