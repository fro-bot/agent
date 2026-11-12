import type {AgentContext} from '@fro-bot/runtime'
import type {TriggerResultProcess} from '../triggers/types.js'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createMockLogger, serializeLoggerCalls} from '../../shared/test-helpers.js'
import {inspectResponseFile} from './response-file.js'
import {readAndParseResponseFile} from './response-post.js'

const SECRET = 'RUNNER-SECRET-MUST-NEVER-BE-POSTED'

async function readResponse(responseFilePath: string, fallbackPaths: readonly string[] = []) {
  const logger = createMockLogger()
  const result = await readAndParseResponseFile(
    {
      agentContext: {} as unknown as AgentContext,
      triggerResult: {} as unknown as TriggerResultProcess,
      responseFilePath,
      responseFilePathCandidates: {expectedPath: responseFilePath, fallbackPaths},
      executionSucceeded: true,
    },
    logger,
  )
  return {result, logs: serializeLoggerCalls(logger)}
}

describe('runner-side response reads refuse what the sandbox could plant', () => {
  let dir: string
  let sentinel: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'response-read-safety-')))
    sentinel = path.join(dir, 'sentinel.txt')
    fs.writeFileSync(sentinel, `${SECRET}\n`, {mode: 0o600})
    vi.stubEnv('GITHUB_WORKSPACE', path.join(dir, 'ws'))
    fs.mkdirSync(path.join(dir, 'ws'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    fs.rmSync(dir, {recursive: true, force: true})
  })

  const plant: Record<string, (target: string) => void> = {
    symlink: target => fs.symlinkSync(sentinel, target),
    fifo: target => execFileSync('mkfifo', [target]),
    directory: target => fs.mkdirSync(target),
  }

  it('control: a regular file with the same content is read as before', async () => {
    // #given a regular response file (so a refusal below is about the planted type, not the content)
    const file = path.join(dir, 'regular.md')
    fs.writeFileSync(file, SECRET)

    // #when read through the status inspector
    const status = await inspectResponseFile(file, 'comment' as never, createMockLogger())

    // #then it is read and accepted as a deliverable
    expect(status).toBe('present')
  })

  it.each(Object.keys(plant))('refuses a %s at the response path and never reads or logs the sentinel', async kind => {
    // #given the sandbox planted a %s where the response file belongs
    const file = path.join(dir, 'response.md')
    plant[kind]?.(file)

    // #when the runner reads it for delivery
    const {result, logs} = await readResponse(file)

    // #then delivery fails closed, and the sentinel content appears nowhere
    expect(result).toMatchObject({delivered: false, reason: 'file-read-failed'})
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(logs).not.toContain(SECRET)
  })

  it('refuses a symlink at the status inspector without reading the target', async () => {
    // #given a symlink to the sentinel
    const file = path.join(dir, 'response.md')
    fs.symlinkSync(sentinel, file)

    // #when inspected
    const status = await inspectResponseFile(file, 'comment' as never, createMockLogger())

    // #then it is unknown (recovery declined), not absent and not present
    expect(status).toBe('unknown')
  })

  it('refuses a fallback candidate that is a symlink', async () => {
    // #given a missing primary and a symlinked fallback under the workspace
    const fallback = path.join(dir, 'ws', 'fallback.md')
    fs.symlinkSync(sentinel, fallback)

    // #when read
    const {result, logs} = await readResponse(path.join(dir, 'missing-primary.md'), [fallback])

    // #then the fallback is refused
    expect(result).toMatchObject({delivered: false})
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(logs).not.toContain(SECRET)
  })
})
