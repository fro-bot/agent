import * as fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {resolveTracingSettings} from '../../../packages/opencode-plugin/src/tracing/settings.js'
import {
  fallbackHosts,
  startRecordingHttpSink,
  tracingFallbackDocument,
  writeTracingFallbackFile,
} from './v2-server.sandbox.fallback.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
})
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-'))
  dirs.push(dir)
  return dir
}

const SINK = 'http://127.0.0.1:45871/v1/traces'
const MACHINE = 'Runner-7.Example.'
const uid = process.getuid?.() ?? 0

/** The plugin's own resolver, as a local session or a headless server would reach it. */
function resolve(configHome: string, env: Record<string, string> = {}): ReturnType<typeof resolveTracingSettings> {
  const lines: string[] = []
  const settings = resolveTracingSettings({
    env: {XDG_CONFIG_HOME: configHome, ...env},
    directory: '/a/project/elsewhere',
    log: line => lines.push(line),
    platform: 'linux',
    uid,
    hostname: () => MACHINE,
  })
  return settings
}

describe('the tracing fallback file', () => {
  const written = (): string => {
    const configHome = tempDir()
    writeTracingFallbackFile(configHome, {endpoint: SINK, hosts: fallbackHosts(MACHINE)})
    return configHome
  }

  it('is a file the plugin accepts when no launcher variable is set (the control that makes the off row mean something)', () => {
    // #given the file at the path the plugin reads, mode 0600, owned by the current user, naming this machine
    const configHome = written()

    // #when the plugin resolves its settings with no launcher variable and no headless marker
    const settings = resolve(configHome)

    // #then tracing is on, for a local session, at the sink
    expect(settings).toMatchObject({mode: 'on', host: 'local', endpoint: SINK})
    expect(settings.mode === 'on' && 'headers' in settings ? settings.headers : null).toEqual({
      'x-fallback-marker': 'sink',
    })
  })

  it('is ignored when the launcher says off: the launcher wins over the file', () => {
    // #given the same file and the Action's off document
    const settings = resolve(written(), {
      OPENCODE_FROBOT_TRACING: JSON.stringify({version: 1, host: 'action', tracing: 'off'}),
    })

    // #then
    expect(settings).toEqual({mode: 'off', reason: 'action-off'})
  })

  it('is also refused by a headless server, which is the second layer the Action server has', () => {
    // #given the markers the Action's server always carries
    expect(resolve(written(), {OPENCODE_PASSWORD: 'x'})).toEqual({mode: 'off', reason: 'headless-host'})
    expect(resolve(written(), {OPENCODE_CONFIG_CONTENT: '{}'})).toEqual({mode: 'off', reason: 'headless-host'})
  })

  it('would not be accepted if it were wrong, so the control above is not vacuous', () => {
    // #given the file with group access, then one naming another machine
    const configHome = written()
    fs.chmodSync(path.join(configHome, 'fro-bot', 'opencode-plugin', 'tracing.json'), 0o640)
    expect(resolve(configHome)).toEqual({mode: 'off', reason: 'settings-file-unsafe'})
    const other = tempDir()
    writeTracingFallbackFile(other, {endpoint: SINK, hosts: ['another-machine']})
    expect(resolve(other)).toEqual({mode: 'off', reason: 'machine-not-listed'})
  })

  it('names the machine the way the plugin matches it: lower case, no trailing dot', () => {
    expect(fallbackHosts('Runner-7.Example.')).toEqual(['runner-7.example'])
  })

  it('refuses an endpoint the plugin would refuse, so a bad fallback is never planted', () => {
    expect(() => tracingFallbackDocument({endpoint: 'http://collector.example/v1/traces', hosts: ['a']})).toThrow()
  })
})

describe('the recording sink', () => {
  it('records what is posted to it and answers 200', async () => {
    // #given a sink
    const sink = await startRecordingHttpSink()
    try {
      // #when a request is posted
      const status = await new Promise<number>(resolveStatus => {
        const request = http.request(`${sink.origin}/v1/traces`, {method: 'POST'}, response => {
          response.resume()
          resolveStatus(response.statusCode ?? 0)
        })
        request.end('{}')
      })

      // #then it answered and kept the request line
      expect(status).toBe(200)
      expect(sink.requests).toEqual(['POST /v1/traces'])
      expect(sink.address).toBe(new URL(sink.origin).host)
    } finally {
      await sink.close()
    }
  })

  it('is loopback http, which the plugin accepts for a user file', async () => {
    const sink = await startRecordingHttpSink()
    try {
      expect(() => tracingFallbackDocument({endpoint: `${sink.origin}/v1/traces`, hosts: ['a']})).not.toThrow()
    } finally {
      await sink.close()
    }
  })
})
