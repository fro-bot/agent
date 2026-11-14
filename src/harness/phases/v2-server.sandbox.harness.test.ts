import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {
  controlCoversMatrix,
  matrixDirectories,
  matrixSentinels,
  parseRows,
  PRELUDE,
  writeMatrixProbe,
  writeWorksProbe,
} from './v2-server.sandbox.harness.js'

const noFs = {isDirectory: () => true, isWritable: () => true, subdirectories: () => [] as string[]}

describe('matrixDirectories', () => {
  it('covers every absolute PATH entry, the extra directories and the tool cache with its first subdirectory, once each', () => {
    // #given a PATH with a relative entry, an empty one and a duplicate
    const directories = matrixDirectories(
      {
        pathEnv: '/usr/local/bin:relative:/usr/bin::/usr/local/bin/',
        toolCache: '/opt/hostedtoolcache',
        extra: ['/opt', '/usr/share'],
      },
      {...noFs, subdirectories: () => ['CodeQL', 'node']},
    )

    // #then
    expect(directories).toEqual([
      '/usr/local/bin',
      '/usr/bin',
      '/opt',
      '/usr/share',
      '/opt/hostedtoolcache',
      '/opt/hostedtoolcache/CodeQL',
    ])
  })

  it('leaves out a directory the runner cannot write, and one that is missing', () => {
    // #given /usr/bin is not writable and /missing is not a directory
    const directories = matrixDirectories(
      {pathEnv: '/usr/local/bin:/usr/bin:/missing', toolCache: '/opt/hostedtoolcache', extra: []},
      {
        isDirectory: target => target !== '/missing',
        isWritable: target => target !== '/usr/bin',
        subdirectories: () => [],
      },
    )

    // #then only what the runner could write is in the matrix
    expect(directories).toEqual(['/usr/local/bin', '/opt/hostedtoolcache'])
  })

  it('picks the first tool cache subdirectory the runner can write', () => {
    // #given a read-only first entry
    const directories = matrixDirectories(
      {pathEnv: undefined, toolCache: '/cache', extra: []},
      {...noFs, isWritable: target => target !== '/cache/a', subdirectories: () => ['a', 'b']},
    )

    // #then
    expect(directories).toEqual(['/cache', '/cache/b'])
  })
})

function run(dir: string): string {
  const probe = writeMatrixProbe('wm_0', dir, '1', os.userInfo().uid)
  const result = spawnSync('bash', ['-c', PRELUDE + probe.cmd], {encoding: 'utf8'})
  return result.stdout + result.stderr
}

const asRoot = os.userInfo().uid === 0

describe('the write matrix probe, run for real on this machine', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.chmodSync(dir, 0o755)
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  function fixture(): {readonly dir: string; readonly sentinels: readonly string[]} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-'))
    dirs.push(dir)
    const sentinels = matrixSentinels(dir, '1')
    for (const file of sentinels) fs.writeFileSync(file, 'sentinel', {mode: 0o666})
    return {dir, sentinels}
  }

  it('reports OPEN with all four operations in a directory the actor can write, and cleans up after itself', () => {
    // #given a writable directory with the runner's sentinels in it
    const {dir, sentinels} = fixture()

    // #when run as the runner (the control)
    const rows = parseRows(run(dir))

    // #then every operation worked and the control covers the matrix
    expect(controlCoversMatrix(rows.get('wm_0'))).toBe(true)
    // #and the append sentinel is back under its name, the new file is gone, and the unlinked one is gone
    expect(fs.existsSync(sentinels[0] ?? '')).toBe(true)
    expect(fs.existsSync(`${sentinels[0]}.moved`)).toBe(false)
    expect(fs.readdirSync(dir).some(name => name.includes('-new-'))).toBe(false)
    expect(fs.existsSync(sentinels[1] ?? '')).toBe(false)
    // #and the sandbox's sentinels were not touched
    expect(fs.readFileSync(sentinels[2] ?? '', 'utf8')).toBe('sentinel')
    expect(fs.existsSync(sentinels[3] ?? '')).toBe(true)
  })

  // Root bypasses permission bits, so these two cannot show a refusal there.
  it.skipIf(asRoot)('reports BLOCKED when nothing can be written', () => {
    // #given a directory and files nobody may change (run as the sandbox actor: another uid than the runner's)
    const {dir, sentinels} = fixture()
    for (const file of sentinels) fs.chmodSync(file, 0o444)
    fs.chmodSync(dir, 0o555)
    const probe = writeMatrixProbe('wm_0', dir, '1', os.userInfo().uid + 1)

    // #when run
    const result = spawnSync('bash', ['-c', PRELUDE + probe.cmd], {encoding: 'utf8'})

    // #then no operation succeeded
    expect(parseRows(result.stdout).get('wm_0')).toEqual([
      {status: 'BLOCKED', evidence: 'no write operation succeeded'},
    ])
  })

  it('does not call a control complete unless it managed all four operations', () => {
    // #given a control row that only created
    // #then it is not enough
    expect(controlCoversMatrix([{status: 'OPEN', evidence: 'succeeded: create'}])).toBe(false)
    expect(controlCoversMatrix([{status: 'BLOCKED', evidence: 'no write operation succeeded'}])).toBe(false)
    expect(controlCoversMatrix(undefined)).toBe(false)
  })
})

describe('writeWorksProbe', () => {
  it.skipIf(asRoot)('reports WORKS for a writable directory and FAILED for one that is not', () => {
    // #given a writable and a read-only directory
    const writable = fs.mkdtempSync(path.join(os.tmpdir(), 'works-'))
    const sealed = fs.mkdtempSync(path.join(os.tmpdir(), 'works-ro-'))
    fs.chmodSync(sealed, 0o555)
    try {
      // #when each is probed
      const good = spawnSync('bash', ['-c', PRELUDE + writeWorksProbe('w_ok', `'${writable}'`).cmd], {encoding: 'utf8'})
      const bad = spawnSync('bash', ['-c', PRELUDE + writeWorksProbe('w_ro', `'${sealed}'`).cmd], {encoding: 'utf8'})

      // #then
      expect(parseRows(good.stdout).get('w_ok')?.[0]?.status).toBe('WORKS')
      expect(parseRows(bad.stdout).get('w_ro')?.[0]?.status).toBe('FAILED')
      expect(fs.readdirSync(writable)).toEqual([])
    } finally {
      fs.chmodSync(sealed, 0o755)
      fs.rmSync(writable, {recursive: true, force: true})
      fs.rmSync(sealed, {recursive: true, force: true})
    }
  })
})
