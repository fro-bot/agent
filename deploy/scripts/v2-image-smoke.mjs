// v2-image-smoke.mjs — the in-container half of the V2 workspace image smoke test.
//
// Run INSIDE the built image, as uid 10001 with no network:
//
//   docker run --rm --network none --user 10001:10001 \
//     -e HOME=/home/opencode -e XDG_CONFIG_HOME=/home/opencode/.config -e XDG_DATA_HOME=/home/opencode/.local/share \
//     -e XDG_CACHE_HOME=/home/opencode/.cache -e XDG_STATE_HOME=/home/opencode/.local/state \
//     -v "$PWD/deploy/scripts/v2-image-smoke.mjs:/smoke.mjs:ro" --entrypoint node "$IMAGE" /smoke.mjs \
//     '@fro.bot/systematic@3.27.0' '@fro.bot/opencode-plugin@0.1.0'
//
// What it proves that nothing else here can, because Docker is what builds the image:
// 1. the musl stock binary starts on Alpine as the agent uid (`serve --stdio`, held stdin, explicit port);
// 2. with no network, both plugins load FROM THE IMAGE'S CACHE, so nothing installs at boot;
// 3. both are listed `active` under the ids the workspace agent's plugin gate expects.
//
// It is the same sequence the workspace agent's supervisor runs (readiness on /api/agent, then /api/plugin), minus the
// permission gate, which needs the TypeScript config builder and is pinned by the supervisor's own tests and by the
// real-binary test. Plain Node ESM, no dependencies, so it needs nothing in the image beyond Node.

import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import process from 'node:process'
import {fileURLToPath} from 'node:url'

const BINARY = process.env.OPENCODE_BIN ?? '/usr/local/bin/opencode'
// SMOKE_EXPECT_UID is a seam for running this script outside the image; the image run never sets it.
const EXPECTED_UID = Number(process.env.SMOKE_EXPECT_UID ?? 10_001)
const PORT = Number(process.env.SMOKE_PORT ?? 54_399)
const BOUND_MS = Number(process.env.SMOKE_BOUND_MS ?? 120_000)
/** The ids `GET /api/plugin` must list active. Keep in step with `WORKSPACE_V2_EXPECTED_PLUGIN_IDS` in the agent. */
export const EXPECTED_PLUGIN_IDS = ['systematic', 'fro-bot.opencode-plugin']

/**
 * The expected ids that are not listed `active` in a `GET /api/plugin` body (`{data: [{id?, state: {status}}]}`).
 * Matched by id, never by presence of some entry (a failed plugin is still an entry).
 */
export function findInactivePlugins(body, expectedIds) {
  const entries = Array.isArray(body?.data) ? body.data : []
  return expectedIds.filter(id => !entries.some(entry => entry?.id === id && entry?.state?.status === 'active'))
}

async function get(pathname, authorization) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    headers: {authorization},
    signal: AbortSignal.timeout(10_000),
  })
  return {status: response.status, body: await response.json().catch(() => undefined)}
}

async function waitFor(label, attempt, deadline) {
  let last = 'no response'
  while (Date.now() < deadline) {
    try {
      const result = await attempt()
      if (result.done) return result.value
      last = result.note
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${label} did not succeed within ${BOUND_MS}ms (${last})`)
}

async function main(specs) {
  if (specs.length === 0) throw new Error('usage: v2-image-smoke.mjs <plugin spec>...')
  if (process.getuid?.() !== EXPECTED_UID) {
    throw new Error(`run this as uid ${EXPECTED_UID}, the identity the workspace agent drops OpenCode to`)
  }

  const password = randomBytes(24).toString('base64url')
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
  const child = spawn(BINARY, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', String(PORT)], {
    // A held stdin pipe: with `ignore` the server exits after about 150 ms.
    stdio: ['pipe', 'ignore', 'inherit'],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      OPENCODE_PASSWORD: password,
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({update: 'disable', plugins: specs}),
    },
  })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})))
  child.stdin.on('error', () => undefined)

  const deadline = Date.now() + BOUND_MS
  try {
    await waitFor(
      '/api/info',
      async () => {
        const result = await get('/api/info', authorization)
        return result.status === 200 ? {done: true, value: true} : {done: false, note: `HTTP ${result.status}`}
      },
      deadline,
    )
    // 503 here means plugins are still activating; a hung boot-time install would stay 503 until the bound.
    await waitFor(
      '/api/agent (plugin activation)',
      async () => {
        const result = await get('/api/agent', authorization)
        return result.status === 200 ? {done: true, value: true} : {done: false, note: `HTTP ${result.status}`}
      },
      deadline,
    )
    const plugins = await get('/api/plugin', authorization)
    const inactive = findInactivePlugins(plugins.body, EXPECTED_PLUGIN_IDS)
    if (inactive.length > 0) throw new Error(`plugins not active: ${inactive.join(', ')}`)
    console.log(`v2-image-smoke: ok (uid ${process.getuid()}, plugins active: ${EXPECTED_PLUGIN_IDS.join(', ')})`)
  } finally {
    child.stdin.end()
    const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('timeout'), 10_000))])
    if (result === 'timeout') child.kill('SIGKILL')
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`v2-image-smoke: FAILED: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
