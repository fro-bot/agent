import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {captureDiagnostics, persistResponseDiagnostics, readCapturedDiagnostics} from './diagnostics.js'

const temporaryDirectories: string[] = []

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function readPersistedFile(directory: string, fileName: string): string {
  return readFileSync(path.join(directory, fileName), 'utf8')
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory != null) {
      rmSync(directory, {recursive: true, force: true})
    }
  }
})

describe('diagnostic persistence boundaries', {timeout: 30_000}, () => {
  it('captures only flat expected files and redacts the pinned OpenCode log', () => {
    // #given a flat OpenCode log, a nested log, and a symlinked directory
    const sourceDirectory = createTemporaryDirectory('fro-bot-flat-source-')
    const outputDirectory = createTemporaryDirectory('fro-bot-flat-output-')
    const outsideDirectory = createTemporaryDirectory('fro-bot-flat-outside-')
    const credential = 'flat-log-arbitrary-credential'
    writeFileSync(path.join(sourceDirectory, 'opencode.log'), `useful flat line ${credential}\n`, 'utf8')
    writeFileSync(path.join(sourceDirectory, 'nested.log'), 'nested root file\n', 'utf8')
    const nestedDirectory = path.join(sourceDirectory, 'nested')
    const symlinkDirectory = path.join(sourceDirectory, 'linked-directory')
    mkdirSync(nestedDirectory)
    writeFileSync(path.join(nestedDirectory, 'nested.log'), 'nested log\n', 'utf8')
    writeFileSync(path.join(outsideDirectory, 'outside.log'), 'outside log\n', 'utf8')
    symlinkSync(outsideDirectory, symlinkDirectory, 'dir')

    // #when flat diagnostics are captured
    const diagnosticsPath = captureDiagnostics(sourceDirectory, outputDirectory, 'flat-only', [credential])

    // #then the flat log survives redacted while nested content and symlink targets do not
    expect(diagnosticsPath).not.toBeNull()
    if (diagnosticsPath == null) {
      throw new Error('Expected flat diagnostics path')
    }
    expect(readPersistedFile(diagnosticsPath, 'opencode.log')).toContain('useful flat line')
    expect(readPersistedFile(diagnosticsPath, 'opencode.log')).not.toContain(credential)
    expect(readCapturedDiagnostics(diagnosticsPath)).not.toContain('nested log')
    expect(readdirSync(diagnosticsPath)).not.toContain('nested')
    expect(readdirSync(diagnosticsPath)).not.toContain('linked-directory')
  })

  it('caps immediate diagnostic entries before capture', () => {
    // #given more immediate expected files than the bounded traversal may inspect
    const sourceDirectory = createTemporaryDirectory('fro-bot-entry-cap-source-')
    const outputDirectory = createTemporaryDirectory('fro-bot-entry-cap-output-')
    for (let index = 0; index < 80; index += 1) {
      writeFileSync(
        path.join(sourceDirectory, `entry-${String(index).padStart(3, '0')}.log`),
        `entry-${index}\n`,
        'utf8',
      )
    }

    // #when flat diagnostics are captured
    const diagnosticsPath = captureDiagnostics(sourceDirectory, outputDirectory, 'entry-cap', [])

    // #then the explicit traversal cap prevents an unbounded file copy
    expect(diagnosticsPath).not.toBeNull()
    if (diagnosticsPath == null) {
      throw new Error('Expected entry-cap diagnostics path')
    }
    const capturedFiles = readdirSync(diagnosticsPath).filter(fileName => fileName.endsWith('.log'))
    expect(capturedFiles.length).toBeLessThanOrEqual(64)
  })

  it('redacts an arbitrary response credential before truncation', () => {
    // #given an arbitrary credential crossing the response diagnostic byte boundary
    const sourceDirectory = createTemporaryDirectory('fro-bot-response-boundary-')
    const credential = 'arbitrary-credential-shape-that-must-not-leak'
    const rawResponse = `${'R'.repeat(65_536 - credential.length + 3)}${credential}response-tail`

    // #when the response diagnostic is persisted and read back
    const diagnosticsPath = persistResponseDiagnostics(sourceDirectory, 'response-boundary', rawResponse, [credential])

    // #then no credential fragment survives while useful surrounding response content remains
    expect(diagnosticsPath).not.toBeNull()
    if (diagnosticsPath == null) {
      throw new Error('Expected response diagnostics path')
    }
    const persisted = readPersistedFile(diagnosticsPath, 'response.md')
    const readback = readCapturedDiagnostics(diagnosticsPath, [credential])
    expect(persisted).toContain('RRRR')
    expect(persisted).not.toContain(credential.slice(0, 12))
    expect(persisted).not.toContain(credential.slice(-12))
    expect(readback).not.toContain(credential.slice(0, 12))
    expect(readback).not.toContain(credential.slice(-12))
  })

  it('omits an oversized log instead of persisting an unsafe partial slice', () => {
    // #given an oversized log whose arbitrary credential crosses the safe read budget
    const sourceDirectory = createTemporaryDirectory('fro-bot-log-boundary-source-')
    const outputDirectory = createTemporaryDirectory('fro-bot-log-boundary-output-')
    const credential = 'arbitrary-log-credential-that-must-not-leak'
    writeFileSync(
      path.join(sourceDirectory, 'agent.log'),
      `${'L'.repeat(65_536 - credential.length + 3)}${credential}log-tail`,
      'utf8',
    )

    // #when the diagnostic directory is captured
    const diagnosticsPath = captureDiagnostics(sourceDirectory, outputDirectory, 'log-boundary', [credential])

    // #then the oversized log is represented only by a fixed safe marker
    expect(diagnosticsPath).not.toBeNull()
    if (diagnosticsPath == null) {
      throw new Error('Expected log diagnostics path')
    }
    const persisted = readPersistedFile(diagnosticsPath, 'agent.log')
    expect(persisted).not.toContain(credential.slice(0, 12))
    expect(persisted).not.toContain(credential.slice(-12))
    expect(persisted).not.toContain('LLLL')
    expect(readCapturedDiagnostics(diagnosticsPath, [credential])).not.toContain(credential.slice(0, 12))
  })

  it('enforces one total persisted log budget while retaining useful normal diagnostics', () => {
    // #given multiple normal-sized logs whose combined content exceeds the total budget
    const sourceDirectory = createTemporaryDirectory('fro-bot-log-total-source-')
    const outputDirectory = createTemporaryDirectory('fro-bot-log-total-output-')
    writeFileSync(path.join(sourceDirectory, 'a.log'), `${'A'.repeat(40_000)} useful-a\n`, 'utf8')
    writeFileSync(path.join(sourceDirectory, 'b.jsonl'), `${'B'.repeat(40_000)} useful-b\n`, 'utf8')

    // #when the diagnostic directory is captured
    const diagnosticsPath = captureDiagnostics(sourceDirectory, outputDirectory, 'total-budget', [])

    // #then useful content remains and all persisted files share one bounded content budget
    expect(diagnosticsPath).not.toBeNull()
    if (diagnosticsPath == null) {
      throw new Error('Expected total-budget diagnostics path')
    }
    const files = readdirSync(diagnosticsPath).filter(
      fileName => fileName.endsWith('.log') || fileName.endsWith('.jsonl'),
    )
    const persistedBytes = files.reduce(
      (total, fileName) => total + statSync(path.join(diagnosticsPath, fileName)).size,
      0,
    )
    const persistedText = files.map(fileName => readPersistedFile(diagnosticsPath, fileName)).join('\n')
    expect(persistedBytes).toBeLessThanOrEqual(65_536)
    expect(persistedText).toContain('useful-a')
  })
})
