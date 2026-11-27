import {spawnSync} from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {afterEach, describe, expect, it} from 'vitest'
import {
  buildOpencodeCliShimScript,
  createOpencodeCliShim,
  OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS,
  OPENCODE_CLI_SHIM_EXIT_CODE,
  OPENCODE_CLI_SHIM_FILE,
  OPENCODE_CLI_SHIM_REFUSAL,
  prependPathDirectory,
} from './cli-shim.js'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cli-shim-test-'))
  roots.push(root)
  return root
}

/** A stand-in for the real binary: records that it ran and how, then prints its argv. */
function fakeBinary(root: string, name = 'real-opencode'): {readonly file: string; readonly marker: string} {
  const file = path.join(root, name)
  const marker = path.join(root, `${name}.ran`)
  const quoted = marker.split("'").join(String.raw`'\''`)
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$#" >> '${quoted}'\nprintf 'real:%s\\n' "$*"\n`, {mode: 0o755})
  chmodSync(file, 0o755)
  return {file, marker}
}

function runShim(shim: string, args: readonly string[]): {status: number | null; stdout: string; stderr: string} {
  const result = spawnSync('/bin/sh', [shim, ...args], {encoding: 'utf8'})
  return {status: result.status, stdout: result.stdout, stderr: result.stderr}
}

function installed(): {
  readonly script: string
  readonly marker: string
  readonly real: string
  readonly root: string
} {
  const root = tempRoot()
  const {file, marker} = fakeBinary(root)
  const script = path.join(root, 'opencode-shim')
  writeFileSync(script, buildOpencodeCliShimScript(file), {mode: 0o755})
  return {script, marker, real: file, root}
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true})
})

describe('buildOpencodeCliShimScript', () => {
  it('is a POSIX sh script that names the real binary by its absolute path', () => {
    // #given an absolute binary path
    // #when the script is built
    const script = buildOpencodeCliShimScript('/opt/oc/opencode')

    // #then it starts with the sh shebang and execs the quoted path
    expect(script.startsWith('#!/bin/sh\n')).toBe(true)
    expect(script).toContain('exec \'/opt/oc/opencode\' "$@"')
  })

  it('refuses a binary path that is not absolute, or holds a control character', () => {
    // #given paths the script must never embed
    // #when / #then each is refused up front
    expect(() => buildOpencodeCliShimScript('opencode')).toThrow(/absolute/)
    expect(() => buildOpencodeCliShimScript('./bin/opencode')).toThrow(/absolute/)
    expect(() => buildOpencodeCliShimScript('/opt/oc\n/opencode')).toThrow(/control/)
    expect(() => buildOpencodeCliShimScript('/opt/oc\u0000/opencode')).toThrow(/control/)
    expect(() => buildOpencodeCliShimScript('')).toThrow(/absolute/)
  })
})

describe('the shim at run time', () => {
  it.each(OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS.map(argument => [argument]))(
    'runs the real binary for the sole argument %s',
    argument => {
      // #given the shim in front of a stand-in binary
      const {script, marker} = installed()

      // #when the allowed argument is the only one
      const result = runShim(script, [argument])

      // #then the real binary ran with exactly it, and the shim added nothing
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`real:${argument}\n`)
      expect(result.stderr).toBe('')
      expect(readFileSync(marker, 'utf8')).toBe('1\n')
    },
  )

  it('lists exactly the six forms the owner allowed', () => {
    expect([...OPENCODE_CLI_SHIM_ALLOWED_ARGUMENTS].toSorted()).toEqual(
      ['--help', '--version', '-h', '-v', 'help', 'version'].toSorted(),
    )
  })

  it.each([
    [[]],
    [['api', 'get', '/global/health']],
    [['api']],
    [['run', 'hello']],
    [['serve']],
    [['serve', '--service']],
    [['service', 'start']],
    [['--version', 'extra']],
    [['-v', '-v']],
    [['version', 'extra']],
    [['help', 'api']],
    [['--help', '--version']],
    [['--standalone']],
    [['--server', 'http://127.0.0.1:1', '--version']],
    [['']],
    [['--version=1']],
    [['-V']],
    [['--VERSION']],
    [['/tmp']],
  ])('refuses %j with exit 2 and one stderr line, without running the real binary', args => {
    // #given the shim in front of a stand-in binary
    const {script, marker} = installed()

    // #when an invocation outside the allowlist is made
    const result = runShim(script, args)

    // #then it exits 2, prints nothing on stdout, one line on stderr, and never reaches the real binary
    expect(result.status).toBe(OPENCODE_CLI_SHIM_EXIT_CODE)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(`${OPENCODE_CLI_SHIM_REFUSAL}\n`)
    expect(existsSync(marker)).toBe(false)
  })

  it('uses a real path with spaces, quotes and shell metacharacters verbatim', () => {
    // #given a binary whose path would break an unquoted or double-quoted script
    const root = tempRoot()
    const directory = path.join(root, `it's $HOME "a" \`b\` ;c`)
    const {file} = fakeBinary(root)
    const hostile = path.join(directory, 'opencode')
    mkdirSync(directory, {recursive: true})
    writeFileSync(hostile, readFileSync(file), {mode: 0o755})
    const script = path.join(root, 'opencode-shim')
    writeFileSync(script, buildOpencodeCliShimScript(hostile), {mode: 0o755})

    // #when an allowed form runs
    const result = runShim(script, ['--version'])

    // #then the hostile path was run as one word
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('real:--version\n')
  })
})

describe('createOpencodeCliShim', () => {
  it('writes a runner-owned directory with a 0755 executable inside it, not writable by group or other', () => {
    // #given a parent directory and a binary
    const root = tempRoot()
    const {file} = fakeBinary(root)

    // #when the shim is created
    const created = createOpencodeCliShim({binaryPath: file, parentDirectory: root})

    // #then the directory is fresh, under the parent, and its entry is the shim
    expect(created.success).toBe(true)
    if (!created.success) return
    const {directory} = created.data
    expect(path.dirname(directory)).toBe(root)
    expect(path.basename(directory).startsWith('fro-bot-opencode-cli-')).toBe(true)
    const shimFile = path.join(directory, OPENCODE_CLI_SHIM_FILE)
    expect(OPENCODE_CLI_SHIM_FILE).toBe('opencode')

    // #and the modes are exact: world-readable and executable, writable by the owner alone
    // (the file is read through one handle, so its mode, owner and content come from the same file)
    const uid = process.getuid?.()
    expect(statSync(directory).mode & 0o7777).toBe(0o755)
    expect(statSync(directory).uid).toBe(uid)
    const fd = openSync(shimFile, 'r')
    try {
      const shimStat = fstatSync(fd)
      expect(shimStat.mode & 0o7777).toBe(0o755)

      // #and the creator owns it (the sandbox user is only ever granted read and execute)
      expect(shimStat.uid).toBe(uid)

      // #and the file is the script for that binary
      expect(readFileSync(fd, 'utf8')).toBe(buildOpencodeCliShimScript(file))
    } finally {
      closeSync(fd)
    }
    expect(runShim(shimFile, ['--version']).stdout).toBe('real:--version\n')
    expect(runShim(shimFile, ['api', 'get', '/global/health']).status).toBe(2)
  })

  it('makes a new directory every time', () => {
    // #given one parent and binary
    const root = tempRoot()
    const {file} = fakeBinary(root)

    // #when two shims are created
    const first = createOpencodeCliShim({binaryPath: file, parentDirectory: root})
    const second = createOpencodeCliShim({binaryPath: file, parentDirectory: root})

    // #then they never share a directory
    expect(first.success && second.success).toBe(true)
    if (!first.success || !second.success) return
    expect(first.data.directory).not.toBe(second.data.directory)
  })

  it('removes the directory and its file, and removing twice is harmless', () => {
    // #given a shim
    const root = tempRoot()
    const {file} = fakeBinary(root)
    const created = createOpencodeCliShim({binaryPath: file, parentDirectory: root})
    expect(created.success).toBe(true)
    if (!created.success) return

    // #when removed twice
    created.data.remove()
    created.data.remove()

    // #then nothing is left
    expect(existsSync(created.data.directory)).toBe(false)
  })

  it('fails with a message, and leaves nothing behind, when the binary path is unusable', () => {
    // #given a relative binary path
    const root = tempRoot()

    // #when the shim is created
    const created = createOpencodeCliShim({binaryPath: 'opencode', parentDirectory: root})

    // #then it fails closed and no directory was made
    expect(created.success).toBe(false)
    if (created.success) return
    expect(created.error).toMatch(/absolute/)
    expect(readdirNames(root)).toEqual([])
  })

  it('fails with a message when the parent directory does not exist', () => {
    // #given a parent that is not there
    const root = tempRoot()
    const {file} = fakeBinary(root)

    // #when the shim is created
    const created = createOpencodeCliShim({binaryPath: file, parentDirectory: path.join(root, 'missing')})

    // #then it reports the failure instead of throwing
    expect(created.success).toBe(false)
  })
})

function readdirNames(directory: string): string[] {
  return readdirSync(directory).filter(name => name.startsWith('fro-bot-opencode-cli-'))
}

describe('prependPathDirectory', () => {
  it('puts the directory first, ahead of everything that was there', () => {
    expect(prependPathDirectory('/shim', '/opt/oc:/usr/bin')).toBe('/shim:/opt/oc:/usr/bin')
  })

  it('is just the directory when there was no PATH', () => {
    expect(prependPathDirectory('/shim', undefined)).toBe('/shim')
    expect(prependPathDirectory('/shim', '')).toBe('/shim')
  })

  it('keeps one copy of the directory, at the front, when it was already listed', () => {
    expect(prependPathDirectory('/shim', '/usr/bin:/shim:/opt')).toBe('/shim:/usr/bin:/opt')
  })
})
