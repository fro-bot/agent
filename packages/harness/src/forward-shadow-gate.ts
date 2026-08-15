#!/usr/bin/env node

import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {evaluateForwardShadowDirectory} from './forward-shadow.js'

export interface ForwardShadowGateCliIo {
  readonly stdout: (value: string) => void
  readonly stderr: (value: string) => void
}

const defaultIo: ForwardShadowGateCliIo = {
  stdout: value => process.stdout.write(value),
  stderr: value => process.stderr.write(value),
}

function parseArgs(
  argv: readonly string[],
): {readonly directory: string; readonly ackNoConflictEvidence: boolean} | null {
  let directory: string | undefined
  let ackNoConflictEvidence = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--ack-no-conflict-evidence') {
      ackNoConflictEvidence = true
      continue
    }
    if (arg === '--records-dir') {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) return null
      directory = next
      index++
      continue
    }
    return null
  }
  return directory === undefined ? null : {directory, ackNoConflictEvidence}
}

export async function runForwardShadowGate(
  argv: readonly string[],
  io: ForwardShadowGateCliIo = defaultIo,
): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed === null) {
    io.stderr('usage: forward-shadow-gate --records-dir <directory> [--ack-no-conflict-evidence]\n')
    return 1
  }
  try {
    const result = await evaluateForwardShadowDirectory(parsed.directory, {
      ackNoConflictEvidence: parsed.ackNoConflictEvidence,
    })
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return result.ok ? 0 : 1
  } catch {
    io.stderr('forward-shadow-gate failed to read records directory\n')
    return 1
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runForwardShadowGate(argv)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1
  })
}
