import {resolveResponseDelivery} from '@fro-bot/runtime'
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
