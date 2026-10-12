import type {ResolveNoProbeResult} from './resolve-binary.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {getHostPlatformInfo} from './platform.js'
import {resolveBinary, resolveBinaryNoProbe} from './resolve-binary.js'

// A real native binary stand-in: the running Node/Bun executable (ELF or Mach-O).
// Symlinked, never copied (100MB+) and never spawned by these tests.
const NATIVE = fs.realpathSync(process.execPath)

let tmp: string
let shim: string
let cli: string

function mkdir(...parts: string[]): string {
  const dir = path.join(tmp, ...parts)
  fs.mkdirSync(dir, {recursive: true})
  return dir
}

function writeExecutable(file: string, body: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, body)
  fs.chmodSync(file, mode)
  return file
}

function fakeNative(file: string): string {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.symlinkSync(NATIVE, file)
  return file
}

function expectFailure(result: ResolveNoProbeResult, kind: string): string {
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.kind).toBe(kind)
  // Callers add their own label; the resolver's text must not carry one (it nested as `[opencode] [harness] …`).
  expect(result.message).not.toContain('[harness]')
  return result.message
}

function platformPackage(binaryBody: string, mode = 0o755): {root: string; marker: string} {
  const root = mkdir('platform-pkg')
  const marker = path.join(tmp, 'spawned.marker')
  writeExecutable(path.join(root, 'bin', 'opencode'), binaryBody.replaceAll('__MARKER__', marker), mode)
  return {root, marker}
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-binary-')))
  shim = writeExecutable(path.join(mkdir('pkg', 'dist'), 'opencode.mjs'), '#!/usr/bin/env node\nconsole.log("shim")\n')
  cli = writeExecutable(path.join(tmp, 'pkg', 'dist', 'cli.mjs'), '#!/usr/bin/env node\nconsole.log("cli")\n')
})

afterEach(() => {
  fs.rmSync(tmp, {recursive: true, force: true})
})

describe('resolveBinaryNoProbe: platform package', () => {
  it('resolves an executable platform binary without spawning it', () => {
    // #given a platform binary that would leave a marker (and hang) if it were ever run
    const {root, marker} = platformPackage('#!/bin/sh\ntouch "__MARKER__"\nsleep 60\n')

    // #when resolving without a probe
    const result = resolveBinaryNoProbe({entryPoints: [shim, cli], env: {}, locatePlatformPackage: () => root})

    // #then it resolves to the absolute binary path and nothing was spawned
    expect(result).toEqual({
      ok: true,
      path: path.join(root, 'bin', 'opencode'),
      source: 'platform-package',
      isBuilt: true,
    })
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('reports not-executable (not not-found) for a present binary without exec permission', () => {
    // #given a platform binary with mode 0644
    const {root} = platformPackage('#!/bin/sh\n', 0o644)

    // #when
    const result = resolveBinaryNoProbe({entryPoints: [shim, cli], env: {}, locatePlatformPackage: () => root})

    // #then the failure is a permission failure, distinct from not-found
    const message = expectFailure(result, 'not-executable')
    expect(message).toContain('chmod +x')
  })

  for (const [label, entry] of [
    ['shim', () => shim],
    ['harness cli', () => cli],
  ] as const) {
    it(`rejects a platform binary that is a symlink to the ${label} as self-reference`, () => {
      // #given a platform package whose bin/opencode is a link back to a harness entry point
      const root = mkdir('self-platform-pkg')
      fs.mkdirSync(path.join(root, 'bin'), {recursive: true})
      fs.symlinkSync(entry(), path.join(root, 'bin', 'opencode'))

      // #when
      const result = resolveBinaryNoProbe({entryPoints: [shim, cli], env: {}, locatePlatformPackage: () => root})

      // #then it is refused instead of being exec'd (which would recurse)
      const message = expectFailure(result, 'self-reference')
      expect(message).toContain('Platform binary')
    })
  }

  it('reports not-found naming the platform package when absent and no override', () => {
    // #given no platform package and no override
    const platform = getHostPlatformInfo()
    if (!platform.ok) throw new Error('host platform unsupported')

    // #when
    const result = resolveBinaryNoProbe({entryPoints: [shim, cli], env: {}, locatePlatformPackage: () => null})

    // #then
    const message = expectFailure(result, 'not-found')
    expect(message).toContain(platform.info.packageName)
    expect(message).toContain('@fro.bot/harness-')
    expect(message).toContain('OPENCODE_PATH')
  })

  it('reports not-found when the package is installed but its binary is missing', () => {
    // #given a platform package root with no bin/opencode
    const root = mkdir('empty-platform-pkg')

    // #when
    const result = resolveBinaryNoProbe({entryPoints: [shim, cli], env: {}, locatePlatformPackage: () => root})

    // #then
    expectFailure(result, 'not-found')
  })

  it('does not search PATH without HARNESS_ALLOW_PATH_FALLBACK=1', () => {
    // #given a native opencode on PATH but no opt-in
    const bin = mkdir('bin')
    fakeNative(path.join(bin, 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {PATH: bin},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-found')
  })
})

describe('resolveBinaryNoProbe: OPENCODE_PATH', () => {
  it('honours an explicit native binary override', () => {
    // #given
    const native = fakeNative(path.join(tmp, 'ov', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: native},
      locatePlatformPackage: () => null,
    })

    // #then the override is honoured as-is, flagged as not a built artifact
    expect(result).toEqual({ok: true, path: native, source: 'override', isBuilt: false})
  })

  for (const [label, entry] of [
    ['shim', () => shim],
    ['harness cli', () => cli],
  ] as const) {
    it(`rejects a symlink to the ${label} as self-reference`, () => {
      // #given
      const link = path.join(tmp, 'links', 'opencode')
      fs.mkdirSync(path.dirname(link), {recursive: true})
      fs.symlinkSync(entry(), link)

      // #when
      const result = resolveBinaryNoProbe({
        entryPoints: [shim, cli],
        env: {OPENCODE_PATH: link},
        locatePlatformPackage: () => null,
      })

      // #then
      expectFailure(result, 'self-reference')
    })

    it(`rejects a hardlink to the ${label} as self-reference`, () => {
      // #given
      const link = path.join(tmp, 'hard', 'opencode')
      fs.mkdirSync(path.dirname(link), {recursive: true})
      fs.linkSync(entry(), link)

      // #when
      const result = resolveBinaryNoProbe({
        entryPoints: [shim, cli],
        env: {OPENCODE_PATH: link},
        locatePlatformPackage: () => null,
      })

      // #then
      expectFailure(result, 'self-reference')
    })
  }

  it('rejects the shim itself given by a non-normalized path', () => {
    // #given OPENCODE_PATH using a dot-dot detour to the shim
    const detour = path.join(path.dirname(shim), '..', 'dist', 'opencode.mjs')

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: detour},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'self-reference')
  })

  it('rejects a script override as opaque-dispatcher with the OPENCODE_PATH remediation', () => {
    // #given a #!/bin/sh dispatcher (what a mise shim looks like)
    const dispatcher = writeExecutable(path.join(tmp, 'mise', 'opencode'), '#!/bin/sh\nexec mise x -- opencode "$@"\n')

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: dispatcher},
      locatePlatformPackage: () => null,
    })

    // #then
    const message = expectFailure(result, 'opaque-dispatcher')
    expect(message).toContain('set OPENCODE_PATH to the native harness opencode binary')
  })

  it('reports not-found for a nonexistent override', () => {
    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: path.join(tmp, 'nope', 'opencode')},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-found')
  })

  it('reports not-executable for a directory override', () => {
    // #given OPENCODE_PATH pointing at a directory (tool-cache dir regression)
    const dir = mkdir('a-directory')

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: dir},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-executable')
  })

  it('reports not-executable for a non-executable override', () => {
    // #given
    const file = writeExecutable(path.join(tmp, 'noexec', 'opencode'), 'binary-ish', 0o644)

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: file},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-executable')
  })

  it('takes precedence over the platform package', () => {
    // #given both an override and an installed platform package
    const {root} = platformPackage('#!/bin/sh\n')
    const native = fakeNative(path.join(tmp, 'ov', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {OPENCODE_PATH: native},
      locatePlatformPackage: () => root,
    })

    // #then
    expect(result).toMatchObject({ok: true, path: native, source: 'override'})
  })
})

describe('resolveBinaryNoProbe: PATH walk', () => {
  const optIn = '1'

  it('skips the shim symlink and resolves the next native opencode as an absolute path', () => {
    // #given PATH = [dir with shim symlink, dir with native opencode]
    const first = mkdir('first')
    fs.symlinkSync(shim, path.join(first, 'opencode'))
    const native = fakeNative(path.join(tmp, 'second', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: [first, path.dirname(native)].join(path.delimiter)},
      locatePlatformPackage: () => null,
    })

    // #then
    expect(result).toEqual({ok: true, path: native, source: 'path-walk', isBuilt: false})
    expect(path.isAbsolute(native)).toBe(true)
  })

  it('skips a hardlink to the harness cli on PATH', () => {
    // #given
    const first = mkdir('first')
    fs.linkSync(cli, path.join(first, 'opencode'))
    const native = fakeNative(path.join(tmp, 'second', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: [first, path.dirname(native)].join(path.delimiter)},
      locatePlatformPackage: () => null,
    })

    // #then
    expect(result).toMatchObject({ok: true, path: native})
  })

  it('skips a non-executable opencode and resolves the next native one', () => {
    // #given PATH = [dir with a 0644 opencode, dir with a native opencode]
    const dirA = mkdir('dir-a')
    writeExecutable(path.join(dirA, 'opencode'), 'not runnable', 0o644)
    const native = fakeNative(path.join(tmp, 'dir-b', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: [dirA, path.dirname(native)].join(path.delimiter)},
      locatePlatformPackage: () => null,
    })

    // #then the non-executable file is passed over, as a shell would
    expect(result).toEqual({ok: true, path: native, source: 'path-walk', isBuilt: false})
  })

  it('fails closed with opaque-dispatcher when the first non-self candidate is a shell script', () => {
    // #given PATH = [shim, sh dispatcher, native]; the dispatcher must not be skipped past
    const first = mkdir('first')
    fs.symlinkSync(shim, path.join(first, 'opencode'))
    const dispatcherDir = path.join(tmp, 'mise-shims')
    writeExecutable(path.join(dispatcherDir, 'opencode'), '#!/bin/sh\nexec mise x -- opencode "$@"\n')
    const native = fakeNative(path.join(tmp, 'third', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {
        HARNESS_ALLOW_PATH_FALLBACK: optIn,
        PATH: [first, dispatcherDir, path.dirname(native)].join(path.delimiter),
      },
      locatePlatformPackage: () => null,
    })

    // #then
    const message = expectFailure(result, 'opaque-dispatcher')
    expect(message).toContain('set OPENCODE_PATH to the native harness opencode binary')
  })

  it('fails with self-reference and no recursion when only the shim is on PATH', () => {
    // #given
    const only = mkdir('only')
    fs.symlinkSync(shim, path.join(only, 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: only},
      locatePlatformPackage: () => null,
    })

    // #then it never resolves to the shim
    const message = expectFailure(result, 'self-reference')
    expect(message).toContain('OPENCODE_PATH')
  })

  it('reports not-found when PATH has no opencode at all', () => {
    // #given
    const empty = mkdir('empty')

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: empty},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-found')
  })

  it('ignores empty and relative PATH entries', () => {
    // #given a relative PATH entry that would resolve against cwd, and an empty entry
    const native = fakeNative(path.join(tmp, 'rel', 'opencode'))
    const relative = path.relative(process.cwd(), path.dirname(native))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: ['', relative].join(path.delimiter)},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-found')
  })

  it('prefers the platform package over the PATH walk', () => {
    // #given
    const {root} = platformPackage('#!/bin/sh\n')
    const native = fakeNative(path.join(tmp, 'second', 'opencode'))

    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: path.dirname(native)},
      locatePlatformPackage: () => root,
    })

    // #then
    expect(result).toMatchObject({ok: true, source: 'platform-package'})
  })

  it('fails (never returns bare opencode) when opted in with an empty PATH', () => {
    // #given opt-in with an empty PATH
    // #when
    const result = resolveBinaryNoProbe({
      entryPoints: [shim, cli],
      env: {HARNESS_ALLOW_PATH_FALLBACK: optIn, PATH: ''},
      locatePlatformPackage: () => null,
    })

    // #then
    expectFailure(result, 'not-found')
  })
})

describe('resolveBinary (probing contract, unchanged)', () => {
  it('still honours OPENCODE_PATH verbatim without validation', () => {
    // #given
    // #when
    const result = resolveBinary({env: {OPENCODE_PATH: '/some/custom/opencode'}, locatePlatformPackage: () => null})

    // #then
    expect(result).toEqual({resolved: true, path: '/some/custom/opencode', isBuilt: false})
  })

  it('locates the platform binary through the shared locator and probes it', () => {
    // #given a platform package whose binary answers --version
    const {root} = platformPackage('#!/bin/sh\necho 1.0.0\n')

    // #when
    const result = resolveBinary({env: {}, locatePlatformPackage: () => root})

    // #then it is the package's bin/opencode, flagged as a built artifact
    expect(result).toEqual({resolved: true, path: path.join(root, 'bin', 'opencode'), isBuilt: true})
  })

  it('ignores a platform binary that fails its --version probe', () => {
    // #given a platform binary that exits non-zero
    const {root} = platformPackage('#!/bin/sh\nexit 3\n')

    // #when / #then it is not trusted, so with no escape hatch resolution fails closed
    expect(() => resolveBinary({env: {}, locatePlatformPackage: () => root})).toThrow('Platform binary not found')
  })

  it('still returns bare opencode under the dev escape hatch when no platform binary exists', () => {
    // #given the escape hatch and a forced "no platform package"
    // #when
    const result = resolveBinary({env: {HARNESS_ALLOW_PATH_FALLBACK: '1'}, locatePlatformPackage: () => null})

    // #then exactly the legacy bare-command fallback
    expect(result).toEqual({resolved: true, path: 'opencode', isBuilt: false})
  })

  it('throws the existing remediation (with its [harness] label) without an escape hatch', () => {
    // #given no override, no escape hatch, no platform package
    const platform = getHostPlatformInfo()
    if (!platform.ok) throw new Error('host platform unsupported')

    // #when / #then
    expect(() => resolveBinary({env: {}, locatePlatformPackage: () => null})).toThrow(
      `[harness] Platform binary not found. Expected package: ${platform.info.packageName}`,
    )
  })
})
