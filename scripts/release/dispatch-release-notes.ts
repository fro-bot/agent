#!/usr/bin/env node

import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import process from 'node:process'

// This file uses .ts import because it runs directly under Node's
// --experimental-strip-types / --experimental-transform-types.
// The test file (release-notes.test.ts) uses .js because it runs under
// Vitest with bundler module resolution. Both are correct for their runtime.
import {buildNarrationPrompt, classifyOutcome, selectDispatchedRun, validateTag} from './release-notes.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ghExec(args: readonly string[], childEnv: NodeJS.ProcessEnv): string {
  return execFileSync('gh', [...args], {
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function sleep(seconds: number): void {
  // Sync sleep via Atomics.wait on a shared buffer — no subprocess needed.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  // Step 1: read target tag from argv
  const tag = process.argv[2]
  if (tag === undefined || tag === '') {
    process.stdout.write('::error::Missing required argument: target tag\n')
    process.exit(1)
  }

  // Step 2: validate tag shape
  const validation = validateTag(tag)
  if (!validation.ok) {
    process.stdout.write(`::error::Invalid RELEASE_VERSION shape: ${tag}\n`)
    process.exit(1)
  }

  // Step 3: correlation id (test escape hatch or fresh UUID)
  const correlationId = process.env.RELEASE_NOTES_TEST_CORRELATION_ID ?? randomUUID()

  // Step 4: repo
  const repo = process.env.GITHUB_REPOSITORY ?? ''

  // Step 5: build prompt
  const prompt = buildNarrationPrompt({tag, repo, correlationId})

  // Step 6: build child env — override GH_TOKEN with the dispatch PAT when available
  const dispatchToken = process.env.RELEASE_NOTES_DISPATCH_TOKEN
  const childEnv: NodeJS.ProcessEnv =
    dispatchToken != null && dispatchToken !== '' ? {...process.env, GH_TOKEN: dispatchToken} : {...process.env}

  // Step 7: capture dispatch epoch BEFORE the dispatch
  const dispatchEpoch = Math.floor(Date.now() / 1000)

  // Step 8: dispatch — fail-soft on any error
  try {
    execFileSync(
      'gh',
      [
        'workflow',
        'run',
        '--ref',
        'main',
        'fro-bot.yaml',
        '-f',
        `prompt=${prompt}`,
        '-f',
        `correlation-id=${correlationId}`,
        '-f',
        'model=anthropic/claude-haiku-4-5',
      ],
      {env: childEnv, stdio: 'inherit'},
    )
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    process.stdout.write(
      `::warning::Dispatch failed (correlation=${correlationId}): ${message}. Narration skipped; release is unaffected.\n`,
    )
    process.exit(0)
  }

  // Step 9: poll loop
  const pollBudget = Number(process.env.RELEASE_NOTES_TEST_POLL_BUDGET_SECS ?? 180)
  const pollInterval = Number(process.env.RELEASE_NOTES_TEST_POLL_INTERVAL_SECS ?? 5)
  const pollDeadline = Date.now() + pollBudget * 1000

  let runId: number | null = null

  while (Date.now() < pollDeadline) {
    try {
      const raw = ghExec(
        [
          'run',
          'list',
          '--workflow=fro-bot.yaml',
          '--branch=main',
          '--event=workflow_dispatch',
          '--json',
          'databaseId,createdAt',
          '--limit',
          '10',
        ],
        childEnv,
      )
      const runs = JSON.parse(raw) as readonly {databaseId: number; createdAt: string}[]
      runId = selectDispatchedRun(runs, dispatchEpoch)
      if (runId !== null) {
        break
      }
    } catch {
      // transient gh error — keep polling
    }

    sleep(pollInterval)
  }

  if (runId === null) {
    process.stdout.write(
      `::warning::Dispatch sent but run not confirmed within ${pollBudget}s (correlation=${correlationId}, dispatched_at_epoch=${dispatchEpoch}). Narration runs async; release unaffected.\n`,
    )
    process.exit(0)
  }

  // Step 10: watch with hard timeout
  const watchTimeoutSecs = Number(process.env.RELEASE_NOTES_TEST_WATCH_TIMEOUT_SECS ?? 600)
  let watchExit = 0
  try {
    execFileSync('timeout', [String(watchTimeoutSecs), 'gh', 'run', 'watch', String(runId), '--exit-status'], {
      env: childEnv,
      stdio: 'inherit',
    })
  } catch (error: unknown) {
    watchExit = (error as {status?: number}).status ?? 1
  }

  // Step 11: fetch conclusion, log, and body length for classification
  let conclusion = 'unknown'
  try {
    conclusion = ghExec(['run', 'view', String(runId), '--json', 'conclusion', '--jq', '.conclusion'], childEnv)
  } catch {
    // default 'unknown'
  }

  let log = ''
  try {
    log = ghExec(['run', 'view', String(runId), '--log'], childEnv)
  } catch {
    // default ''
  }

  let bodyLen = 0
  if (conclusion === 'success') {
    try {
      const raw = ghExec(['release', 'view', tag, '--json', 'body', '--jq', '.body | length'], childEnv)
      bodyLen = Number(raw)
    } catch {
      // default 0
    }
  }

  // Step 12: classify and emit
  const result = classifyOutcome({watchExit, conclusion, log, bodyLen, targetTag: tag})

  if (result.level === 'error') {
    process.stdout.write(`::error::${result.message}\n`)
  } else if (result.level === 'warn') {
    process.stdout.write(`::warning::${result.message}\n`)
  } else {
    process.stdout.write(`${result.message}\n`)
  }

  process.exit(result.exitCode)
}

main()
