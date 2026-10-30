/**
 * Fixture binary for `server-v2` tests: a tiny Node script that behaves like `opencode serve --stdio`.
 *
 * It speaks only the endpoints the V2 lifecycle touches (`/api/info`, `/api/agent`, `/api/plugin`,
 * `/api/session/active`, `/api/session/:id/interrupt`), authenticates with Basic `opencode:<OPENCODE_PASSWORD>`
 * like upstream, exits when stdin closes, and appends an ordered event log so tests can assert sequencing
 * (for example "interrupt before stdin close").
 *
 * Not shipped: imported by tests only.
 */

import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export interface FixtureConfig {
  /** Print the listening line this long after start. Default 0. */
  readonly listenDelayMs?: number
  /** Never print the listening line. */
  readonly silent?: boolean
  /** Exit with this code before printing anything. */
  readonly exitBeforeListen?: number
  /** Advertise this port instead of the real one. */
  readonly advertisePort?: number
  /** `/api/agent` answers 503 until this long after listening. Default 0. */
  readonly agentReadyAfterMs?: number
  /** `/api/agent` answers 503 forever. */
  readonly agentNeverReady?: boolean
  /** `/api/agent` never answers. */
  readonly agentHang?: boolean
  /** Answer 401 to every request, as a server holding a different password would. */
  readonly rejectAllAuth?: boolean
  readonly plugins?: readonly {
    readonly id?: string
    readonly status: 'active' | 'failed'
    readonly error?: string
    /** Not listed until this long after listening (an activation that finishes late). */
    readonly appearAfterMs?: number
  }[]
  /** Sessions the server reports as active. */
  readonly activeSessions?: readonly string[]
  /** An interrupt removes the session from the active list after this delay. Default 0. */
  readonly dropDelayMs?: number
  /** Interrupts reply `{interrupted:true}` but the session never leaves the active list. */
  readonly neverDrops?: boolean
  /** The first N interrupts per session reply `{interrupted:false}` and do nothing (an unadmitted turn). */
  readonly interruptFalseFirst?: number
  /** Keep running when stdin closes. */
  readonly ignoreStdinClose?: boolean
  /** Make the unauthenticated-looking `/api/info` fail like a stopped server (500). */
  readonly infoStatus?: number
}

export interface FixtureRecord {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly pid: number
}

export interface Fixture {
  readonly binaryPath: string
  readonly logPath: string
  readonly dir: string
  readonly readRecord: () => FixtureRecord
  readonly readLog: () => readonly string[]
  readonly cleanup: () => void
}

const FIXTURE_SOURCE = String.raw`
const fs = require('node:fs')
const http = require('node:http')

const cfg = __CONFIG__
const log = line => fs.appendFileSync(cfg.logPath, line + '\n')
const args = process.argv.slice(2)
const port = Number(args[args.indexOf('--port') + 1])
const password = process.env.OPENCODE_PASSWORD
fs.writeFileSync(cfg.recordPath, JSON.stringify({argv: args, env: {...process.env}, pid: process.pid}))
// Upstream --stdio deletes the credential from its own environment so tools never inherit it.
delete process.env.OPENCODE_PASSWORD

if (cfg.exitBeforeListen !== undefined) process.exit(cfg.exitBeforeListen)

const expected = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')
const active = new Set(cfg.activeSessions ?? [])
const interrupts = new Map()
let listenedAt = 0

function json(res, status, body) {
  res.writeHead(status, {'content-type': 'application/json'})
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const authorized = req.headers.authorization === expected && cfg.rejectAllAuth !== true
  log('req ' + req.method + ' ' + url.pathname + ' auth=' + (authorized ? 'ok' : 'bad') + ' dir=' + (req.headers['x-opencode-directory'] ?? '-'))
  if (!authorized) return json(res, 401, {_tag: 'UnauthorizedError', message: 'Authentication required'})
  const sinceListen = Date.now() - listenedAt

  if (req.method === 'GET' && url.pathname === '/api/info') {
    return json(res, cfg.infoStatus ?? 200, {version: '2.2.0', pid: process.pid})
  }
  if (req.method === 'GET' && url.pathname === '/api/agent') {
    if (cfg.agentHang === true) return
    if (cfg.agentNeverReady === true || sinceListen < (cfg.agentReadyAfterMs ?? 0)) {
      log('agent 503')
      return json(res, 503, {_tag: 'ServiceUnavailableError', message: 'Location plugins did not finish activating', service: 'plugin'})
    }
    log('agent 200')
    return json(res, 200, {location: {directory: '/x'}, data: []})
  }
  if (req.method === 'GET' && url.pathname === '/api/plugin') {
    const data = (cfg.plugins ?? [])
      .filter(p => sinceListen >= (p.appearAfterMs ?? 0))
      .map(p => ({
        ...(p.id === undefined ? {} : {id: p.id}),
        source: {type: 'package', target: 'fixture'},
        features: {server: true},
        state: p.status === 'active' ? {status: 'active'} : {status: 'failed', error: p.error ?? 'boom'},
      }))
    return json(res, 200, {location: {directory: '/x'}, data})
  }
  if (req.method === 'GET' && url.pathname === '/api/session/active') {
    return json(res, 200, {data: Object.fromEntries([...active].map(id => [id, {type: 'running'}]))})
  }
  const interrupt = url.pathname.match(/^\/api\/session\/([^/]+)\/interrupt$/)
  if (req.method === 'POST' && interrupt) {
    const id = decodeURIComponent(interrupt[1])
    const count = (interrupts.get(id) ?? 0) + 1
    interrupts.set(id, count)
    log('interrupt ' + id)
    if (count <= (cfg.interruptFalseFirst ?? 0) || !active.has(id)) return json(res, 200, {interrupted: false})
    if (cfg.neverDrops !== true) {
      setTimeout(() => {
        active.delete(id)
        log('dropped ' + id)
      }, cfg.dropDelayMs ?? 0)
    }
    return json(res, 200, {interrupted: true})
  }
  return json(res, 404, {_tag: 'NotFound'})
})

process.stdin.resume()
process.stdin.on('end', () => {
  log('stdin-closed')
  if (cfg.ignoreStdinClose !== true) process.exit(0)
})

server.listen(port, '127.0.0.1', () => {
  listenedAt = Date.now()
  if (cfg.silent === true) return
  setTimeout(() => console.log(JSON.stringify({url: 'http://127.0.0.1:' + (cfg.advertisePort ?? port)})), cfg.listenDelayMs ?? 0)
})
`

export function createFixture(config: FixtureConfig = {}): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'server-v2-fixture-'))
  const binaryPath = path.join(dir, 'opencode')
  const logPath = path.join(dir, 'events.log')
  const recordPath = path.join(dir, 'record.json')
  const source = FIXTURE_SOURCE.replace('__CONFIG__', JSON.stringify({...config, logPath, recordPath}))
  writeFileSync(binaryPath, `#!${process.execPath}\n${source}`)
  chmodSync(binaryPath, 0o755)
  return {
    binaryPath,
    logPath,
    dir,
    readRecord: () => JSON.parse(readFileSync(recordPath, 'utf8')) as FixtureRecord,
    readLog: () => {
      try {
        return readFileSync(logPath, 'utf8')
          .split('\n')
          .filter(line => line !== '')
      } catch {
        return []
      }
    },
    cleanup: () => rmSync(dir, {recursive: true, force: true}),
  }
}
