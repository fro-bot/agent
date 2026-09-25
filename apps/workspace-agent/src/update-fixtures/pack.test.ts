/**
 * Unit 2 adversarial fixture suite — pack import.
 *
 * Proves the mechanism the plan's "Objects cross as a pack stream, never by local fetch or
 * alternates" key technical decision relies on: `git pack-objects --stdout` (against the
 * protected bare repo) piped into `git index-pack --stdin --strict` (in the checkout) transfers
 * the full object closure, creates no alternates file, and — because neither subcommand ever
 * resolves a URL or consults transport config — is completely unaffected by any hostile
 * transport/credential config planted in either repository.
 *
 * See docs/plans/2026-09-24-001-feat-workspace-checkout-update-recovery-plan.md, Unit 2's "Pack
 * import" scenario bullet.
 */

import type {LoopbackListener} from './helpers.js'

import {execFile} from 'node:child_process'
import {readdir, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import process from 'node:process'

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {runPackStream} from '../git-stream.js'
import {
  commitFile,
  gitSync,
  initRepo,
  isolatedGitEnv,
  makeTempDir,
  startLoopbackListener,
  writeExecutableScript,
} from './helpers.js'

/** Minimal, working env for the shell/node script stubs below — real command resolution (`sh`, `node`, `cat`, `sleep`, `yes`, `head`) needs `PATH`; these fixtures are not testing git's own env sealing, so a plain PATH is fine. */
const SCRIPT_ENV: Record<string, string> = {PATH: process.env.PATH ?? '/usr/bin:/bin'}

let sourceRepo: string
let sourceHome: string
let destRepo: string
let destHome: string
let listener: LoopbackListener

beforeEach(async () => {
  sourceRepo = await makeTempDir('pack-source-')
  sourceHome = await makeTempDir('pack-source-home-')
  destRepo = await makeTempDir('pack-dest-')
  destHome = await makeTempDir('pack-dest-home-')
  listener = await startLoopbackListener()
  initRepo(sourceRepo, isolatedGitEnv(sourceHome))
  initRepo(destRepo, isolatedGitEnv(destHome))
})

afterEach(async () => {
  await listener.close()
  await rm(sourceRepo, {recursive: true, force: true})
  await rm(sourceHome, {recursive: true, force: true})
  await rm(destRepo, {recursive: true, force: true})
  await rm(destHome, {recursive: true, force: true})
})

/** Runs the exact `pack-objects --stdout | index-pack --stdin --strict` shape the plan specifies, with no shell involved (matching how Unit 3's real implementation must spawn both ends directly, never via `sh -c`). */
async function runRawPackPipe(
  sourceSha: string,
  env: Readonly<Record<string, string>>,
): Promise<{readonly indexPackStdout: string; readonly indexPackStderr: string}> {
  return new Promise((resolve, reject) => {
    const writer = execFile(
      'git',
      ['-C', sourceRepo, 'pack-objects', '--stdout', '--revs'],
      {env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024},
      (writerError, writerStdout) => {
        if (writerError) {
          reject(writerError)
          return
        }
        execFile(
          'git',
          ['-C', destRepo, 'index-pack', '--stdin', '--strict'],
          {env, encoding: 'utf8'},
          (readerError, readerStdout, readerStderr) => {
            if (readerError) {
              reject(readerError)
              return
            }
            resolve({indexPackStdout: readerStdout, indexPackStderr: readerStderr})
          },
        ).stdin?.end(writerStdout)
      },
    )
    writer.stdin?.write(`${sourceSha}\n`)
    writer.stdin?.end()
  })
}

describe('pack import — feasibility (real git, no stub)', () => {
  it('transfers the full object closure byte-for-byte, with no alternates file and no credential material', async () => {
    // #given a small source history: three commits, so trees/blobs/commits are all exercised
    const c1 = commitFile(sourceRepo, isolatedGitEnv(sourceHome), 'a.txt', 'one', 'c1')
    commitFile(sourceRepo, isolatedGitEnv(sourceHome), 'dir/b.txt', 'two', 'c2')
    const c3 = commitFile(sourceRepo, isolatedGitEnv(sourceHome), 'dir/c.txt', 'three', 'c3')

    // #when the exact plan-specified pipe runs
    await runRawPackPipe(c3, isolatedGitEnv(destHome))

    // #then every commit, tree, and blob from the source closure is present and matches in dest
    for (const sha of [c1, c3]) {
      const kind = gitSync(destRepo, ['cat-file', '-t', sha], isolatedGitEnv(destHome)).trim()
      expect(kind).toBe('commit')
    }
    const sourceTreeListing = gitSync(sourceRepo, ['ls-tree', '-r', c3], isolatedGitEnv(sourceHome))
    const destTreeListing = gitSync(destRepo, ['ls-tree', '-r', c3], isolatedGitEnv(destHome))
    expect(destTreeListing).toBe(sourceTreeListing)

    // #then — no alternates file, no credential material: index-pack only ever writes into
    // objects/pack/, never objects/info/alternates
    const infoDirEntries = await readdir(join(destRepo, '.git', 'objects', 'info')).catch(() => [])
    expect(infoDirEntries).not.toContain('alternates')
    const destConfig = gitSync(destRepo, ['config', '--local', '--list'], isolatedGitEnv(destHome))
    expect(destConfig).not.toMatch(/token|ghs_|password/i)
  })
})

describe('pack import — non-influence (real git, no stub): hostile transport/credential config never affects the pipe', () => {
  it('a hostile url.insteadOf, http.proxy, and credential.helper in BOTH repos never cause a network attempt during pack-objects | index-pack', async () => {
    // #given hostile config in both the source and destination repos, all pointed at the
    // loopback listener
    for (const [repo, home] of [
      [sourceRepo, sourceHome],
      [destRepo, destHome],
    ] as const) {
      gitSync(
        repo,
        ['config', `url.http://127.0.0.1:${listener.port}/.insteadOf`, 'https://github.com/'],
        isolatedGitEnv(home),
      )
      gitSync(repo, ['config', 'http.proxy', `http://127.0.0.1:${listener.port}`], isolatedGitEnv(home))
      gitSync(repo, ['config', 'credential.helper', '!true'], isolatedGitEnv(home))
    }
    const sha = commitFile(sourceRepo, isolatedGitEnv(sourceHome), 'a.txt', 'one', 'c1')

    // #when the pipe runs despite the hostile config being present in both repos' local config
    await runRawPackPipe(sha, isolatedGitEnv(destHome))

    // #then the object still transferred (the pipe is functionally unaffected)...
    const kind = gitSync(destRepo, ['cat-file', '-t', sha], isolatedGitEnv(destHome)).trim()
    expect(kind).toBe('commit')

    // #then ...and the listener was never contacted — pack-objects/index-pack never resolve a
    // URL or invoke a credential helper, so the hostile config is simply never read for this
    // operation, regardless of which repo it lives in
    expect(listener.requests).toHaveLength(0)
  })
})

describe('pack import — protected (Unit 3 git-stream.ts, not implemented yet)', () => {
  it('runPackStream transfers the closure the same way the raw pipe above does', async () => {
    // #given the same small source history
    const sha = commitFile(sourceRepo, isolatedGitEnv(sourceHome), 'a.txt', 'one', 'c1')
    const env = isolatedGitEnv(destHome)

    // #when the PRODUCTION streaming primitive is used instead of the raw pipe above
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit
    // 3 lands. It documents the exact contract: runPackStream must produce the same effect as
    // runRawPackPipe above (full closure transferred, ok outcome, no alternates file).
    const outcome = await runPackStream({
      writer: {command: 'git', args: ['-C', sourceRepo, 'pack-objects', '--stdout', '--revs'], cwd: sourceRepo, env},
      reader: {command: 'git', args: ['-C', destRepo, 'index-pack', '--stdin', '--strict'], cwd: destRepo, env},
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 10_000,
    })

    // #then
    expect(outcome.kind).toBe('ok')
    const kind = gitSync(destRepo, ['cat-file', '-t', sha], isolatedGitEnv(destHome)).trim()
    expect(kind).toBe('commit')
  })
})

describe('pack import — runPackStream contract (Unit 3 git-stream.ts, not implemented yet): failure and edge-case handling', () => {
  let scriptsDir: string

  beforeEach(async () => {
    scriptsDir = await makeTempDir('pack-scripts-')
  })

  afterEach(async () => {
    await rm(scriptsDir, {recursive: true, force: true})
  })

  it('the writer exits early (non-zero, before the reader is done), so the reader is terminated and both are reported', async () => {
    // #given a writer that writes a little then fails, and a reader that would otherwise sit
    // "processing" for far longer than this test's budget — real git cannot be made to fail mid
    // pack-objects on demand, hence the shell stubs (per the plan's own instruction for this case)
    const writerScript = join(scriptsDir, 'writer-fails-early.sh')
    await writeExecutableScript(writerScript, "printf 'partial-pack-bytes'\nexit 1")
    const readerScript = join(scriptsDir, 'reader-waits.sh')
    await writeExecutableScript(readerScript, 'cat > /dev/null\nsleep 30')

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands. It documents the exact contract: a non-zero writer exit aborts the reader too, well
    // before the reader's own 30s sleep would ever complete on its own.
    const outcome = await runPackStream({
      writer: {command: 'sh', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      reader: {command: 'sh', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 5_000,
    })

    // #then
    expect(outcome.kind).toBe('failed')
    const failure = outcome.kind === 'failed' ? outcome : null
    expect(failure?.reason).toBe('writer-failed')
    expect(failure?.writer.exitCode).toBe(1)
    expect(failure?.writer.signal).toBeNull()
    // The reader never got to finish its 30s sleep on its own — it was terminated in response.
    expect(failure?.reader.signal).not.toBeNull()
  })

  it('the reader ignores SIGTERM, so it is escalated to SIGKILL and confirmed dead', async () => {
    // #given a reader that traps and swallows SIGTERM (a shell `trap` was unreliable across
    // shells in manual verification; a tiny Node script gives deterministic signal handling) —
    // real `index-pack` cannot be made to ignore SIGTERM on demand, hence the stub
    const readerScript = join(scriptsDir, 'reader-ignores-term.js')
    await writeFile(
      readerScript,
      ["process.on('SIGTERM', () => {})", 'process.stdin.resume()', 'setTimeout(() => {}, 30000)', ''].join('\n'),
    )
    const writerScript = join(scriptsDir, 'writer-quick.sh')
    await writeExecutableScript(writerScript, "printf 'data'")

    // #when — a short time budget forces the timeout path quickly rather than waiting out the
    // reader's 30s resistance
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands. It documents the exact contract: SIGTERM alone is not sufficient — the runner must
    // escalate to SIGKILL and confirm the reap before resolving `timeout`.
    const outcome = await runPackStream({
      writer: {command: 'sh', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      reader: {command: 'node', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 500,
    })

    // #then — confirmed termination via escalation, not an ordinary graceful exit
    expect(outcome.kind).toBe('timeout')
  })

  it('a grandchild that holds the pipe open yields termination-unconfirmed, never timeout', async () => {
    // #given a reader that spawns a DETACHED grandchild inheriting its stdin (the pipe from the
    // writer) and immediately exits itself — the grandchild escapes into its own process group
    // (Node's `detached: true` is the POSIX setsid equivalent), so killing the reader's own
    // process group can never reach it, and the pipe never fully closes. Confirmed by hand against
    // real process-group behaviour on this machine before writing this fixture (see the report).
    const readerScript = join(scriptsDir, 'reader-spawns-grandchild.js')
    await writeFile(
      readerScript,
      [
        "const {spawn} = require('node:child_process')",
        "const grandchild = spawn('sh', ['-c', 'cat > /dev/null'], {stdio: ['inherit', 'ignore', 'ignore'], detached: true})",
        'grandchild.unref()',
        '',
      ].join('\n'),
    )
    const writerScript = join(scriptsDir, 'writer-slow.sh')
    await writeExecutableScript(writerScript, 'sleep 30')

    // #when
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands.
    const outcome = await runPackStream({
      writer: {command: 'sh', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      reader: {command: 'node', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 500,
    })

    // #then
    expect(outcome.kind).toBe('termination-unconfirmed')
  })

  it('the byte cap is exceeded mid-stream, so both processes are terminated before the writer finishes', async () => {
    // #given a writer that produces far more than the cap, continuously, and a reader that would
    // happily accept all of it
    const writerScript = join(scriptsDir, 'writer-oversized.sh')
    await writeExecutableScript(writerScript, "yes 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' | head -c 50000000")
    const readerScript = join(scriptsDir, 'reader-sink.sh')
    await writeExecutableScript(readerScript, 'cat > /dev/null')

    // #when a byte cap far smaller than what the writer would produce is enforced
    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands. It documents the exact contract: the cap is enforced WHILE STREAMING, not only by
    // measuring the total afterward — both sides must be terminated well before the writer's 50MB
    // completes on its own.
    const outcome = await runPackStream({
      writer: {command: 'sh', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      reader: {command: 'sh', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      maxBytes: 1_000,
      timeoutMs: 5_000,
    })

    // #then
    expect(outcome.kind).toBe('failed')
    const failure = outcome.kind === 'failed' ? outcome : null
    expect(failure?.reason).toBe('byte-cap-exceeded')
    expect(failure?.writer.signal).not.toBeNull()
    expect(failure?.reader.signal).not.toBeNull()
  })

  it('the time cap is exceeded when neither process ever produces output', async () => {
    const writerScript = join(scriptsDir, 'writer-hangs.sh')
    await writeExecutableScript(writerScript, 'sleep 30')
    const readerScript = join(scriptsDir, 'reader-hangs.sh')
    await writeExecutableScript(readerScript, 'cat > /dev/null')

    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands.
    const outcome = await runPackStream({
      writer: {command: 'sh', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      reader: {command: 'sh', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 300,
    })

    expect(outcome.kind).toBe('timeout')
  })

  it('a zero-byte stream (both processes exit 0 having transferred nothing) is a valid ok outcome', async () => {
    const writerScript = join(scriptsDir, 'writer-empty.sh')
    await writeExecutableScript(writerScript, 'exit 0')
    const readerScript = join(scriptsDir, 'reader-empty.sh')
    await writeExecutableScript(readerScript, 'cat > /dev/null\nexit 0')

    // NOT IMPLEMENTED YET (Unit 3): this throws, so this test is expected to fail red until Unit 3
    // lands.
    const outcome = await runPackStream({
      writer: {command: 'sh', args: [writerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      reader: {command: 'sh', args: [readerScript], cwd: scriptsDir, env: SCRIPT_ENV},
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 5_000,
    })

    expect(outcome.kind).toBe('ok')
    const success = outcome.kind === 'ok' ? outcome : null
    expect(success?.bytesTransferred).toBe(0)
  })
})
