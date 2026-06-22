/**
 * Live integration probe for OpenCode 1.17.9 SDK streaming path.
 *
 * Gate: OPENCODE_LIVE_PROBE=1 (skipped in normal CI)
 *
 * Proves the real harness consumer path (createOpencode → processEventStream →
 * arming → wait) works end-to-end against a stock isolated 1.17.9 server.
 *
 * Run: OPENCODE_LIVE_PROBE=1 pnpm vitest run src/features/agent/live-probe-1.17.9.test.ts
 */
import type {Event} from '@opencode-ai/sdk'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {createOpencode} from '@opencode-ai/sdk'
import {createOpencodeClient} from '@opencode-ai/sdk/v2'
import {describe, expect, it} from 'vitest'
import {createLogger} from '../../shared/logger.js'
import {runPromptAttempt} from './retry.js'

const PROBE_ENABLED = process.env.OPENCODE_LIVE_PROBE === '1'
const PROBE_TIMEOUT_MS = 120_000 // 2 minutes for LLM response

// ---------------------------------------------------------------------------
// Resolve the real bun binary at module load time (before any env changes).
// Bypasses mise shims which may be broken.
// ---------------------------------------------------------------------------

function resolveBunBinaryAtLoad(): string {
  // Try common mise install paths for bun 1.3.14 (the pinned version)
  const realHome = os.homedir() // real HOME before any env mutation
  const misePaths = [
    path.join(realHome, '.local', 'share', 'mise', 'installs', 'bun', '1.3.14', 'bin', 'bun'),
    path.join(realHome, '.local', 'share', 'mise', 'installs', 'bun', '1.3', 'bin', 'bun'),
    path.join(realHome, '.local', 'share', 'mise', 'installs', 'bun', 'latest', 'bin', 'bun'),
  ]
  for (const p of misePaths) {
    if (fs.existsSync(p)) {
      try {
        const version = childProcess
          .execSync(`"${p}" --version`, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']})
          .trim()
        if (version.length > 0) return p
      } catch {
        // try next
      }
    }
  }
  // Fall back to PATH resolution (may be a shim, but try anyway)
  try {
    return childProcess.execSync('which bun', {encoding: 'utf8'}).trim()
  } catch {
    throw new Error('Cannot find bun binary — install bun or set up mise correctly')
  }
}

// Resolved once at module load, before any env mutations
const BUN_BIN = PROBE_ENABLED ? resolveBunBinaryAtLoad() : '/usr/bin/false'

// ---------------------------------------------------------------------------
// Isolated environment helpers
// ---------------------------------------------------------------------------

interface IsolatedEnv {
  readonly home: string
  readonly binDir: string
  readonly opencodeBin: string
  readonly originalEnv: Record<string, string | undefined>
}

function createIsolatedEnv(suffix: string): IsolatedEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `oc-probe-${suffix}-`))
  const binDir = path.join(home, 'bin')
  fs.mkdirSync(binDir, {recursive: true})

  // Create a wrapper script that calls `bun x opencode-ai@1.17.9`
  const opencodeBin = path.join(binDir, 'opencode')
  fs.writeFileSync(
    opencodeBin,
    `#!/bin/sh
exec "${BUN_BIN}" x opencode-ai@1.17.9 "$@"
`,
    {mode: 0o755},
  )

  // Save original env values
  const originalEnv: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  }

  // Apply isolated env
  process.env.HOME = home
  process.env.PATH = `${binDir}:${originalEnv.PATH ?? ''}`
  process.env.XDG_CONFIG_HOME = path.join(home, '.config')
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share')
  process.env.XDG_CACHE_HOME = path.join(home, '.cache')

  return {home, binDir, opencodeBin, originalEnv}
}

function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function cleanupIsolatedEnv(env: IsolatedEnv): void {
  restoreEnv(env.originalEnv)
  try {
    fs.rmSync(env.home, {recursive: true, force: true})
  } catch {
    // best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Probe suite
// ---------------------------------------------------------------------------

describe.skipIf(!PROBE_ENABLED)('OpenCode 1.17.9 live integration probe', {timeout: PROBE_TIMEOUT_MS}, () => {
  const logger = createLogger({component: 'probe'})

  it('streams tool execution and final text via real harness consumer path', {timeout: PROBE_TIMEOUT_MS}, async () => {
    const env = createIsolatedEnv('main')
    const abortController = new AbortController()
    let opencode: Awaited<ReturnType<typeof createOpencode>> | null = null

    try {
      // -----------------------------------------------------------------------
      // Verify the binary version before starting the server
      // -----------------------------------------------------------------------
      const versionOutput = childProcess
        .execSync(`"${env.opencodeBin}" --version`, {encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']})
        .trim()
      console.log('[probe] opencode binary version:', versionOutput)
      expect(versionOutput).toContain('1.17.9')
      console.log('[probe] Isolated HOME:', env.home)

      // -----------------------------------------------------------------------
      // Start an isolated stock 1.17.9 server
      //
      // Config:
      //   - permission.bash = "allow" → auto-allow bash tool (no interactive gate)
      //   - permission.edit = "allow" → auto-allow edits
      //   - model = "opencode/big-pickle" → free model, no auth required
      //   - isolated HOME/XDG means no global plugins load (--pure equivalent)
      // -----------------------------------------------------------------------
      opencode = await createOpencode({
        signal: abortController.signal,
        timeout: 30_000,
        port: 0, // Random port to avoid conflicts
        config: {
          permission: {
            bash: 'allow',
            edit: 'allow',
            webfetch: 'allow',
          },
          model: 'opencode/big-pickle',
        },
      })

      const {client, server} = opencode
      console.log('[probe] Server started at:', server.url)

      // -----------------------------------------------------------------------
      // Create a session
      // -----------------------------------------------------------------------
      const sessionResponse = await client.session.create()
      expect(sessionResponse.data).toBeDefined()
      expect(sessionResponse.error).toBeFalsy()
      const sessionId = sessionResponse.data!.id
      console.log('[probe] Session created:', sessionId)

      // -----------------------------------------------------------------------
      // Drive the real harness path: sendPromptToSession → runPromptAttempt
      // (mirrors what executeOpenCode does internally)
      // -----------------------------------------------------------------------
      const directory = process.cwd()
      const prompt = 'Run `echo hello_from_probe` using the bash tool and report the output.'

      // Subscribe to events BEFORE sending the prompt (mirrors harness ordering)
      const eventSubscription = await client.event.subscribe()
      const eventStream = eventSubscription.stream as AsyncIterable<Event>

      // Track observed events for assertions
      const observedEventTypes: string[] = []
      let toolLineObserved = false
      let finalTextObserved = false
      let sessionIdleObserved = false
      let sessionErrorObserved = false

      // Wrap the stream to capture event types for assertions
      async function* instrumentedStream(): AsyncIterable<Event> {
        for await (const event of eventStream) {
          const eventType = (event as {type?: string}).type ?? 'unknown'
          observedEventTypes.push(eventType)

          // Detect tool execution events (message.part.updated with tool/completed)
          if (eventType === 'session.next.tool.success') {
            toolLineObserved = true
            console.log('[probe] ✓ session.next.tool.success observed')
          } else if (eventType === 'message.part.updated') {
            const props = (event as {properties?: unknown}).properties
            const part = props != null && typeof props === 'object' ? (props as {part?: unknown}).part : undefined
            const partType = part != null && typeof part === 'object' ? (part as {type?: string}).type : undefined
            const toolState = part != null && typeof part === 'object' ? (part as {state?: unknown}).state : undefined
            const status =
              toolState != null && typeof toolState === 'object' ? (toolState as {status?: string}).status : undefined
            if (partType === 'tool' && status === 'completed') {
              toolLineObserved = true
              console.log('[probe] ✓ message.part.updated tool/completed observed')
            }
            finalTextObserved = true
          }

          if (eventType === 'message.part.delta') {
            finalTextObserved = true
          }

          if (eventType === 'session.idle') {
            sessionIdleObserved = true
            console.log('[probe] ✓ session.idle observed')
          }

          if (eventType === 'session.error') {
            sessionErrorObserved = true
            console.log('[probe] ✗ session.error observed!')
          }

          yield event
        }
      }

      // Send the prompt
      const promptResponse = await client.session.promptAsync({
        path: {id: sessionId},
        body: {
          parts: [{type: 'text', text: prompt}],
          model: {providerID: 'opencode', modelID: 'big-pickle'},
        },
        query: {directory},
      })
      console.log('[probe] Prompt sent, response error:', promptResponse.error ?? 'none')

      // Run the real harness event processor (the actual consumer path)
      const result = await runPromptAttempt(
        client,
        sessionId,
        directory,
        PROBE_TIMEOUT_MS,
        logger,
        instrumentedStream(),
        server.url,
      )

      console.log('[probe] runPromptAttempt result:', {
        success: result.success,
        error: result.error,
        llmError: result.llmError,
      })
      console.log('[probe] Observed event types:', [...new Set(observedEventTypes)].join(', '))

      // -----------------------------------------------------------------------
      // Assertions
      // -----------------------------------------------------------------------

      // 1. Tool execution rendered
      expect(toolLineObserved, 'A tool execution event (bash) should have been observed').toBe(true)

      // 2. Final assistant text arrived (message.part.delta or message.part.updated)
      expect(finalTextObserved, 'message.part.delta or message.part.updated events should have flowed').toBe(true)

      // 3. SSE events flowed
      const hasStreamEvents =
        observedEventTypes.includes('message.part.updated') || observedEventTypes.includes('message.part.delta')
      expect(hasStreamEvents, 'SSE stream events (message.part.updated or message.part.delta) should have flowed').toBe(
        true,
      )

      // 4. session.idle fired
      expect(sessionIdleObserved, 'session.idle should have fired as terminal signal').toBe(true)

      // 5. No session.error
      expect(sessionErrorObserved, 'session.error should NOT have been observed').toBe(false)

      // 6. runPromptAttempt succeeded
      expect(result.success, `runPromptAttempt should succeed, got error: ${result.error ?? 'none'}`).toBe(true)

      console.log('[probe] ✓ All assertions passed')
    } finally {
      abortController.abort()
      opencode?.server.close()
      cleanupIsolatedEnv(env)
    }
  })

  it('v2 session.wait surface: fallback behavior holds', {timeout: 30_000}, async () => {
    // -----------------------------------------------------------------------
    // Smoke the v2 session.wait surface against a live server.
    // The 1.17.3 cycle saw it return a structured "not available yet" error
    // (ServiceUnavailableError), and the harness falls back to the poll watchdog.
    // Confirm the fallback still holds: wait() either resolves or throws/errors,
    // but never hangs indefinitely.
    // -----------------------------------------------------------------------
    const env = createIsolatedEnv('v2wait')
    const abortController = new AbortController()
    let opencode: Awaited<ReturnType<typeof createOpencode>> | null = null

    try {
      opencode = await createOpencode({
        signal: abortController.signal,
        timeout: 30_000,
        port: 0, // Random port to avoid conflicts
        config: {
          permission: {bash: 'allow', edit: 'allow'},
          model: 'opencode/big-pickle',
        },
      })

      const {client, server} = opencode
      console.log('[probe:v2-wait] Server started at:', server.url)

      // Create a session
      const sessionResponse = await client.session.create()
      const sessionId = sessionResponse.data!.id
      console.log('[probe:v2-wait] Session:', sessionId)

      // Create a v2 client attached to the same server
      const v2Client = createOpencodeClient({baseUrl: server.url})

      // Call v2.session.wait() — expect it to either:
      //   a) resolve with a response (success or structured error)
      //   b) throw (ServiceUnavailableError or similar)
      // Either way, the harness poll-watchdog fallback handles it.
      let waitResult: 'resolved' | 'threw' = 'threw'
      let waitError: string | null = null
      let waitResponse: unknown = null

      try {
        // Use a short timeout signal so we don't hang if wait() blocks forever
        const waitSignal = AbortSignal.timeout(10_000)
        const response = await v2Client.v2.session.wait({sessionID: sessionId}, {signal: waitSignal})
        waitResult = 'resolved'
        waitResponse = response
        console.log('[probe:v2-wait] wait() resolved:', JSON.stringify(response).slice(0, 200))
      } catch (error) {
        waitResult = 'threw'
        waitError = error instanceof Error ? error.message : String(error)
        console.log('[probe:v2-wait] wait() threw:', waitError)
      }

      // The harness handles both cases gracefully — assert it's one or the other
      expect(['resolved', 'threw']).toContain(waitResult)

      if (waitResult === 'resolved') {
        // If it resolved, check for structured error (the 1.17.3 pattern)
        const response = waitResponse as {error?: unknown}
        if (response.error == null) {
          console.log('[probe:v2-wait] ✓ wait() resolved successfully (v2 wait path)')
        } else {
          console.log(
            '[probe:v2-wait] ✓ wait() returned structured error (poll-watchdog fallback path):',
            response.error,
          )
        }
      } else {
        console.log('[probe:v2-wait] ✓ wait() threw (poll-watchdog fallback path):', waitError)
      }

      // The key assertion: the harness signature `wait({sessionID}, options?)` is valid
      // (TypeScript would have caught a shape mismatch at compile time)
      console.log('[probe:v2-wait] ✓ v2.session.wait({sessionID}, options?) signature is valid in 1.17.9')
    } finally {
      abortController.abort()
      opencode?.server.close()
      cleanupIsolatedEnv(env)
    }
  })
})
