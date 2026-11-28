import {KEY_PROXY_MCP_FORBIDDEN_HEADERS, resolveResponseDelivery} from '@fro-bot/runtime'
import {describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls, unwrapErr, unwrapOk} from '../../shared/test-helpers.js'
import {
  applyBrokeredMcpV2,
  applyOperatorMcpV2,
  mcpToolNamespace,
  parseMcpServersV2,
  planMcpBrokerV2,
} from './mcp-servers-v2.js'

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

function infos(logger: ReturnType<typeof createMockLogger>): readonly string[] {
  return vi.mocked(logger.info).mock.calls.map(call => String(call[0]))
}

describe('applyOperatorMcpV2', () => {
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
    const STATIC_LOCAL = {type: 'local', command: ['node', 'tools/knowledge.mjs']} as const
    const KEPT_MESSAGE = 'MCP servers kept while the credential is withheld'
    const DROPPED_MESSAGE = 'MCP servers removed while the credential is withheld'

    const spellings = [
      ['mcp.<name>', (servers: Record<string, unknown>): Record<string, unknown> => servers],
      ['mcp.servers.<name>', (servers: Record<string, unknown>): Record<string, unknown> => ({servers})],
    ] as const

    it.each(['pull_request', 'issue_comment', 'issues'])('%s withholds the credential', eventName => {
      // #given / #when / #then: the matrix below is pinned to the triggers that withhold
      expect(resolveResponseDelivery(eventName, 'github').credential).toBe('withhold')
    })

    describe.each(['pull_request', 'issue_comment', 'issues'])('on %s', eventName => {
      const credential = resolveResponseDelivery(eventName, 'github').credential

      describe.each(spellings)('%s', (_spelling, spell) => {
        it('keeps a local server with no reference and drops a referenced local server and a remote one', () => {
          // #given
          const logger = createMockLogger()
          const operator = {
            share: 'disabled',
            mcp: spell({
              knowledge: STATIC_LOCAL,
              viaEnv: {type: 'local', command: ['node', '{env:TOOL}']},
              viaFile: {type: 'local', command: ['node', '{file:./tool}']},
              remote: {type: 'remote', url: 'https://mcp.example.com/mcp'},
            }),
          }

          // #when
          const result = unwrapOk(applyOperatorMcpV2(operator, credential, logger))

          // #then
          expect(result).toEqual({share: 'disabled', mcp: spell({knowledge: STATIC_LOCAL})})
          expect(infos(logger)).toHaveLength(1)
          expect(infos(logger)[0]).toContain(KEPT_MESSAGE)
          expect(infos(logger)[0]).toContain('knowledge')
          expect(warnings(logger)).toHaveLength(1)
          expect(warnings(logger)[0]).toContain(DROPPED_MESSAGE)
          for (const name of ['viaEnv', 'viaFile', 'remote']) expect(warnings(logger)[0]).toContain(name)
          expect(warnings(logger)[0]).not.toContain('knowledge')
        })

        it('drops a local server whose definition carries a {file:} reference', () => {
          // #given / #when
          const result = unwrapOk(
            applyOperatorMcpV2(
              {mcp: spell({viaFile: {type: 'local', command: ['node', 'a.mjs'], cwd: '{file:./cwd}'}})},
              credential,
              createMockLogger(),
            ),
          )

          // #then: nothing is left, so the key goes
          expect(result).not.toHaveProperty('mcp')
        })

        it('drops a local server whose definition carries an {env:} reference (helper level)', () => {
          // #given / #when
          const result = unwrapOk(
            applyOperatorMcpV2(
              {mcp: spell({viaEnv: {type: 'local', command: ['node', 'a.mjs'], environment: {A: 'x{env:Y}z'}}})},
              credential,
              createMockLogger(),
            ),
          )

          // #then
          expect(result).not.toHaveProperty('mcp')
        })

        it('drops a remote server, with or without a reference', () => {
          // #given / #when
          const result = unwrapOk(
            applyOperatorMcpV2(
              {
                mcp: spell({
                  plain: {type: 'remote', url: 'https://mcp.example.com/mcp'},
                  authed: {type: 'remote', url: 'https://mcp.example.com/mcp', headers: {A: '{file:./h}'}},
                }),
              },
              credential,
              createMockLogger(),
            ),
          )

          // #then
          expect(result).not.toHaveProperty('mcp')
        })

        it.each([
          ['a nested field', {type: 'local', command: ['node', 'a.mjs'], extra: {deep: [{x: 'p-{file:./n}-q'}]}}],
          ['a nested key', {type: 'local', command: ['node', 'a.mjs'], extra: {'{file:./k}': true}}],
          ['an unknown top-level field', {type: 'local', command: ['node', 'a.mjs'], unknownField: '{file:./u}'}],
          [
            'an {env:} reference in an unknown field',
            {type: 'local', command: ['node', 'a.mjs'], unknownField: '{env:U}'},
          ],
          ['a command argument', {type: 'local', command: ['node', '--token={file:./t}']}],
          ['a referenced enabled flag', {type: 'local', command: ['node', 'a.mjs'], enabled: '{file:./e}'}],
        ])('drops a local server with a reference in %s', (_label, server) => {
          // #given / #when
          const result = unwrapOk(
            applyOperatorMcpV2({mcp: spell({kept: STATIC_LOCAL, bad: server})}, credential, createMockLogger()),
          )

          // #then
          expect(result).toEqual({mcp: spell({kept: STATIC_LOCAL})})
        })

        it.each([
          ['{file:} in the middle', 'a{file:./n}b'],
          ['an {env:} reference', '{env:N}'],
        ])('drops a server whose name carries %s, which could resolve to servers or timeout', (_label, name) => {
          // #given / #when
          const result = unwrapOk(
            applyOperatorMcpV2(
              {mcp: spell({kept: STATIC_LOCAL, [name]: STATIC_LOCAL})},
              credential,
              createMockLogger(),
            ),
          )

          // #then
          expect(result).toEqual({mcp: spell({kept: STATIC_LOCAL})})
        })

        it('keeps a local server with a literal environment', () => {
          // #given
          const server = {
            ...STATIC_LOCAL,
            environment: {LOG_LEVEL: 'debug'},
            cwd: 'tools',
            enabled: true,
            timeout: 5000,
          }

          // #when
          const result = unwrapOk(applyOperatorMcpV2({mcp: spell({knowledge: server})}, credential, createMockLogger()))

          // #then
          expect(result).toEqual({mcp: spell({knowledge: server})})
        })

        it.each([
          ['a local server with no command', {type: 'local'}],
          ['a local server with an empty command', {type: 'local', command: []}],
          ['a local server with a non-string environment value', {...STATIC_LOCAL, environment: {A: 1}}],
          ['a non-object entry', 'node server.mjs'],
          ['a null entry', null],
          ['an array entry', [STATIC_LOCAL]],
          ['an unknown type', {type: 'sse', command: ['node', 'a.mjs']}],
          ['a missing type', {command: ['node', 'a.mjs']}],
          ['a referenced type', {type: '{file:./t}', command: ['node', 'a.mjs']}],
          ['a non-literal type', {type: 'Local', command: ['node', 'a.mjs']}],
        ])('drops %s and keeps the valid server beside it', (_label, bad) => {
          // #given / #when
          const logger = createMockLogger()
          const result = unwrapOk(applyOperatorMcpV2({mcp: spell({kept: STATIC_LOCAL, bad})}, credential, logger))

          // #then
          expect(result).toEqual({mcp: spell({kept: STATIC_LOCAL})})
          expect(warnings(logger)[0]).toContain('bad')
        })

        it('removes the mcp key when every server is dropped, and keeps the other keys', () => {
          // #given
          const operator = {
            share: 'disabled',
            mcp: spell({remote: REMOTE, viaFile: {type: 'local', command: ['{file:./c}']}}),
            provider: {a: 1},
          }

          // #when
          const result = unwrapOk(applyOperatorMcpV2(operator, credential, createMockLogger()))

          // #then
          expect(result).toEqual({share: 'disabled', provider: {a: 1}})
          expect(result).not.toHaveProperty('mcp')
        })

        it('does not log a kept line when nothing is kept', () => {
          // #given
          const logger = createMockLogger()

          // #when
          unwrapOk(applyOperatorMcpV2({mcp: spell({remote: REMOTE})}, credential, logger))

          // #then
          expect(infos(logger)).toEqual([])
          expect(warnings(logger)).toHaveLength(1)
        })

        it('does not warn about dropped servers when everything is kept', () => {
          // #given
          const logger = createMockLogger()

          // #when
          unwrapOk(applyOperatorMcpV2({mcp: spell({a: STATIC_LOCAL, b: STATIC_LOCAL})}, credential, logger))

          // #then
          expect(warnings(logger)).toEqual([])
          expect(infos(logger)).toHaveLength(1)
        })

        it('drops servers that share one tool prefix, because the prefix would be ambiguous', () => {
          // #given
          const logger = createMockLogger()

          // #when
          const result = unwrapOk(
            applyOperatorMcpV2(
              {mcp: spell({'a.b': STATIC_LOCAL, a_b: STATIC_LOCAL, other: STATIC_LOCAL})},
              credential,
              logger,
            ),
          )

          // #then
          expect(result).toEqual({mcp: spell({other: STATIC_LOCAL})})
          expect(warnings(logger)[0]).toContain('a_b')
        })

        it('does not turn a __proto__ server name into a prototype', () => {
          // #given: JSON.parse makes it an own key
          const servers = JSON.parse(`{"__proto__": ${JSON.stringify(STATIC_LOCAL)}}`) as Record<string, unknown>

          // #when
          const result = unwrapOk(applyOperatorMcpV2({mcp: spell(servers)}, credential, createMockLogger()))

          // #then
          const out = result.mcp as Record<string, unknown>
          const target = (out.servers as Record<string, unknown> | undefined) ?? out
          expect(Object.getPrototypeOf(target)).toBe(Object.prototype)
          expect(Object.keys(target)).toEqual(['__proto__'])
        })
      })
    })

    it('keeps both spellings at once, each in the spelling it was written in', () => {
      // #given
      const operator = {
        mcp: {legacy: STATIC_LOCAL, remoteLegacy: REMOTE, servers: {native: STATIC_LOCAL, remoteNative: REMOTE}},
      }

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'withhold', createMockLogger()))

      // #then
      expect(result).toEqual({mcp: {legacy: STATIC_LOCAL, servers: {native: STATIC_LOCAL}}})
    })

    it('keeps a legacy server literally named servers, as upstream reads it', () => {
      // #given
      const operator = {mcp: {servers: STATIC_LOCAL}}

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'withhold', createMockLogger()))

      // #then
      expect(result).toEqual({mcp: {servers: STATIC_LOCAL}})
    })

    it('keeps a literal mcp.timeout beside a kept server, and drops one with a reference or without a server', () => {
      // #given / #when
      const kept = unwrapOk(
        applyOperatorMcpV2({mcp: {timeout: {catalog: 9000}, docs: STATIC_LOCAL}}, 'withhold', createMockLogger()),
      )
      const referenced = unwrapOk(
        applyOperatorMcpV2({mcp: {timeout: '{file:./t}', docs: STATIC_LOCAL}}, 'withhold', createMockLogger()),
      )
      const alone = unwrapOk(applyOperatorMcpV2({mcp: {timeout: {catalog: 9000}}}, 'withhold', createMockLogger()))

      // #then
      expect(kept).toEqual({mcp: {timeout: {catalog: 9000}, docs: STATIC_LOCAL}})
      expect(referenced).toEqual({mcp: {docs: STATIC_LOCAL}})
      expect(alone).not.toHaveProperty('mcp')
    })

    it('does not mutate the operator config', () => {
      // #given
      const operator = {mcp: {docs: STATIC_LOCAL, wiki: REMOTE}}
      const before = structuredClone(operator)

      // #when
      unwrapOk(applyOperatorMcpV2(operator, 'withhold', createMockLogger()))

      // #then
      expect(operator).toEqual(before)
    })

    it('sanitizes a hostile server name before it reaches the log, kept or dropped', () => {
      // #given
      const logger = createMockLogger()

      // #when
      unwrapOk(
        applyOperatorMcpV2(
          {mcp: {'x\n::error::kept': STATIC_LOCAL, 'y\n::error::dropped': REMOTE}},
          'withhold',
          logger,
        ),
      )

      // #then
      const logged = serializeLoggerCalls(logger)
      expect(logged).not.toContain(String.raw`\n`)
      expect(logged).not.toContain('::error::')
      expect(infos(logger)[0]).toContain('x___error__kept')
      expect(warnings(logger)[0]).toContain('y___error__dropped')
    })

    it('bounds the number of names it logs', () => {
      // #given
      const logger = createMockLogger()
      const mcp = Object.fromEntries(Array.from({length: 30}, (_unused, index) => [`server${index}`, STATIC_LOCAL]))

      // #when
      unwrapOk(applyOperatorMcpV2({mcp}, 'withhold', logger))

      // #then
      expect(infos(logger)[0]).toContain('and 10 more')
      expect(infos(logger)[0]).not.toContain('server29')
    })

    it.each([
      ['a string', 'docs'],
      ['an array', []],
      ['null', null],
      ['a non-object servers wrapper', {servers: 'docs'}],
    ])('removes mcp when it is %s, and warns', (_label, mcp) => {
      // #given
      const logger = createMockLogger()

      // #when
      const result = unwrapOk(applyOperatorMcpV2({share: 'disabled', mcp}, 'withhold', logger))

      // #then
      expect(result).toEqual({share: 'disabled'})
      expect(warnings(logger)).toHaveLength(1)
      expect(warnings(logger)[0]).toContain(DROPPED_MESSAGE)
      expect(infos(logger)).toEqual([])
    })

    it('drops a timeout entry whose type is a substituted reference that could resolve to a local server', () => {
      // #given
      const logger = createMockLogger()

      // #when
      const result = unwrapOk(
        applyOperatorMcpV2({mcp: {timeout: {type: '{file:./t}', command: ['node']}}}, 'withhold', logger),
      )

      // #then
      expect(result).not.toHaveProperty('mcp')
    })

    it('does not warn when there was no mcp', () => {
      // #given
      const logger = createMockLogger()

      // #when
      unwrapOk(applyOperatorMcpV2({share: 'disabled'}, 'withhold', logger))

      // #then
      expect(logger.warning).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('removes a top-level key whose name carries a {file:} reference, which could resolve to mcp', () => {
      // #given: OpenCode substitutes {file:} in the text before it parses the keys (`{env:}` never gets this far: the
      // config builder rejects it on a withheld run)
      const logger = createMockLogger()
      const operator = {share: 'disabled', '{file:./key}': {docs: STATIC_LOCAL}, 'm{file:./x}cp': {docs: STATIC_LOCAL}}

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'withhold', logger))

      // #then
      expect(result).toEqual({share: 'disabled'})
      expect(warnings(logger)).toHaveLength(1)
    })

    it('removes a referenced top-level key and still filters mcp', () => {
      // #given
      const operator = {'{file:./key}': {docs: STATIC_LOCAL}, mcp: {docs: STATIC_LOCAL, wiki: REMOTE}}

      // #when
      const result = unwrapOk(applyOperatorMcpV2(operator, 'withhold', createMockLogger()))

      // #then
      expect(result).toEqual({mcp: {docs: STATIC_LOCAL}})
    })

    it('logs server names only, never a configured value', () => {
      // #given a sentinel in every kind of value, on kept and dropped servers alike
      const SENTINEL = 'SENTINEL-7f3a91'
      const logger = createMockLogger()
      const mcp = {
        kept: {
          type: 'local',
          command: ['node', `/path/${SENTINEL}-cmd.mjs`],
          cwd: `/cwd/${SENTINEL}`,
          environment: {[`KEY_${SENTINEL}`]: `value-${SENTINEL}`},
        },
        refLocal: {type: 'local', command: ['node', `${SENTINEL}-{file:./x}`], environment: {A: SENTINEL}},
        remote: {
          type: 'remote',
          url: `https://user:${SENTINEL}@mcp.example.com/mcp?sig=${SENTINEL}`,
          headers: {Authorization: `Bearer ${SENTINEL}`, [`X-${SENTINEL}`]: '{file:./secret}'},
          oauth: {clientId: SENTINEL, clientSecret: SENTINEL},
        },
        bad: {type: 'local', command: `${SENTINEL}`},
      }

      // #when
      unwrapOk(applyOperatorMcpV2({mcp}, 'withhold', logger))
      const logged = serializeLoggerCalls(logger)

      // #then
      expect(logged).not.toContain(SENTINEL)
      for (const forbidden of ['./secret', './x', 'Authorization', 'oauth']) expect(logged).not.toContain(forbidden)
      for (const name of ['kept', 'refLocal', 'remote', 'bad']) expect(logged).toContain(name)
    })
  })
})

describe('planMcpBrokerV2', () => {
  const TOKEN = 'planner-TOKEN-0123456789'
  const BEARER = `Bearer ${TOKEN}`
  const credentialed = (extra: Record<string, unknown> = {}) => ({
    ...REMOTE,
    headers: {Authorization: BEARER},
    ...extra,
  })

  describe('what is brokered', () => {
    it('turns a remote with headers into one route that holds the headers, in the legacy spelling', () => {
      // #given a legacy `mcp.<name>` remote with a bearer header
      // #when planned
      const plan = unwrapOk(planMcpBrokerV2({search: credentialed()}))

      // #then one route, with a route id, the fixed origin and path, and the header as written
      expect(plan.routes).toEqual([
        {
          name: 'search',
          layout: 'legacy',
          route: {id: 's1', origin: 'https://mcp.example.com', path: '/mcp', headers: {Authorization: BEARER}},
        },
      ])
      expect(plan.stripped).toEqual([])
    })

    it('plans the native `mcp.servers.<name>` layout the same way', () => {
      const plan = unwrapOk(planMcpBrokerV2({servers: {search: credentialed()}}))

      expect(plan.routes).toEqual([
        {
          name: 'search',
          layout: 'native',
          route: {id: 's1', origin: 'https://mcp.example.com', path: '/mcp', headers: {Authorization: BEARER}},
        },
      ])
    })

    it('leaves a remote with no `headers` key direct, and plans nothing for a local server', () => {
      const plan = unwrapOk(planMcpBrokerV2({direct: REMOTE, docs: LOCAL, timeout: 9000}))

      expect(plan).toEqual({routes: [], stripped: [], secrets: []})
    })

    it('plans nothing when there is no `mcp` block', () => {
      expect(unwrapOk(planMcpBrokerV2(undefined))).toEqual({routes: [], stripped: [], secrets: []})
    })

    it('brokers `headers: {}` with zero headers, because a header name is never a guess at what is a credential', () => {
      const plan = unwrapOk(planMcpBrokerV2({quiet: {...REMOTE, headers: {}}}))

      expect(plan.routes.map(entry => entry.route.headers)).toEqual([{}])
      expect(plan.secrets).toEqual([])
    })

    it('gives two remotes on one origin two routes, each with its own fixed path and id', () => {
      const plan = unwrapOk(
        planMcpBrokerV2({
          one: {...REMOTE, url: 'https://mcp.example.com/tenant-a/mcp', headers: {'X-Key': 'tenant-a-key-0001'}},
          two: {...REMOTE, url: 'https://mcp.example.com/tenant-b/mcp', headers: {'X-Key': 'tenant-b-key-0002'}},
        }),
      )

      expect(plan.routes.map(entry => [entry.route.id, entry.route.origin, entry.route.path])).toEqual([
        ['s1', 'https://mcp.example.com', '/tenant-a/mcp'],
        ['s2', 'https://mcp.example.com', '/tenant-b/mcp'],
      ])
    })

    it('keeps a trailing slash, a port and a bare origin path exactly as configured', () => {
      const plan = unwrapOk(
        planMcpBrokerV2({
          slash: {...REMOTE, url: 'https://mcp.example.com/mcp/', headers: {}},
          port: {...REMOTE, url: 'https://mcp.example.com:8443/mcp', headers: {}},
          root: {...REMOTE, url: 'https://mcp.example.com', headers: {}},
          defaultPort: {...REMOTE, url: 'https://mcp.example.com:443/mcp', headers: {}},
        }),
      )

      expect(plan.routes.map(entry => [entry.route.origin, entry.route.path])).toEqual([
        ['https://mcp.example.com', '/mcp/'],
        ['https://mcp.example.com:8443', '/mcp'],
        ['https://mcp.example.com', '/'],
        ['https://mcp.example.com', '/mcp'],
      ])
    })

    it('lets both spellings coexist, numbering routes in config order', () => {
      const plan = unwrapOk(
        planMcpBrokerV2({a: credentialed(), servers: {b: credentialed({url: 'https://b.example.com/mcp'})}}),
      )

      expect(plan.routes.map(entry => [entry.name, entry.layout, entry.route.id])).toEqual([
        ['a', 'legacy', 's1'],
        ['b', 'native', 's2'],
      ])
    })
  })

  describe('definitively disabled servers', () => {
    it.each([
      ['enabled: false', {enabled: false}],
      ['`enabled: false` beside a `disabled: true` that the client ignores', {enabled: false, disabled: true}],
    ])('strips the headers and plans no route for %s', (_label, flags) => {
      const plan = unwrapOk(planMcpBrokerV2({off: credentialed(flags)}))

      expect(plan.routes).toEqual([])
      expect(plan.stripped).toEqual([{name: 'off', layout: 'legacy'}])
      expect(plan.secrets.map(secret => secret.value)).toEqual([BEARER, TOKEN])
    })

    it('strips a disabled native entry, and a disabled local entry that carries headers', () => {
      const plan = unwrapOk(
        planMcpBrokerV2({
          servers: {off: credentialed({disabled: true})},
          dead: {...LOCAL, headers: {A: 'b'}, enabled: false},
        }),
      )

      expect(plan.stripped).toEqual([
        {name: 'off', layout: 'native'},
        {name: 'dead', layout: 'legacy'},
      ])
    })

    it.each([
      [
        'a flat `disabled: true`, which the 2.4.2 client ignores',
        (flags: Record<string, unknown>) => ({off: credentialed(flags)}),
        {disabled: true},
      ],
      [
        'a native `enabled: false`, which the 2.4.2 client ignores',
        (flags: Record<string, unknown>) => ({servers: {off: credentialed(flags)}}),
        {enabled: false},
      ],
    ])('brokers %s, because the server stays active', (_label, layout, flags) => {
      // #given an entry whose flag the client does not honour in its layout
      const plan = unwrapOk(planMcpBrokerV2(layout(flags)))

      // #then it is routed and masked like any active server, and nothing is stripped
      expect(plan.routes).toHaveLength(1)
      expect(plan.stripped).toEqual([])
      expect(plan.secrets.map(secret => secret.value)).toContain(BEARER)
    })

    it.each([
      [
        'a flat `enabled: false`',
        (flags: Record<string, unknown>) => ({off: credentialed(flags)}),
        {enabled: false},
        'legacy',
      ],
      [
        'a native `disabled: true`',
        (flags: Record<string, unknown>) => ({servers: {off: credentialed(flags)}}),
        {disabled: true},
        'native',
      ],
    ])('strips %s, the one disabled form of its layout', (_label, layout, flags, kind) => {
      const plan = unwrapOk(planMcpBrokerV2(layout(flags)))

      expect(plan.routes).toEqual([])
      expect(plan.stripped).toEqual([{name: 'off', layout: kind}])
    })

    it('brokers an entry that says `enabled: true`', () => {
      const plan = unwrapOk(planMcpBrokerV2({on: credentialed({enabled: true})}))

      expect(plan.routes).toHaveLength(1)
    })
  })

  describe('which header values are masked and scanned', () => {
    const secretsOf = (headers: Record<string, string>) =>
      unwrapOk(planMcpBrokerV2({search: {...REMOTE, headers}})).secrets.map(secret => secret.value)

    it('takes a value of 8 characters or more, and the token after Bearer, Basic or Token', () => {
      expect(secretsOf({'X-Key': 'abcdefgh'})).toEqual(['abcdefgh'])
      expect(secretsOf({Authorization: 'Bearer abcdefgh1'})).toEqual(['Bearer abcdefgh1', 'abcdefgh1'])
      expect(secretsOf({Authorization: 'basic dXNlcjpwYXNz'})).toEqual(['basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'])
      expect(secretsOf({Authorization: 'TOKEN   tok-abcdefgh'})).toEqual(['TOKEN   tok-abcdefgh', 'tok-abcdefgh'])
    })

    it('leaves out a value of 7 characters or fewer, and a scheme token under the same floor', () => {
      expect(secretsOf({'X-Key': 'abcdefg', 'X-Version': 'v1', 'X-Empty': ''})).toEqual([])
      // `Bearer abcdefg` is 14 characters, so it is scanned as a whole; its 7-character token is not on its own.
      expect(secretsOf({Authorization: 'Bearer abcdefg'})).toEqual(['Bearer abcdefg'])
    })

    it('does not split a value that merely starts with a scheme word', () => {
      expect(secretsOf({Authorization: 'Bearertoken12345'})).toEqual(['Bearertoken12345'])
    })

    it('lists a value once, with the first server that holds it', () => {
      const plan = unwrapOk(
        planMcpBrokerV2({
          one: {...REMOTE, headers: {'X-Key': 'shared-value-0001'}},
          two: {...REMOTE, url: 'https://two.example.com/mcp', headers: {'X-Other': 'shared-value-0001'}},
        }),
      )

      expect(plan.secrets).toEqual([{server: 'one', value: 'shared-value-0001'}])
    })

    it('masks and scans the values of a disabled server too, so a copy elsewhere is still found', () => {
      // #given a flat and a native disabled entry, each with a long value and a short one
      const flat = unwrapOk(
        planMcpBrokerV2({off: credentialed({enabled: false, headers: {Authorization: BEARER, 'X-V': 'v1'}})}),
      )
      const native = unwrapOk(
        planMcpBrokerV2({servers: {off: credentialed({disabled: true, headers: {'X-Key': 'native-value-0001'}})}}),
      )

      // #then the headers are only dropped, but the values of 8 characters or more and the scheme token are collected
      expect(flat.routes).toEqual([])
      expect(flat.secrets.map(secret => secret.value)).toEqual([BEARER, TOKEN])
      expect(native.secrets.map(secret => secret.value)).toEqual(['native-value-0001'])
    })

    it('collects the values of a disabled entry whose headers are not all strings, without refusing it', () => {
      const plan = unwrapOk(
        planMcpBrokerV2({
          off: credentialed({
            enabled: false,
            headers: {'X-A': 12_345_678, 'X-C': ['Bearer array-token-123'], 'X-B': 'string-value-1'},
          }),
        }),
      )
      expect(plan.secrets.map(secret => secret.value)).toEqual(['string-value-1'])
    })

    it('keeps a header named __proto__ as an own header of its route', () => {
      // #given a header whose name a plain object would swallow
      const headers = JSON.parse('{"__proto__":"proto-value-0001","X-Other":"other-value-1"}') as Record<string, string>
      const plan = unwrapOk(planMcpBrokerV2({search: {...REMOTE, headers}}))

      // #then it is on the route and its value is masked like any other
      const route = plan.routes[0]?.route
      expect(Object.keys(route?.headers ?? {})).toEqual(['__proto__', 'X-Other'])
      expect(Object.getOwnPropertyDescriptor(route?.headers, '__proto__')?.value).toBe('proto-value-0001')
      expect(plan.secrets.map(secret => secret.value)).toEqual(['proto-value-0001', 'other-value-1'])
    })
  })

  describe('what is refused', () => {
    /** Each case carries a recognisable value somewhere a refusal could quote it. */
    const CANARY = 'REFUSAL-CANARY-4471'

    function refusalOf(mcp: unknown) {
      const refusal = unwrapErr(planMcpBrokerV2(mcp))
      // The reason names the rule and a fix, and never a configured value.
      expect(refusal.message).toMatch(/^isolate-agent: .+ Fix: .+\.$/)
      expect(refusal.message).not.toContain(CANARY)
      expect(refusal.message).not.toContain('set `isolate-agent: false`')
      return refusal
    }

    const withCanary = (extra: Record<string, unknown>) => ({
      ...REMOTE,
      headers: {Authorization: `Bearer ${CANARY}`},
      ...extra,
    })

    it.each([
      ['an entry under a key that holds a reference', {'{env:SERVER}': withCanary({})}, 'reference-key'],
      ['a `{file:}` key', {'{file:/x}': withCanary({})}, 'reference-key'],
      [
        'a reference key whose value has no headers of its own, which a file could supply',
        {'{file:/tmp/k}': {Authorization: `Bearer ${CANARY}`}},
        'reference-key',
      ],
      [
        'a reference key inside a headerless flat entry',
        {plain: {...REMOTE, '{file:/tmp/k}': {Authorization: `Bearer ${CANARY}`}}},
        'reference-key',
      ],
      ['a reference key naming a native server', {servers: {'{env:NAME}': {...REMOTE}}}, 'reference-key'],
      [
        'a reference key deep inside a native entry',
        {servers: {a: {...REMOTE, extra: {deep: [{'{file:/k}': CANARY}]}}}},
        'reference-key',
      ],
      [
        'a reference key beside a credentialed entry that is otherwise fine',
        {search: withCanary({}), other: {...REMOTE, '{env:X}': 1}},
        'reference-key',
      ],
      [
        'an `enabled`-only stub that also sets headers',
        {stub: {enabled: false, headers: {Authorization: `Bearer ${CANARY}`}}},
        'enabled-stub',
      ],
      [
        'a `type` built from a reference',
        {x: {type: '{env:KIND}', url: 'https://a.example/mcp', headers: {Authorization: `Bearer ${CANARY}`}}},
        'unresolved-type',
      ],
      [
        'a local server with headers',
        {x: {...LOCAL, headers: {Authorization: `Bearer ${CANARY}`}}},
        'local-with-headers',
      ],
      ['an entry with no type', {x: {url: 'https://a.example/mcp', headers: {A: CANARY}}}, 'unsupported-type'],
      ['an unknown type', {x: withCanary({type: 'sse'})}, 'unsupported-type'],
      [
        '`enabled` and `disabled` that contradict',
        {x: withCanary({enabled: true, disabled: true})},
        'conflicting-flags',
      ],
      [
        '`enabled: false` with `disabled: false`',
        {x: withCanary({enabled: false, disabled: false})},
        'conflicting-flags',
      ],
      ['an `enabled` flag that is a reference', {x: withCanary({enabled: '{env:ON}'})}, 'unresolved-flag'],
      ['a `disabled` flag that is not a boolean', {x: withCanary({disabled: 'yes'})}, 'unresolved-flag'],
      [
        'a disabled entry that holds a reference, which could resolve into the flag',
        {x: withCanary({enabled: false, note: '{env:NOTE}'})},
        'reference',
      ],
      [
        '`Bearer {env:TOKEN}` in a header',
        {x: withCanary({headers: {Authorization: 'Bearer {env:TOKEN}'}})},
        'reference',
      ],
      ['a `{file:}` value in a header', {x: withCanary({headers: {'X-Key': '{file:/run/secret}'}})}, 'reference'],
      ['a reference in the url', {x: withCanary({url: 'https://{env:HOST}/mcp'})}, 'reference'],
      ['a reference in an unknown field of the entry', {x: withCanary({extra: {deep: ['{file:./y}']}})}, 'reference'],
      ['a reference in a header name', {x: withCanary({headers: {'X-{env:N}': 'v'}})}, 'reference'],
      ['an `oauth` object', {x: withCanary({oauth: {}})}, 'oauth'],
      ['an `oauth` object with a client secret', {x: withCanary({oauth: {clientSecret: CANARY}})}, 'oauth'],
    ] as const)('refuses %s', (_label, mcp, kind) => {
      expect(refusalOf(mcp).kind).toBe(kind)
    })

    it.each([
      ['plain http', `http://mcp.example.com/${CANARY}`, 'url-not-https'],
      ['http on loopback', `http://127.0.0.1:8080/${CANARY}`, 'url-not-https'],
      ['userinfo', `https://user:${CANARY}@mcp.example.com/mcp`, 'url-userinfo'],
      ['an empty userinfo', 'https://@mcp.example.com/mcp', 'url-userinfo'],
      ['a fragment', `https://mcp.example.com/mcp#${CANARY}`, 'url-fragment'],
      ['an empty fragment', 'https://mcp.example.com/mcp#', 'url-fragment'],
      ['a query string', `https://mcp.example.com/mcp?sig=${CANARY}`, 'url-query'],
      ['an empty query string', 'https://mcp.example.com/mcp?', 'url-query'],
      ['a cloud metadata host', `https://169.254.169.254/${CANARY}`, 'url-unsafe-host'],
      ['a path that normalises away', `https://mcp.example.com/a/../${CANARY}`, 'url-path'],
      ['a path with a dot segment', 'https://mcp.example.com/a/./b', 'url-path'],
      ['a path with an empty segment', 'https://mcp.example.com/a//b', 'url-path'],
      ['a path with a semicolon', 'https://mcp.example.com/a;b', 'url-path'],
      ['a path with an encoded slash', 'https://mcp.example.com/a%2Fb', 'url-path'],
      ['a path with a space', 'https://mcp.example.com/a b', 'url-path'],
      ['a backslash', String.raw`https://mcp.example.com\mcp`, 'url-path'],
      ['a scheme-relative form', 'https:mcp.example.com/mcp', 'url-invalid'],
      ['text that is not a URL', `not a url ${CANARY}`, 'url-invalid'],
    ])('refuses %s in the url', (_label, url, kind) => {
      expect(refusalOf({x: withCanary({url})}).kind).toBe(kind)
    })

    it('refuses a url that is not a string, including one a URL parser would coerce into a valid URL', () => {
      expect(refusalOf({x: {type: 'remote', url: 5, headers: {A: CANARY}}}).kind).toBe('url-invalid')
      expect(refusalOf({x: {...REMOTE, headers: {A: CANARY}, url: ['https://mcp.example.com/mcp']}}).kind).toBe(
        'url-invalid',
      )
    })

    it('refuses a url longer than the frame carries', () => {
      const long = `https://mcp.example.com/${'a'.repeat(2048)}`

      expect(refusalOf({x: {...REMOTE, headers: {A: CANARY}, url: long}}).kind).toBe('url-invalid')
    })

    it.each([...KEY_PROXY_MCP_FORBIDDEN_HEADERS])(
      'refuses the header %s, which the forwarder owns, whatever its case',
      lowered => {
        const refusal = refusalOf({x: withCanary({headers: {[lowered.toUpperCase()]: CANARY}})})

        expect(refusal.kind).toBe('header-forbidden')
        expect(refusal.message).toContain(`"${lowered}"`)
      },
    )

    it('refuses the headers named for it in the plan: Host, Connection and Transfer-Encoding', () => {
      for (const name of ['Host', 'Connection', 'Transfer-Encoding']) {
        expect(refusalOf({x: withCanary({headers: {[name]: CANARY}})}).kind).toBe('header-forbidden')
      }
    })

    it('refuses two header names that differ only in case, naming neither value', () => {
      const refusal = refusalOf({x: withCanary({headers: {'X-Key': CANARY, 'x-key': `${CANARY}-2`}})})

      expect(refusal.kind).toBe('header-duplicate')
    })

    it.each([
      ['a name with a space', 'Bad Name'],
      ['an empty name', ''],
      ['a name with a colon', 'X:Key'],
      ['a name with a newline', 'X-Key\r\nX-Injected'],
      ['a non-ASCII name', 'X-Clé'],
    ])('refuses %s, without echoing it', (_label, name) => {
      const refusal = refusalOf({x: withCanary({headers: {[name]: 'value-0001'}})})

      expect(refusal.kind).toBe('header-name-invalid')
      expect(refusal.message).not.toContain(name === '' ? 'EMPTY-NAME-SENTINEL' : name)
    })

    it.each([
      ['a newline', `a\nb${CANARY}`],
      ['a carriage return', `a\r${CANARY}`],
      ['a NUL', `a\u0000${CANARY}`],
      ['DEL', `a\u007F${CANARY}`],
      ['a character above Latin-1', `a\u2603${CANARY}`],
    ])('refuses a header value with %s', (_label, value) => {
      expect(refusalOf({x: withCanary({headers: {'X-Key': value}})}).kind).toBe('header-value-invalid')
    })

    it.each([
      ['null', null],
      ['a list', [['A', CANARY]]],
      ['a string', CANARY],
    ])('refuses `headers` that is %s', (_label, headers) => {
      expect(refusalOf({x: withCanary({headers})}).kind).toBe('headers-invalid')
    })

    it('refuses a header whose value is not a string', () => {
      expect(refusalOf({x: withCanary({headers: {'X-Key': 5}})}).kind).toBe('header-value-invalid')
    })

    it('refuses an `mcp` value that is not an object', () => {
      expect(unwrapErr(planMcpBrokerV2('nope')).kind).toBe('unreadable-layout')
    })

    it('refuses more servers, more headers, longer values or more header text than the wire frame carries', () => {
      const many = Object.fromEntries(
        Array.from({length: 65}, (_value, index) => [`s${index}`, {...REMOTE, headers: {}}] as const),
      )
      const manyHeaders = Object.fromEntries(Array.from({length: 33}, (_value, index) => [`X-H${index}`, 'v'] as const))

      expect(refusalOf(many).kind).toBe('too-many-servers')
      expect(refusalOf({x: withCanary({headers: manyHeaders})}).kind).toBe('too-many-headers')
      expect(refusalOf({x: withCanary({headers: {'X-Key': 'a'.repeat(4097)}})}).kind).toBe('header-value-too-long')
      expect(unwrapOk(planMcpBrokerV2({x: {...REMOTE, headers: {'X-Key': 'a'.repeat(4096)}}})).routes).toHaveLength(1)
    })

    it('refuses headers that together outgrow the frame, though each server is within its own limits', () => {
      const heavy = (index: number) =>
        [
          `s${index}`,
          {
            ...REMOTE,
            headers: Object.fromEntries(Array.from({length: 8}, (_v, h) => [`X-H${h}`, 'a'.repeat(1000)] as const)),
          },
        ] as const
      const servers = Object.fromEntries(Array.from({length: 40}, (_v, index) => heavy(index)))

      expect(refusalOf(servers).kind).toBe('headers-too-large')
    })

    it('names the server by its sanitised, bounded name, never as typed', () => {
      const refusal = unwrapErr(
        planMcpBrokerV2({[`my server/${'x'.repeat(100)}"quoted"`]: {...LOCAL, headers: {A: 'b'}}}),
      )

      expect(refusal.server).toBe(`my_server_${'x'.repeat(54)}`)
      expect(refusal.message).toContain(`"${refusal.server}"`)
      expect(refusal.message).not.toContain('/')
    })

    it('refuses the first bad entry even when other entries are fine, and plans nothing', () => {
      const result = planMcpBrokerV2({good: credentialed(), bad: withCanary({url: 'http://mcp.example.com/mcp'})})

      expect(unwrapErr(result).kind).toBe('url-not-https')
    })

    it('does not refuse a bad shape on an entry that has no `headers` key', () => {
      // A remote with an `http://` url and no headers carries no credential, so it stays direct and unchanged.
      const plan = unwrapOk(planMcpBrokerV2({plain: {type: 'remote', url: 'http://mcp.example.com/mcp'}}))

      expect(plan.routes).toEqual([])
    })
  })
})

describe('applyBrokeredMcpV2', () => {
  const HEADER = 'Bearer rewrite-CANARY-0123456789'
  const LOOPBACK = 'http://127.0.0.1:43111/mcp/s1'
  const route = (name: string, layout: 'legacy' | 'native', url = LOOPBACK) =>
    ({name, layout, action: 'route', url}) as const
  const strip = (name: string, layout: 'legacy' | 'native') => ({name, layout, action: 'strip'}) as const

  it('points a legacy entry at its route, drops its headers, sets `oauth: false` and keeps its other fields', () => {
    // #given a credentialed legacy remote with settings of its own, next to servers the broker does not touch
    const operator = {
      model: 'a/b',
      mcp: {
        search: {...REMOTE, headers: {Authorization: HEADER}, timeout: 9000, codemode: false},
        direct: REMOTE,
        docs: LOCAL,
        timeout: 5000,
      },
    }

    // #when rewritten
    const result = unwrapOk(applyBrokeredMcpV2(operator, {servers: [route('search', 'legacy')]}))

    // #then only that entry changed: loopback url, no headers, oauth false, the rest as written, in the same key order
    expect(result).toEqual({
      model: 'a/b',
      mcp: {
        search: {type: 'remote', url: LOOPBACK, timeout: 9000, codemode: false, oauth: false},
        direct: REMOTE,
        docs: LOCAL,
        timeout: 5000,
      },
    })
    expect(Object.keys((result.mcp as Record<string, unknown>).search as object)).toEqual([
      'type',
      'url',
      'timeout',
      'codemode',
      'oauth',
    ])
    expect(JSON.stringify(result)).not.toContain(HEADER)
    // The input is not mutated.
    expect((operator.mcp.search.headers as Record<string, string>).Authorization).toBe(HEADER)
  })

  it('rewrites the native `mcp.servers.<name>` layout, and both spellings in one config', () => {
    const operator = {
      mcp: {
        legacy: {...REMOTE, headers: {Authorization: HEADER}},
        servers: {native: {...REMOTE, headers: {Authorization: HEADER}}, other: REMOTE},
      },
    }

    const result = unwrapOk(
      applyBrokeredMcpV2(operator, {
        servers: [
          route('legacy', 'legacy', 'http://127.0.0.1:1/mcp/s1'),
          route('native', 'native', 'http://127.0.0.1:1/mcp/s2'),
        ],
      }),
    )

    expect(result.mcp).toEqual({
      legacy: {type: 'remote', url: 'http://127.0.0.1:1/mcp/s1', oauth: false},
      servers: {native: {type: 'remote', url: 'http://127.0.0.1:1/mcp/s2', oauth: false}, other: REMOTE},
    })
  })

  it('drops the headers of a stripped entry and touches nothing else about it', () => {
    const operator = {mcp: {off: {...REMOTE, headers: {Authorization: HEADER}, enabled: false}}}

    const result = unwrapOk(applyBrokeredMcpV2(operator, {servers: [strip('off', 'legacy')]}))

    expect(result.mcp).toEqual({off: {...REMOTE, enabled: false}})
    expect(JSON.stringify(result)).not.toContain(HEADER)
  })

  it('does not confuse a legacy server named `servers` with the native map, nor reach into `timeout`', () => {
    const operator = {mcp: {servers: {...REMOTE, headers: {Authorization: HEADER}}, timeout: {startup: 1000}}}

    const result = unwrapOk(applyBrokeredMcpV2(operator, {servers: [route('servers', 'legacy')]}))

    expect(result.mcp).toEqual({
      servers: {type: 'remote', url: LOOPBACK, oauth: false},
      timeout: {startup: 1000},
    })
  })

  it('keeps a server named `__proto__` an own key', () => {
    const operator = JSON.parse(
      `{"mcp": {"__proto__": {"type": "remote", "url": "https://a.example/mcp", "headers": {"A": "${HEADER}"}}}}`,
    ) as Record<string, unknown>

    const result = unwrapOk(applyBrokeredMcpV2(operator, {servers: [route('__proto__', 'legacy')]}))

    expect(Object.keys(result.mcp as object)).toEqual(['__proto__'])
    expect(JSON.stringify(result)).not.toContain(HEADER)
  })

  it('returns the config as it was when nothing is brokered and nothing has headers', () => {
    const operator = {model: 'a/b', mcp: {direct: REMOTE, docs: LOCAL}}

    expect(unwrapOk(applyBrokeredMcpV2(operator, {servers: []}))).toEqual(operator)
    expect(unwrapOk(applyBrokeredMcpV2({model: 'a/b'}, {servers: []}))).toEqual({model: 'a/b'})
  })

  it('fails, naming the server and no value, when a planned entry is not in the config', () => {
    const operator = {mcp: {search: {...REMOTE, headers: {Authorization: HEADER}}}}

    const message = unwrapErr(applyBrokeredMcpV2(operator, {servers: [route('search', 'native')]}))

    expect(message).toContain('"search"')
    expect(message).not.toContain(HEADER)
  })

  it('fails when a planned entry has no headers to drop, rather than rewrite a server it never classified', () => {
    const operator = {mcp: {search: REMOTE}}

    expect(unwrapErr(applyBrokeredMcpV2(operator, {servers: [route('search', 'legacy')]}))).toContain('"search"')
  })

  it('fails closed when any entry keeps headers the plan did not cover, without quoting them', () => {
    // #given two credentialed servers, only one of which was planned
    const operator = {
      mcp: {
        planned: {...REMOTE, headers: {Authorization: HEADER}},
        missed: {...REMOTE, headers: {Authorization: HEADER}},
      },
    }

    // #when rewritten
    const message = unwrapErr(applyBrokeredMcpV2(operator, {servers: [route('planned', 'legacy')]}))

    // #then it fails and names the server that kept its headers
    expect(message).toContain('"missed"')
    expect(message).not.toContain(HEADER)
  })

  it('fails closed on a leftover entry the broker would refuse, without quoting it', () => {
    const operator = {mcp: {local: {...LOCAL, headers: {Authorization: HEADER}}}}

    const message = unwrapErr(applyBrokeredMcpV2(operator, {servers: []}))

    expect(message).toContain('isolate-agent')
    expect(message).not.toContain(HEADER)
  })
})
