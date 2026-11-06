import {describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {applyOperatorMcpV2, mcpToolNamespace, parseMcpServersV2} from './mcp-servers-v2.js'

const LOCAL = {type: 'local', command: ['node', 'server.mjs'], environment: {API_BASE: 'http://localhost'}} as const
const REMOTE = {type: 'remote', url: 'https://mcp.example.com/mcp'} as const

describe('mcpToolNamespace', () => {
  it('mirrors upstream tool/mcp.ts namespace: every character outside [a-zA-Z0-9_-] becomes an underscore', () => {
    // #given / #when / #then
    expect(mcpToolNamespace('github')).toBe('github')
    expect(mcpToolNamespace('my-server_2')).toBe('my-server_2')
    expect(mcpToolNamespace('my server')).toBe('my_server')
    expect(mcpToolNamespace('a.b/c:d')).toBe('a_b_c_d')
    expect(mcpToolNamespace('cafe\u0301*')).toBe('cafe__')
  })
})

describe('parseMcpServersV2', () => {
  describe('accepted shapes', () => {
    it('parses the legacy per-name map, local and remote', () => {
      // #given / #when
      const servers = unwrapOk(
        parseMcpServersV2({
          docs: {...LOCAL, cwd: 'tools', enabled: true, timeout: 9000},
          search: {...REMOTE, headers: {'X-Team': 'platform'}, oauth: false},
        }),
      )

      // #then
      expect(servers).toEqual([
        {
          kind: 'local',
          name: 'docs',
          namespace: 'docs',
          origin: 'legacy',
          command: ['node', 'server.mjs'],
          cwd: 'tools',
          environment: {API_BASE: 'http://localhost'},
        },
        {
          kind: 'remote',
          name: 'search',
          namespace: 'search',
          origin: 'legacy',
          url: 'https://mcp.example.com/mcp',
          headers: {'X-Team': 'platform'},
        },
      ])
    })

    it('parses the native servers map next to a timeout block', () => {
      // #given / #when
      const servers = unwrapOk(parseMcpServersV2({timeout: {catalog: 10_000}, servers: {docs: LOCAL, search: REMOTE}}))

      // #then
      expect(servers.map(server => [server.name, server.kind, server.origin])).toEqual([
        ['docs', 'local', 'native'],
        ['search', 'remote', 'native'],
      ])
    })

    it('reads a server literally named servers as a legacy server, and timeout likewise', () => {
      // #given / #when
      const servers = unwrapOk(parseMcpServersV2({servers: LOCAL, timeout: REMOTE}))

      // #then
      expect(servers.map(server => [server.name, server.origin])).toEqual([
        ['servers', 'legacy'],
        ['timeout', 'legacy'],
      ])
    })

    it('skips an enabled-only legacy entry, which upstream omits', () => {
      // #given / #when
      const servers = unwrapOk(parseMcpServersV2({docs: {enabled: false}, search: REMOTE}))

      // #then
      expect(servers.map(server => server.name)).toEqual(['search'])
    })

    it('accepts every recognized per-server field and the timeout block in both of its spellings', () => {
      // #given / #when
      const result = parseMcpServersV2({
        timeout: 8000,
        docs: {...LOCAL, enabled: false, codemode: false, timeout: 9000},
        search: {...REMOTE, oauth: {clientId: 'id', scope: 'read', callbackPort: 19_876, redirectUri: 'http://x/cb'}},
      })
      const native = parseMcpServersV2({
        timeout: {startup: 1000, catalog: 2000, execution: 3000},
        servers: {docs: {...LOCAL, disabled: true, timeout: {execution: 5000}}},
      })

      // #then
      expect(result.success).toBe(true)
      expect(native.success).toBe(true)
    })

    it('sanitizes the namespace the way upstream does', () => {
      // #given / #when
      const [server] = unwrapOk(parseMcpServersV2({'my docs.v2': LOCAL}))

      // #then
      expect(server).toMatchObject({name: 'my docs.v2', namespace: 'my_docs_v2'})
    })

    it('accepts an empty map', () => {
      // #given / #when / #then
      expect(unwrapOk(parseMcpServersV2({}))).toEqual([])
    })
  })

  describe('references OpenCode resolves before it reads the config', () => {
    // OpenCode substitutes {env:} and {file:} in the config text first (`core/src/config/variable.ts`), so the format of
    // a field that holds one is OpenCode's to check, not ours.
    it.each([
      ['a whole-value {env:} url', '{env:MCP_URL}'],
      ['a whole-value {file:} url', '{file:./mcp-url}'],
      ['a url with a reference inside it', 'https://{env:MCP_HOST}/mcp'],
    ])('accepts %s, in both spellings', (_label, url) => {
      // #given
      const server = {type: 'remote', url}

      // #when
      const legacy = parseMcpServersV2({docs: server})
      const native = parseMcpServersV2({servers: {docs: server}})

      // #then
      expect(unwrapOk(legacy)[0]).toMatchObject({kind: 'remote', url})
      expect(unwrapOk(native)[0]).toMatchObject({kind: 'remote', url})
    })

    it('still checks the format of a literal url', () => {
      // #given / #when / #then
      for (const url of ['not a url', 'file:///etc/passwd', 'ftp://x.example']) {
        expect(parseMcpServersV2({docs: {type: 'remote', url}}).success).toBe(false)
        expect(parseMcpServersV2({servers: {docs: {type: 'remote', url}}}).success).toBe(false)
      }
    })

    it('still checks the structure around a reference: a non-string url, a map that is not a map', () => {
      // #given / #when / #then
      expect(parseMcpServersV2({docs: {type: 'remote', url: 5}}).success).toBe(false)
      expect(parseMcpServersV2({docs: {type: 'remote', url: '{env:U}', headers: ['{env:H}']}}).success).toBe(false)
      expect(parseMcpServersV2({docs: {type: 'local', command: '{env:CMD}'}}).success).toBe(false)
      expect(parseMcpServersV2({docs: {type: 'local', command: ['{env:CMD}', 1]}}).success).toBe(false)
    })

    it('accepts referenced command, cwd, environment and header values', () => {
      // #given / #when
      const result = parseMcpServersV2({
        docs: {type: 'local', command: ['{env:NODE}', '{file:./entry}'], cwd: '{env:DIR}', environment: {A: '{env:A}'}},
        wiki: {type: 'remote', url: 'https://x.example/mcp', headers: {'X-A': '{file:./a}'}},
      })

      // #then
      expect(result.success).toBe(true)
    })

    it('accepts a referenced number or boolean in a field that otherwise needs one', () => {
      // #given / #when
      const result = parseMcpServersV2({
        timeout: '{env:T}',
        a: {...LOCAL, timeout: '{env:T}', enabled: '{env:E}', codemode: '{file:./c}'},
        b: {...REMOTE, oauth: {callbackPort: '{env:PORT}'}},
        servers: {c: {...LOCAL, timeout: {startup: '{env:T}', catalog: 2000}, disabled: '{env:D}'}},
      })

      // #then
      expect(result.success).toBe(true)
    })

    it('passes a referenced type through as a server of unresolved kind, in every position', () => {
      // #given: OpenCode decides what `type` is, so nothing that depends on it can be checked here
      const unresolved = {type: '{env:KIND}', command: '{env:CMD}', url: 5}

      // #when
      const servers = unwrapOk(
        parseMcpServersV2({
          docs: unresolved,
          timeout: {type: '{file:./t}', command: ['node']},
          servers: {wiki: unresolved},
        }),
      )

      // #then
      expect(servers.map(server => [server.name, server.kind, server.origin])).toEqual([
        ['docs', 'unresolved', 'legacy'],
        ['timeout', 'unresolved', 'legacy'],
        ['wiki', 'unresolved', 'native'],
      ])
    })

    it('reads a referenced-type value named servers as a server, not as the native map', () => {
      // #given / #when
      const servers = unwrapOk(parseMcpServersV2({servers: {type: '{env:KIND}'}}))

      // #then
      expect(servers.map(server => [server.name, server.kind])).toEqual([['servers', 'unresolved']])
    })

    it('still rejects two servers that sanitize to one name when one has a referenced type', () => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2({'a.b': {type: '{env:K}'}, a_b: LOCAL}))

      // #then
      expect(error.kind).toBe('duplicate-name')
    })
  })

  describe('rejected shapes', () => {
    it.each([
      ['an array', []],
      ['a string', 'docs'],
      ['null', null],
    ])('rejects mcp as %s', (_label, value) => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2(value))

      // #then
      expect(error).toMatchObject({kind: 'not-an-object', server: null})
    })

    it.each([
      ['a non-object server', {docs: 'node server.mjs'}],
      ['a missing type', {docs: {command: ['node']}}],
      ['an unknown type', {docs: {type: 'sse', url: 'https://x.example'}}],
      ['a local server with no command', {docs: {type: 'local'}}],
      ['a local server with an empty command', {docs: {type: 'local', command: []}}],
      ['a local server with a string command', {docs: {type: 'local', command: 'node server.mjs'}}],
      ['a local server with a non-string argument', {docs: {type: 'local', command: ['node', 1]}}],
      ['a local server with an empty executable', {docs: {type: 'local', command: ['']}}],
      ['a non-string cwd', {docs: {...LOCAL, cwd: 1}}],
      ['a non-string environment value', {docs: {...LOCAL, environment: {A: 1}}}],
      ['an array environment', {docs: {...LOCAL, environment: ['A=1']}}],
      ['a remote server with no url', {docs: {type: 'remote'}}],
      ['a remote server with a non-URL url', {docs: {type: 'remote', url: 'not a url'}}],
      ['a remote server with a non-http url', {docs: {type: 'remote', url: 'file:///etc/passwd'}}],
      ['a non-string header value', {docs: {...REMOTE, headers: {A: 1}}}],
      ['a non-object oauth', {docs: {...REMOTE, oauth: 'yes'}}],
      ['oauth true', {docs: {...REMOTE, oauth: true}}],
      ['a non-boolean enabled', {docs: {...LOCAL, enabled: 'yes'}}],
      ['a non-boolean codemode', {docs: {...LOCAL, codemode: 'yes'}}],
      ['a non-numeric server timeout', {docs: {...LOCAL, timeout: 'invalid'}}],
      ['a zero server timeout', {docs: {...LOCAL, timeout: 0}}],
      ['a fractional server timeout', {docs: {...LOCAL, timeout: 1.5}}],
      ['a non-numeric native timeout leaf', {servers: {docs: {...LOCAL, timeout: {startup: 'x'}}}}],
      ['a non-boolean native disabled', {servers: {docs: {...LOCAL, disabled: 'yes'}}}],
      ['an oauth string field of the wrong type', {docs: {...REMOTE, oauth: {clientId: 1}}}],
      ['an out-of-range oauth callbackPort', {docs: {...REMOTE, oauth: {callbackPort: 70_000}}}],
      ['a string mcp.timeout', {timeout: 'invalid'}],
      ['a negative mcp.timeout', {timeout: -5}],
      ['an mcp.timeout object with a non-numeric leaf', {timeout: {catalog: 'x'}}],
      ['an mcp.timeout array', {timeout: [1]}],
      ['a native servers value that is not a map', {servers: 'docs'}],
      ['a native server that is not an object', {servers: {docs: 1}}],
    ])('rejects %s with a named error that names the server', (_label, value) => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2(value))

      // #then
      expect(error.kind).toMatch(/^(invalid-server|not-an-object)$/)
      expect(error.message).toContain('opencode-config mcp')
    })

    it('names the offending server and field', () => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2({docs: {type: 'local', command: []}}))

      // #then
      expect(error).toEqual({
        kind: 'invalid-server',
        server: 'docs',
        message: 'opencode-config mcp server "docs": local servers need a non-empty command array of strings',
      })
    })

    it('rejects an empty server name', () => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2({'': LOCAL}))

      // #then
      expect(error.kind).toBe('invalid-name')
    })

    it('rejects two servers that collide after sanitization, since both would own one tool prefix', () => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2({'a.b': LOCAL, a_b: REMOTE}))

      // #then
      expect(error).toMatchObject({kind: 'duplicate-name', server: 'a_b'})
    })

    it('rejects the same name in the legacy and native shapes', () => {
      // #given / #when
      const error = unwrapErr(parseMcpServersV2({docs: LOCAL, servers: {docs: REMOTE}}))

      // #then
      expect(error).toMatchObject({kind: 'duplicate-name', server: 'docs'})
    })

    it('does not echo a value into the error message', () => {
      // #given
      const secret = 'sk-live-0123456789abcdef'

      // #when
      const error = unwrapErr(parseMcpServersV2({docs: {...REMOTE, url: secret}}))

      // #then
      expect(JSON.stringify(error)).not.toContain(secret)
    })
  })
})

function warnings(logger: ReturnType<typeof createMockLogger>): readonly string[] {
  return vi.mocked(logger.warning).mock.calls.map(call => String(call[0]))
}

describe('applyOperatorMcpV2', () => {
  const REFERENCE_MESSAGE = 'MCP servers are not run while the credential is withheld'

  describe('on a provisioned run', () => {
    it('passes the operator config through unchanged, mcp included', () => {
      // #given
      const operator = {
        share: 'disabled',
        mcp: {docs: LOCAL, search: {...REMOTE, headers: {Authorization: 'Bearer x'}}},
      }
      const logger = createMockLogger()

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'provision', logger))

      // #then
      expect(result).toEqual(operator)
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('passes native-only fields through unchanged: protocol and snake_case oauth', () => {
      // #given
      const operator = {
        mcp: {
          servers: {
            wiki: {
              type: 'remote',
              url: 'https://mcp.example.com/mcp',
              protocol: '2026-07-28',
              oauth: {client_id: 'id', client_secret: 'shh', callback_port: 19_876, redirect_uri: 'http://x/cb'},
              timeout: {startup: 10, catalog: 20, execution: 30},
              disabled: false,
            },
          },
        },
      }
      const expected = structuredClone(operator)

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'provision', createMockLogger()))

      // #then
      expect(result).toBe(operator)
      expect(result).toEqual(expected)
    })

    it('passes a substituted url through unchanged', () => {
      // #given
      const operator = {mcp: {docs: {type: 'remote', url: '{env:MCP_URL}'}}}

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'provision', createMockLogger()))

      // #then
      expect(result).toBe(operator)
    })

    it('is a no-op when the operator set no mcp', () => {
      // #given / #when / #then
      expect(unwrapOk(applyOperatorMcpV2({share: 'disabled'}, 'provision', createMockLogger()))).toEqual({
        share: 'disabled',
      })
    })

    it('fails on a bad shape, naming the server', () => {
      // #given / #when
      const error = unwrapErr(applyOperatorMcpV2({mcp: {docs: {type: 'local'}}}, 'provision', createMockLogger()))

      // #then
      expect(error).toMatchObject({kind: 'invalid-server', server: 'docs'})
    })
  })

  describe('on a credential-withheld run', () => {
    it('removes the whole mcp key and keeps every other key', () => {
      // #given
      const operator = {share: 'disabled', mcp: {docs: LOCAL, wiki: REMOTE}, provider: {a: 1}}

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'withhold', createMockLogger()))

      // #then
      expect(result).toEqual({share: 'disabled', provider: {a: 1}})
      expect(result).not.toHaveProperty('mcp')
    })

    it('warns once, listing the sanitized server names and a fixed reason, in both spellings', () => {
      // #given
      const logger = createMockLogger()

      // #when
      unwrapOk(
        applyOperatorMcpV2(
          {mcp: {timeout: {catalog: 1}, 'my docs': LOCAL, servers: {wiki: REMOTE}, other: REMOTE}},
          'withhold',
          logger,
        ),
      )

      // #then
      expect(warnings(logger)).toHaveLength(1)
      expect(warnings(logger)[0]).toContain(REFERENCE_MESSAGE)
      for (const name of ['my_docs', 'wiki', 'other']) expect(warnings(logger)[0]).toContain(name)
      expect(warnings(logger)[0]).not.toContain('timeout')
    })

    it('sanitizes a hostile server name before it reaches the log', () => {
      // #given
      const logger = createMockLogger()

      // #when
      unwrapOk(applyOperatorMcpV2({mcp: {'x\n::error::injected': LOCAL}}, 'withhold', logger))

      // #then
      expect(warnings(logger)[0]).not.toContain('\n')
      expect(warnings(logger)[0]).not.toContain('::error::')
    })

    it.each([
      ['a string', 'docs'],
      ['an array', []],
      ['null', null],
      ['a malformed server', {docs: {type: 'local'}}],
      ['a substituted timeout block', {timeout: {type: '{file:./t}', command: ['node']}}],
    ])('still removes mcp when it is %s, and warns without names', (_label, mcp) => {
      // #given
      const logger = createMockLogger()

      // #when
      const result = unwrapOk(applyOperatorMcpV2({share: 'disabled', mcp}, 'withhold', logger))

      // #then
      expect(result).toEqual({share: 'disabled'})
      expect(warnings(logger)).toHaveLength(1)
      expect(warnings(logger)[0]).toContain(REFERENCE_MESSAGE)
    })

    it('does not warn when there was no mcp', () => {
      // #given
      const logger = createMockLogger()

      // #when
      unwrapOk(applyOperatorMcpV2({share: 'disabled'}, 'withhold', logger))

      // #then
      expect(logger.warning).not.toHaveBeenCalled()
    })

    it('removes a top-level key whose name carries a {file:} reference, which could resolve to mcp', () => {
      // #given: OpenCode substitutes {file:} in the text before it parses the keys (`{env:}` never gets this far: the
      // config builder rejects it on a withheld run)
      const logger = createMockLogger()
      const operator = {share: 'disabled', '{file:./key}': {docs: LOCAL}, 'm{file:./x}cp': {docs: LOCAL}}

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'withhold', logger))

      // #then
      expect(result).toEqual({share: 'disabled'})
      expect(warnings(logger)).toHaveLength(1)
    })

    it('logs no command, url, header, environment or oauth value', () => {
      // #given
      const logger = createMockLogger()
      const mcp = {
        docs: {type: 'local', command: ['node', '/secret/path/server.mjs'], environment: {TOKEN_VALUE: 'tok-env-1234'}},
        search: {
          type: 'remote',
          url: 'https://user:urlpass-5678@mcp.example.com/mcp?sig=querykey-9012',
          headers: {'X-Session': '{file:./secret}', Authorization: 'Bearer hdr-secret-3456'},
          oauth: {clientId: 'cid', clientSecret: 'oauth-secret-7890'},
        },
      }

      // #when
      unwrapOk(applyOperatorMcpV2({mcp}, 'withhold', logger))
      const logged = serializeLoggerCalls(logger)

      // #then
      for (const value of [
        '/secret/path',
        'tok-env-1234',
        'urlpass-5678',
        'querykey-9012',
        'hdr-secret-3456',
        'oauth-secret-7890',
        './secret',
        'Authorization',
      ]) {
        expect(logged).not.toContain(value)
      }
      expect(logged).toContain('docs')
      expect(logged).toContain('search')
    })
  })
})
